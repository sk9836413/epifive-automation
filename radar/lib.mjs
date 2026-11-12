// Launch radar: pure functions (feed parsing, scoring, de-duplication, backlog/log edits, article checks).
// No network and no file access here, so everything is unit-tested in radar.test.mjs.

// ---------- text helpers ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

export function decodeEntities(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripTags(s = '') {
  // Decode first: RSS descriptions often carry escaped HTML (&lt;p&gt;).
  return decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};

const toIso = (s) => {
  if (!s) return null;
  const t = Date.parse(decodeEntities(s).trim().replace(/ Z$/, ' GMT'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// ---------- parsers ----------

/** RSS 2.0 <item> or Atom <entry> -> [{ title, link, guid, date, updated, summary, categories }] */
export function parseFeed(xml) {
  const items = [];
  for (const [, block] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    items.push({
      title: stripTags(tag(block, 'title')),
      link: decodeEntities(tag(block, 'link')).trim(),
      guid: decodeEntities(tag(block, 'guid')).trim(),
      date: toIso(tag(block, 'pubDate') || tag(block, 'dc:date')),
      updated: toIso(tag(block, 'a10:updated') || tag(block, 'atom:updated')),
      summary: stripTags(tag(block, 'description') || tag(block, 'content:encoded')).slice(0, 700),
      categories: [...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => stripTags(m[1])).filter(Boolean),
    });
  }
  for (const [, block] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
    const alt = links.find((a) => /rel=["']alternate["']/.test(a)) ?? links.find((a) => !/rel=/.test(a)) ?? links[0] ?? '';
    items.push({
      title: stripTags(tag(block, 'title')),
      link: decodeEntities(alt.match(/href=["']([^"']+)["']/)?.[1] ?? '').trim(),
      guid: decodeEntities(tag(block, 'id')).trim(),
      date: toIso(tag(block, 'published') || tag(block, 'updated')),
      updated: toIso(tag(block, 'updated')),
      summary: stripTags(tag(block, 'summary') || tag(block, 'content')).slice(0, 700),
      categories: [...block.matchAll(/<category\b[^>]*term=["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1])),
    });
  }
  return items.filter((i) => i.title && i.link);
}

/** Sitemap <url><loc>..</loc><lastmod>..</lastmod></url>; the title comes from the URL slug. */
export function parseSitemap(xml, { linkPattern } = {}) {
  const re = linkPattern ? new RegExp(linkPattern) : null;
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)]
    .map(([, b]) => ({ link: decodeEntities(tag(b, 'loc')).trim(), date: toIso(tag(b, 'lastmod')) }))
    .filter((i) => i.link && (!re || re.test(i.link)))
    .map((i) => {
      const slug = new URL(i.link).pathname.split('/').filter(Boolean).pop() ?? '';
      const title = slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
      return { ...i, title, guid: i.link, updated: null, summary: '', categories: [] };
    });
}

/**
 * A news listing page: every <a href> matching linkPattern that contains a heading (h1-h4) is a post.
 * The date is the first <time> after the link, the summary the first <p>.
 */
export function parseHtmlList(html, { base, linkPattern }) {
  const re = new RegExp(linkPattern);
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]);
    const path = href.startsWith('http') ? new URL(href).pathname : href.split(/[?#]/)[0];
    if (!re.test(path)) continue;
    const heading = m[2].match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
    if (!heading) continue;
    const link = new URL(href, base).toString();
    if (out.has(link)) continue;
    const after = html.slice(m.index, m.index + 3000);
    const time = after.match(/<time\b([^>]*)>([^<]*)<\/time>/i);
    const dt = time ? toIso(time[1].match(/datetime="([^"]+)"/)?.[1] ?? time[2]) : null;
    out.set(link, {
      title: stripTags(heading[1]),
      link,
      guid: link,
      date: dt,
      updated: null,
      summary: stripTags(after.slice(m[0].length).match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').slice(0, 400),
      categories: [],
    });
  }
  return [...out.values()];
}

/** Release-notes page: <h2>YYYY.MM.DD</h2> sections, each feature an <h3> followed by its "What:" paragraph. */
export function parseDatedSections(html, { url }) {
  const items = [];
  const parts = html.split(/<h2\b[^>]*>\s*(\d{4})[.-](\d{2})[.-](\d{2})\s*<\/h2>/i);
  for (let i = 1; i + 3 < parts.length; i += 4) {
    const [y, mo, d, body] = [parts[i], parts[i + 1], parts[i + 2], parts[i + 3] ?? ''];
    for (const h of body.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/gi)) {
      const title = stripTags(h[1]);
      if (!title) continue;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      items.push({
        title,
        link: `${url}#${y}-${mo}-${d}-${slug}`,
        guid: `${y}-${mo}-${d}-${slug}`,
        date: `${y}-${mo}-${d}T12:00:00.000Z`,
        updated: null,
        summary: stripTags(h[2].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').slice(0, 500),
        categories: [],
      });
    }
  }
  return items;
}

export function parseSource(body, source) {
  switch (source.type) {
    case 'rss':
    case 'atom':
      return parseFeed(body);
    case 'sitemap':
      return parseSitemap(body, source);
    case 'html-list':
      return parseHtmlList(body, { base: source.url, linkPattern: source.linkPattern });
    case 'dated-sections':
      return parseDatedSections(body, { url: source.page ?? source.url.split('?')[0] });
    default:
      throw new Error(`unknown source type ${source.type}`);
  }
}

// ---------- keys, tokens, similarity ----------

/** Stable key for an item: the link without tracking parameters, fragment (except our own #date-slug) or trailing slash. */
export function normalizeUrl(u) {
  try {
    const url = new URL(u.trim());
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|ocid|cid$|ref$|source$)/i.test(k)) url.searchParams.delete(k);
    if (!/^#\d{4}-\d{2}-\d{2}-/.test(url.hash)) url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return u.trim().toLowerCase();
  }
}

const STOP = new Set(('a an and are as at be by for from has have how in into is it its new now of on or our out the this to up we what when with you your ' +
  'introducing introduces introduced launch launches launched launching available today announcing announces update updates updated ' +
  'more will can get gets more just here latest week month year all about over use using').split(' '));

const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(sses)$/, 'ss').replace(/([^s])s$/, '$1');

/** Significant lowercase tokens (stop words and launch verbs removed, simple plural stemming). */
export function tokens(s = '') {
  return [...new Set(String(s).toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z0-9+]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem))];
}

/** Share of the item's tokens found in the other text, and the number shared. */
export function overlap(itemText, otherText) {
  const A = tokens(itemText);
  const B = new Set(tokens(otherText));
  const shared = A.filter((w) => B.has(w)).length;
  return { shared, ratio: A.length ? shared / A.length : 0 };
}

/** Same launch/topic: at least 3 significant tokens shared and 60% of the item's tokens. */
export const sameTopic = (itemText, otherText) => {
  const o = overlap(itemText, otherText);
  return o.shared >= 3 && o.ratio >= 0.6;
};

export function hashText(s = '') {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// ---------- scoring ----------

// Products and services EpiFive covers. Weight = how much search demand a launch there tends to bring.
export const NICHE = [
  [/\bchatgpt\b/i, 3], [/\bwhatsapp\b/i, 3], [/\bcopilot\b/i, 2], [/\bmicrosoft 365\b|\bm365\b|\boffice 365\b/i, 2],
  [/\bmicrosoft teams\b|\bteams (meetings?|chat|app|admin|premium|phone|rooms)\b/i, 2], [/\boutlook\b/i, 2], [/\bwindows 1[01]\b/i, 2], [/\bgemini\b/i, 2], [/\bgoogle workspace\b/i, 2],
  [/\bgmail\b/i, 2], [/\biphone\b|\bios \d+|\bipados\b/i, 2], [/\bandroid\b/i, 2], [/\bclaude\b/i, 2], [/\bupi\b/i, 2],
  [/\baadhaar\b|\bdigilocker\b/i, 2], [/\bopenai\b/i, 1], [/\bexcel\b|\bmicrosoft word\b|\bpowerpoint\b|\bonedrive\b|\bsharepoint\b/i, 1],
  [/\bexchange\b/i, 1], [/\bintune\b|\bentra\b|\bdefender\b|\bautopilot\b/i, 1], [/\bwindows\b/i, 1], [/\bgoogle (drive|meet|docs|sheets|chrome|photos|maps)\b/i, 1],
  [/\bpixel\b|\bgalaxy\b|\bmac(os|book)?\b|\bapple watch\b|\bairpods\b/i, 1], [/\binstagram\b|\bfacebook\b|\bmessenger\b/i, 1],
  [/\bgithub copilot\b|\bcodex\b/i, 1], [/\bpasskeys?\b|\bpassword\b|\bscam\b|\bfraud\b|\bkyc\b/i, 1], [/\bagents?\b|\bai assistant\b/i, 1],
];
const NICHE_CAP = 4;

const LAUNCH = /\b(introduc(ing|es|ed)|launch(es|ed|ing)?|now available|available (now|today)|generally available|general availability|rolling out|roll(s|ing)? out|starting today|is here|arrives?|now you can|you can now|now lets you|now supports?|expands? to|available in|new features?)\b/i;
const ACTION = /\b(set ?up|turn (it )?(on|off)|enable|disable|opt[- ](in|out)|how to|migrat(e|ion)|claim|sign up|upgrade|switch to|install|download|configure|get started|try it|admins? can|users? can|you can|businesses can|step[- ]by[- ]step|redeem|verify your|apply (for|now))\b/i;
const MONEY = /\b(price|pricing|plans?|subscriptions?|subscribers|free|paid|tier|per user|regions?|countries|india|available to|eligible|eligibility|rollout)\b|[$₹]\d/i;
// Enterprise procurement and developer-only launches: real, but rarely a how-to for EpiFive readers.
const NARROW = /\b(marketplace|api|sdk|developers?|enterprise customers|private preview)\b/i;
const RETIRE = /\b(retir(e|es|ing|ement)|deprecat\w*|end of support|sunset\w*)\b/i;
// Microsoft 365 services whose retirements EpiFive turns into migration how-tos (matched on title, summary or feed category).
const M365_CHANGE = /\b(microsoft 365|m365|office 365|exchange|sharepoint|onedrive|outlook|teams|entra|azure ad|intune|defender|copilot|purview|microsoft graph|graph api)\b/i;
export const RETIRE_WINDOW_DAYS = 120;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = MONTHS.join('|');
const EXACT_MDY = new RegExp(`\\b(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi');
const EXACT_DMY = new RegExp(`\\b(\\d{1,2})\\s+(${MON})\\s+(20\\d{2})\\b`, 'gi');
const MONTH_YEAR = new RegExp(`\\b(?:(early|mid|late|end of|the end of)[\\s-]+)?(${MON}),?\\s+(20\\d{2})\\b`, 'gi');

/** Dates written in an announcement ("January 31, 2027", "31 January 2027", "mid-January 2027", "end of November 2026") as UTC ms. */
export function datesIn(text = '') {
  const out = [];
  const mon = (m) => MONTHS.indexOf(m.toLowerCase());
  for (const m of text.matchAll(EXACT_MDY)) out.push(Date.UTC(+m[3], mon(m[1]), +m[2]));
  for (const m of text.matchAll(EXACT_DMY)) out.push(Date.UTC(+m[3], mon(m[2]), +m[1]));
  for (const m of text.matchAll(MONTH_YEAR)) {
    const y = +m[3];
    const mo = mon(m[2]);
    const part = (m[1] ?? '').toLowerCase();
    const day = part === 'early' ? 5 : part === 'mid' ? 15 : part === 'late' ? 25 : new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    out.push(Date.UTC(y, mo, day));
  }
  return out;
}

/** Days until the soonest date in the text that falls between yesterday and RETIRE_WINDOW_DAYS ahead, else null. */
export function daysToDeadline(text, now = Date.now()) {
  const days = datesIn(text).map((t) => Math.ceil((t - now) / 864e5)).filter((d) => d >= -1 && d <= RETIRE_WINDOW_DAYS);
  return days.length ? Math.min(...days) : null;
}
// Title-only negatives: customer stories and corporate news are not how-tos.
const STORY = /\b(how .{1,40} uses?|customer stor(y|ies)|case study|scales|rethinks|transforms?|elevates?|reimagin\w*|with (openai|ai) technology|powered by|partners? with|partnership|collaborat\w*|builds? .{0,30} with)\b/i;
const CORPORATE = /\b(funding|raises|earnings|quarter|acquir\w*|hiring|appoint\w*|economic|economy|elections?|midterms|research|paper|benchmark|grants?|fellowship|nonprofits?|evaluat\w*|podcast|webinar|events?|conference|summit|recap|what you.ll learn|keynote|interview|awards?|anniversary|sustainability|this week|guidance gap|careers?|mission|commitment|principles)\b/i;
export const RUMOUR = /\b(rumou?r(s|ed)?|leak(s|ed)?|reportedly|allegedly|spotted|unconfirmed)\b/i;
export const UPDATE_SIGNAL = /\b(expand(s|ed|ing)?|now available (in|to|for)|more (countries|regions|markets|languages|users)|india|rolling out to|generally available|general availability|price (change|increase|cut)|new pricing|now free|all users|everyone|additional (regions|countries|plans))\b/i;

/**
 * Score one item for "fast-track how-to" value.
 * Returns { score, reasons[], reject } where reject is a reason string for items that can never qualify.
 */
export function scoreItem(item, source, { now = Date.now(), freshHours = 36, threshold = 10 } = {}) {
  // Security news feeds are scored differently: "leak" and "allegedly" are the subject there, not a rumour signal.
  if (source.category === 'incident') return scoreIncident(item, source, { now, freshHours });
  const reasons = [];
  let score = 0;
  const add = (n, why) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };
  const title = item.title ?? '';
  const text = `${title} ${item.summary ?? ''}`;

  if (RUMOUR.test(text)) return { score: -99, reasons: ['rumour/leak wording'], reject: 'rumour' };

  add(source.weight ?? 0, `source ${source.id}`);
  let niche = 0;
  const hits = [];
  for (const [re, w] of NICHE) {
    const m = text.match(re);
    if (m) {
      niche += w;
      hits.push(m[0].toLowerCase());
    }
  }
  add(Math.min(niche, NICHE_CAP), `niche (${hits.slice(0, 4).join(', ')})`);
  if (LAUNCH.test(text)) add(2, `launch "${text.match(LAUNCH)[0]}"`);
  if (ACTION.test(text)) add(2, `user steps "${text.match(ACTION)[0]}"`);
  if (MONEY.test(text)) add(1, `plans/price/availability "${text.match(MONEY)[0]}"`);
  if (LAUNCH.test(title)) add(1, 'launch in the headline');
  if (RETIRE.test(text)) add(1, 'retirement/migration');
  if (NARROW.test(title)) add(-1, `narrow audience "${title.match(NARROW)[0]}"`);
  if (item.alsoIn?.length) add(1, `also on ${item.alsoIn.slice(0, 2).join(', ')}`);
  if (STORY.test(title)) add(-4, 'customer story');
  else if (CORPORATE.test(title)) add(-3, `corporate/announcement "${title.match(CORPORATE)[0]}"`);

  const boosts = source.categoryBoost ?? {};
  let cat = 0;
  for (const c of item.categories ?? []) if (boosts[c] !== undefined) cat += boosts[c];
  if (!(item.categories ?? []).length && boosts['(none)'] !== undefined) cat += boosts['(none)'];
  add(cat, `category (${(item.categories ?? []).slice(0, 3).join(', ') || 'none'})`);

  // A Microsoft 365 retirement or deprecation due within RETIRE_WINDOW_DAYS always clears the threshold:
  // admins need the migration how-to before the date, whatever the headline wording.
  if (RETIRE.test(text) && M365_CHANGE.test(`${text} ${(item.categories ?? []).join(' ')}`)) {
    const days = daysToDeadline(text, now);
    if (days !== null) add(Math.max(3, threshold + 1 - score), `M365 retirement due in ${Math.max(days, 0)} days`);
  }

  const date = Date.parse(item.date ?? '');
  const ageHours = Number.isNaN(date) ? null : (now - date) / 3600e3;
  if (ageHours !== null && ageHours > freshHours) return { score, reasons, reject: `stale (${Math.round(ageHours)}h old)`, ageHours };
  if (ageHours !== null && ageHours < -24) return { score, reasons, reject: 'dated in the future', ageHours };
  return { score, reasons, reject: null, ageHours };
}

// ---------- security incidents ----------
// Sources with "category": "incident" (security news and vendor security blogs). Big incidents on platforms EpiFive
// readers use, or at Indian banks / UPI / Aadhaar, become a "what happened / am I affected / what to do now" guide.

export const INCIDENT = /\b(breach(ed|es)?|leak(s|ed)?|hack(s|ed|ers?)?|compromis(e|ed|es)|hijack(s|ed|ing)?|stolen|steal(s|ers?|ing)?|exfiltrat\w*|ransomware|malware|infostealers?|spyware|backdoor(s|ed)?|phishing|supply[- ]chain attacks?|zero[- ]days?|0-days?|actively exploited|exploited in the wild|vulnerabilit(y|ies)|flaws?|cve-\d{4}-\d+|dark web|account takeovers?|credential stuffing|data exposure|exposed (data|records|database|customer))\b/i;
// Platforms with a large EpiFive audience (each distinct match +3, capped at +4).
export const MAJOR_PLATFORM = /\b(github|npm|pypi|microsoft 365|office 365|m365|outlook|exchange online|sharepoint|onedrive|microsoft teams|azure|entra|windows|google|gmail|chrome|android|apple|iphone|ios|macos|whatsapp|chatgpt|openai|claude|instagram|facebook|meta|aws|cloudflare|okta|salesforce|zoom|slack|telegram)\b/i;
// Indian banks, payments and identity (+5): the consumer incidents Indian readers search for.
export const INDIA_INCIDENT = /\b(sbi|state bank of india|hdfc bank|icici bank|axis bank|kotak|au small finance|small finance bank|punjab national bank|pnb|bank of baroda|canara bank|union bank of india|yes bank|indusind|idfc first|indian banks?|paytm|phonepe|bhim|upi|npci|aadhaar|uidai|digilocker|pan card|cert-in|reserve bank of india|rbi|airtel|jio|bsnl|irctc)\b/i;
const SCALE = /\b\d+(\.\d+)?\+?\s*(million|billion|lakh|crore)\b|\b\d{1,3}(,\d{3})+\+?\s*(\w+\s)?(users|accounts|customers|repositor(y|ies)|repos|records|people|devices|sites|servers|packages|organi[sz]ations)\b/i;
// What a reader has to do: patch, rotate, reset, check... (explicit), or user data/credentials were exposed (implied).
export const USER_ACTION = /\b(patch(es|ed)?|update (now|immediately|to)|emergency (update|patch)|security updates?|fix(es|ed)?|rotate|revok(e|ed)|reset (your |their )?passwords?|change (your |their )?passwords?|enable (2fa|mfa|two[- ]factor)|check (if|whether|your)|are you affected|urg(es|ed) (users|customers)|warns? (users|customers)|advis(es|ory)|mitigat\w*|workaround|indicators of compromise|iocs?|uninstall|remove)\b/i;
const AFFECTED = /\b(customers?|users?|accounts?|account holders|subscribers|developers?|repositor(y|ies)|repos|maintainers|patients|records)\b/i;
const EXPOSURE = /\b(breach|leak|stolen|steal|hijack|compromis|exposed|exposure|dark web|ransomware|phishing)/i;
const EXPLOITED = /\b(zero[- ]days?|0-days?|exploited|under (active )?attack|mass exploitation)\b/i;
// A vulnerability on its own (fixed, nothing exploited or stolen) scores lower than a breach or an attack campaign.
const VULN_ONLY = /^(vulnerabilit(y|ies)|flaws?|cve-\d{4}-\d+)$/i;
// "A flaw could leak data" describes what a vulnerability might allow, not a breach that happened.
const HYPOTHETICAL = /\b(could|may|might|can|lets?|allows?|enables?)\s+(\w+\s+){0,2}?(leak|expose|steal|hijack|compromise)\w*/gi;
const INCIDENT_TOPICS = ['security-identity', 'online-safety'];
// Sponsored posts, roundups and business news on security sites.
const INCIDENT_NOISE = /\b(webinar|sponsored|podcast|recap|week in review|weekly|newsletter|funding|raises|acquir\w*|earnings|ipo|conference|summit|awards?|opinion|interview|buyer'?s guide|whitepaper|survey|predictions?|explained|what is)\b/i;
export const INCIDENT_UPDATE = /\b(confirm(s|ed)?|disclos(es|ed|ure)|new details|now says|clarif\w*|(patch|fix)(es)? (released|available)|advisory|regulator|cert-in|rbi)\b/i;

/** Score a security-incident item. Same return shape as scoreItem, plus category and a suggested site topic. */
export function scoreIncident(item, source, { now = Date.now(), freshHours = 36 } = {}) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };
  const title = item.title ?? '';
  const text = `${title} ${item.summary ?? ''}`;
  const india = INDIA_INCIDENT.test(text);
  const base = { category: 'incident', topic: india ? 'online-safety' : source.topic ?? 'security-identity' };

  if (!INCIDENT.test(text)) return { score: 0, reasons: ['not a security incident'], reject: 'not an incident', ...base };
  const action = USER_ACTION.test(text);
  if (!action && !(AFFECTED.test(text) && EXPOSURE.test(text))) {
    return { score: 0, reasons: ['no concrete user action'], reject: 'incident without a user action', ...base };
  }

  add(source.weight ?? 0, `source ${source.id}`);
  const found = [...text.replace(HYPOTHETICAL, ' flaw ').matchAll(new RegExp(INCIDENT.source, 'gi'))].map((m) => m[0]);
  const exploited = EXPLOITED.test(text);
  if (found.every((w) => VULN_ONLY.test(w)) && !exploited) add(2, `vulnerability "${found[0]}"`);
  else add(3, `incident "${found.find((w) => !VULN_ONLY.test(w)) ?? found[0]}"`);
  const majors = [...new Set((text.match(new RegExp(MAJOR_PLATFORM.source, 'gi')) ?? []).map((m) => m.toLowerCase()))];
  add(Math.min(majors.length * 3, 4), `major platform (${majors.slice(0, 3).join(', ')})`);
  if (india) add(5, `India banking/payments/identity "${text.match(INDIA_INCIDENT)[0]}"`);
  if (SCALE.test(text)) add(2, `large scale "${text.match(SCALE)[0]}"`);
  if (exploited) add(2, `exploited "${text.match(EXPLOITED)[0]}"`);
  if (action) add(2, `user action "${text.match(USER_ACTION)[0]}"`);
  else add(1, 'user data or credentials exposed');
  if (INCIDENT_NOISE.test(title)) add(-5, `not an incident report "${title.match(INCIDENT_NOISE)[0]}"`);
  if (item.alsoIn?.length) add(1, `also on ${item.alsoIn.slice(0, 2).join(', ')}`);
  // Claims ("allegedly", "a group claims") are allowed here; the writer must label them as claims.
  if (RUMOUR.test(text) || /\bclaim(s|ed)?\b/i.test(text)) reasons.push('contains claims: label them as claims');

  const boosts = source.categoryBoost ?? {};
  let cat = 0;
  for (const c of item.categories ?? []) if (boosts[c] !== undefined) cat += boosts[c];
  if (!(item.categories ?? []).length && boosts['(none)'] !== undefined) cat += boosts['(none)'];
  add(cat, `category (${(item.categories ?? []).slice(0, 3).join(', ') || 'none'})`);

  const date = Date.parse(item.date ?? '');
  const ageHours = Number.isNaN(date) ? null : (now - date) / 3600e3;
  if (ageHours !== null && ageHours > freshHours) return { score, reasons, reject: `stale (${Math.round(ageHours)}h old)`, ageHours, ...base };
  if (ageHours !== null && ageHours < -24) return { score, reasons, reject: 'dated in the future', ageHours, ...base };
  return { score, reasons, reject: null, ageHours, ...base };
}

// Words most security headlines share (as tokens() returns them, simple plural stemming applied).
const SECURITY_WORDS = new Set(('patch patche patched fix fixe fixed flaw vulnerability bug critical remote code execution rce attack ' +
  'attacker exploit exploited actively security update data breach leak leaked hacker hack hacked malware including could let ' +
  'enable allow user customer warn warning campaign threat actor zero day cve cvss server after potential say report reported ' +
  'third party provider vendor client platform service account system notifie notify exposed expose stolen information ' +
  'personal detail access affected impact').split(' '));

/**
 * Two headlines about the same incident. Outlets word it differently, so this is looser than sameTopic, but it
 * ignores generic security words ("patches", "flaw", "remote code execution") so unrelated advisories don't match.
 */
export function sameIncident(a, b) {
  const A = tokens(a).filter((w) => !SECURITY_WORDS.has(w));
  const B = new Set(tokens(b).filter((w) => !SECURITY_WORDS.has(w)));
  const shared = A.filter((w) => B.has(w)).length;
  const ratio = A.length ? shared / A.length : 0;
  return (shared >= 4 && ratio >= 0.3) || (shared >= 3 && ratio >= 0.5);
}

/**
 * Keep one item per incident: the highest-scored of several outlets' reports, and none for an incident that is
 * already queued, being written or published (recent = [{ title }]). Marks the others with dupOf.
 */
export function markIncidentDuplicates(scored, recent = []) {
  const kept = [];
  for (const x of [...scored].filter((s) => s.category === 'incident').sort((a, b) => b.score - a.score)) {
    const hit = recent.find((r) => sameIncident(x.item.title, r.title)) ?? kept.find((k) => sameIncident(x.item.title, k.item.title))?.item;
    if (hit) {
      x.dupOf = hit.title;
      x.reasons.push(`same incident as "${hit.title.slice(0, 60)}"`);
    } else kept.push(x);
  }
  return scored;
}

/** Signal that a covered launch or incident has news worth an update. */
export const updateSignal = (text, category = 'launch') => (category === 'incident' ? INCIDENT_UPDATE : UPDATE_SIGNAL).test(text);

/** Backlog slug from a headline. */
export const slugify = (title) => tokens(title).filter((w) => /^[a-z0-9]+$/.test(w)).slice(0, 7).join('-') || 'launch';

/** Backlog line for a launch or incident that could not be fast-tracked (daily cap or failed gate). */
export function backlogLine({ title, date, topic, link, category = 'launch', reason, slug }) {
  const t = cleanTitle(title);
  const day = String(date ?? '').slice(0, 10);
  if (category === 'incident') {
    return `- [ ] ${slug ?? slugify(t)} | ${t}: what happened and what to do (incident ${day}) | ${topic} | incident guide (what happened / am I affected / what to do now / how to prevent it), primary sources first, from ${link} (fast-track incident, ${reason})`;
  }
  return `- [ ] ${slug ?? slugify(t)} | How to use ${t} (official launch ${day}) | ${topic} | set up or use the new feature, from ${link} (fast-track, ${reason})`;
}

/** +2 if a Google "trending now" query names the launch, +1 if Google autocomplete already completes its phrase. */
export function trendBoost(item, { trending = [], suggestions = [] } = {}) {
  const itemTokens = tokens(item.title);
  let boost = 0;
  const why = [];
  for (const q of trending) {
    const t = tokens(q);
    const shared = t.filter((w) => itemTokens.includes(w)).length;
    if (shared >= 2 || (shared === 1 && t.length === 1)) {
      boost += 2;
      why.push(`trending "${q}"`);
      break;
    }
  }
  if (suggestions.length >= 2) {
    boost += 1;
    why.push(`autocomplete (${suggestions.length})`);
  }
  return { boost, why };
}

/** The phrase to ask Google autocomplete about: the product plus the first feature words of the title. */
export function searchPhrase(title) {
  return tokens(title).slice(0, 3).join(' ');
}

// ---------- de-duplication ----------

/**
 * One entry per launch across feeds: the same link, or the same title, on several official feeds
 * (e.g. the Gemini blog and The Keyword) is kept once, from the highest-weight source, with alsoIn = the others.
 */
export function mergeDuplicates(items) {
  const byKey = new Map();
  const titleKey = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const item of [...items].sort((a, b) => (b.source?.weight ?? 0) - (a.source?.weight ?? 0))) {
    const k1 = normalizeUrl(item.link);
    const k2 = `t:${titleKey(item.title)}`;
    const first = byKey.get(k1) ?? byKey.get(k2);
    if (first) {
      if (item.source?.id && item.source.id !== first.source?.id && !first.alsoIn.includes(item.source.id)) first.alsoIn.push(item.source.id);
      continue;
    }
    const kept = { ...item, alsoIn: [] };
    byKey.set(k1, kept);
    byKey.set(k2, kept);
  }
  return [...new Set(byKey.values())];
}

/**
 * Find what already covers an item.
 * posts: [{ slug, title, date, body }], news: [{ slug, body }], backlog: [{ slug, title, done }]
 */
export function findCoverage(item, { posts = [], news = [], backlog = [] }, { loose = false, now = Date.now() } = {}) {
  const key = normalizeUrl(item.link).replace(/^https:\/\//, '').split('#')[0];
  const inBody = (body) => body && body.toLowerCase().includes(key.toLowerCase()) && key.split('/').length > 2;
  // Incidents (loose): another outlet's headline about an incident we already covered still counts as covered.
  // Only security and online-safety posts are compared, and only recent ones (45 days) also by their opening
  // paragraph, which carries the numbers and names; older how-tos would match on words like "client" or "Outlook".
  const same = loose ? sameIncident : sameTopic;
  const candidates = loose ? posts.filter((p) => !p.topic || INCIDENT_TOPICS.includes(p.topic)) : posts;
  const recent = (p) => p.date && now - Date.parse(p.date) < 45 * 86400e3;
  const intro = (p) => (loose && recent(p) ? (p.body ?? '').replace(/^---[\s\S]*?\n---/, '').slice(0, 600) : '');
  const post =
    posts.find((p) => inBody(p.body)) ??
    candidates.find((p) => same(item.title, `${p.title} ${p.slug.replace(/-/g, ' ')} ${intro(p)}`));
  const newsHit = news.find((n) => inBody(n.body));
  const backlogHit = backlog.find((b) => !b.done && same(item.title, `${b.title} ${b.slug.replace(/-/g, ' ')}`));
  return { post: post ?? null, news: newsHit ?? null, backlog: backlogHit ?? null };
}

/** Parse automation/backlog.md lines: "- [ ] slug | title | ..." */
export function parseBacklog(md) {
  return md.split(/\r?\n/).map((line) => line.match(/^- \[( |x)\] ([a-z0-9-]+) \| ([^|]+)/)).filter(Boolean)
    .map((m) => ({ done: m[1] === 'x', slug: m[2], title: m[3].trim() }));
}

// ---------- decisions ----------

/** A launch headline without its announcement wording, for backlog titles: "Now available: X" -> "X". */
export function cleanTitle(title = '') {
  return title.replace(/^(introducing|announcing|now available|new|available now|coming soon|update)\s*[:\-–—]?\s*/i, '').replace(/[.!]+$/, '').trim();
}

export const istDate =(t = Date.now()) => new Date(new Date(t).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

/** Fast-track publishes and attempts on one IST date, from radar/results.jsonl entries and "writing" state. */
export function todayCounts(results, state, today) {
  const r = results.filter((x) => x.date === today && !x.dryRun);
  const writing = Object.values(state.seen ?? {}).filter((s) => s.status === 'writing' && istDate(Date.parse(s.taskAt)) === today);
  return {
    newPublished: r.filter((x) => x.kind === 'new' && x.status === 'published').length + writing.filter((s) => s.kind !== 'update').length,
    updates: r.filter((x) => x.kind === 'update' && x.status === 'published').length + writing.filter((s) => s.kind === 'update').length,
    attempts: r.filter((x) => x.kind === 'new').length + writing.filter((s) => s.kind !== 'update').length,
  };
}

// ---------- site file edits (applied on a fresh checkout, so they never conflict) ----------

export const RADAR_MARK = '<!-- radar fast-track -->';

/** Insert a backlog line at the top of "## Queue" under the radar marker (once). */
export function parkInBacklog(md, line) {
  if (md.includes(line.split(' | ')[0])) return md; // same slug already there
  const lines = md.split('\n');
  let i = lines.findIndex((l) => l.trim() === RADAR_MARK);
  if (i === -1) {
    const q = lines.findIndex((l) => /^## Queue\s*$/.test(l));
    if (q === -1) return `${md.trimEnd()}\n${line}\n`;
    lines.splice(q + 1, 0, '', RADAR_MARK);
    i = q + 2;
  }
  lines.splice(i + 1, 0, line);
  return lines.join('\n');
}

/** Mark a fast-track post published: remove an open item with the same slug, add "- [x]" at the top of "## Published". */
export function markPublished(md, { slug, title, date }) {
  const lines = md.split('\n').filter((l) => !l.startsWith(`- [ ] ${slug} |`));
  if (lines.some((l) => l.startsWith(`- [x] ${slug} |`))) return lines.join('\n');
  const entry = `- [x] ${slug} | ${title} | ${date} (fast-track)`;
  const p = lines.findIndex((l) => /^## Published\s*$/.test(l));
  if (p === -1) lines.push('', '## Published', entry);
  else lines.splice(p + 1, 0, entry);
  return lines.join('\n');
}

/** Append to automation/log.md. Status "fast-track" never matches the daily writer's "| published |" guard. */
export function logLine(md, { date, slug, status, words }) {
  return `${md.replace(/\s*$/, '')}\n${date} | ${slug} | ${status} | ~${words} words\n`;
}

// ---------- fast-track article structure ----------

const REQUIRED_SECTIONS = [
  ['what it is', /^## (what (is|are) |what .{0,60} (is|are|does|do)\b|what it is|.*\bexplained\b)/im],
  ['who it is for and availability', /^## .*(availab|eligib|who (it'?s|this is|it is|is it) for|who can|pricing)/im],
  ['requirements', /^## .*(requirement|before you (start|begin)|prerequisite)/im],
  ['steps', /^## .*(step|how to|set up|turn on|enable|get started)/im],
  ['limitations', /^## .*(limitation|known issues|what it can.?t)/im],
  ['privacy and admin notes', /^## .*(privacy|admin)/im],
  ['what we checked', /^## What we checked\s*$/m],
  ['sources', /^## (Sources|References)\s*$/m],
];

// Security incident guides (automation/RADAR.md, "Security incidents").
const INCIDENT_SECTIONS = [
  ['what happened', /^## What happened\b/im],
  ['am I affected', /^## (Am I affected|Are you affected|Who is affected)/im],
  ['what to do now', /^## What to do\b/im],
  ['how to prevent it', /^## (How to prevent|How to protect|Preventing|Prevention)/im],
  ['what we checked', /^## What we checked\s*$/m],
  ['sources', /^## (Sources|References)\s*$/m],
];
// A bare IPv4 address in an incident guide: indicators must be defanged as published (194.150.166[.]244).
const BARE_IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/;

/** Extra structure check for fast-track how-tos and incident guides (the site's check-posts.mjs gate runs as well). */
export function checkFastTrack(text, { kind = 'new', today, category = 'launch' } = {}) {
  const markdown = text.replace(/\r\n/g, '\n');
  const errors = [];
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  const front = fm?.[1] ?? '';
  const body = fm ? markdown.slice(fm[0].length) : markdown;
  if (kind === 'new') {
    const required = category === 'incident' ? INCIDENT_SECTIONS : REQUIRED_SECTIONS;
    for (const [name, re] of required) if (!re.test(body)) errors.push(`missing a "## ..." section for: ${name}`);
    if (!/^faqs:/m.test(front)) errors.push('missing faqs in frontmatter (the FAQ)');
    if (category === 'incident') {
      const ip = body.match(BARE_IPV4);
      if (ip) errors.push(`incident: IP address ${ip[0]} is not defanged; write indicators exactly as the source publishes them, e.g. 192.0.2[.]1`);
    }
  } else {
    if (!/^updated:\s*'?\d{4}-\d{2}-\d{2}'?\s*$/m.test(front)) errors.push('update: frontmatter needs updated: YYYY-MM-DD');
    if (today && !new RegExp(`\\*\\*Updated ${today}[:.]?\\*\\*|\\*\\*Updated \\d{1,2} \\w+ \\d{4}[:.]?\\*\\*`).test(body)) {
      errors.push(`update: add a dated "**Updated ${today}:**" note near the top`);
    }
  }
  const sources = body.split(/^## (?:Sources|References)\s*$/m)[1] ?? '';
  if (!/https:\/\//.test(sources)) errors.push('the Sources section lists no https:// links');
  return errors;
}
