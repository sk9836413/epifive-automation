#!/usr/bin/env node
// CRM Control Center snapshots (owner only screen in the CRM). Computes five JSON snapshots with the secrets that live
// in GitHub and posts each one to the CRM (POST /api/ingest/control, INGEST_TOKEN):
//   performance  website today vs yesterday at the same time (Cloudflare RUM; China = bots, shown apart), sources,
//                top pages, 7-day trend; YouTube EpiFive + Shyam (subs, views, latest uploads); newsletter (Resend)
//   health       last run of each important workflow (3 repos) + token checks (Cloudflare, YouTube, Search Console,
//                Resend, Meta, LinkedIn expiry dates)
//   content      today's published articles and the top of the backlog (site repo automation/*.md)
//   social       last post per platform and Instagram failures (site repo automation/social-log.md)
//   shyam        next festivals, owner-footage queue + skip list, email-ingest status (public Shyam repo files)
//
//   node control/snapshot.mjs --site <EPIVIFE dir> --shyam <shyam dir> [--only performance,health] [--out file] [--dry-run]
//
// THIS REPO IS PUBLIC: the log shows "<key>: ok|failed" and counts only. The numbers go to the CRM, never to the log.
// --dry-run (or no INGEST_TOKEN) posts nothing; --out writes the JSON to a file (local use only, never in Actions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, addDays, bucketSources, istDate, istDayBounds, istTime, previousSnapshot } from '../report/lib.mjs';
import { expiryHealth, footageQueue, metaTokenHealth, parseBacklog, parseSocialLog, publishedOn, rumTotals, rumTrend, runHealth, socialSummary, upcomingFestivals } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const env = process.env;
const DRY = args.includes('--dry-run') || !env.INGEST_TOKEN;
const ONLY = (arg('only', '') || 'performance,health,content,social,shyam').split(',').map((s) => s.trim()).filter(Boolean);
const SITE_DIR = arg('site', env.SITE_DIR || '');
const SHYAM_DIR = arg('shyam', env.SHYAM_DIR || '');
const NOW = Date.now();
const TODAY = istDate(new Date(NOW));
const TIMEOUT = 25_000;
const RUN_URL = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
const checks = {}; // token checks found while building performance (used by health)

const clean = (s) => String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>').replace(/(token|key|secret)=[^&\s]+/gi, '$1=<hidden>').slice(0, 160);
const readFile = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };

async function http(url, opts = {}, what = 'request') {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = body?.error;
    const err = new Error(`${what} HTTP ${res.status}${(typeof e === 'string' ? e : e?.message) || body?.message ? `: ${clean((typeof e === 'string' ? e : e?.message) || body?.message)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body ?? text;
}

async function googleToken(prefix) {
  const j = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: env[`${prefix}CLIENT_ID`], client_secret: env[`${prefix}CLIENT_SECRET`], refresh_token: env[`${prefix}REFRESH_TOKEN`], grant_type: 'refresh_token' }),
  }, 'Google token');
  return j.access_token;
}

// ---------------------------------------------------------------- performance
async function website() {
  if (!env.CF_API_TOKEN) { checks.cf = { state: 'warn', text: 'CF_API_TOKEN secret set nahi' }; return { ok: false, error: 'CF_API_TOKEN secret set nahi hai' }; }
  const account = env.CF_ACCOUNT_ID || 'cc7da560c73a0539ed32313476555d4a';
  const hosts = JSON.stringify((env.CF_HOSTS || 'www.epifive.com,epifive.com').split(',').map((s) => s.trim()));
  const day = istDayBounds(TODAY);
  const yday = istDayBounds(addDays(TODAY, -1));
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const now = iso(Math.min(NOW, Date.parse(day.to)));
  const ySame = iso(Date.parse(now) - 864e5);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(TODAY, i - 6));
  const g = (alias, from, to, dims, extra = '', limit = 1000) =>
    `${alias}: rumPageloadEventsAdaptiveGroups(limit:${limit}${extra},filter:{datetime_geq:"${from}",datetime_lt:"${to}",requestHost_in:${hosts}}){count sum{visits} dimensions{${dims}}}`;
  const query = `{viewer{accounts(filter:{accountTag:"${account}"}){${[
    g('tRef', day.from, now, 'refererHost countryName', '', 3000),
    g('tPath', day.from, now, 'requestPath countryName', ',orderBy:[count_DESC]', 300),
    g('ySame', yday.from, ySame, 'refererHost countryName', '', 3000),
    g('yAll', yday.from, yday.to, 'countryName', '', 300),
    g('trend', istDayBounds(dates[0]).from, now, 'date countryName', '', 2000),
  ].join(' ')}}}}`;
  try {
    const j = await http('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }, 'Cloudflare');
    if (j.errors?.length) throw new Error(`Cloudflare: ${clean(j.errors[0].message)}`);
    const a = j.data.viewer.accounts[0];
    const real = (rows) => rows.filter((r) => r.dimensions.countryName !== 'CN');
    const refRows = (rows) => real(rows).map((r) => ({ host: r.dimensions.refererHost || '', visits: r.sum?.visits || 0 }));
    const src = bucketSources(refRows(a.tRef));
    const srcY = bucketSources(refRows(a.ySame));
    const pages = new Map();
    for (const r of real(a.tPath)) pages.set(r.dimensions.requestPath || '/', (pages.get(r.dimensions.requestPath || '/') || 0) + (r.count || 0));
    // CF "date" is the UTC date; the trend uses it as a close-enough day label.
    checks.cf = { state: 'good', text: 'Cloudflare analytics OK' };
    return {
      ok: true,
      now_ist: istTime(new Date(Date.parse(now))),
      today: rumTotals(a.tRef),
      yesterday_same: rumTotals(a.ySame),
      yesterday: rumTotals(a.yAll),
      sources: SOURCES.filter((s) => src.by[s] || srcY.by[s]).map((s) => ({ name: s, today: src.by[s], yesterday_same: srcY.by[s] })),
      top_pages: [...pages.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([p, views]) => ({ path: p.slice(0, 200), views })),
      trend: rumTrend(a.trend, dates),
    };
  } catch (e) {
    checks.cf = { state: 'bad', text: clean(e.message) };
    return { ok: false, error: clean(e.message) };
  }
}

