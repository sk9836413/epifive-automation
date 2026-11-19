#!/usr/bin/env node
// Retirement and deadline data for https://www.epifive.com/microsoft-365-retirements (calendar, ICS, RSS).
//
// Sources (official notices only):
//   - Microsoft 365 Message Center: posts tagged "Retirement" (or retire/deprecate/end of support in the title), read
//     from the public mc.merill.net archive of Microsoft's Graph service announcements (github.com/merill/mc, MIT).
//     The date is Microsoft's own "Act by" date (actionRequiredByDateTime) when set, else the first date written in a
//     retirement sentence of the notice, quoted in dateText so it can be checked.
//   - Azure updates tagged "Retirements" (same archive, azure.json): date from the title, else the notice text.
//   - GitHub changelog: deprecation / retirement posts (the feed holds only the latest 10, so rows are appended
//     over time, and the radar's own seen items are used too).
// Our guides: a post in the site checkout that cites the MC number, the Azure update id or the changelog URL.
//
// Output: radar/retirements.json (public; the site renders it at request time, no rebuild). Rows are appended and
// updated, never silently dropped, until they are more than 120 days past.
//
//   node radar/retirements.mjs [--site <site checkout>] [--force] [--max-age-hours 6] [--now ISO]
//
// Runs on every radar scan (radar.yml) but fetches the ~7 MB of archive data at most every --max-age-hours.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'retirements.json');
const STATE = path.join(HERE, 'state.json');

export const MC_DATA = 'https://raw.githubusercontent.com/merill/mc/main/@data/messages.json';
export const AZURE_DATA = 'https://raw.githubusercontent.com/merill/mc/main/@data/azure.json';
export const GITHUB_FEED = 'https://github.blog/changelog/feed/';
export const DROP_PAST_DAYS = 120;

export const RETIRE = /\b(retir(e|es|ed|ing|ement)|deprecat\w*|end of (support|life|sale)|sunset\w*|discontinu\w*|no longer (be )?(supported|available)|will be removed|removal of|shut(ting)? down|closing down)\b/i;
// Sentence words that mark the date of the change (not the date a notice was published or a rollout began).
const CHANGE = /\b(retir\w*|deprecat\w*|end|ends|ending|remov\w*|no longer|stop\w*|block\w*|enforc\w*|disabl\w*|replac\w*|turn(ed)? off|unavailable|discontinu\w*|sunset\w*|starting|beginning|after|by|on)\b/i;

// ---------- text helpers ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function htmlToText(html = '') {
  return String(html)
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|hr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const oneLine = (s = '') => s.replace(/\s+/g, ' ').trim();

