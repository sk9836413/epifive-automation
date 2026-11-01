#!/usr/bin/env node
// EpiFive CRM collector: gathers daily numbers from every platform and POSTs them to the CRM
// (/api/ingest/metrics, header X-Ingest-Token). Runs from .github/workflows/crm-collect.yml once a day,
// and the website part also from the owner's PC (E:\SK\site-stats\push.mjs) until CF_API_TOKEN is a secret.
//
//   node crm/collect.mjs [--days 10] [--only website,gsc,...] [--dry-run]
//
// THIS REPO IS PUBLIC: never print secrets, email addresses, lead data or raw API responses. The log shows
// only "<source>: <status> (<n> days)". Each source is independent; a failing source never blocks the others.
//
// Environment (all optional except CRM_URL + INGEST_TOKEN; a source without its credentials is skipped):
//   CRM_URL, INGEST_TOKEN
//   CF_API_TOKEN (Account Analytics: Read), CF_ACCOUNT_ID         -> website  (Cloudflare Web Analytics)
//   GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN, GSC_SITE  -> gsc
//   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN               -> youtube_epifive
//   SHYAM_YT_CLIENT_ID, SHYAM_YT_CLIENT_SECRET, SHYAM_YT_REFRESH_TOKEN -> youtube_shyam
//   MAKE_WEBHOOK_URL, MAKE_API_KEY                                 -> facebook, instagram, linkedin (Make "stats" route)
//   RESEND_API_KEY, RESEND_SEGMENT_ID                              -> newsletter
//   DEVTO_API_KEY                                                  -> devto
//   SITE_REPO_TOKEN                                                -> content calendar logs (/api/ingest/calendar)
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const DAYS = Math.min(Math.max(Number(arg('days', process.env.CRM_DAYS || 10)) || 10, 1), 90);
const ONLY = String(arg('only', process.env.CRM_ONLY || '')).split(',').map((s) => s.trim()).filter(Boolean);
const DRY = args.includes('--dry-run');
const env = process.env;
const TIMEOUT = 30_000;

const today = new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const FROM = addDays(today, -(DAYS - 1));

/** Removes anything that could be a secret or personal data from a message before it is logged or stored. */
export function clean(msg) {
  return String(msg || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/[A-Za-z0-9_\-]{24,}/g, '<redacted>')
    .slice(0, 200);
}

async function http(url, opts = {}, what = 'request', attempt = 1) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  // Google and others answer 500/503 now and then: retry twice with a short pause.
  if (res.status >= 500 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return http(url, opts, what, attempt + 1);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const reason = body?.error?.message || body?.error_description || body?.error || body?.message || '';
    throw new Error(`${what} HTTP ${res.status}${reason ? `: ${typeof reason === 'string' ? reason : 'error'}` : ''}`);
  }
  if (body === null) throw new Error(`${what}: not JSON`);
  return body;
}

async function googleToken(id, secret, refresh, what) {
  const j = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  }, `${what} token`);
  return j.access_token;
}

const top = (map, n = 20) => [...map.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, n)
  .map(([label, v]) => ({ label: label.slice(0, 300), value: v.value, ...(v.value2 !== undefined ? { value2: v.value2 } : {}), ...(v.url ? { url: v.url } : {}) }));

// ---------------------------------------------------------------- website (Cloudflare Web Analytics)
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|gemini\.google\.com|bard\.google\.com|copilot\.microsoft\.com|claude\.ai|you\.com|phind\.com|poe\.com|meta\.ai|chat\.deepseek\.com|grok\.com|kagi\.com)$/;
const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.com|yandex\.[a-z]+|baidu\.com|ecosia\.org|search\.brave\.com|naver\.com|qwant\.com|startpage\.com)$/;
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linkedin\.com|lnkd\.in|t\.co|x\.com|twitter\.com|youtube\.com|reddit\.com|quora\.com|whatsapp\.com|pinterest\.com|threads\.net|telegram\.org|t\.me|dev\.to|hashnode\.com|medium\.com)$/;
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });

