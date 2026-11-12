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
export function findCoverage(item, { posts = [], news = [], backlog = [] }) {
  const key = normalizeUrl(item.link).replace(/^https:\/\//, '').split('#')[0];
  const inBody = (body) => body && body.toLowerCase().includes(key.toLowerCase()) && key.split('/').length > 2;
  const post =
    posts.find((p) => inBody(p.body)) ??
    posts.find((p) => sameTopic(item.title, `${p.title} ${p.slug.replace(/-/g, ' ')}`));
  const newsHit = news.find((n) => inBody(n.body));
  const backlogHit = backlog.find((b) => !b.done && sameTopic(item.title, `${b.title} ${b.slug.replace(/-/g, ' ')}`));
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

/** Extra structure check for fast-track how-tos (the site's check-posts.mjs gate runs as well). */
export function checkFastTrack(text, { kind = 'new', today } = {}) {
  const markdown = text.replace(/\r\n/g, '\n');
  const errors = [];
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  const front = fm?.[1] ?? '';
  const body = fm ? markdown.slice(fm[0].length) : markdown;
  if (kind === 'new') {
    for (const [name, re] of REQUIRED_SECTIONS) if (!re.test(body)) errors.push(`missing a "## ..." section for: ${name}`);
    if (!/^faqs:/m.test(front)) errors.push('missing faqs in frontmatter (the FAQ)');
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
