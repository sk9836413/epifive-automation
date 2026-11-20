#!/usr/bin/env node
// Owner's daily performance email ("aaj ka performance batao"), ~20:00 IST from .github/workflows/report.yml.
// Sections: website (Cloudflare Web Analytics RUM), today's articles (site repo log), YouTube x2, Facebook/Instagram x2,
// leads and outreach (CRM), tomorrow's plan, and one "aaj ki seekh" line. Every section is fail-soft: a source that
// fails shows "data nahi mila" and the email still goes. EpiFive and Shyam Premi stay in separate sections; this email
// is private to the owner and never published anywhere.
//
//   node report/report.mjs [--dry-run] [--date YYYY-MM-DD] [--force]
//
// THIS REPO IS PUBLIC: the log shows only "<section>: <status>" lines and counts. A dry run prints the email text; in
// GitHub Actions the private lines (lead names, deals) are masked. Never print secrets, emails or raw API responses.
//
// Environment (each source is skipped without its credentials):
//   CF_API_TOKEN (Account Analytics: Read), CF_ACCOUNT_ID                 -> website
//   SITE_REPO_TOKEN                                                        -> articles, GTA/backlog plan (private site repo)
//   YT_CLIENT_ID/SECRET/REFRESH_TOKEN, SHYAM_YT_CLIENT_ID/SECRET/REFRESH_TOKEN -> YouTube
//   META_PAGE_ID, META_PAGE_TOKEN, IG_USER_ID; SHYAM_META_PAGE_ID, SHYAM_META_PAGE_TOKEN, SHYAM_IG_USER_ID -> Meta
//   CRM_URL, INGEST_TOKEN                                                  -> leads and outreach
//   SHYAM_DIR (sparse checkout of sk9836413/shyam-premi-sn)                -> Shyam's plan for tomorrow
//   LINKEDIN_PAGE_TOKEN_EXPIRES, LINKEDIN_MEMBER_TOKEN_EXPIRES (repo variables) -> section 0 warning 7 days before
//   RESEND_API_KEY, REPORT_FROM, REPORT_TO, REPORT_BCC                     -> sending
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BOT_COUNTRIES, SOURCES, addDays, articlesOn, bucketSources, clean, dayLabel, delta, failedSection, fmt, istDate,
  istDayBounds, istTime, linkedinTokenNotes, missedTrendsLines, nextDatedBacklog, parseDayPlanLine, pct, previousSnapshot, pruneSnapshot, renderHtml, renderText, seekh, short,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAP_FILE = path.join(HERE, 'snapshot.json');
const args = process.argv.slice(2);
const arg = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const env = process.env;
const NOW = new Date();
const DATE = arg('date', env.REPORT_DATE || '') || istDate(NOW);
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) throw new Error('Bad --date');
const YDAY = addDays(DATE, -1);
const TOMORROW = addDays(DATE, 1);
const TIMEOUT = 30_000;
const SITE = 'https://www.epifive.com';
const CRM_PUBLIC = 'https://crm.epifive.com';
const log = [];

async function http(url, opts = {}, what = 'request', attempt = 1) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status >= 500 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return http(url, opts, what, attempt + 1);
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = body?.error;
    const reason = (typeof e === 'string' ? e : e?.message) || body?.message || '';
    const err = new Error(`${what} HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body ?? text;
}

const ghRaw = (repo, file, token) => http(`https://api.github.com/repos/${repo}/contents/${file}`, {
  headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'epifive-daily-report', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}, 'GitHub');

async function googleToken(prefix) {
  const j = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: env[`${prefix}CLIENT_ID`], client_secret: env[`${prefix}CLIENT_SECRET`], refresh_token: env[`${prefix}REFRESH_TOKEN`], grant_type: 'refresh_token' }),
  }, 'Google token');
  return j.access_token;
}

// ---------------------------------------------------------------- 1. website
const regionName = new Intl.DisplayNames(['en'], { type: 'region' });
const website = { seekh: [] };

