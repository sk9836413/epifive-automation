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

// ---------- status pages (category "outage") ----------
// Status items carry three extra fields that scoreOutage gates on: status (the latest incident status),
// impact (none|minor|major|critical) and components (affected services; single Cloudflare PoPs are dropped).

// A Statuspage component that is one data center ("St. Louis, United States - (STL)"), not a service.
const POP_COMPONENT = /\([A-Z]{3}\)\s*$/;
const anchorSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Atlassian Statuspage /api/v2/incidents.json (GitHub, Cloudflare). Scheduled maintenance is a separate endpoint, so none here. */
export function parseStatuspage(body, { url }) {
  const j = JSON.parse(body);
  if (!Array.isArray(j.incidents)) throw new Error('not a Statuspage incidents.json');
  const origin = new URL(url).origin;
  return j.incidents.map((i) => ({
    title: stripTags(i.name ?? ''),
    link: `${origin}/incidents/${i.id}`,
    guid: i.id,
    date: toIso(i.started_at ?? i.created_at),
    updated: toIso(i.updated_at),
    summary: stripTags(i.incident_updates?.[0]?.body ?? '').slice(0, 700),
    categories: [],
    status: String(i.status ?? '').toLowerCase(),
    impact: String(i.impact ?? 'none').toLowerCase(),
    components: (i.components ?? []).map((c) => c.name).filter((n) => n && !POP_COMPONENT.test(n)),
  })).filter((i) => i.title);
}

const GOOGLE_IMPACT = { high: 'critical', medium: 'major', low: 'minor' };
const unmark = (s = '') => String(s).replace(/\*\*([^*]*)\*\*/g, '$1 ').replace(/\s+/g, ' ').trim();

/** Google status dashboards' incidents.json (Google Workspace, Google Cloud). */
export function parseGoogleStatus(body, { page }) {
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error('not a Google incidents.json');
  return arr.map((i) => {
    const desc = unmark(i.external_desc ?? '').replace(/^(Summary|Title|Description)\s*:?\s*/i, '');
    const first = desc.split(/(?<=[.!?])\s|\s(?:Description|Symptoms|Workaround)\s*:/)[0].slice(0, 160);
    const resolved = Boolean(i.end) || i.most_recent_update?.status === 'AVAILABLE';
    let impact = GOOGLE_IMPACT[i.severity] ?? 'minor';
    if (i.status_impact === 'SERVICE_OUTAGE' && impact === 'major') impact = 'critical';
    const regions = new Set([...(i.currently_affected_locations ?? []), ...(i.previously_affected_locations ?? [])].map((l) => l.id ?? l.title));
    return {
      title: `${i.service_name ?? 'Google'}: ${first}`,
      link: new URL(i.uri, page).toString(),
      guid: i.id,
      date: toIso(i.begin),
      updated: toIso(i.modified),
      summary: unmark(i.most_recent_update?.text ?? '').slice(0, 700),
      categories: [],
      status: resolved ? 'resolved' : 'investigating',
      impact,
      components: (i.affected_products ?? []).map((p) => p.title).filter(Boolean),
      regions: regions.size,
    };
  }).filter((i) => i.title && i.link);
}

const MS_IMPACT = (s) => (/interruption|outage/i.test(s) ? 'critical' : /degradation|investigating|recovery|restoring|mitigat/i.test(s) ? 'major' : 'minor');

/** status.cloud.microsoft/api/posts/<page>: one post (or an array) with Title, Message and Status; "Available" = no incident. */
export function parseMsStatus(body, { page }) {
  const j = JSON.parse(body);
  const posts = Array.isArray(j) ? j : [j];
  if (!posts.every((p) => p && typeof p === 'object' && 'Status' in p)) throw new Error('not a Microsoft status post');
  return posts.filter((p) => p.Title && !/^(available|operational)$/i.test(p.Status ?? '')).map((p) => {
    const when = [p.AuthoredDateTime, p.LastUpdatedTime].find((t) => t && !t.startsWith('0001'));
    const summary = stripTags(p.Message ?? '');
    // The admin-center post lists each affected service as "- Exchange Online: ...".
    const components = [...summary.matchAll(/(?:^|\s)- ([A-Z][\w .()-]{2,40}?):/g)].map((m) => m[1].trim());
    return {
      title: stripTags(p.Title),
      // The page has one URL; a dated anchor keeps one key per incident and day (normalizeUrl keeps #YYYY-MM-DD-slug).
      link: `${page}#${String(when ?? '').slice(0, 10)}-${anchorSlug(p.Title)}`,
      guid: p.Id ?? anchorSlug(p.Title),
      date: toIso(when),
      updated: toIso(p.LastUpdatedTime),
      summary: summary.slice(0, 700),
      categories: [],
      status: String(p.Status).toLowerCase(),
      impact: MS_IMPACT(p.Status),
      components,
    };
  });
}