async function website() {
  if (!env.CF_API_TOKEN) return null;
  const account = env.CF_ACCOUNT_ID || 'cc7da560c73a0539ed32313476555d4a';
  const hosts = (env.CF_HOSTS || 'www.epifive.com,epifive.com').split(',').map((h) => `"${h.trim()}"`).join(',');
  const q = async (dims) => {
    const query = `{viewer{accounts(filter:{accountTag:"${account}"}){rumPageloadEventsAdaptiveGroups(limit:10000,filter:{date_geq:"${FROM}",date_leq:"${today}",requestHost_in:[${hosts}]}){count sum{visits} dimensions{${dims}}}}}}`;
    const j = await http('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
    }, 'Cloudflare analytics');
    if (j.errors?.length) throw new Error(`Cloudflare analytics: ${j.errors[0].message}`);
    return j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups;
  };
  const [byDate, byPath, byCountry, byRef] = await Promise.all([q('date'), q('date requestPath'), q('date countryName'), q('date refererHost')]);
  const days = new Map(range(FROM, today).map((d) => [d, { date: d, metrics: { visits: 0, pageviews: 0, search_visits: 0, ai_visits: 0, social_visits: 0 }, lists: {} }]));
  for (const r of byDate) {
    const d = days.get(r.dimensions.date);
    if (d) { d.metrics.visits = r.sum.visits; d.metrics.pageviews = r.count; }
  }
  const lists = {};
  const bump = (date, list, label, value, url) => {
    const m = ((lists[date] ||= {})[list] ||= new Map());
    const cur = m.get(label) || { value: 0, url };
    cur.value += value;
    m.set(label, cur);
  };
  for (const r of byPath) bump(r.dimensions.date, 'top_pages', r.dimensions.requestPath || '/', r.count, `https://www.epifive.com${r.dimensions.requestPath || '/'}`);
  for (const r of byCountry) if (r.sum.visits) bump(r.dimensions.date, 'countries', regionName.of(r.dimensions.countryName) || r.dimensions.countryName, r.sum.visits);
  for (const r of byRef) {
    const host = (r.dimensions.refererHost || '').toLowerCase().replace(/^www\./, '');
    const d = days.get(r.dimensions.date);
    if (!d || !r.sum.visits || host.endsWith('epifive.com')) continue;
    if (!host) { bump(r.dimensions.date, 'referrers', '(direct / none)', r.sum.visits); continue; }
    if (AI.test(host)) d.metrics.ai_visits += r.sum.visits;
    else if (SEARCH.test(host)) d.metrics.search_visits += r.sum.visits;
    else if (SOCIAL.test(host)) d.metrics.social_visits += r.sum.visits;
    bump(r.dimensions.date, 'referrers', host, r.sum.visits);
  }
  for (const [date, l] of Object.entries(lists)) {
    const d = days.get(date);
    if (d) for (const [name, m] of Object.entries(l)) d.lists[name] = top(m, name === 'top_pages' ? 25 : 20);
  }
  // Only days Cloudflare has numbers for (the site's Web Analytics data starts on 2026-10-24).
  const withData = [...days.values()].filter((d) => d.metrics.pageviews > 0 || Object.keys(d.lists).length);
  return { source: 'website', status: withData.length ? 'ok' : 'no-data', note: withData.length ? '' : 'No visits recorded yet', days: withData };
}