async function youtube(name, prefix, key, prev) {
  if (!env[`${prefix}REFRESH_TOKEN`]) { checks[key] = { state: 'warn', text: `${prefix}* secrets set nahi` }; return { key, name, ok: false, error: `${prefix}* secrets set nahi` }; }
  try {
    const token = await googleToken(prefix);
    checks[key] = { state: 'good', text: 'refresh token OK' };
    const yt = (p) => http(`https://www.googleapis.com/youtube/v3/${p}`, { headers: { Authorization: `Bearer ${token}` } }, 'YouTube');
    const ch = (await yt('channels?part=statistics,contentDetails&mine=true')).items?.[0];
    if (!ch) throw new Error('no channel on this account');
    const pl = await yt(`playlistItems?part=contentDetails&maxResults=8&playlistId=${ch.contentDetails.relatedPlaylists.uploads}`);
    const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
    const vids = ids.length ? (await yt(`videos?part=snippet,statistics,status&id=${ids.join(',')}`)).items || [] : [];
    const subs = Number(ch.statistics.subscriberCount || 0);
    const before = prev?.data?.[key]?.subs;
    return {
      key, name, ok: true, subs, views: Number(ch.statistics.viewCount || 0), videos: Number(ch.statistics.videoCount || 0),
      subs_delta: before === undefined ? null : subs - before,
      latest: vids.slice(0, 6).map((v) => ({ id: v.id, title: String(v.snippet.title).slice(0, 120), views: Number(v.statistics.viewCount || 0), published_at: v.status.publishAt || v.snippet.publishedAt, privacy: v.status.privacyStatus })),
    };
  } catch (e) {
    if (!checks[key] || /token/i.test(e.message)) checks[key] = { state: 'bad', text: clean(e.message) };
    return { key, name, ok: false, error: clean(e.message) };
  }
}