/** RSS status feeds where every item shares one link (AWS): a dated anchor from the guid keeps items apart. */
function anchorFromGuid(items) {
  return items.map((i) => {
    const frag = (i.guid.split('#')[1] ?? i.guid).replace(/_\d+$/, '');
    return { ...i, link: `${i.link.split('#')[0]}#${String(i.date ?? '').slice(0, 10)}-${anchorSlug(frag)}-${anchorSlug(i.title).slice(0, 30)}`, components: [frag] };
  });
}

export function parseSource(body, source) {
  switch (source.type) {
    case 'rss':
    case 'atom':
      return source.anchorFromGuid ? anchorFromGuid(parseFeed(body)) : parseFeed(body);
    case 'statuspage-json':
      return parseStatuspage(body, source);
    case 'google-status-json':
      return parseGoogleStatus(body, source);
    case 'ms-status-json':
      return parseMsStatus(body, source);
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
  if (source.category === 'outage') return scoreOutage(item, source, { now, freshHours });
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

/**
 * Score an item from a security news feed: a service outage on a major platform (scoreOutage) or a security
 * incident (scoreSecurity), whichever applies; when both do, the higher score wins.
 */
export function scoreIncident(item, source, opts = {}) {
  const sec = scoreSecurity(item, source, opts);
  if (!outageTerm(`${item.title ?? ''} ${item.summary ?? ''}`)) return sec;
  const out = scoreOutage(item, source, opts);
  if (out.reject && !/^(stale|dated in the future)/.test(out.reject)) return sec;
  if (sec.reject && !/^(stale|dated in the future)/.test(sec.reject)) return out;
  return out.score > sec.score ? out : sec;
}

/** Score a security-incident item. Same return shape as scoreItem, plus category and a suggested site topic. */
function scoreSecurity(item, source, { now = Date.now(), freshHours = 36 } = {}) {
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

// ---------- service outages ----------
// A big outage on a platform EpiFive readers depend on becomes a "what happened / how to check status / what to
// do now" guide (automation/RADAR.md, "Outages"). Found on security/tech news feeds (scoreIncident routes here)
// and on official status pages (sources with "category": "outage"), which are gated to large incidents only.

// Platform family -> name pattern. The family is also the de-duplication key: one outage guide per family at a time.
export const OUTAGE_PLATFORMS = [
  ['microsoft', /\b(microsoft 365|m365|office 365|outlook(\.com)?|microsoft teams|exchange online|azure|onedrive|sharepoint( online)?|microsoft copilot|copilot)\b/i],
  ['google', /\b(google workspace|gmail|google cloud|gcp|google drive|google meet|google docs)\b/i],
  ['aws', /\b(aws|amazon web services)\b/i],
  ['cloudflare', /\bcloudflare\b/i],
  ['github', /\bgithub\b/i],
  ['whatsapp', /\bwhatsapp\b/i],
  ['upi', /\b(upi|npci|bhim|phonepe|paytm|google pay|gpay)\b/i],
  ['sbi', /\b(sbi|state bank of india|yono)\b/i],
  ['hdfc', /\bhdfc( bank)?\b/i],
  ['icici', /\bicici( bank)?\b/i],
  ['axis', /\baxis bank\b/i],
  ['kotak', /\bkotak( mahindra)?( bank)?\b/i],
  ['bank-in', /\b(punjab national bank|pnb|bank of baroda|canara bank|union bank of india|yes bank|indusind|idfc first|au small finance|indian banks?)\b/i],
];
const OUTAGE_TOPIC = { microsoft: 'microsoft-365', google: 'small-business-it', aws: 'cloud', cloudflare: 'cloud', github: 'ai-engineering', whatsapp: 'how-to-tips' };
const INDIA_FAMILIES = new Set(['upi', 'sbi', 'hdfc', 'icici', 'axis', 'kotak', 'bank-in']);
const PLATFORM_SOURCE = OUTAGE_PLATFORMS.map(([, re]) => re.source.replace(/^\\b\(|\)\\b$/g, '')).join('|');

/** Platform families named in a text (["microsoft"], ["upi", "sbi"], ...). */
export function outageFamilies(text = '') {
  return OUTAGE_PLATFORMS.filter(([, re]) => re.test(text)).map(([f]) => f);
}

const STRONG_OUTAGE = /\b(outages?|service incidents?|(went|goes|going) down)\b/i;
const SOFT_OUTAGE = /\b(disruptions?|disrupt(s|ed|ing)?|degraded|degradation|not working|unable to (access|connect|sign in|log ?in|send|load)|connectivity (issues?|problems?)|service (issues?|problems?))\b/i;
// Phrasal verbs and money words that make "down" not an outage: "shuts down", "cracks down", "prices are down".
const DOWN_NOT_OUTAGE_PREV = /^(shut|shuts|crack|cracks|cracked|step|steps|stepped|cut|cuts|bring|brings|brought|back|backs|turn|turns|turned|break|breaks|tone|tones|slow|slows|scale|scales|scaled|wind|winds|let|lets|track|tracks|tracked|narrow|narrows|hunt|hunts|hand|hands|water|watered|mark|marked|write|written|put|puts|sit|sits|lay|lays|calm|knock|knocks|knocked|take|takes|took|taken|tear|tears|pin|pins|play|plays|played|clamp|clamps|clamped|bear|bears|settle|settles|count|counts|go|goes|went|going|is|are|was|were|been|remains|remain|still)$/i;
const DOWN_FINANCE = /\b(shares?|stocks?|prices?|revenue|sales|profits?|earnings|growth|numbers|figures|rates?|inflation|market|index|sensex|nifty|usage|subscribers)\s+(is|are|was|were|went|goes|has gone|have gone)\s+down\b/i;
const PLATFORM_BEFORE = new RegExp(`\\b(?:${PLATFORM_SOURCE})(?:\\s+(?:services?|apps?|email|mail|login|servers?|website|payments?|transactions?))?\\s*(?:is\\s+|are\\s+|was\\s+|were\\s+)?$`, 'i');

/**
 * The outage wording in a text: { term, strong } or null. "down" counts only as an outage ("Outlook down",
 * "Gmail is down", "went down", "down for thousands") — never in download, crackdown, shutdown, "shuts down",
 * "cracks down on", "down payment" or "shares are down".
 */
export function outageTerm(text = '') {
  const strong = text.match(STRONG_OUTAGE);
  if (strong) return { term: strong[0], strong: true };
  for (const m of text.matchAll(/\bdown\b/gi)) {
    const before = text.slice(0, m.index);
    const prev = before.match(/([a-z]+)\s*$/i)?.[1] ?? '';
    const next = text.slice(m.index + 4).match(/^\s*([a-z0-9$₹%]+)/i)?.[1] ?? '';
    if (/^(payments?|to|by|from|on|with|the|\d.*|[$₹%].*|side|grade|load|time|stream|wards?|town)$/i.test(next)) continue;
    if (DOWN_FINANCE.test(text.slice(Math.max(0, m.index - 40), m.index + 4))) continue;
    const isWas = /^(is|are|was|were|been|remains|remain|still|went|goes|going|go)$/i.test(prev);
    const before2 = before.replace(/\s*\b(is|are|was|were|been|remains|remain|still)\s*$/i, '');
    if (PLATFORM_BEFORE.test(before) || PLATFORM_BEFORE.test(before2) ||
        (isWas && /^(for|worldwide|globally|across|again|in|after|since|nationwide|across)$/i.test(next)) ||
        (!DOWN_NOT_OUTAGE_PREV.test(prev) && /^(for|worldwide|globally|nationwide|across)$/i.test(next) && /\b(users|customers|services?|thousands|millions)\b/i.test(text))) {
      return { term: `${prev} down`.trim(), strong: true };
    }
  }
  const soft = text.match(SOFT_OUTAGE);
  return soft ? { term: soft[0], strong: false } : null;
}

// Never a new article: planned work, and outages that are over (those can only update an existing outage guide).
export const SCHEDULED = /\b(scheduled|planned) (maintenance|downtime|work|outage)\b|\bmaintenance (window|notice|scheduled)\b|\bwill be performing\b|^\s*scheduled\b/i;
const RESOLVED_TITLE = /\b(resolved|restored|fixed|fixes|mitigated|recovered|back (up|online|to normal)|is back|are back|ends?|ended|over)\b|\[resolved\]|operating normally/i;
const RESOLVED_STATUS = /^(resolved|postmortem|completed|service restored|restored|post-incident report published|false positive|available|operational)$/i;
/** A status post that now says the outage is over (its status, or "resolved"/"[Resolved]" in the title). */
export const statusClosed = (item) => RESOLVED_STATUS.test(String(item.status ?? '').trim()) || /\[resolved\]|\bresolved\b/i.test(item.title ?? '');
// Retrospectives (root cause, PIR) and explainers: update material for an existing guide, not a new one.
const OUTAGE_RETRO = /\b(root cause|post-incident|postmortem|post-mortem|rca|pir|explains? (what|why|how)|blames?|lessons|anniversary|a year after|last year|how to prepare|outage insurance|what caused)\b/i;
const OUTAGE_WIDE = /\b(multiple|several|many|all) ((\w+|aws|google|github|microsoft 365) )?(services|products|regions|data ?cent(er|re)s|locations|apps)\b|\bmultipleservices\b|\bwidespread\b|\bglobal(ly)?\b|\bworldwide\b|\bnationwide\b|\ball (users|customers)\b|\bmajor outage\b|\bmassive\b/i;
const OUTAGE_SCALE = /\b(massive|major|huge|widespread|worldwide|global(ly)?|nationwide|across india|across the (us|world|globe)|thousands|millions|lakhs?|hundreds of thousands)\b/i;
// Headlines that mention outages without one happening: features, tools, insurance.
const OUTAGE_NOT_EVENT = /\b(adds?|introduc(es|ing|ed)|launch(es|ed)?|new feature|now lets|outage (alerts?|insurance|maps?|trackers?|detection))\b/i;
export const OUTAGE_UPDATE = /\b(resolved|restored|mitigat\w*|recover(ed|y)|fixed|back (up|online|to normal)|root cause|post-incident|preliminary|pir|rca|explains?|confirm(s|ed)?|caused by|credits?)\b/i;
const IMPACT_RANK = { none: 0, maintenance: 0, minor: 1, major: 2, critical: 3 };

/** Impact and status of an RSS status item (AWS, Azure) from its wording, when the feed has no structured fields. */
function statusFromText(item) {
  const t = `${item.title} ${item.summary ?? ''}`;
  const status = /\[resolved\]|operating normally|\bresolved\b|\bmitigated\b|\brecovered\b/i.test(item.title) ? 'resolved' : 'investigating';
  const impact = /service disruption|\boutage\b|unavailable|unable to/i.test(t) ? 'critical'
    : /degradation|degraded|increased (error|latenc)|elevated (error|latenc)|performance issues|connectivity issues/i.test(t) ? 'major' : 'minor';
  return { status, impact };
}

/**
 * Score a service-outage item. News items need outage wording and a major platform; status-page items need an
 * open incident (not scheduled, not resolved) with impact >= source.minImpact (default major) that is large:
 * critical with >= source.minComponentsCritical services (default 1), or >= source.minComponents services
 * (default 3), or multi-region/multi-service wording, or a source flagged assumeMajor (pages that only post big
 * incidents). Same return shape as scoreItem plus category "outage", topic, families and resolved.
 * Resolved items are not rejected (so they can update an existing outage guide) but are never queued.
 */
export function scoreOutage(item, source, { now = Date.now(), freshHours = 36 } = {}) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };
  const title = item.title ?? '';
  const text = `${title} ${item.summary ?? ''}`;
  const statusPage = source.category === 'outage';
  const families = statusPage ? [source.platform ?? 'status'] : outageFamilies(text);
  const family = families[0];
  const base = { category: 'outage', families, topic: source.category === 'outage' ? source.topic ?? OUTAGE_TOPIC[family] ?? 'cloud' : INDIA_FAMILIES.has(family) ? 'online-safety' : OUTAGE_TOPIC[family] ?? source.topic ?? 'cloud', resolved: false };

  const st = statusPage && !item.status ? statusFromText(item) : { status: item.status ?? '', impact: item.impact ?? '' };
  if (SCHEDULED.test(title) || st.status === 'scheduled' || /maintenance/.test(st.impact) || (statusPage && SCHEDULED.test((item.summary ?? '').slice(0, 120)))) {
    return { score: 0, reasons: ['scheduled maintenance'], reject: 'scheduled maintenance', ...base };
  }
  const term = statusPage ? { term: 'status-page incident', strong: true } : outageTerm(text);
  if (!term) return { score: 0, reasons: ['no outage wording'], reject: 'not an outage', ...base };
  if (!families.length) return { score: 0, reasons: ['no major platform named'], reject: 'outage outside the major platforms', ...base };

  if (statusPage) {
    const comps = item.components ?? [];
    const rank = IMPACT_RANK[st.impact] ?? 0;
    // Scope from the headline and the component list only: update text says "global load balancing" or "all users"
    // about small incidents too.
    const wide = OUTAGE_WIDE.test(`${title} ${comps.join(' ')}`) || (item.regions ?? 0) >= (source.minRegions ?? 3);
    // criticalProducts: products big enough on their own when critical (Gmail yes, Google Keep no).
    const keyProduct = source.criticalProducts ? comps.some((c) => new RegExp(source.criticalProducts, 'i').test(c)) : false;
    const big = source.assumeMajor ||
      (rank >= IMPACT_RANK.critical && (comps.length >= (source.minComponentsCritical ?? 1) || keyProduct)) ||
      (rank >= IMPACT_RANK[source.minImpact ?? 'major'] && (comps.length >= (source.minComponents ?? 3) || wide));
    const scope = `impact ${st.impact || 'n/a'}, ${comps.length} service(s)${item.regions ? `, ${item.regions} region(s)` : ''}`;
    if (!big) return { score: 0, reasons: [`small status incident (${scope})`], reject: 'below the major-incident gate', ...base };
    add(source.weight ?? 0, `source ${source.id}`);
    add(6, `status-page incident "${st.status || 'open'}"`);
    add(3, `major platform (${family})`);
    add(2, `large incident (${scope}${wide ? ', multi-service/region' : ''})`);
    if (RESOLVED_STATUS.test(st.status)) base.resolved = true;
  } else {
    add(source.weight ?? 0, `source ${source.id}`);
    // Outage wording in the headline is the story; only in the summary it is often a passing mention.
    const inTitle = outageTerm(title);
    if (inTitle) add(inTitle.strong ? 6 : 4, `outage "${inTitle.term}"`);
    else add(term.strong ? 4 : 2, `outage "${term.term}" (summary only)`);
    add(3, `major platform (${families.slice(0, 3).join(', ')})`);
    if (OUTAGE_SCALE.test(text)) add(1, `scale "${text.match(OUTAGE_SCALE)[0]}"`);
    const named = new Set((text.match(new RegExp(`\\b(${PLATFORM_SOURCE}|teams|copilot|onedrive|word|excel)\\b`, 'gi')) ?? []).map((m) => m.toLowerCase()));
    if (named.size >= 3) add(1, `several services (${[...named].slice(0, 4).join(', ')})`);
    if (INCIDENT_NOISE.test(title)) add(-5, `not an outage report "${title.match(INCIDENT_NOISE)[0]}"`);
    else if (OUTAGE_NOT_EVENT.test(title)) add(-4, `feature or explainer, not an outage "${title.match(OUTAGE_NOT_EVENT)[0]}"`);
    if (RESOLVED_TITLE.test(title)) base.resolved = true;
    if (/downdetector|user reports|reports? (from|by) users/i.test(text)) reasons.push('user reports (Downdetector) are claims: label them');
    // Only the strongly negative feed categories (Gaming, Deals) apply: security-tuned boosts don't fit outages.
    const boosts = source.categoryBoost ?? {};
    const neg = (item.categories ?? []).reduce((n, c) => n + (boosts[c] !== undefined && boosts[c] <= -3 ? boosts[c] : 0), 0);
    add(neg, `category (${(item.categories ?? []).slice(0, 3).join(', ')})`);
  }
  if (OUTAGE_RETRO.test(title)) base.resolved = true;
  if (base.resolved) reasons.push('resolved or retrospective: may update an existing outage guide, never a new one');
  if (item.alsoIn?.length) add(1, `also on ${item.alsoIn.slice(0, 2).join(', ')}`);

  // An open incident that started long ago is still news while the status page keeps updating it.
  const stamps = [item.date, statusPage && !base.resolved ? item.updated : null].map((d) => Date.parse(d ?? '')).filter((t) => !Number.isNaN(t));
  const ageHours = stamps.length ? (now - Math.max(...stamps)) / 3600e3 : null;
  if (ageHours !== null && ageHours > freshHours) return { score, reasons, reject: `stale (${Math.round(ageHours)}h old)`, ageHours, ...base };
  if (ageHours !== null && ageHours < -24) return { score, reasons, reject: 'dated in the future', ageHours, ...base };
  return { score, reasons, reject: null, ageHours, ...base };
}

/** Two outage items about the same platform family (one guide per family at a time). */
export const sameOutage = (a, b) => {
  const fa = a.families ?? outageFamilies(a.title);
  const fb = new Set(b.families ?? outageFamilies(b.title));
  return fa.some((f) => fb.has(f)) || sameIncident(a.title, b.title);
};

/**
 * Pick the next new fast-track: within the normal daily caps the best queued item; once those are used up, a
 * queued outage may take the one extra "major outage" slot (maxOutageExtraPerDay). Returns { key, extra } or null.
 */
export function pickNewTask(queued, counts, { maxNewPerDay = 2, maxAttemptsPerDay = 3, maxOutageExtraPerDay = 1 } = {}) {
  if (!queued.length) return null;
  if (counts.newPublished < maxNewPerDay && counts.attempts < maxAttemptsPerDay) return { key: queued[0][0], extra: false };
  if ((counts.outageExtra ?? 0) < maxOutageExtraPerDay) {
    const o = queued.find(([, s]) => s.category === 'outage');
    if (o) return { key: o[0], extra: true };
  }
  return null;
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
    const hit = recent.filter((r) => (r.category ?? 'incident') === 'incident').find((r) => sameIncident(x.item.title, r.title)) ??
      kept.find((k) => sameIncident(x.item.title, k.item.title))?.item;
    if (hit) {
      x.dupOf = hit.title;
      x.reasons.push(`same incident as "${hit.title.slice(0, 60)}"`);
    } else kept.push(x);
  }
  // Outages: one per platform family (a news report and the status page about the same Microsoft 365 outage,
  // or day two of it, are one outage). Open incidents are kept before resolved ones, then the higher score.
  const keptOut = [];
  const outs = [...scored].filter((s) => s.category === 'outage').sort((a, b) => (a.resolved - b.resolved) || b.score - a.score);
  for (const x of outs) {
    const me = { title: x.item.title, families: x.families };
    const hit = recent.filter((r) => r.category === 'outage').find((r) => sameOutage(me, r)) ??
      keptOut.find((k) => sameOutage(me, { title: k.item.title, families: k.families }))?.item;
    if (hit) {
      x.dupOf = hit.title;
      x.reasons.push(`same outage as "${hit.title.slice(0, 60)}"`);
    } else keptOut.push(x);
  }
  return scored;
}