// ---------------------------------------------------------------- Google Search Console
async function gsc() {
  if (!env.GSC_REFRESH_TOKEN) return null;
  const token = await googleToken(env.GSC_CLIENT_ID, env.GSC_CLIENT_SECRET, env.GSC_REFRESH_TOKEN, 'Search Console');
  const site = env.GSC_SITE || 'sc-domain:epifive.com';
  const query = (dimensions, rowLimit) => http(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: FROM, endDate: today, dimensions, rowLimit, dataState: 'all' }),
  }, 'Search Console');
  const [byDate, byQuery, byPage] = await Promise.all([query(['date'], 1000), query(['date', 'query'], 25000), query(['date', 'page'], 25000)]);
  const days = new Map();
  for (const r of byDate.rows || []) {
    days.set(r.keys[0], { date: r.keys[0], metrics: { clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }, lists: {} });
  }
  const lists = {};
  const add = (rows, list, toLabel) => {
    for (const r of rows || []) {
      const m = ((lists[r.keys[0]] ||= {})[list] ||= new Map());
      const { label, url } = toLabel(r.keys[1]);
      m.set(label, { value: r.clicks, value2: r.impressions, url });
    }
  };
  add(byQuery.rows, 'top_queries', (k) => ({ label: k }));
  add(byPage.rows, 'top_pages', (k) => {
    let label = k;
    try { label = new URL(k).pathname; } catch { /* keep */ }
    return { label, url: k.startsWith('https://') ? k : undefined };
  });
  for (const [date, l] of Object.entries(lists)) {
    const d = days.get(date);
    if (!d) continue;
    for (const [name, m] of Object.entries(l)) {
      // Rank by clicks, then impressions.
      d.lists[name] = [...m.entries()].sort((a, b) => b[1].value - a[1].value || b[1].value2 - a[1].value2).slice(0, 20)
        .map(([label, v]) => ({ label: label.slice(0, 300), value: v.value, value2: v.value2, ...(v.url ? { url: v.url } : {}) }));
    }
  }
  return { source: 'gsc', status: days.size ? 'ok' : 'no-data', note: days.size ? '' : 'Search Console returned no rows yet', days: [...days.values()] };
}

// ---------------------------------------------------------------- YouTube (Data API + Analytics API)
async function youtube(source, prefix) {
  const id = env[`${prefix}CLIENT_ID`];
  const secret = env[`${prefix}CLIENT_SECRET`];
  const refresh = env[`${prefix}REFRESH_TOKEN`];
  if (!refresh) return null;
  const token = await googleToken(id, secret, refresh, 'YouTube');
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const ch = await http('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', auth, 'YouTube channel');
  const stats = ch.items?.[0]?.statistics;
  if (!stats) throw new Error('YouTube: no channel on this account');
  const days = new Map(range(FROM, today).map((d) => [d, { date: d, metrics: {}, lists: {} }]));
  days.get(today).metrics = { subscribers: Number(stats.subscriberCount || 0), total_views: Number(stats.viewCount || 0), videos: Number(stats.videoCount || 0) };
  let note = '';
  try {
    const report = (params) => http(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: 'channel==MINE', ...params })}`, auth, 'YouTube Analytics');
    const daily = await report({ startDate: FROM, endDate: today, dimensions: 'day', metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost', sort: 'day' });
    for (const [day, views, minutes, gained, lost] of daily.rows || []) {
      const d = days.get(day);
      if (d) Object.assign(d.metrics, { views, watch_minutes: minutes, subscribers_gained: gained, subscribers_lost: lost });
    }
    try {
      await topVideos(daily, report, auth, days);
    } catch (e) {
      note = `Top videos unavailable (${clean(e.message)}).`;
    }
  } catch (e) {
    note = `Daily views/watch time unavailable (${clean(e.message)}); channel totals only.`;
  }
  return { source, status: note ? 'partial' : 'ok', note, days: [...days.values()].filter((d) => Object.keys(d.metrics).length || Object.keys(d.lists).length) };
}

async function topVideos(daily, report, auth, days) {
  // Top videos per day (Analytics data lags 2-3 days; days without rows are skipped).
  const perDay = {};
  const withData = (daily.rows || []).filter((r) => r[1] > 0).map((r) => r[0]);
  for (const day of withData) {
    const r = await report({ startDate: day, endDate: day, dimensions: 'video', metrics: 'views,estimatedMinutesWatched', sort: '-views', maxResults: '10' });
    perDay[day] = r.rows || [];
  }
  const ids = [...new Set(Object.values(perDay).flat().map((r) => r[0]))];
  const titles = {};
  for (let i = 0; i < ids.length; i += 50) {
    const v = await http(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.slice(i, i + 50).join(',')}`, auth, 'YouTube videos');
    for (const it of v.items || []) titles[it.id] = it.snippet.title;
  }
  for (const [day, rows] of Object.entries(perDay)) {
    const d = days.get(day);
    if (d && rows.length) d.lists.top_videos = rows.map(([vid, views, minutes]) => ({ label: (titles[vid] || vid).slice(0, 300), value: views, value2: Math.round(minutes), url: `https://www.youtube.com/watch?v=${vid}` }));
  }
}