async function websiteSection() {
  const title = '1. Website (www.epifive.com)';
  if (!env.CF_API_TOKEN) {
    return { title, items: [{ text: 'Website numbers unavailable: repo secret CF_API_TOKEN (Cloudflare "Account Analytics: Read") set nahi hai.' }, { text: 'Owner step: gh secret set CF_API_TOKEN -R sk9836413/epifive-automation' }] };
  }
  const account = env.CF_ACCOUNT_ID || 'cc7da560c73a0539ed32313476555d4a';
  const hosts = JSON.stringify((env.CF_HOSTS || 'www.epifive.com,epifive.com').split(',').map((h) => h.trim()));
  const day = istDayBounds(DATE);
  const yday = istDayBounds(YDAY);
  const nowIso = new Date(Math.min(NOW.getTime(), Date.parse(day.to))).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ySame = new Date(Date.parse(nowIso) - 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const g = (alias, from, to, dims, extra = '') => `${alias}: rumPageloadEventsAdaptiveGroups(limit:${dims === 'refererHost' ? 2000 : 300}${extra},filter:{datetime_geq:"${from}",datetime_lt:"${to}",requestHost_in:${hosts}}){count sum{visits} dimensions{${dims}}}`;
  const query = `{viewer{accounts(filter:{accountTag:"${account}"}){${[
    g('tRef', day.from, nowIso, 'refererHost'),
    g('tPath', day.from, nowIso, 'requestPath', ',orderBy:[count_DESC]'),
    g('tCountry', day.from, nowIso, 'countryName', ',orderBy:[sum_visits_DESC]'),
    g('yRef', yday.from, yday.to, 'refererHost'),
    g('ySame', yday.from, ySame, 'refererHost'),
  ].join(' ')}}}}`;
  const j = await http('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  }, 'Cloudflare');
  if (j.errors?.length) throw new Error(`Cloudflare: ${clean(j.errors[0].message)}`);
  const a = j.data.viewer.accounts[0];
  const total = (rows) => rows.reduce((s, r) => ({ visits: s.visits + (r.sum?.visits || 0), views: s.views + (r.count || 0) }), { visits: 0, views: 0 });
  const refRows = (rows) => rows.map((r) => ({ host: r.dimensions.refererHost || '', visits: r.sum?.visits || 0 }));
  const t = total(a.tRef);
  const y = total(a.yRef);
  const ys = total(a.ySame);
  const src = bucketSources(refRows(a.tRef));
  const srcY = bucketSources(refRows(a.yRef));
  const srcSame = bucketSources(refRows(a.ySame));
  const items = [
    { text: `Aaj (${dayLabel(DATE)}, ${istTime(new Date(nowIso))} IST tak): ${fmt(t.visits)} visits, ${fmt(t.views)} page views` },
    { text: `Kal (${dayLabel(YDAY)}) final: ${fmt(y.visits)} visits, ${fmt(y.views)} page views` },
    { text: `Kal isi samay tak: ${fmt(ys.visits)} visits -> aaj ${pct(t.visits, ys.visits) || '0%'} (${delta(t.visits, ys.visits)})` },
    { heading: 'Visits by source (aaj / kal final)' },
  ];
  for (const s of SOURCES) {
    if (!src.by[s] && !srcY.by[s]) continue;
    items.push({ text: `${s}: ${fmt(src.by[s])} / ${fmt(srcY.by[s])}${s === 'Others' && src.others.length ? ` (${src.others.map(([h, v]) => `${h} ${v}`).join(', ')})` : ''}` });
  }
  const pages = new Map();
  for (const r of a.tPath) {
    const p = r.dimensions.requestPath || '/';
    pages.set(p, (pages.get(p) || 0) + (r.count || 0));
  }
  items.push({ heading: 'Top 5 pages (page views aaj)' });
  for (const [p, n] of [...pages.entries()].sort((x, z) => z[1] - x[1]).slice(0, 5)) items.push({ text: `${n}  ${p}`, href: `${SITE}${p}` });
  const countries = new Map();
  for (const r of a.tCountry) {
    const c = r.dimensions.countryName || '??';
    countries.set(c, (countries.get(c) || 0) + (r.sum?.visits || 0));
  }
  items.push({ heading: 'Visitors by country (visits aaj)' });
  const top = [...countries.entries()].filter(([, v]) => v > 0).sort((x, z) => z[1] - x[1]);
  for (const [c, v] of top.slice(0, 7)) {
    let name = c;
    try { name = regionName.of(c) || c; } catch { /* keep code */ }
    items.push({ text: `${name}: ${v}${BOT_COUNTRIES.has(c) ? '  (China: zyada tar bots, ignore karo)' : ''}` });
  }
  if (top.length > 7) items.push({ text: `+${top.length - 7} aur countries: ${top.slice(7).reduce((s, [, v]) => s + v, 0)} visits` });
  website.seekh = [{ label: 'Website visits', now: t.visits, before: ys.visits }, ...SOURCES.filter((s) => s !== 'Others').map((s) => ({ label: s, now: src.by[s], before: srcSame.by[s] }))];
  website.counts = { visits: t.visits, views: t.views };
  log.push(`website: ok (${a.tRef.length + a.tPath.length + a.tCountry.length} rows)`);
  return { title, items };
}

// ---------------------------------------------------------------- 2. articles
const site = {};
async function articlesSection() {
  const title = '2. Aaj ke articles (www.epifive.com)';
  if (!env.SITE_REPO_TOKEN) return failedSection(title, 'SITE_REPO_TOKEN nahi hai');
  const text = await ghRaw('sk9836413/EPIVIFE', 'automation/log.md', env.SITE_REPO_TOKEN);
  const rows = articlesOn(text, DATE);
  site.articles = rows.length;
  log.push(`articles: ok (${rows.length})`);
  if (!rows.length) return { title, items: [{ text: 'Aaj abhi tak koi article publish nahi hua (log.md me aaj ki line nahi).' }, ...radarMissedTrends()] };
  const items = [{ text: `${rows.length} article(s) aaj: ${rows.filter((r) => r.status === 'published').length} daily, ${rows.filter((r) => r.status.startsWith('fast-track')).length} fast-track` }];
  await Promise.all(rows.map(async (r) => {
    try {
      const md = await ghRaw('sk9836413/EPIVIFE', `content/posts/${r.slug}.md`, env.SITE_REPO_TOKEN);
      const m = String(md).match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
      r.title = m ? m[1].replace(/''/g, "'") : r.slug;
    } catch { r.title = r.slug; }
  }));
  for (const r of rows) items.push({ text: `${r.title}${r.status === 'published' ? '' : ` [${r.status}]`}`, href: `${SITE}/blog/${r.slug}` });
  items.push(...radarMissedTrends());
  return { title, items };
}

// The radar's once-a-day missed-trends check (this repo's radar/state.json; public data, headlines and links only).
function radarMissedTrends() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'radar', 'state.json'), 'utf8'));
    return [{ heading: 'Trending topics jo chhoot sakte the' }, ...missedTrendsLines(state, DATE)];
  } catch (e) {
    return [{ heading: 'Trending topics jo chhoot sakte the' }, { text: `radar state: data nahi mila (${clean(e.message)})` }];
  }
}