/** Sentences of a text (a "." inside a word, as in vibe.powerapps.com or Exchange.ManageV2, does not end one). */
export const sentencesOf = (s = '') => oneLine(s).split(/(?<=[.!?])\s+(?=["'(A-Z0-9])/).filter(Boolean);

/** First sentence(s) up to `max` characters, cut at a word boundary. */
export function brief(s = '', max = 240) {
  const t = oneLine(s);
  if (t.length <= max) return t;
  let out = '';
  for (const x of sentencesOf(t)) {
    if (`${out} ${x}`.trim().length > max) break;
    out = `${out} ${x}`.trim();
  }
  if (out) return out;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIndex = (m) => MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const validDay = (y, m, d) => d >= 1 && d <= new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * Dates written in a sentence, in order: "November 30, 2026", "30 November 2026", "Nov 30 2026", "2026-11-30" (day
 * precision) and "December 2026", "mid-December 2026", "end of December 2026" (month precision, first of the month).
 */
export function datesIn(text = '') {
  const found = [];
  const add = (index, length, y, m, d, precision, raw) => {
    if (m < 0 || y < 2020 || y > 2040) return;
    if (precision === 'day' && !validDay(y, m, d)) return;
    if (found.some((f) => index < f.index + f.length && f.index < index + length)) return;
    found.push({ index, length, date: ymd(y, m, precision === 'day' ? d : 1), precision, raw });
  };
  for (const m of text.matchAll(new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi'))) {
    add(m.index, m[0].length, +m[3], monthIndex(m[1]), +m[2], 'day', m[0]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\.?,?\\s+(20\\d{2})\\b`, 'gi'))) {
    add(m.index, m[0].length, +m[3], monthIndex(m[2]), +m[1], 'day', m[0]);
  }
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(m.index, m[0].length, +m[1], +m[2] - 1, +m[3], 'day', m[0]);
  for (const m of text.matchAll(new RegExp(`\\b(?:(?:early|mid|late|end of|the end of|beginning of|the beginning of)[\\s-]+)?${MON_RE}\\.?,?\\s+(20\\d{2})\\b`, 'gi'))) {
    add(m.index, m[0].length, +m[2], monthIndex(m[1]), 1, 'month', m[0]);
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * The date of the change in a notice: the first date in the first sentence that talks about retiring/removing
 * (RETIRE), else in a sentence with a change word (CHANGE). Dates more than a year before `now` are skipped.
 * Returns { date, precision, dateText } or null.
 */
export function changeDate(text = '', now = Date.now()) {
  const sentences = String(text).split(/\n/).flatMap(sentencesOf);
  const pick = (test) => {
    for (const s of sentences) {
      if (!test(s)) continue;
      const d = datesIn(s).find((x) => Date.parse(`${x.date}T00:00:00Z`) > now - 365 * 864e5);
      if (d) return { date: d.date, precision: d.precision, dateText: brief(s, 220) };
    }
    return null;
  };
  return pick((s) => RETIRE.test(s)) ?? pick((s) => CHANGE.test(s));
}

/** Text after one of the headings, up to the next known heading. */
const HEADINGS = [
  'what and why', 'when this will happen', 'rollout schedule', 'rollout timeline', 'impact on your organization', 'who is affected',
  'platforms and services', 'what will happen', 'how this will affect your organization', 'how this affects your organization',
  'what you need to do to prepare', 'what you can do to prepare', 'action required and recommendations', 'action required',
  'compliance considerations', 'admin controls', 'before the rollout', 'after the rollout', 'additional information',
  'more information', 'learn more', 'what is changing', "what's changing", 'why this is happening', 'timeline',
  'how does this affect me', 'what action do i need to take', 'what do i need to do', 'what you need to do', 'recommended actions',
  'platforms/services', 'impact on your organisation', 'what and why',
];
const headingKey = (l) => l.trim().toLowerCase().replace(/[:?.]+$/, '').trim();
const unbullet = (l) => l.replace(/^\s*([-*•·]|\d+[.)])\s+/, '').trim();
/** List lines become one sentence each ("Makers who ...; Admins who ..."). */
const joinLines = (lines) =>
  lines.map(unbullet).filter(Boolean).map((l, i, a) => (/[.!?:;]$/.test(l) || i === a.length - 1 ? l : `${l};`)).join(' ');
export function section(text, wanted) {
  const lines = text.split(/\n/);
  const isHeading = (l) => HEADINGS.includes(headingKey(l));
  for (let i = 0; i < lines.length; i++) {
    if (!wanted.includes(headingKey(lines[i]))) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !isHeading(lines[j]); j++) body.push(lines[j]);
    const t = oneLine(joinLines(body));
    if (t) return t;
  }
  // Older notices put the heading inline: "How this will affect your organization: ..."
  for (const w of wanted) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const m = text.match(new RegExp(`${escaped}\\s*:\\s*([^\\n]+)`, 'i'));
    if (m) return oneLine(m[1]);
  }
  return '';
}

// ---------- products ----------

const PRODUCT_RULES = [
  ['copilot', /\bcopilot\b/i],
  ['teams', /\bteams\b/i],
  ['exchange', /\b(exchange|outlook)\b/i],
  ['sharepoint', /\b(sharepoint|onedrive)\b/i],
  ['entra', /\b(entra|azure ad|azure active directory)\b/i],
  ['intune', /\b(intune|endpoint manager|autopilot)\b/i],
  ['security', /\b(defender|purview|sentinel)\b/i],
  ['power-platform', /\b(power (apps|automate|bi|pages|platform)|dataverse|copilot studio|dynamics 365)\b/i],
];

/** Product id from the notice title's "Product:" prefix, then its services, then anywhere in the title. */
export function productFor(title = '', services = []) {
  const prefix = title.includes(':') ? title.split(':')[0] : '';
  const svc = services.join(' ');
  for (const text of [prefix, svc, title]) {
    if (!text) continue;
    for (const [id, re] of PRODUCT_RULES) if (re.test(text)) return id;
  }
  return 'microsoft-365';
}

// ---------- rows ----------

/** A row from a Message Center post (Graph serviceUpdateMessage as archived by mc.merill.net), or null. */
export function fromMessage(msg, now = Date.now()) {
  const id = String(msg.Id ?? msg.id ?? '');
  const title = oneLine(msg.Title ?? msg.title ?? '');
  const tags = msg.Tags ?? msg.tags ?? [];
  if (!/^MC\d{5,9}$/.test(id) || !title) return null;
  if (!tags.includes('Retirement') && !RETIRE.test(title)) return null;
  const text = htmlToText(msg.Body?.Content ?? msg.body?.content ?? '');
  const services = msg.Services ?? msg.services ?? [];
  const actBy = msg.ActionRequiredByDateTime ?? msg.actionRequiredByDateTime;
  let when = null;
  if (actBy && !Number.isNaN(Date.parse(actBy))) {
    when = { date: new Date(Date.parse(actBy)).toISOString().slice(0, 10), precision: 'day', dateBasis: 'act-by' };
  } else {
    const d = changeDate(`${title}. ${text}`, now);
    if (d) when = { ...d, dateBasis: 'stated' };
  }
  if (!when) return null;
  const affected = section(text, ['who is affected', 'how this will affect your organization', 'how this affects your organization', 'how does this affect me', 'impact on your organization']);
  const action = section(text, ['what you need to do to prepare', 'action required and recommendations', 'what you can do to prepare', 'what action do i need to take', 'what do i need to do', 'what you need to do', 'recommended actions', 'action required']);
  return {
    id,
    source: 'message-center',
    product: productFor(title, services),
    title,
    ...when,
    affected: brief(dropLabel(affected) || (services.length ? `Organizations using ${services.join(', ')}.` : ''), 220) || undefined,
    action: brief(action, 240) || undefined,
    url: `https://admin.microsoft.com/#/MessageCenter/:/messages/${id}`,
    mirror: `https://mc.merill.net/message/${id}`,
    published: msg.StartDateTime ?? msg.startDateTime ?? undefined,
  };
}

/** A row from an Azure update tagged Retirements, or null. */
export function fromAzure(u, now = Date.now()) {
  const rawId = String(u.Id ?? '');
  const title = oneLine(u.Title ?? '');
  if (!/^AZ[\w-]+$/.test(rawId) || !title || !(u.Tags ?? []).includes('Retirements')) return null;
  const text = htmlToText(u.Body?.Content ?? '');
  const d = changeDate(title, now) ?? changeDate(text, now);
  if (!d) return null;
  const key = rawId.slice(2).replace(/^-/, '');
  const todo = brief(actionSentence(text), 240);
  return {
    id: rawId.length > 40 ? `AZ${hash(rawId)}` : rawId,
    source: 'azure-updates',
    product: 'azure',
    title: title.replace(/^Retirement:\s*/i, ''),
    ...d,
    dateBasis: 'stated',
    affected: (u.Services ?? []).length ? `Customers using ${(u.Services ?? []).join(', ')}.` : undefined,
    action: todo || undefined,
    url: `https://azure.microsoft.com/en-us/updates?id=${encodeURIComponent(key)}`,
    published: u.StartDateTime ?? undefined,
  };
}

/** A row from a GitHub changelog item ({ title, link, date, summary, categories }), or null. */
export function fromGithub(item, now = Date.now()) {
  const title = oneLine(item.title ?? '');
  const link = String(item.link ?? '');
  const cats = (item.categories ?? []).join(' ');
  if (!/^https:\/\/github\.blog\/changelog\//.test(link) || !title) return null;
  if (!RETIRE.test(title) && !/\b(retired|deprecation)\b/i.test(cats)) return null;
  const d = changeDate(`${title}. ${item.summary ?? ''}`, now);
  if (!d) return null;
  const slug = link.replace(/\/+$/, '').split('/').pop().replace(/[^a-z0-9-]/gi, '').slice(0, 60);
  return {
    id: `gh-${slug}`,
    source: 'github-changelog',
    product: 'github',
    title,
    ...d,
    dateBasis: 'stated',
    action: brief(actionSentence(item.summary ?? ''), 240) || undefined,
    url: link,
    published: item.date ? new Date(Date.parse(item.date)).toISOString() : undefined,
  };
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/** RSS items of the GitHub changelog feed. */
export function parseChangelog(xml = '') {
  const tag = (b, n) => (b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'))?.[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => ({
    title: htmlToText(tag(m[0], 'title')),
    link: htmlToText(tag(m[0], 'link')),
    date: tag(m[0], 'pubDate'),
    summary: htmlToText(tag(m[0], 'description')).slice(0, 1200),
    categories: [...m[0].matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => htmlToText(c[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))),
  }));
}

/** Attach our guide: a post that cites the MC number, the Azure update id or the changelog URL. posts: [{ slug, title, text }]. */
export function linkGuides(rows, posts) {
  const pick = (needle) => {
    const hits = posts.filter((p) => p.text.includes(needle));
    if (!hits.length) return null;
    return (hits.find((p) => /retir|deprecat|migrat|end of support/i.test(`${p.slug} ${p.title}`)) ?? hits[0]).slug;
  };
  return rows.map((r) => {
    let guide = null;
    if (r.source === 'message-center') guide = pick(r.id);
    else if (r.source === 'azure-updates') guide = pick(r.url.split('id=')[1] ?? '\u0000');
    else guide = pick(r.url.replace(/\/+$/, ''));
    return { ...r, guide };
  });
}

/** The first sentence that tells the reader what to do (migrate, move, update...), for notices with no action section. */
const ACTION_WORDS = /\b(migrat\w*|transition|move (to|your)|switch to|recommend\w*|we encourage|update (to|your)|upgrade|replace|before (that|this) date|you (must|should|need to)|use .{1,40} instead)\b/i;
export const actionSentence = (text = '') => sentencesOf(String(text).replace(/\n/g, ' ')).find((x) => ACTION_WORDS.test(x)) ?? '';
/** "Who is affected: All organizations ..." -> "All organizations ..." */
const dropLabel = (s = '') => s.replace(/^(who is affected|this change affects|this retirement affects)\s*:\s*/i, '');

const daysPast = (r, now) => (now - Date.parse(`${r.date}T00:00:00Z`)) / 864e5;

/**
 * Merge fresh rows into the stored ones: fresh data wins (dates move when Microsoft updates a notice), firstSeen is
 * kept, rows missing from the sources are kept, and rows more than DROP_PAST_DAYS past are dropped.
 */
export function mergeRows(old = [], fresh = [], now = Date.now()) {
  const byId = new Map(old.map((r) => [r.id, r]));
  const iso = new Date(now).toISOString();
  for (const r of fresh) {
    const prev = byId.get(r.id);
    const guide = r.guide ?? prev?.guide ?? null;
    byId.set(r.id, { ...prev, ...r, guide, firstSeen: prev?.firstSeen ?? iso });
  }
  return [...byId.values()]
    .filter((r) => daysPast(r, now) <= DROP_PAST_DAYS)
    .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// ---------- CLI ----------

function readPosts(site) {
  const dir = site && path.join(site, 'content', 'posts');
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return { slug: f.replace(/\.mdx?$/, ''), title: text.match(/^title:\s*['"]?(.+?)['"]?\s*$/m)?.[1] ?? '', text };
    });
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'EpiFive radar (+https://www.epifive.com/microsoft-365-retirements)' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, f) => {
    const i = args.indexOf(`--${n}`);
    if (i === -1) return f;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
  };
  const now = opt('now') ? Date.parse(opt('now')) : Date.now();
  const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { items: [] };
  const maxAge = Number(opt('max-age-hours', 6)) * 36e5;
  if (!opt('force') && old.generated && now - Date.parse(old.generated) < maxAge) {
    console.log(`Retirements: checked ${Math.round((now - Date.parse(old.generated)) / 6e4)} min ago, next check after ${maxAge / 36e5} h.`);
    return;
  }
  const errors = [];
  const fresh = [];
  const counts = {};
  const take = (rows, name) => {
    counts[name] = rows.length;
    fresh.push(...rows);
  };
  try {
    take(JSON.parse(await getText(MC_DATA)).map((m) => fromMessage(m, now)).filter(Boolean), 'message-center');
  } catch (e) {
    errors.push(`Message Center: ${e.message}`);
  }
  try {
    take(JSON.parse(await getText(AZURE_DATA)).map((u) => fromAzure(u, now)).filter(Boolean), 'azure');
  } catch (e) {
    errors.push(`Azure updates: ${e.message}`);
  }
  try {
    const feed = parseChangelog(await getText(GITHUB_FEED));
    const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { seen: {} };
    const seen = Object.values(state.seen ?? {}).filter((s) => s.source === 'github-changelog');
    const rows = [...feed, ...seen].map((i) => fromGithub(i, now)).filter(Boolean);
    take([...new Map(rows.map((r) => [r.id, r])).values()], 'github');
  } catch (e) {
    errors.push(`GitHub changelog: ${e.message}`);
  }
  if (!fresh.length && errors.length) {
    console.log(`Retirements: no source could be read (${errors.join('; ')}); kept the old file.`);
    return;
  }
  const items = mergeRows(old.items, linkGuides(fresh, readPosts(opt('site'))), now);
  const out = {
    generated: new Date(now).toISOString(),
    about: 'Microsoft 365 / Azure / GitHub retirements for https://www.epifive.com/microsoft-365-retirements. Built by radar/retirements.mjs from official notices; see that file for sources and date rules.',
    sources: counts,
    errors,
    items,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  const upcoming = items.filter((r) => daysPast(r, now) <= 0).length;
  console.log(`Retirements: ${items.length} rows (${upcoming} upcoming; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})${errors.length ? `; errors: ${errors.join('; ')}` : ''}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.log(`Retirements: failed (${e.message}); kept the old file.`);
  });
}
