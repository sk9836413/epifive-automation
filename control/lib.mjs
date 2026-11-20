// Pure helpers for the CRM Control Center snapshot (control/snapshot.mjs). No I/O here, so the tests can cover them.
import { addDays } from '../report/lib.mjs';

/** Unchecked backlog items in file order with the "## ..." section they sit under. */
export function parseBacklog(text, n = 10) {
  let section = '';
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const hd = line.match(/^##\s+(.+?)\s*$/);
    if (hd) { section = hd[1].replace(/\s*\(.*$/, '').trim(); continue; }
    const m = line.match(/^- \[ \] ([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|.*)?$/);
    if (m) items.push({ section: section.slice(0, 80), slug: m[1].trim().slice(0, 120), title: m[2].trim().slice(0, 200), topic: m[3].trim().slice(0, 60) });
  }
  return { unchecked: items.length, top: items.slice(0, n) };
}

/** automation/log.md lines of one IST date: `YYYY-MM-DD | slug | published | note`. */
export function publishedOn(text, date) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}) \| ([^|]+?) \| published \|\s*(.*)$/);
    if (m && m[1] === date) out.push({ slug: m[2].trim(), note: m[3].trim().slice(0, 80) });
  }
  return out;
}

export const PLATFORMS = { fb: 'Facebook post', 'fb-reel': 'Facebook Reel', ig: 'Instagram', yt: 'YouTube Short', linkedin: 'LinkedIn' };

/** One social-log value -> {state, url, text}. */
export function platformValue(v) {
  const s = String(v || '').trim();
  const url = s.match(/https:\/\/\S+/)?.[0]?.replace(/[),.]+$/, '') ?? null;
  if (/^(?:make )?error\b/i.test(s)) return { state: 'error', url: null, text: s.replace(/https:\/\/\S+/g, '<url>').slice(0, 160) };
  if (/^skipped\b/i.test(s)) return { state: 'skipped', url: null, text: s.slice(0, 80) };
  if (/^queued\b/i.test(s)) return { state: 'queued', url: null, text: s.slice(0, 80) };
  if (url && s.startsWith('http')) return { state: /\(scheduled /.test(s) ? 'scheduled' : 'ok', url, text: s.slice(0, 160) };
  return { state: 'info', url, text: s.slice(0, 120) };
}

/** automation/social-log.md entries `- date | slug | fb: ... | ig: ...` (newest last in the file). */
export function parseSocialLog(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2}) \| ([a-z0-9][a-z0-9-]*) \| (.*)$/);
    if (!m) continue;
    const fields = {};
    for (const part of m[3].split(/ \| (?=[a-z][a-z-]*: )/)) {
      const k = part.match(/^([a-z][a-z-]*): (.*)$/);
      if (k) fields[k[1]] = platformValue(k[2]);
    }
    out.push({ date: m[1], slug: m[2], fields });
  }
  return out;
}

/** Per-platform state from the last `window` entries: last OK post, errors in 7 days, state of the newest entry. */
export function socialSummary(entries, today, window = 10) {
  const last = entries.slice(-window);
  const since = addDays(today, -7);
  const per = {};
  for (const [k, label] of Object.entries(PLATFORMS)) {
    const seen = last.filter((e) => e.fields[k]);
    const okRows = seen.filter((e) => ['ok', 'scheduled'].includes(e.fields[k].state));
    const newest = seen[seen.length - 1];
    const lastOk = okRows[okRows.length - 1];
    const errs = seen.filter((e) => e.fields[k].state === 'error' && e.date >= since);
    const st = newest?.fields[k].state;
    per[k] = {
      label,
      state: !newest ? 'info' : st === 'error' ? 'bad' : st === 'ok' || st === 'scheduled' ? 'good' : 'warn',
      last_ok_date: lastOk?.date ?? null,
      last_url: lastOk?.fields[k].url ?? null,
      errors_7d: errs.length,
      last_error: st === 'error' ? newest.fields[k].text : null,
    };
  }
  const igFailures = last.filter((e) => e.date >= since && e.fields.ig?.state === 'error').map((e) => ({ date: e.date, slug: e.slug, error: e.fields.ig.text }));
  return { per_platform: per, ig_failures: igFailures, last: last.slice(-5).reverse().map((e) => ({ date: e.date, slug: e.slug })) };
}