// ---------------------------------------------------------------- Facebook / Instagram / LinkedIn (Make "stats" route)
const RENAME = { follower_count: 'followers', followers_count: 'followers', fan_count: 'followers', all_page_views: 'page_views', page_views_total: 'page_views' };
function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = `${prefix}${k}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (typeof v === 'number' && Number.isFinite(v)) out[RENAME[key] || key] = v;
    else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) out[RENAME[key] || key] = Number(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && prefix.split('_').length < 3) flatten(v, `${key}_`, out);
  }
  return Object.fromEntries(Object.entries(out).filter(([k]) => /^[a-z][a-z0-9_]{0,39}$/.test(k)).slice(0, 20));
}

async function social() {
  if (!env.MAKE_WEBHOOK_URL) return null;
  const names = ['facebook', 'instagram', 'linkedin'];
  let body;
  try {
    const res = await fetch(env.MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.MAKE_API_KEY ? { 'x-make-apikey': env.MAKE_API_KEY } : {}) },
      body: JSON.stringify({ action: 'stats' }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Make stats route returned HTTP ${res.status}`);
    try { body = JSON.parse(text); } catch { throw new Error('Make stats route did not answer with JSON (scenario not set to run immediately?)'); }
  } catch (e) {
    const note = e.name === 'TimeoutError' ? 'Make stats route timed out' : clean(e.message);
    return names.map((source) => ({ source, status: 'no-data', note, days: [] }));
  }
  return names.map((source) => {
    const metrics = flatten(body?.[source]);
    return Object.keys(metrics).length
      ? { source, status: 'ok', days: [{ date: today, metrics }] }
      : { source, status: 'no-data', note: 'No numbers for this platform in the Make reply', days: [] };
  });
}

// ---------------------------------------------------------------- Newsletter (Resend contacts)
async function newsletter() {
  if (!env.RESEND_API_KEY) return null;
  const isOwnerTest = (email) => { const e = String(email).toLowerCase(); return e.startsWith('epifive2') && e.endsWith('@gmail.com'); };
  let after = '';
  let active = 0;
  let unsub = 0;
  const signups = new Map(range(FROM, today).map((d) => [d, 0]));
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ limit: '100', ...(env.RESEND_SEGMENT_ID ? { segment_id: env.RESEND_SEGMENT_ID } : {}), ...(after ? { after } : {}) });
    const j = await http(`https://api.resend.com/contacts?${q}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } }, 'Resend');
    for (const c of j.data || []) {
      if (isOwnerTest(c.email)) continue;
      if (c.unsubscribed) unsub++;
      else active++;
      const day = String(c.created_at || '').slice(0, 10);
      if (signups.has(day)) signups.set(day, signups.get(day) + 1);
    }
    if (!j.has_more || !j.data?.length) break;
    after = j.data[j.data.length - 1].id;
  }
  const days = [...signups.entries()].map(([date, n]) => ({ date, metrics: { signups: n, ...(date === today ? { subscribers: active, unsubscribed: unsub } : {}) } }));
  return { source: 'newsletter', status: 'ok', note: 'Owner/test addresses excluded', days };
}

// ---------------------------------------------------------------- dev.to
async function devto() {
  if (!env.DEVTO_API_KEY) return null;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const j = await http(`https://dev.to/api/articles/me/published?per_page=100&page=${page}`, { headers: { 'api-key': env.DEVTO_API_KEY, Accept: 'application/vnd.forem.api-v1+json', 'User-Agent': 'epifive-crm-collector' } }, 'dev.to');
    all.push(...j);
    if (j.length < 100) break;
  }
  const sum = (k) => all.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const topArticles = all.map((a) => ({ label: String(a.title).slice(0, 300), value: Number(a.page_views_count) || 0, value2: Number(a.public_reactions_count) || 0, url: String(a.url || '').startsWith('https://') ? a.url : undefined }))
    .sort((a, b) => b.value - a.value).slice(0, 20).map((x) => (x.url ? x : { label: x.label, value: x.value, value2: x.value2 }));
  return {
    source: 'devto', status: 'ok',
    days: [{ date: today, metrics: { views_total: sum('page_views_count'), reactions_total: sum('public_reactions_count'), comments_total: sum('comments_count'), articles: all.length }, lists: { top_articles: topArticles } }],
  };
}