async function newsletter() {
  if (!env.RESEND_API_KEY) { checks.resend = { state: 'warn', text: 'RESEND_API_KEY set nahi' }; return { ok: false, error: 'RESEND_API_KEY set nahi' }; }
  const get = (p) => http(`https://api.resend.com${p}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } }, 'Resend');
  const pause = () => new Promise((r) => setTimeout(r, 600)); // Resend: 2 requests a second
  const all = async (p) => {
    let out = [];
    let after = null;
    for (let i = 0; i < 20; i++) {
      const j = await get(`${p}${p.includes('?') ? '&' : '?'}limit=100${after ? `&after=${after}` : ''}`);
      const d = j.data || [];
      out = out.concat(d);
      if (!j.has_more || !d.length) break;
      after = d[d.length - 1].id;
      await pause();
    }
    return out;
  };
  try {
    const c = await all('/contacts');
    const segments = [];
    try {
      await pause();
      const s = await get('/segments');
      for (const seg of (s.data || []).slice(0, 8)) {
        await pause();
        const list = await all(`/segments/${seg.id}/contacts`);
        segments.push({ name: String(seg.name).slice(0, 40), subscribed: list.filter((x) => !x.unsubscribed).length });
      }
    } catch { /* segments are optional */ }
    checks.resend = { state: 'good', text: 'Resend API OK' };
    return { ok: true, total: c.length, subscribed: c.filter((x) => !x.unsubscribed).length, segments };
  } catch (e) {
    checks.resend = { state: 'bad', text: clean(e.message) };
    return { ok: false, error: clean(e.message) };
  }
}

async function performance() {
  let snap = {};
  try { snap = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'report', 'snapshot.json'), 'utf8')); } catch { /* none */ }
  const prev = previousSnapshot(snap, TODAY);
  const [web, ytE, ytS, news] = await Promise.all([
    website(),
    youtube('EpiFive', 'YT_', 'yt_epifive', prev),
    youtube('Shyam Premi SN', 'SHYAM_YT_', 'yt_shyam', prev),
    newsletter(),
  ]);
  return { generated_at: new Date(NOW).toISOString(), date: TODAY, website: web, youtube: [ytE, ytS], newsletter: news };
}

// ---------------------------------------------------------------- health
const WORKFLOWS = [
  { repo: 'sk9836413/epifive-automation', file: 'article.yml', name: 'Daily article', maxH: 30 },
  { repo: 'sk9836413/epifive-automation', file: 'radar.yml', name: 'Launch radar', maxH: 12 },
  { repo: 'sk9836413/epifive-automation', file: 'social.yml', name: 'Social media', maxH: 30 },
  { repo: 'sk9836413/epifive-automation', file: 'report.yml', name: 'Daily report email', maxH: 30 },
  { repo: 'sk9836413/epifive-automation', file: 'crm-collect.yml', name: 'CRM collect', maxH: 30 },
  { repo: 'sk9836413/epifive-automation', file: 'replies.yml', name: 'Comment replies', maxH: 30 },
  { repo: 'sk9836413/epifive-automation', file: 'ai-task.yml', name: 'AI Tasks agent', maxH: null },
  { repo: 'sk9836413/EPIVIFE', file: 'outreach.yml', name: 'Outreach (Gmail/Zoho)', maxH: 30, token: 'SITE_REPO_TOKEN' },
  { repo: 'sk9836413/EPIVIFE', file: 'daily50.yml', name: 'Daily 50 list', maxH: 30, token: 'SITE_REPO_TOKEN' },
  { repo: 'sk9836413/shyam-premi-sn', file: 'daily.yml', name: 'Shyam daily', maxH: 12 },
  { repo: 'sk9836413/shyam-premi-sn', file: 'photos.yml', name: 'Shyam photos/trigger', maxH: 30 },
  { repo: 'sk9836413/shyam-premi-sn', file: 'comments.yml', name: 'Shyam comment replies', maxH: 30 },
];

async function workflowItems() {
  return Promise.all(WORKFLOWS.map(async (w) => {
    const token = env[w.token || 'GITHUB_TOKEN'];
    const group = w.repo.endsWith('shyam-premi-sn') ? 'Shyam workflows' : w.repo.endsWith('EPIVIFE') ? 'Site workflows' : 'EpiFive workflows';
    try {
      const j = await http(`https://api.github.com/repos/${w.repo}/actions/workflows/${w.file}/runs?per_page=1&exclude_pull_requests=true`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'epifive-control', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }, 'GitHub');
      const run = j.workflow_runs?.[0];
      const h = runHealth(run, NOW, w.maxH);
      // Only links to the public repos' runs: the site repo is private.
      return { group, name: w.name, ...h, at: run?.created_at ?? null, url: run && !w.repo.endsWith('EPIVIFE') ? run.html_url : null };
    } catch (e) {
      const why = e.status === 403 || e.status === 404 ? (w.token ? `${w.token} ko "Actions: read" chahiye` : 'workflow nahi mila') : clean(e.message);
      return { group, name: w.name, state: w.file === 'ai-task.yml' && e.status === 404 ? 'info' : 'warn', text: `status nahi mila: ${why}` };
    }
  }));
}