/** Next festival rows of Shyam's automation/calendar.md (`| YYYY-MM-DD | text |`), from `today`. */
export function upcomingFestivals(text, today, n = 8) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\| (\d{4}-\d{2}-\d{2}) \| (.+?) \|\s*$/);
    if (!m || m[1] < today) continue;
    const body = m[2].replace(/\s*Sources:.*$/, '').trim();
    const status = body.match(/\(((?:BIG, )?(?:status Shorts|no status Short)[^)]*)\)/)?.[1] ?? '';
    const name = body.replace(/\s*\((?:BIG, )?(?:status Shorts|no status Short)[^)]*\)/, '').split(';')[0].trim();
    out.push({ date: m[1], name: name.slice(0, 120), status: status.slice(0, 200) });
    if (out.length >= n) break;
  }
  return out;
}

/** Owner-footage lane: which clips are posted (log lines `| owner | <day>-owner-<name>`), skipped, and the queue. */
export function footageQueue(plan, { skip = '', log = '', today }) {
  const clips = Array.isArray(plan?.clips) ? plan.clips : [];
  const skipped = String(skip).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const posted = clips.filter((c) => new RegExp(`\\| owner \\| \\d{4}-\\d{2}-\\d{2}-owner-${c.name.replace(/[^a-z0-9-]/g, '')}\\b`).test(log)).map((c) => c.id);
  const postedToday = new RegExp(`^${today} \\| owner \\|`, 'm').test(log);
  let day = plan?.start && plan.start > today ? plan.start : postedToday ? addDays(today, 1) : today;
  const queue = [];
  for (const c of clips) {
    if (posted.includes(c.id) || skipped.includes(c.id)) continue;
    queue.push({ id: c.id, name: c.name, day });
    day = addDays(day, 1);
  }
  return { start: plan?.start ?? null, at: plan?.at ?? null, total: clips.length, posted, skipped, queue: queue.slice(0, 10) };
}

/** Health state of a workflow's newest run. maxAgeH: warn when the last run is older (null = no expectation). */
export function runHealth(run, now, maxAgeH) {
  if (!run) return { state: 'warn', text: 'abhi tak koi run nahi' };
  const ageH = (now - Date.parse(run.created_at)) / 3600e3;
  const old = maxAgeH && ageH > maxAgeH;
  if (run.status !== 'completed') return { state: old ? 'warn' : 'good', text: `${run.status.replace('_', ' ')}${old ? ` (${Math.round(ageH)} h se)` : ''}` };
  const c = run.conclusion;
  const state = c === 'success' ? (old ? 'warn' : 'good') : c === 'failure' || c === 'timed_out' || c === 'startup_failure' ? 'bad' : 'warn';
  return { state, text: `${c}${old ? `, last run ${Math.round(ageH)} h pehle` : ''}` };
}

/** LinkedIn token expiry variable (YYYY-MM-DD) -> health item state. */
export function expiryHealth(date, now) {
  if (!date) return { state: 'info', text: 'expiry date set nahi (variable khali)' };
  const days = Math.floor((Date.parse(`${date}T00:00:00Z`) - now) / 864e5);
  if (Number.isNaN(days)) return { state: 'warn', text: `date samajh nahi aayi: ${String(date).slice(0, 20)}` };
  if (days < 0) return { state: 'bad', text: `expire ho gaya (${date}): re-login karo` };
  if (days <= 7) return { state: 'warn', text: `${days} din me expire (${date}): re-login karo` };
  return { state: 'good', text: `valid till ${date} (${days} din)` };
}

/** Meta debug_token data -> health item state. expires_at 0 = never expires. */
export function metaTokenHealth(d, now) {
  if (!d) return { state: 'warn', text: 'check nahi ho paya' };
  if (d.is_valid === false) return { state: 'bad', text: 'token invalid: naya token banao' };
  if (!d.expires_at) return { state: 'good', text: 'valid (no expiry)' };
  const days = Math.floor((d.expires_at * 1000 - now) / 864e5);
  if (days < 0) return { state: 'bad', text: 'expire ho gaya' };
  if (days <= 7) return { state: 'warn', text: `${days} din me expire` };
  return { state: 'good', text: `valid, ${days} din baaki` };
}

/** Sums CF RUM groups: {visits, views, cn, real}. */
export function rumTotals(rows) {
  let visits = 0; let views = 0; let cn = 0;
  for (const r of rows || []) {
    visits += r.sum?.visits || 0;
    views += r.count || 0;
    if (r.dimensions?.countryName === 'CN') cn += r.sum?.visits || 0;
  }
  return { visits, views, cn, real: visits - cn };
}

/** 7-day trend from `date countryName` groups. */
export function rumTrend(rows, dates) {
  return dates.map((date) => ({ date, ...rumTotals((rows || []).filter((r) => r.dimensions?.date === date)) }));
}