/** Signal that a covered launch, incident or outage has news worth an update. */
export const updateSignal = (text, category = 'launch') =>
  (category === 'incident' ? INCIDENT_UPDATE : category === 'outage' ? OUTAGE_UPDATE : UPDATE_SIGNAL).test(text);

/** Backlog slug from a headline. */
export const slugify = (title) => tokens(title).filter((w) => /^[a-z0-9]+$/.test(w)).slice(0, 7).join('-') || 'launch';

/** Backlog line for a launch or incident that could not be fast-tracked (daily cap or failed gate). */
export function backlogLine({ title, date, topic, link, category = 'launch', reason, slug }) {
  const t = cleanTitle(title);
  const day = String(date ?? '').slice(0, 10);
  if (category === 'incident') {
    return `- [ ] ${slug ?? slugify(t)} | ${t}: what happened and what to do (incident ${day}) | ${topic} | incident guide (what happened / am I affected / what to do now / how to prevent it), primary sources first, from ${link} (fast-track incident, ${reason})`;
  }
  if (category === 'outage') {
    return `- [ ] ${slug ?? slugify(t)} | ${t}: what happened, status and what to do (outage ${day}) | ${topic} | outage guide (what happened / how to check status / what users and admins can do / SLA credits / post-incident review), vendor status pages first, from ${link} (fast-track outage, ${reason})`;
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

// Root-cause news about an outage: a headline about the cause or the vendor's review, or a status post that states
// it ("Root cause: ..."). Not the promise in every Microsoft update ("we will share a full Post-Incident Report").
const ROOT_CAUSE_TITLE = /\b(root[- ]cause|post-incident|postmortem|post-mortem|rca|pir|caused|blame[sd]?|explains?|cause of|what (caused|went wrong))\b/i;
const ROOT_CAUSE_TEXT = /\broot cause\s*:\s*(?!n\/?a\b)\w|\bpost-incident report (?:has been |is )?(?:now )?(?:published|available)|\bpreliminary post-incident (?:report|review) (?:has been |is )?(?:now )?(?:published|available)/i;
export const isRootCauseNews = (item) => ROOT_CAUSE_TITLE.test(item.title ?? '') || ROOT_CAUSE_TEXT.test(item.summary ?? '');

/**
 * Find what already covers an item.
 * posts: [{ slug, title, date, body }], news: [{ slug, body }], backlog: [{ slug, title, done }]
 */
export function findCoverage(item, { posts = [], news = [], backlog = [] }, { loose = false, now = Date.now(), category, families } = {}) {
  const key = normalizeUrl(item.link).replace(/^https:\/\//, '').split('#')[0];
  const inBody = (body) => body && body.toLowerCase().includes(key.toLowerCase()) && key.split('/').length > 2;
  if (category === 'outage') {
    // An outage guide (a "## Post-incident review" section, or "outage"/"down" in its title or slug) from the last
    // 7 days on the same platform family covers every later report of that outage; older ones never do.
    const fam = families ?? outageFamilies(`${item.title} ${item.summary ?? ''}`);
    // A root-cause follow-up ("pir: pending" in its front matter) takes the vendor's root-cause news (a PIR/RCA, or a
    // headline about the cause) and stays open to it for 14 days, since a final PIR can come days after resolution.
    // Every other update (status, resolved) goes to the outage guide itself (no "pir:" key), as before.
    const awaitingPir = (p) => /^pir:\s*['"]?pending\b/m.test(p.body ?? '');
    const followUp = (p) => /^pir:/m.test(p.body ?? '');
    const rootCause = isRootCauseNews(item);
    const age = (p) => now - Date.parse(p.date);
    const fresh = (p) => p.date && (age(p) < 7 * 86400e3 || (rootCause && awaitingPir(p) && age(p) < 14 * 86400e3));
    const isOutagePost = (p) => /^## Post-incident review/im.test(p.body ?? '') || /\b(outages?|down)\b/i.test(`${p.title} ${p.slug.replace(/-/g, ' ')}`);
    const live = posts.filter((p) => fresh(p) && isOutagePost(p));
    const matches = [...live.filter((p) => inBody(p.body)),
      ...live.filter((p) => sameOutage({ title: item.title, families: fam }, { title: `${p.title} ${p.slug.replace(/-/g, ' ')}` }))];
    const post = (rootCause ? matches.find(awaitingPir) : matches.find((p) => !followUp(p))) ?? matches.find((p) => age(p) < 7 * 86400e3);
    const backlogHit = backlog.find((b) => !b.done && sameOutage({ title: item.title, families: fam }, { title: `${b.title} ${b.slug.replace(/-/g, ' ')}` }) && /outage/i.test(b.title));
    return { post: post ?? null, news: news.find((n) => inBody(n.body)) ?? null, backlog: backlogHit ?? null };
  }
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

/**
 * Fast-track publishes and attempts on one IST date, from radar/results.jsonl entries and "writing" state.
 * Tasks that used the major-outage extra slot (extra: true) count only toward outageExtra (attempts, any outcome).
 */
export function todayCounts(results, state, today) {
  const r = results.filter((x) => x.date === today && !x.dryRun && x.type !== 'alert');
  const writing = Object.values(state.seen ?? {}).filter((s) => s.status === 'writing' && istDate(Date.parse(s.taskAt)) === today);
  const rn = r.filter((x) => !x.extra);
  const wn = writing.filter((s) => !s.extra);
  return {
    newPublished: rn.filter((x) => x.kind === 'new' && x.status === 'published').length + wn.filter((s) => s.kind !== 'update').length,
    updates: r.filter((x) => x.kind === 'update' && x.status === 'published').length + writing.filter((s) => s.kind === 'update').length,
    attempts: rn.filter((x) => x.kind === 'new').length + wn.filter((s) => s.kind !== 'update').length,
    outageExtra: r.filter((x) => x.extra && x.kind === 'new').length + writing.filter((s) => s.extra && s.kind !== 'update').length,
  };
}

// ---------- trending videos ----------

/**
 * Views on a trending topic (a big outage, a security incident) come in the first hours, so right after the radar
 * publishes such a fast-track article the write job starts the Short (social.yml) and the long video (longvideo.yml
 * with publish_now: public on YouTube and on the Facebook Page at once instead of the fixed 14:00 UTC slot).
 * Trending = category outage or incident, or a score of at least minScore. At most maxPerDay pairs a UTC day
 * (radar/results.jsonl entries with autoVideo = that day), so it never fights the daily long video slot: when the
 * daily long video is not made yet, the trending one replaces it (longvideo.yml skips the daily run once today's
 * log has a YouTube URL). Consumer topics (bank leaks, phones) get the Short only: the long video is a Microsoft
 * 365-style screen walkthrough, which has nothing to show there.
 */
export const AUTO_VIDEO = {
  minScore: 12,
  categories: ['outage', 'incident'],
  maxPerDay: 1,
  shortOnlyTopics: ['online-safety', 'mobiles', 'laptops-hardware', 'how-to-tips'],
};

const HOOK_EXAMPLE = { outage: '"Outlook down right now?"', incident: '"Is your account affected?"', launch: '"It is live today:"' };

export function autoVideoPlan({ task = {}, status, slug, topic = '', title = '', results = [], longVideoLog = '', now = Date.now(), settings = AUTO_VIDEO } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const no = (reason) => ({ dispatch: false, reason, day });
  if (task.kind !== 'new') return no('not a new fast-track article');
  if (status !== 'published') return no(`the article was not published (${status || 'no result'})`);
  if (!/^[a-z0-9-]+$/.test(slug ?? '')) return no('no valid slug');
  const category = ['outage', 'incident'].includes(task.category) ? task.category : 'launch';
  const score = Number(task.score) || 0;
  const why = settings.categories.includes(category) ? `category ${category}` : score >= settings.minScore ? `score ${score} >= ${settings.minScore}` : null;
  if (!why) return no(`not trending (category ${category}, score ${score} < ${settings.minScore})`);
  const used = results.filter((r) => r.autoVideo === day && !r.dryRun).length;
  if (used >= settings.maxPerDay) return no(`daily cap reached (${used}/${settings.maxPerDay} trending video pair on ${day} UTC)`);
  const long = !settings.shortOnlyTopics.includes(topic);
  const dailyDone = longVideoLog.split(/\r?\n/).some((l) => l.startsWith(`- ${day} | `) && l.includes(' | yt: https://'));
  const subject = String(title || task.title || slug).replace(/[\r\n"`$\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const brief = `TRENDING NOW (${category}): "${subject}". People are searching for this right now and the video goes out at once. `
    + `Hook in the first second: open on the problem exactly as the viewer is living it (e.g. ${HOOK_EXAMPLE[category]}), no intro, `
    + 'then what to do now. Facts and times only as the article states them.';
  return {
    dispatch: true, reason: why, day, slug, category, score, short: true, long,
    ...(long ? { replacesDaily: !dailyDone } : { longSkipped: `topic ${topic} gets the Short only` }),
    brief,
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
// Outage guides (automation/RADAR.md, "Outages").
const OUTAGE_SECTIONS = [
  ['what happened', /^## What happened\b/im],
  ['how to check status', /^## How to check (the )?(service )?status\b/im],
  ['what users can do now', /^## What users can do\b/im],
  ['what admins should do', /^## What admins should do\b/im],
  ['SLA credits', /^## SLA credits?\b/im],
  ['post-incident review', /^## Post-incident review\b/im],
  ['what we checked', /^## What we checked\s*$/m],
  ['sources', /^## (Sources|References)\s*$/m],
];
// "Status as of 10:30 IST, 13 November 2026" (any wording around it, but a time and IST).
const STATUS_AS_OF = /\bas of\b[^\n]{0,40}?\b\d{1,2}:\d{2}\s*(am|pm|a\.m\.|p\.m\.)?\s*IST\b/i;
const sectionText = (body, re) => {
  const m = body.match(re);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
};

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
    const required = category === 'incident' ? INCIDENT_SECTIONS : category === 'outage' ? OUTAGE_SECTIONS : REQUIRED_SECTIONS;
    for (const [name, re] of required) if (!re.test(body)) errors.push(`missing a "## ..." section for: ${name}`);
    if (!/^faqs:/m.test(front)) errors.push('missing faqs in frontmatter (the FAQ)');
    if (category === 'incident') {
      const ip = body.match(BARE_IPV4);
      if (ip) errors.push(`incident: IP address ${ip[0]} is not defanged; write indicators exactly as the source publishes them, e.g. 192.0.2[.]1`);
    }
    if (category === 'outage') {
      const timeline = sectionText(body, /^## What happened\b.*$/im);
      if (timeline && !/\bIST\b/.test(timeline)) errors.push('outage: the "What happened" timeline needs times in IST');
      if (timeline && !/\b(ET|EST|EDT|Eastern)\b/.test(timeline)) errors.push('outage: the "What happened" timeline needs times in ET as well as IST');
    }
  } else {
    if (!/^updated:\s*'?\d{4}-\d{2}-\d{2}'?\s*$/m.test(front)) errors.push('update: frontmatter needs updated: YYYY-MM-DD');
    if (today && !new RegExp(`\\*\\*Updated ${today}[:.]?\\*\\*|\\*\\*Updated \\d{1,2} \\w+ \\d{4}[:.]?\\*\\*`).test(body)) {
      errors.push(`update: add a dated "**Updated ${today}:**" note near the top`);
    }
  }
  if (category === 'outage') {
    if (!STATUS_AS_OF.test(body)) errors.push('outage: state the status with a timestamp, e.g. "Status as of 10:30 IST, 13 November 2026"');
    if (!/^Last tested:/m.test(sectionText(body, /^## What we checked\s*$/m))) errors.push('outage: end "## What we checked" with a "Last tested:" line');
  }
  const sources = body.split(/^## (?:Sources|References)\s*$/m)[1] ?? '';
  if (!/https:\/\//.test(sources)) errors.push('the Sources section lists no https:// links');
  return errors;
}