// ---------------------------------------------------------------- 3. YouTube
const snapNow = {};
async function youtubeSection(name, prefix, key, prev) {
  const title = `3. YouTube: ${name}`;
  if (!env[`${prefix}REFRESH_TOKEN`]) return failedSection(title, `${prefix}* secrets nahi hain`);
  const token = await googleToken(prefix);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const yt = (p) => http(`https://www.googleapis.com/youtube/v3/${p}`, auth, 'YouTube');
  const ch = (await yt('channels?part=snippet,statistics,contentDetails&mine=true')).items?.[0];
  if (!ch) throw new Error('no channel on this account');
  const subs = Number(ch.statistics.subscriberCount || 0);
  const views = Number(ch.statistics.viewCount || 0);
  const videos = Number(ch.statistics.videoCount || 0);
  snapNow[key] = { subs, views, videos };
  const before = prev?.data?.[key];
  const vs = before ? ` (${prev.date === YDAY ? 'kal se' : `${dayLabel(prev.date)} se`}: subs ${delta(subs, before.subs)}, views ${delta(views, before.views)})` : ' (kal ka snapshot nahi: kal se change dikhega)';
  const items = [{ text: `Subscribers ${fmt(subs)}, total views ${fmt(views)}, videos ${fmt(videos)}${vs}` }];

  const pl = await yt(`playlistItems?part=contentDetails&maxResults=50&playlistId=${ch.contentDetails.relatedPlaylists.uploads}`);
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
  const vids = ids.length ? (await yt(`videos?part=snippet,statistics,status&id=${ids.join(',')}`)).items || [] : [];
  const pub = vids.filter((v) => v.status.privacyStatus === 'public');
  const age = (v) => NOW.getTime() - Date.parse(v.snippet.publishedAt);
  const recent = pub.filter((v) => age(v) >= 0 && age(v) < 48 * 3600e3).sort((a, b) => Date.parse(b.snippet.publishedAt) - Date.parse(a.snippet.publishedAt));
  items.push({ heading: `Last 48 h me publish (${recent.length})` });
  if (!recent.length) items.push({ text: 'koi nahi' });
  for (const v of recent.slice(0, 8)) items.push({ text: `${fmt(v.statistics.viewCount)} views, ${fmt(v.statistics.likeCount)} likes - ${short(v.snippet.title)} (${dayLabel(istDate(new Date(v.snippet.publishedAt)))} ${istTime(new Date(v.snippet.publishedAt))})`, href: `https://youtu.be/${v.id}` });
  const week = pub.filter((v) => age(v) < 7 * 864e5).sort((a, b) => Number(b.statistics.viewCount) - Number(a.statistics.viewCount))[0];
  if (week) items.push({ heading: 'Is hafte ka top video (7 din me publish hue)' }, { text: `${fmt(week.statistics.viewCount)} views - ${short(week.snippet.title)}`, href: `https://youtu.be/${week.id}` });
  // Scheduled for tomorrow (private with publishAt on TOMORROW, IST).
  const sched = vids.filter((v) => v.status.privacyStatus !== 'public' && v.status.publishAt && istDate(new Date(v.status.publishAt)) === TOMORROW);
  tomorrowYt[key] = sched.map((v) => `${istTime(new Date(v.status.publishAt))} ${short(v.snippet.title, 60)}`).sort();

  try {
    const q = new URLSearchParams({ ids: 'channel==MINE', startDate: addDays(DATE, -8), endDate: DATE, dimensions: 'day', metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost', sort: 'day' });
    const r = await http(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, auth, 'YouTube Analytics');
    const rows = (r.rows || []).filter((x) => x[1] > 0 || x[2] > 0);
    const last = rows[rows.length - 1];
    const prevRow = rows[rows.length - 2];
    items.push({ heading: 'YouTube Analytics (2-3 din ka lag, isliye purani date)' });
    if (!last) items.push({ text: 'abhi data nahi aaya' });
    else {
      items.push({ text: `${dayLabel(last[0])}: ${fmt(last[1])} views, ${fmt(last[2])} watch minutes, subs +${last[3]}/-${last[4]}${prevRow ? ` (pichhle din ${fmt(prevRow[1])} views, ${fmt(prevRow[2])} min: ${pct(last[1], prevRow[1]) || '0%'})` : ''}` });
    }
  } catch (e) {
    items.push({ heading: 'YouTube Analytics' }, { text: `data nahi mila (${clean(e.message)})` });
  }
  log.push(`youtube ${key}: ok (${recent.length} recent)`);
  return { title, items };
}
const tomorrowYt = {};

// ---------------------------------------------------------------- 4. Facebook + Instagram
async function metaSection(name, prefix, igVar, key, prev) {
  const title = `4. Facebook + Instagram: ${name}`;
  const token = env[`${prefix}PAGE_TOKEN`];
  const pageId = env[`${prefix}PAGE_ID`];
  if (!token || !pageId) {
    return { title, items: [{ text: `skip: ${prefix}PAGE_ID / ${prefix}PAGE_TOKEN${igVar ? ` / ${igVar}` : ''} secrets is repo (epifive-automation) me nahi hain.` }] };
  }
  const V = 'https://graph.facebook.com/v23.0/';
  const g = (p) => http(`${V}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, {}, 'Graph API');
  const before = prev?.data?.[key] || {};
  const snap = (snapNow[key] = {});
  const items = [];
  try {
    const page = await g(`${pageId}?fields=followers_count,fan_count`);
    snap.fb = page.followers_count ?? 0;
    items.push({ heading: `Facebook Page: ${fmt(snap.fb)} followers${before.fb !== undefined ? ` (${delta(snap.fb, before.fb)})` : ''}` });
    const posts = await g(`${pageId}/posts?fields=created_time,message,permalink_url,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares&limit=5`);
    const reels = await g(`${pageId}/video_reels?fields=id,description,created_time,permalink_url&limit=5`).catch(() => ({ data: [] }));
    const plays = new Map();
    await Promise.all((reels.data || []).map(async (r) => {
      try {
        const ins = await g(`${r.id}/video_insights?metric=fb_reels_total_plays`);
        plays.set(r.id, ins.data?.[0]?.values?.[0]?.value);
      } catch { /* no plays */ }
    }));
    // A Reel's post id is "<page>_<post>", not the video id: match on the caption instead.
    const reelByText = new Map((reels.data || []).map((r) => [short(r.description, 40), r.id]));
    for (const p of posts.data || []) {
      const rid = reelByText.get(short(p.message, 40));
      const pl = rid && plays.has(rid) ? `, ${fmt(plays.get(rid))} plays` : '';
      items.push({ text: `${dayLabel(istDate(new Date(p.created_time)))}: ${fmt(p.reactions?.summary?.total_count ?? 0)} likes, ${fmt(p.comments?.summary?.total_count ?? 0)} comments, ${fmt(p.shares?.count ?? 0)} shares${pl} - ${short(p.message, 60)}`, href: p.permalink_url });
    }
    if (!(posts.data || []).length) items.push({ text: 'koi post nahi mili' });
  } catch (e) {
    items.push({ heading: 'Facebook' }, { text: `data nahi mila (${clean(e.message)})` });
  }
  if (env[igVar]) {
    try {
      const ig = await g(`${env[igVar]}?fields=followers_count,media_count`);
      snap.ig = ig.followers_count ?? 0;
      items.push({ heading: `Instagram: ${fmt(snap.ig)} followers${before.ig !== undefined ? ` (${delta(snap.ig, before.ig)})` : ''}, ${fmt(ig.media_count)} posts` });
      let insightsErr = '';
      const media = await g(`${env[igVar]}/media?fields=id,timestamp,caption,like_count,comments_count,media_product_type,permalink&limit=5`);
      for (const m of media.data || []) {
        let views = '';
        try {
          const ins = await g(`${m.id}/insights?metric=views`);
          const v = ins.data?.[0]?.values?.[0]?.value ?? ins.data?.[0]?.total_value?.value;
          if (v !== undefined) views = `, ${fmt(v)} ${m.media_product_type === 'REELS' ? 'plays' : 'views'}`;
        } catch (e) {
          // Insights not available for this media; log the reason once (cleaned, no ids or tokens).
          if (!insightsErr) { insightsErr = clean(e.message); log.push(`meta ${key} ig insights: ${insightsErr}`); }
        }
        items.push({ text: `${dayLabel(istDate(new Date(m.timestamp)))} ${m.media_product_type === 'REELS' ? 'Reel' : 'Post'}: ${fmt(m.like_count)} likes, ${fmt(m.comments_count)} comments${views} - ${short(m.caption, 60)}`, href: m.permalink });
      }
      if (insightsErr) items.push({ text: `IG plays/views nahi mile: ${/permission/i.test(insightsErr) ? 'token me instagram_manage_insights permission nahi hai' : insightsErr}` });
    } catch (e) {
      items.push({ heading: 'Instagram' }, { text: `data nahi mila (${clean(e.message)})` });
    }
  } else items.push({ heading: 'Instagram' }, { text: `skip: ${igVar} secret nahi hai` });
  log.push(`meta ${key}: ${snap.fb !== undefined ? 'ok' : 'partial'}`);
  return { title, items };
}

// ---------------------------------------------------------------- 5. leads and outreach
const leadsCounts = {};
async function leadsSection() {
  const title = '5. Leads aur outreach (EpiFive)';
  if (!env.CRM_URL || !env.INGEST_TOKEN) return failedSection(title, 'CRM_URL / INGEST_TOKEN nahi hai');
  const base = env.CRM_URL.replace(/\/$/, '');
  const h = { headers: { 'X-Ingest-Token': env.INGEST_TOKEN } };
  const items = [];
  let r = null;
  try {
    r = await http(`${base}/api/ingest/report?date=${DATE}`, h, 'CRM report');
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (r && typeof r === 'object') {
    const o = r.outreach || {};
    leadsCounts.leads = r.new_leads.length;
    leadsCounts.sent = (o.sent || 0) + (o['follow-up'] || 0);
    items.push({ heading: `Naye leads aaj: ${r.new_leads.length}` });
    for (const l of r.new_leads) items.push({ text: `#${l.id} ${l.name}${l.company ? ` (${l.company})` : ''} - ${l.service || 'service ?'}, ${l.source}, stage ${l.stage}`, private: true, href: `${CRM_PUBLIC}/#/leads/${l.id}` });
    items.push({ heading: `Open deals (${r.open_deals.length})` });
    if (!r.open_deals.length) items.push({ text: 'koi nahi' });
    for (const d of r.open_deals.slice(0, 10)) items.push({ text: `${d.company || d.name}: ${d.stage}${d.value ? `, USD ${fmt(d.value)}` : ''}${d.next_follow_up ? `, follow-up ${d.next_follow_up}${d.next_follow_up < DATE ? ' (OVERDUE)' : ''}` : ''}`, private: true, href: `${CRM_PUBLIC}/#/leads/${d.id}` });
    items.push({ heading: 'Outreach aaj (cold email)' });
    items.push({ text: `Sent ${o.sent || 0} naye + ${o['follow-up'] || 0} follow-ups; replies ${o.reply || 0}, interested ${o.interested || 0}, bounces ${o.bounce || 0}, opt-outs ${o['opt-out'] || 0}${o.complaint ? `, COMPLAINTS ${o.complaint}` : ''}` });
    items.push({ heading: 'Daily 50 list' }, { text: `${r.daily50?.rows ?? 0} rows aaj ki list me`, href: `${CRM_PUBLIC}/#/daily` });
  } else {
    // Older CRM without /api/ingest/report: outreach volume only.
    const since = istDayBounds(DATE).from;
    const s = await http(`${base}/api/ingest/outreach?since=${encodeURIComponent(since)}`, h, 'CRM outreach');
    leadsCounts.sent = s.stats?.sent_since ?? 0;
    items.push({ text: 'Naye leads / open deals: CRM ka /api/ingest/report abhi deploy nahi hua (owner step neeche).' });
    items.push({ heading: 'Outreach aaj (cold email)' });
    items.push({ text: `Sent (naye + follow-ups) ${s.stats?.sent_since ?? 0}; last 30 din: ${s.stats?.sent_30d ?? 0} sent, ${s.stats?.bounces_30d ?? 0} bounces, complaints ${s.stats?.complaints ?? 0}${s.paused ? '; OUTREACH PAUSED' : ''}` });
    const replied = (s.open || []).filter((l) => l.replies > 0).length;
    items.push({ text: `Open threads with a reply (60 din): ${replied}` });
    items.push({ heading: 'Daily 50 list' }, { text: 'CRM me dekho', href: `${CRM_PUBLIC}/#/daily` });
  }
  log.push(`leads: ok (${leadsCounts.leads ?? '-'} new, ${leadsCounts.sent ?? 0} sent)`);
  return { title, items };
}

// ---------------------------------------------------------------- 6. tomorrow
async function tomorrowSection() {
  const title = `6. Kal (${dayLabel(TOMORROW)}) ka plan`;
  const items = [{ heading: 'EpiFive' }];
  if (env.SITE_REPO_TOKEN) {
    try {
      const backlog = await ghRaw('sk9836413/EPIVIFE', 'automation/backlog.md', env.SITE_REPO_TOKEN);
      const next = nextDatedBacklog(backlog, TOMORROW);
      items.push(next ? { text: `Series article (dated backlog): ${next.title}` } : { text: 'Koi dated series item nahi (GTA series khatam ya sab likh diye).' });
    } catch (e) {
      items.push({ text: `backlog: data nahi mila (${clean(e.message)})` });
    }
  }
  if (tomorrowYt.yt_epifive?.length) items.push({ text: `YouTube scheduled: ${tomorrowYt.yt_epifive.join('; ')}` });
  items.push({ heading: 'Shyam Premi SN' });
  const dir = env.SHYAM_DIR;
  if (dir && fs.existsSync(path.join(dir, 'scripts/day-plan.mjs'))) {
    try {
      const out = execFileSync(process.execPath, ['scripts/day-plan.mjs', '--days', '1', '--from', TOMORROW], { cwd: dir, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split('\n').find((l) => l.startsWith(TOMORROW)) || '';
      const p = parseDayPlanLine(line);
      if (p) {
        items.push({ text: `Plan (${p.kind} day, approx): ${p.plan}` });
        if (p.festival) items.push({ text: `Festival: ${p.festival}` });
      } else items.push({ text: 'day-plan ne kuch nahi bataya' });
    } catch (e) {
      items.push({ text: `day-plan: data nahi mila (${clean(e.message)})` });
    }
  } else items.push({ text: 'day-plan checkout nahi mila (skip)' });
  if (tomorrowYt.yt_shyam?.length) items.push({ text: `YouTube scheduled (${tomorrowYt.yt_shyam.length}): ${tomorrowYt.yt_shyam.join('; ')}` });
  log.push('tomorrow: ok');
  return { title, items };
}

// ---------------------------------------------------------------- main
async function safe(title, fn) {
  try {
    return await fn();
  } catch (e) {
    log.push(`${title.replace(/^\d+[a-z]?\.\s*/, '').toLowerCase()}: failed`);
    return failedSection(title, clean(e.message));
  }
}

async function main() {
  let snap = { days: {} };
  try { snap = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')); } catch { /* first run */ }
  if (!DRY && !FORCE && snap.sent === DATE) {
    console.log(`Report for ${DATE} already sent: nothing to do (use force to send again).`);
    return;
  }
  const prev = previousSnapshot(snap, DATE);
  const sections = [];
  sections.push(await safe('1. Website (www.epifive.com)', websiteSection));
  sections.push(await safe('2. Aaj ke articles (www.epifive.com)', articlesSection));
  sections.push(await safe('3. YouTube: EpiFive', () => youtubeSection('EpiFive', 'YT_', 'yt_epifive', prev)));
  sections.push(await safe('3. YouTube: Shyam Premi SN', () => youtubeSection('Shyam Premi SN', 'SHYAM_YT_', 'yt_shyam', prev)));
  sections.push(await safe('4. Facebook + Instagram: EpiFive', () => metaSection('EpiFive', 'META_', 'IG_USER_ID', 'meta_epifive', prev)));
  sections.push(await safe('4. Facebook + Instagram: Shyam Premi SN', () => metaSection('Shyam Premi SN', 'SHYAM_META_', 'SHYAM_IG_USER_ID', 'meta_shyam', prev)));
  sections.push(await safe('5. Leads aur outreach (EpiFive)', leadsSection));
  sections.push(await safe(`6. Kal (${dayLabel(TOMORROW)}) ka plan`, tomorrowSection));

  // 7. one line: today vs yesterday (website at the same time, else YouTube subscribers).
  let line = seekh(website.seekh);
  if (!line) {
    const yt = ['yt_epifive', 'yt_shyam'].map((k) => ({ k, now: snapNow[k]?.views, before: prev?.data?.[k]?.views })).filter((x) => x.now !== undefined && x.before !== undefined);
    const best = yt.sort((a, b) => (b.now - b.before) - (a.now - a.before))[0];
    if (best) line = `${best.k === 'yt_shyam' ? 'Shyam' : 'EpiFive'} YouTube views ${delta(best.now, best.before)} kal se. Jo video upar hai uska format kal repeat karo.`;
  }
  sections.push({ title: '7. Aaj ki 1 seekh', items: [{ text: line || 'Compare karne layak data nahi mila (website token / kal ka snapshot chahiye).' }] });
  // 0. LinkedIn API tokens (60 days): re-login reminder on top, 7 days before the expiry.
  const tokenNotes = linkedinTokenNotes(env, NOW);
  if (tokenNotes.length) {
    sections.unshift({ title: '0. Zaroori: LinkedIn token renew karo', items: tokenNotes.map((text) => ({ text })) });
    log.push(`linkedin tokens: ${tokenNotes.length} warning(s)`);
  }

  const owner = [];
  if (!env.CF_API_TOKEN) owner.push('CF_API_TOKEN secret (website numbers)');
  if (!env.SHYAM_META_PAGE_TOKEN) owner.push('SHYAM_META_* + SHYAM_IG_USER_ID secrets (Shyam FB/IG)');
  const report = {
    title: `EpiFive daily report - ${dayLabel(DATE)} ${DATE.slice(0, 4)}`,
    intro: `Aaj ka performance, ${istTime(NOW)} IST tak. Har section alag source se hai; jo source fail hua wahan "data nahi mila" likha hai.`,
    sections,
    footer: `Auto report (epifive-automation report.yml). Private: sirf owner ke liye.${owner.length ? ` Pending owner steps: ${owner.join('; ')}.` : ''}`,
  };
  const subject = `Aaj ka performance ${dayLabel(DATE)}: ${website.counts ? `${fmt(website.counts.visits)} visits, ` : ''}${site.articles ?? '?'} articles${leadsCounts.leads !== undefined ? `, ${leadsCounts.leads} leads` : ''}${leadsCounts.sent !== undefined ? `, ${leadsCounts.sent} outreach` : ''}`;
  const text = renderText(report);
  const html = renderHtml(report);
  for (const l of log) console.log(l);

  if (DRY) {
    console.log('\n----- DRY RUN: email not sent -----');
    console.log(`Subject: ${subject}\n`);
    console.log(renderText(report, { redact: Boolean(env.GITHUB_ACTIONS) }));
    return;
  }
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `epifive-daily-report-${DATE}${FORCE ? `-${Date.now()}` : ''}` },
    body: JSON.stringify({
      from: env.REPORT_FROM || 'EpiFive Report <hello@epifive.com>',
      to: (env.REPORT_TO || 'info@epifive.com').split(',').map((s) => s.trim()),
      ...(env.REPORT_BCC ? { bcc: env.REPORT_BCC.split(',').map((s) => s.trim()) } : {}),
      subject,
      html,
      text,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  console.log(`Resend: HTTP ${res.status}`);
  if (!res.ok) process.exit(1);
  snap.sent = DATE;
  snap.days = { ...(snap.days || {}), [DATE]: { ...(snap.days?.[DATE] || {}), ...snapNow } };
  fs.writeFileSync(SNAP_FILE, `${JSON.stringify(pruneSnapshot(snap), null, 1)}\n`);
}

await main();