// ---------------------------------------------------------------- content calendar logs
async function calendarFiles() {
  const files = {};
  const get = async (repo, path, token) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'epifive-crm-collector', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 404) return '';
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    return (await res.text()).slice(-400_000);
  };
  if (env.SITE_REPO_TOKEN) {
    files.social = await get('sk9836413/EPIVIFE', 'automation/social-log.md', env.SITE_REPO_TOKEN);
    files.longvideo = await get('sk9836413/EPIVIFE', 'automation/longvideo-log.md', env.SITE_REPO_TOKEN);
  }
  files.shyam = await get('sk9836413/shyam-premi-sn', 'automation/log.md');
  return files;
}

// ---------------------------------------------------------------- main
const SOURCES = {
  website,
  gsc,
  youtube_epifive: () => youtube('youtube_epifive', 'YT_'),
  youtube_shyam: () => youtube('youtube_shyam', 'SHYAM_YT_'),
  social,
  newsletter,
  devto,
};
const SOCIAL_NAMES = ['facebook', 'instagram', 'linkedin'];

async function post(path, body) {
  if (DRY) return { ok: true, dry: true };
  return http(`${env.CRM_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': env.INGEST_TOKEN }, body: JSON.stringify(body),
  }, 'CRM');
}

async function main() {
  if (!DRY && (!env.CRM_URL || !env.INGEST_TOKEN)) {
    console.log('CRM_URL or INGEST_TOKEN is not set: nothing to do.');
    process.exit(1);
  }
  const summary = [];
  const wanted = Object.keys(SOURCES).filter((k) => !ONLY.length || ONLY.includes(k) || (k === 'social' && ONLY.some((o) => SOCIAL_NAMES.includes(o))));
  for (const key of wanted) {
    let results;
    try {
      results = await SOURCES[key]();
    } catch (e) {
      const names = key === 'social' ? SOCIAL_NAMES : [key];
      results = names.map((source) => ({ source, status: 'error', note: clean(e.message), days: [] }));
    }
    if (results === null) {
      summary.push([key, 'skipped (credentials not set)', 0]);
      continue;
    }
    for (const r of [results].flat()) {
      r.note = clean(r.note);
      try {
        await post('/api/ingest/metrics', { sources: [r] });
        summary.push([r.source, r.status + (r.note ? ` - ${r.note}` : ''), r.days.length]);
      } catch (e) {
        summary.push([r.source, `not saved: ${clean(e.message)}`, 0]);
      }
    }
  }
  if (!ONLY.length || ONLY.includes('calendar')) {
    try {
      const files = await calendarFiles();
      await post('/api/ingest/calendar', { files });
      summary.push(['calendar', `ok (${Object.keys(files).join(', ')})`, 0]);
    } catch (e) {
      summary.push(['calendar', `error - ${clean(e.message)}`, 0]);
    }
  }
  for (const [s, status, n] of summary) console.log(`${s}: ${status}${n ? ` (${n} days)` : ''}`);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, ['| Source | Result | Days |', '| --- | --- | ---: |', ...summary.map(([s, st, n]) => `| ${s} | ${st.replace(/\|/g, '/')} | ${n} |`), ''].join('\n'));
  }
  // Fail the run only if nothing at all could be saved (so a broken CRM or token gets noticed).
  if (!DRY && summary.length && summary.every(([, st]) => st.startsWith('not saved') || st.startsWith('skipped'))) process.exit(1);
}

await main();
