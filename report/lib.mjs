// Pure helpers for the owner's daily performance email (report/report.mjs): IST date math, traffic-source
// classification, number formatting, the "aaj ki 1 seekh" line and the text/HTML rendering. No network, no secrets.

export const IST_MIN = 330; // IST = UTC+05:30

/** IST calendar date (YYYY-MM-DD) of a moment. */
export function istDate(d = new Date()) {
  return new Date(d.getTime() + IST_MIN * 60_000).toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const x = new Date(`${date}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** UTC ISO bounds [from, to) of an IST calendar day: 00:00 IST = 18:30 UTC the day before. */
export function istDayBounds(date) {
  return { from: `${addDays(date, -1)}T18:30:00Z`, to: `${date}T18:30:00Z` };
}

/** "19 Nov" style label of a YYYY-MM-DD date. */
export function dayLabel(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
}

/** HH:MM IST of a moment. */
export function istTime(d = new Date()) {
  return new Date(d.getTime() + IST_MIN * 60_000).toISOString().slice(11, 16);
}

export const fmt = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '-' : Math.round(Number(n)).toLocaleString('en-IN'));

/** Signed difference "+12" / "-3" / "0". */
export function delta(now, before) {
  if (now === null || now === undefined || before === null || before === undefined) return '';
  const d = Math.round(Number(now) - Number(before));
  return d > 0 ? `+${fmt(d)}` : d < 0 ? `-${fmt(-d)}` : '0';
}

/** Percent change "+40%" / "-12%" ("new" when the base is 0, "" when both are 0). */
export function pct(now, before) {
  const a = Number(now) || 0;
  const b = Number(before) || 0;
  if (!a && !b) return '';
  if (!b) return 'new';
  const p = Math.round(((a - b) / b) * 100);
  return p > 0 ? `+${p}%` : `${p}%`;
}

// ---------------------------------------------------------------- website traffic sources
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|claude\.ai|copilot\.microsoft\.com|copilot\.cloud\.microsoft|gemini\.google\.com|bard\.google\.com|you\.com|phind\.com|poe\.com|meta\.ai|chat\.deepseek\.com|deepseek\.com|grok\.com|kagi\.com|chat\.mistral\.ai)$/;
const TEAMS = /(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|teams\.cdn\.office\.net)$/;
const FACEBOOK = /(^|\.)(facebook\.com|fb\.com|fb\.me)$/;
export const SOURCES = ['Direct', 'Google', 'Bing', 'AI (ChatGPT/Perplexity/Claude/Copilot)', 'Facebook', 'Teams', 'Others'];

/** Which report bucket a referrer host belongs to ('' = no referrer). Internal epifive.com hops count as Direct. */
export function classifySource(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!h || h === 'epifive.com' || h.endsWith('.epifive.com')) return 'Direct';
  if (AI.test(h)) return SOURCES[3];
  if (/(^|\.)bing\.com$/.test(h)) return 'Bing';
  if (/(^|\.)google\.[a-z.]+$/.test(h) || h === 'android-app' || h === 'com.google.android.googlequicksearchbox') return 'Google';
  if (FACEBOOK.test(h)) return 'Facebook';
  if (TEAMS.test(h)) return 'Teams';
  return 'Others';
}

/** Sums rows [{host, visits}] into the report buckets; also keeps the top "Others" hosts. */
export function bucketSources(rows) {
  const by = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  const others = new Map();
  for (const r of rows || []) {
    const b = classifySource(r.host);
    by[b] += r.visits || 0;
    if (b === 'Others' && r.visits) others.set(r.host, (others.get(r.host) || 0) + r.visits);
  }
  return { by, others: [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) };
}

/** Likely-bot countries (owner: China traffic on epifive.com is crawlers). */
export const BOT_COUNTRIES = new Set(['CN']);

// ---------------------------------------------------------------- aaj ki 1 seekh
const HINTS = {
  up: {
    Google: 'Google search chal raha hai: jo pages upar hain unke jaise aur likho.',
    Bing: 'Bing/Copilot se traffic badh raha hai: IndexNow + FAQ format chalu rakho.',
    [SOURCES[3]]: 'AI assistants humein cite kar rahe hain: seedhe jawab + steps wale guides chalu rakho.',
    Facebook: 'Facebook se log aa rahe hain: aaj ki post/Reel ka format repeat karo.',
    Teams: 'Teams me link share ho raha hai: office/M365 topics pe aur likho.',
    Direct: 'Direct visits badhe: log seedhe site pe aa rahe hain (bookmark/WhatsApp share).',
    'Website visits': 'Total traffic badha: aaj ke topics ka pattern dekho aur repeat karo.',
  },
  down: 'gira hai: top pages aur source check karo, kal ka content us side pe do.',
};

/**
 * One line comparing today with yesterday. candidates: [{label, now, before}] (today so far vs yesterday at the same
 * time). Picks the biggest relative move on a base of at least `min` visits; null when nothing qualifies.
 */
export function seekh(candidates, min = 5) {
  let best = null;
  for (const c of candidates || []) {
    const a = Number(c.now) || 0;
    const b = Number(c.before) || 0;
    if (Math.max(a, b) < min || a === b) continue;
    const rel = b ? Math.abs(a - b) / b : 1;
    // A source must move by at least 2 visits; ties go to the bigger absolute change.
    if (Math.abs(a - b) < 2) continue;
    const score = rel * 1000 + Math.abs(a - b);
    if (!best || score > best.score) best = { ...c, now: a, before: b, score };
  }
  if (!best) return null;
  const up = best.now > best.before;
  const hint = up ? HINTS.up[best.label] || HINTS.up['Website visits'] : `${best.label} ${HINTS.down}`;
  return `${best.label} ${pct(best.now, best.before)} (${fmt(best.before)} -> ${fmt(best.now)}, kal isi samay tak se). ${hint}`;
}

// ---------------------------------------------------------------- rendering
// A section: { title, items: [Item] } where Item = { text, href?, private?, sub? } or { heading }.
// `private` items (lead names, deal values) are replaced by a placeholder when the text goes to a public log.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderText(report, { redact = false } = {}) {
  const out = [report.title, ''];
  if (report.intro) out.push(report.intro, '');
  for (const s of report.sections) {
    out.push(`== ${s.title} ==`);
    for (const it of s.items) {
      if (it.heading) { out.push('', `${it.heading}:`); continue; }
      const text = redact && it.private ? '[private: sirf email me]' : it.text;
      out.push(`${it.sub ? '    ' : ''}- ${text}${it.href && !(redact && it.private) ? `  ${it.href}` : ''}`);
    }
    out.push('');
  }
  if (report.footer) out.push(report.footer);
  return out.join('\n');
}

export function renderHtml(report) {
  const parts = [
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d2329;max-width:680px">',
    `<h2 style="margin:0 0 4px;font-size:19px">${esc(report.title)}</h2>`,
  ];
  if (report.intro) parts.push(`<p style="margin:0 0 12px;color:#55606b">${esc(report.intro)}</p>`);
  for (const s of report.sections) {
    parts.push(`<h3 style="margin:18px 0 6px;font-size:16px;border-bottom:1px solid #e3e7eb;padding-bottom:3px">${esc(s.title)}</h3>`);
    let open = false;
    const close = () => { if (open) { parts.push('</ul>'); open = false; } };
    for (const it of s.items) {
      if (it.heading) { close(); parts.push(`<p style="margin:8px 0 2px;font-weight:600">${esc(it.heading)}</p>`); continue; }
      if (!open) { parts.push('<ul style="margin:2px 0 6px;padding-left:20px">'); open = true; }
      const body = it.href ? `<a href="${esc(it.href)}" style="color:#0b63c5">${esc(it.text)}</a>` : esc(it.text);
      parts.push(`<li${it.sub ? ' style="margin-left:16px;color:#55606b"' : ''}>${body}</li>`);
    }
    close();
  }
  if (report.footer) parts.push(`<p style="margin-top:18px;font-size:12px;color:#8a949e">${esc(report.footer)}</p>`);
  parts.push('</div>');
  return parts.join('\n');
}

/** A section whose source failed: one line, never blocks the email. */
export function failedSection(title, why) {
  return { title, items: [{ text: `data nahi mila${why ? ` (${why})` : ''}` }] };
}

/** Removes anything that could be a secret or personal data from an error before it is shown or logged. */
export function clean(msg) {
  return String(msg || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/[A-Za-z0-9_\-]{24,}/g, '<redacted>')
    .slice(0, 160);
}

/** Lines of EPIVIFE automation/log.md for one date: [{slug, status, words}]. */
export function articlesOn(log, date) {
  const out = [];
  for (const line of String(log || '').split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}) \| ([a-z0-9-]+) \| ([^|]+?)\s*(?:\|\s*(.*))?$/);
    if (m && m[1] === date) out.push({ slug: m[2], status: m[3].trim(), words: (m[4] || '').trim() });
  }
  return out;
}

/** First unchecked backlog item with a "(not before YYYY-MM-DD)" tag on or before `date` (the writer's next pick). */
export function nextDatedBacklog(backlog, date) {
  for (const line of String(backlog || '').split(/\r?\n/)) {
    const m = line.match(/^- \[ \] ([a-z0-9-]+) \| (.+?) \(not before (\d{4}-\d{2}-\d{2})\)/);
    if (m && m[3] <= date) return { slug: m[1], title: m[2].trim(), notBefore: m[3] };
  }
  return null;
}

/** The snapshot entry to compare with: the given day, else the latest earlier one. */
export function previousSnapshot(snap, date) {
  const days = Object.keys(snap?.days || {}).filter((d) => d < date).sort();
  if (!days.length) return null;
  const d = days.includes(addDays(date, -1)) ? addDays(date, -1) : days[days.length - 1];
  return { date: d, data: snap.days[d] };
}

/** Keeps the last `keep` days of the snapshot. */
export function pruneSnapshot(snap, keep = 30) {
  const days = Object.keys(snap.days || {}).sort().slice(-keep);
  return { ...snap, days: Object.fromEntries(days.map((d) => [d, snap.days[d]])) };
}

/** Shortens a caption/title to one line. */
export const short = (s, n = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || '(no caption)';
};

/** One line of Shyam's `day-plan.mjs --days 1` output -> { kind, plan, festival }. */
export function parseDayPlanLine(line) {
  const m = String(line || '').match(/^\d{4}-\d{2}-\d{2} \S+ (\S+)\s+\d+: (.*?)(?:\s+\|.*?)?(?:\s+\[(.+)\])?\s*$/);
  return m ? { kind: m[1], plan: m[2].trim(), festival: m[3] || '' } : null;
}