async function metaCheck(prefix) {
  const t = env[`${prefix}PAGE_TOKEN`];
  if (!t) return { state: 'info', text: `${prefix}PAGE_TOKEN set nahi` };
  try {
    const j = await http(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(t)}&access_token=${encodeURIComponent(t)}`, {}, 'Meta');
    return metaTokenHealth(j.data, NOW);
  } catch (e) {
    return { state: e.status === 400 || e.status === 401 || e.status === 190 ? 'bad' : 'warn', text: clean(e.message.replace(/access_token=\S+/g, '')) };
  }
}

async function health() {
  const items = await workflowItems();
  const tok = (name, c) => items.push({ group: 'Tokens', name, ...(c || { state: 'info', text: 'performance ke saath check hota hai' }) });
  tok('Cloudflare analytics (CF_API_TOKEN)', checks.cf);
  tok('YouTube EpiFive refresh token', checks.yt_epifive);
  tok('YouTube Shyam refresh token', checks.yt_shyam);
  tok('Resend (newsletter + emails)', checks.resend);
  if (env.GSC_REFRESH_TOKEN) {
    try { await googleToken('GSC_'); tok('Search Console refresh token', { state: 'good', text: 'OK' }); } catch (e) { tok('Search Console refresh token', { state: 'bad', text: clean(e.message) }); }
  } else tok('Search Console refresh token', { state: 'info', text: 'GSC_* secrets set nahi' });
  tok('Meta EpiFive page token', await metaCheck('META_'));
  tok('Meta Shyam page token', await metaCheck('SHYAM_META_'));
  tok('LinkedIn Page token', expiryHealth(env.LINKEDIN_PAGE_TOKEN_EXPIRES, NOW));
  tok('LinkedIn member token', expiryHealth(env.LINKEDIN_MEMBER_TOKEN_EXPIRES, NOW));
  items.push({ group: 'Tokens', name: 'Gmail / Zoho (outreach)', state: 'info', text: 'Site repo ke secrets: "Outreach" workflow ka last run dekho (upar).' });
  return { generated_at: new Date(NOW).toISOString(), items };
}

// ---------------------------------------------------------------- content, social, shyam
function content() {
  if (!SITE_DIR) throw new Error('site checkout missing (--site)');
  const backlog = readFile(SITE_DIR, 'automation/backlog.md');
  const log = readFile(SITE_DIR, 'automation/log.md');
  if (backlog === null || log === null) throw new Error('site automation files not found');
  return { generated_at: new Date(NOW).toISOString(), date: TODAY, today_published: publishedOn(log, TODAY), backlog: parseBacklog(backlog, 10) };
}

function social() {
  if (!SITE_DIR) throw new Error('site checkout missing (--site)');
  const text = readFile(SITE_DIR, 'automation/social-log.md');
  if (text === null) throw new Error('social-log.md not found');
  return { generated_at: new Date(NOW).toISOString(), ...socialSummary(parseSocialLog(text), TODAY) };
}

function shyam() {
  if (!SHYAM_DIR) throw new Error('Shyam checkout missing (--shyam)');
  const cal = readFile(SHYAM_DIR, 'automation/calendar.md') || '';
  let plan = null;
  try { plan = JSON.parse(readFile(SHYAM_DIR, 'automation/owner-footage.json') || 'null'); } catch { /* none */ }
  const footage = plan ? footageQueue(plan, { skip: readFile(SHYAM_DIR, 'automation/owner-footage-skip.txt') || '', log: readFile(SHYAM_DIR, 'automation/log.md') || '', today: TODAY }) : null;
  let inbox = { present: false };
  try {
    const cfg = JSON.parse(readFile(SHYAM_DIR, 'automation/inbox.json') || 'null');
    if (cfg) inbox = { present: true, text: `Email se darshan photos/videos: subject "${String(cfg.subject_word || 'Shyam').slice(0, 20)} ..." se shuru karo` };
  } catch { /* not set up yet */ }
  return { generated_at: new Date(NOW).toISOString(), festivals: upcomingFestivals(cal, TODAY, 8), footage, inbox };
}

// ---------------------------------------------------------------- main
const BUILDERS = { performance, health, content, social, shyam };

async function post(key, data) {
  const base = (env.CRM_URL || 'https://epifive-crm.pages.dev').replace(/\/$/, '');
  const res = await fetch(`${base}/api/ingest/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': env.INGEST_TOKEN },
    body: JSON.stringify({ key, data, run_url: RUN_URL }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`CRM HTTP ${res.status}`);
}

async function main() {
  const out = {};
  let failed = 0;
  let notDeployed = 0;
  // performance first: health reuses its token checks.
  for (const key of ['performance', 'health', 'content', 'social', 'shyam'].filter((k) => ONLY.includes(k))) {
    try {
      out[key] = await BUILDERS[key]();
      if (!DRY) await post(key, out[key]);
      console.log(`${key}: ok${DRY ? ' (dry run, not sent)' : ''}`);
    } catch (e) {
      failed++;
      if (/CRM HTTP 404/.test(e.message)) notDeployed++;
      console.log(`${key}: failed (${clean(e.message)})`);
    }
  }
  const outFile = arg('out', '');
  if (outFile && !env.GITHUB_ACTIONS) fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  // The CRM answers 404 until its Control Center is deployed: not a failure of this job.
  if (notDeployed && notDeployed === failed) { console.log('::notice::CRM Control Center is not deployed yet (HTTP 404): nothing sent.'); return; }
  if (failed === ONLY.length) process.exit(1);
}

await main();
