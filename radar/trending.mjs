// Trending tier of the "Tech news today" page (Tier 2 only; owner asked 15 Nov 2026 after the radar missed big general
// tech stories such as a chipmaker CEO's resignation, the FAA ground stop, a Starship catch, an AI lab's IPO talk and
// robotaxi pre-orders). Pure functions, no network and no files: unit-tested in brief.test.mjs.
//
// Sources: news aggregators with role "trending" in sources.json (Techmeme, Google News feeds) plus the reputable news
// feeds the radar already reads (sources with an "outlet" name: The Verge, TechCrunch, Engadget, BleepingComputer).
//
// A story qualifies only when it is trending:
//   - Techmeme lists it among its top headlines, or
//   - 3 or more distinct reputable outlets (REPUTABLE) cover it (items clustered by topic, company and title similarity;
//     Google News' own grouping of other outlets' stories counts too),
// and it is about an allowed topic (trendTopic):
//   - leadership changes and IPOs / valuations at major tech companies (COMPANIES),
//   - big product, AI model, space and EV milestones at those companies,
//   - critical-infrastructure outages (FAA / aviation, airlines, banks, payments, telecom, 911).
// Never: routine earnings, stock moves on their own, small-startup funding, deals and promos, opinion and analysis.
// Safety (brief.mjs TREND_BLOCKED): no personal allegations, scandals, relationships, crime or investigations. A hit
// keeps only the neutral headline fact ("X resigns as CEO") from a clean outlet headline, or drops the story.
// The item is "Reported by <outlet>" with a link to that outlet; lines are a neutral 2-4 sentence factual summary.
// Own cap (BRIEF.trendingMaxPerDay, 4 a day, enforced in mergeIntoDays); deduplicated against the day pages of the last
// 3 days and recent articles. Clearly-IT outages (lib.mjs outageFamilies: Microsoft, AWS, Google, ...) do not use this
// tier: they go through the existing outage logic (scoreOutage).
import { tokens, normalizeUrl, hashText, stripTags, outageFamilies, sameTopic } from './lib.mjs';
import { BRIEF, TREND_BLOCKED, INVEST_ADVICE, briefHeadline, detectAiModel } from './brief.mjs';

// [canonical name, outlet-name pattern, host pattern]. Order = attribution preference (wire services first).
export const REPUTABLE = [
  ['Reuters', /^reuters(\.com)?$/i, /(^|\.)reuters\.com$/],
  ['AP', /^(ap|ap news|associated press|the associated press)$/i, /(^|\.)apnews\.com$/],
  ['Bloomberg', /^bloomberg(\.com| news)?$/i, /(^|\.)bloomberg\.com$/],
  ['CNBC', /^cnbc(\.com)?$/i, /(^|\.)cnbc\.com$/],
  ['WSJ', /^(wsj|the wall street journal|wall street journal)$/i, /(^|\.)wsj\.com$/],
  ['Financial Times', /^(ft|ft\.com|financial times|the financial times)$/i, /(^|\.)ft\.com$/],
  ['The New York Times', /^((the )?new york times|nyt)$/i, /(^|\.)nytimes\.com$/],
  ['The Washington Post', /^(the )?washington post$/i, /(^|\.)washingtonpost\.com$/],
  ['BBC', /^bbc( news|\.com)?$/i, /(^|\.)bbc\.(com|co\.uk)$/],
  ['CNN', /^cnn( business)?$/i, /(^|\.)cnn\.com$/],
  ['Axios', /^axios$/i, /(^|\.)axios\.com$/],
  ['The Information', /^the information$/i, /(^|\.)theinformation\.com$/],
  ['The Verge', /^(the )?verge$/i, /(^|\.)theverge\.com$/],
  ['TechCrunch', /^techcrunch$/i, /(^|\.)techcrunch\.com$/],
  ['Ars Technica', /^ars technica$/i, /(^|\.)arstechnica\.com$/],
  ['Wired', /^wired$/i, /(^|\.)wired\.com$/],
  ['Engadget', /^engadget$/i, /(^|\.)engadget\.com$/],
  ['GeekWire', /^geekwire$/i, /(^|\.)geekwire\.com$/],
  ['ZDNet', /^zdnet$/i, /(^|\.)zdnet\.com$/],
  ['The Register', /^the register$/i, /(^|\.)theregister\.com$/],
  ['BleepingComputer', /^bleepingcomputer$/i, /(^|\.)bleepingcomputer\.com$/],
];
const hostOf = (link) => {
  try {
    return new URL(link).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};
/** The canonical reputable outlet for an outlet name or article link, or null (Google News links say nothing). */
export function reputableOutlet(name = '', link = '') {
  const n = String(name).trim();
  const host = hostOf(link);
  const hit = REPUTABLE.find(([, re, hre]) => re.test(n) || (host && !/news\.google\.com$/.test(host) && hre.test(host)));
  return hit ? hit[0] : null;
}
const rank = (outlet) => {
  const i = REPUTABLE.findIndex(([n]) => n === outlet);
  return i === -1 ? 99 : i;
};

// Major tech companies (and space agencies / robotaxi makers for milestones). Entity = the first one named.
export const COMPANIES = [
  ['microsoft', /\bMicrosoft\b/], ['apple', /\bApple\b/], ['google', /\b(Google|Alphabet|DeepMind)\b/], ['amazon', /\b(Amazon|AWS)\b/],
  ['meta', /\bMeta\b/], ['nvidia', /\bNvidia\b/i], ['openai', /\bOpenAI\b/i], ['anthropic', /\bAnthropic\b/i],
  ['tesla', /\b(Tesla|Cybercab|Cybertruck)\b/i], ['spacex', /\b(SpaceX|Starship|Starlink)\b/i], ['intel', /\bIntel\b/], ['amd', /\bAMD\b/],
  ['salesforce', /\bSalesforce\b/i], ['oracle', /\bOracle\b/], ['ibm', /\bIBM\b/], ['samsung', /\bSamsung\b/i], ['qualcomm', /\bQualcomm\b/i],
  ['broadcom', /\bBroadcom\b/i], ['tsmc', /\b(TSMC|Taiwan Semiconductor)\b/i], ['cisco', /\bCisco\b/], ['xai', /\b(xAI|X Corp)\b/],
  ['nasa', /\bNASA\b/], ['blue-origin', /\bBlue Origin\b/i], ['waymo', /\bWaymo\b/i],
];
/** The company named first in a text, or the one named nearest to position `near` (e.g. the "CEO" or "IPO" word). */
export function firstCompany(text = '', near = null, only = null) {
  let best = null;
  for (const [id, re] of COMPANIES) {
    if (only && !only.includes(id)) continue;
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      const d = near === null || near < 0 ? m.index : Math.abs(m.index - near);
      if (!best || d < best.d) best = { id, d };
    }
  }
  return best?.id ?? null;
}

const ROLE = /\b(CEO|chief executive( officer)?|CFO|CTO|COO|chief (financial|technology|operating|product|AI|people|revenue) officer|chair(man|woman|person)?|president|co-?founder)\b/i;
const CHANGE = /\b(resign(s|ed|ing|ation)?|steps? down|stepping down|stepped down|ousted|ousts?|fired|fires|depart(s|ed|ing|ure)?|exits?|exited|leaves|leaving|to leave|retir(e|es|ed|ing|ement)|succeeds?|succeeded|replac(e|es|ed|ing)|interim|appoint(s|ed|ment)?|names? .{1,40} (as )?(new |interim )?(ceo|chief|president|chair)|named (as )?(new |interim )?(ceo|chief|president|chair)|new (ceo|chief executive)|takes? over|took over|transition|succession|shake-?up)\b/i;
const IPO = /\b(IPO|initial public offering|go(es|ing)? public|files? (confidentially )?(for an ipo|to go public)|public (listing|debut|offering)|market debut|direct listing|valuation|valued at|S-1)\b/i;
const SPACE = /\b(Starship|Super Heavy|Falcon (9|Heavy)|New Glenn|Artemis|Orion|Dragon|rocket|booster|orbit(al)?|spacecraft|lunar|moon|Mars|splashdown|launch (pad|tower))\b/i;
const SPACE_MILESTONE = /\b(catch(es)?|caught|captur(e|es|ed)|land(s|ed|ing)?|launch(es|ed)?|lift(s|ed)? off|liftoff|reach(es|ed)? orbit|first|historic|history|record|returns?|returned|success(ful|fully)?|milestone|test flight|flight \d+|docks?|docked)\b/i;
const EV = /\b(Cybercab|robotaxis?|Cybertruck|Model [3SXYQ]|Tesla Semi|Optimus|FSD|full self-driving|driverless|self-driving|autonomous (car|vehicle|ride|taxi)s?)\b/i;
const EV_MILESTONE = /\b(pre-?orders?|orders?|buy|invites?|reservations?|on sale|goes on sale|sales|launch(es|ed)?|unveil(s|ed)?|deliver(y|ies|s|ed)|first|begins?|began|starts?|opens?|approv(al|ed|es)|permits?|expands?|rollout|rolls? out|production)\b/i;
const VEHICLE = /\b(Starship|Super Heavy|Falcon 9|Falcon Heavy|New Glenn|Artemis [IV]+|Orion|Crew Dragon|Starliner|Cybercab|Cybertruck|Optimus|Model [3SXYQ]|Tesla Semi)\b/i;
const PRODUCT = /\b(launch(es|ed)?|unveil(s|ed)?|introduc(es|ed)|announc(es|ed)|releas(es|ed)|debuts?|rolls? out|now available|goes on sale|ships|begins shipping)\b/i;
// Critical infrastructure families (checked in this order) and outage wording.
export const INFRA = [
  ['aviation', /\b(FAA|air traffic|ground stop|airlines?|flights?|airports?|TSA|NOTAM)\b/i],
  ['911', /\b(911|E911|emergency (services|calls?|lines?|dispatch))\b/i],
  ['payments', /\b(payments?|Visa|Mastercard|card (payments|transactions)|PayPal|Venmo|Zelle|Stripe|point[- ]of[- ]sale)\b/i],
  ['banking', /\b(banks?|banking|ATMs?|Chase|Wells Fargo|Bank of America|Citibank|Capital One)\b/i],
  ['telecom', /\b(telecoms?|telecommunications|cell(ular)? (service|network)s?|mobile networks?|wireless (service|network)s?|carriers?|AT&T|Verizon|T-Mobile|phone (service|lines|network)s?)\b/i],
];
const INFRA_OUTAGE = /\b(ground stop|outages?|went down|is down|are down|(system|network|computer|technical|IT|software|equipment|telecoms?) (failure|outage|glitch|issue|problem|malfunction)s?|glitch(es)?|halt(s|ed)?|grounded|disrupt(s|ed|ion|ions)?|blackout)\b/i;

const TREND_RUMOUR = /\b(rumou?r(s|ed)?|leak(s|ed)?|spotted|unconfirmed|tipped|teases?|teased)\b/i;
const EARNINGS = /\b(earnings|results|quarterly (results|revenue|profit|sales)|(q[1-4]|first|second|third|fourth)[- ]quarter|fiscal|revenue (rises|falls|jumps|grows|beats|misses)|beats? (estimates|expectations)|miss(es)? (estimates|expectations)|guidance|profit (warning|rises|falls|jumps))\b/i;
const STOCK = /\b(shares?|stocks?|market (cap|value)|sell-?off|rall(y|ies|ied)|plung(e|es|ed)|soar(s|ed)?|tumbl(e|es|ed)|slump(s|ed)?|surg(e|es|ed)|sinks?|sank|jump(s|ed)?|slid(es)?|price target|analysts?|upgrades?|downgrades?|nasdaq|s&p 500|dow jones)\b/i;
const FUNDING = /\b(raises?|raised|raising|funding|series [a-h]|seed round|round led by|venture)\b/i;
const DEALS = /\b(deals?|discounts?|\d+% off|black friday|cyber monday|prime day|gift guide|gifts?|coupons?|promo codes?|save (up to )?\$|best .{1,40} (to buy|for \w+))\b/i;
const OPINION = /^['‘“"]|\b(opinion|op-ed|column|commentary|analysis|editorial|letter|podcast|interview|reviews?|hands[- ]on|i (test|tested|tried|used|switched)|i['’](d|m|ve)|my (favorite|favourite)|why|what .{1,30} means|what to know|how to|who should|should you|our picks|top candidates|lessons|explainer|here['’]s|everything (you need|we know)|poll|quiz|newsletter|live updates|live blog|video|in photos|watch|bullish|bearish|discuss(es|ing)?|hear|listen|timeline|highlights)\b/i;
const NOT_MILESTONE = /\b(layoffs?|job cuts|fines?|fined|antitrust|regulators?|court|judge|ruling|bans?|banned|tariffs?|lobby\w*|senators?|congress|white house|lawmakers)\b/i;

/**
 * Allowed topic of a headline: { topic: leadership|ipo|milestone|infra-outage, entity, key } or { reject: why }.
 * key ("leadership:nvidia", "infra-outage:aviation") is the dedupe key for the trending tier across sources and days.
 */
export function trendTopic(title = '') {
  const t = stripTags(title);
  const ok = (topic, entity) => ({ topic, entity, key: `${topic}:${entity}` });
  if (TREND_RUMOUR.test(t)) return { reject: 'rumour' };
  if (DEALS.test(t)) return { reject: 'deal or promo' };
  if (OPINION.test(t)) return { reject: 'opinion, analysis or media piece' };
  if (INFRA_OUTAGE.test(t)) {
    // Clearly IT (a platform the outage guides cover): the existing outage logic, not this tier.
    if (outageFamilies(t).length) return { reject: 'IT outage (existing outage logic)' };
    const fam = INFRA.find(([, re]) => re.test(t));
    if (fam) return ok('infra-outage', fam[0]);
  }
  const entity = firstCompany(t);
  if (!entity) return { reject: 'no major tech company or critical infrastructure' };
  const leadership = ROLE.test(t) && CHANGE.test(t);
  if (EARNINGS.test(t) && !leadership && !IPO.test(t)) return { reject: 'earnings' };
  // The company the change or the IPO is about: the one named nearest the "CEO" / "IPO" word.
  if (leadership) return ok('leadership', firstCompany(t, t.search(ROLE)));
  if (IPO.test(t)) return ok('ipo', firstCompany(t, t.search(IPO)));
  if (FUNDING.test(t)) return { reject: 'funding round' };
  if (STOCK.test(t)) return { reject: 'stock move' };
  if (NOT_MILESTONE.test(t)) return { reject: 'policy, legal or jobs news' };
  // Milestones also carry the vehicle or model they are about ("starship", "gpt-6"), so differently worded headlines
  // about it join one story (clusterTrending).
  const thing = (s) => (s ? s.toLowerCase().replace(/\s+/g, ' ') : null);
  if (SPACE.test(t) && SPACE_MILESTONE.test(t)) return { ...ok('milestone', firstCompany(t, null, ['spacex', 'nasa', 'blue-origin']) ?? entity), thing: thing(t.match(VEHICLE)?.[0]) };
  if (EV.test(t) && EV_MILESTONE.test(t)) return { ...ok('milestone', firstCompany(t, null, ['tesla', 'waymo']) ?? entity), thing: thing(t.match(VEHICLE)?.[0]) };
  const ai = detectAiModel({ title: t, link: '' }, {});
  if (ai?.kind === 'release') return { ...ok('milestone', entity), thing: thing(ai.model) };
  if (PRODUCT.test(t)) return ok('milestone', entity);
  return { reject: 'not an allowed topic' };
}

/**
 * The neutral headline fact when a headline hits the safety filter: the first clause, if it is clean and still about
 * the same thing ("Nvidia CEO resigns amid ... investigation" -> "Nvidia CEO resigns"). Null when nothing clean is left.
 */
export function neutralHeadline(title, key) {
  const t = stripTags(title);
  if (!TREND_BLOCKED.test(t) && !INVEST_ADVICE.test(t)) return t;
  const first = t.split(/\s+(?:amid|after|over|following|as|because|due to|while|despite|with|in wake of)\s+|\s*[;:,—–]\s+|\s+-\s+/i)[0].trim();
  if (first && first.length >= 15 && !TREND_BLOCKED.test(first) && !INVEST_ADVICE.test(first) && trendTopic(first).key === key) return first;
  return null;
}

// Words every headline about a story shares that say nothing about which story it is.
const GENERIC = new Set(('says said say report reports reported source sources first company after amid over could would may ' +
  'year week day time people million billion us u.s world global ceo chief executive').split(' '));
const sig = (s) => tokens(s).filter((w) => !GENERIC.has(w));

/** Two headlines about the same story (looser than sameTopic; used only inside one topic + company). */
export function similarTitles(a, b) {
  const A = sig(a);
  const B = new Set(sig(b));
  const shared = A.filter((w) => B.has(w)).length;
  return shared >= 3 || (shared >= 2 && shared / Math.max(1, Math.min(A.length, B.size)) >= 0.4);
}

/**
 * Group trending entries into stories. entries: [{ title, outlet, link, date, summary, techmeme, related, sourceId, topic }].
 * Leadership, IPO and infrastructure-outage entries group by key (one such story per company or family at a time);
 * milestones also need similar titles or the same vehicle or model (two Apple launches the same day are two stories).
 */
export function clusterTrending(entries) {
  const clusters = [];
  for (const e of entries) {
    const near = clusters.filter((c) => c.key === e.topic.key && (e.topic.topic !== 'milestone' ||
      c.members.some((m) => (e.topic.thing && m.topic.thing === e.topic.thing) || similarTitles(m.title, e.title))));
    if (!near.length) {
      clusters.push({ key: e.topic.key, topic: e.topic.topic, entity: e.topic.entity, members: [e] });
      continue;
    }
    // Single linkage: an entry that joins two clusters merges them.
    const [keep, ...rest] = near;
    keep.members.push(e);
    for (const r of rest) {
      keep.members.push(...r.members);
      clusters.splice(clusters.indexOf(r), 1);
    }
  }
  for (const c of clusters) {
    const outlets = new Set();
    for (const m of c.members) {
      const o = reputableOutlet(m.outlet, m.link);
      if (o) outlets.add(o);
      for (const r of m.related ?? []) {
        const ro = reputableOutlet(r.outlet, r.link);
        if (ro) outlets.add(ro);
      }
    }
    c.outlets = outlets;
    c.techmeme = c.members.some((m) => m.techmeme);
    c.trending = c.techmeme || outlets.size >= 3;
  }
  return clusters;
}

// Side angles of a big story (who was stuck, which team was late): never the headline when a direct one exists.
const SIDE_ANGLE = /\b(sports?|teams?|games?|fans?|travell?ers?|stranded|students?|college|nfl|nba|mlb|nhl|nwsl|football|basketball|baseball|concerts?|weddings?|the athletic)\b/i;

const TOPIC_POINTS = { 'infra-outage': 3, leadership: 2, ipo: 2, milestone: 1 };

/**
 * Pick the trending stories for the day page. pool: raw items from the trending sources and the reputable news feeds
 * (each { title, link, date, summary, outlet, related, techmeme, source }). Returns { items, skipped, clusters } where items
 * are day-page items (same shape as brief.mjs briefItem, plus trending: true, trendKey, topic, techmeme) best first.
 *
 * listed: items already on the day pages of the lookback days and this run's other candidates ([{ headline, key, trendKey, day }]).
 * posts: site articles ([{ slug, title, date }]); a story an article from the last 3 days covers is not listed again.
 */
export function selectTrending(pool, { now = Date.now(), today, freshHours = 36, listed = [], posts = [] } = {}) {
  const ist = (t) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
  const skipped = [];
  const entries = [];
  for (const it of pool) {
    const t = Date.parse(it.date ?? '');
    if (Number.isNaN(t) || now - t > freshHours * 3600e3 || t - now > 24 * 3600e3) continue;
    const topic = trendTopic(it.title);
    if (!topic.key) continue;
    entries.push({
      title: stripTags(it.title), outlet: it.outlet ?? it.source?.outlet ?? '', link: it.link, date: it.date, t, summary: it.summary ?? '',
      techmeme: Boolean(it.techmeme), related: it.related ?? [], sourceId: it.source?.id ?? 'news', topic,
    });
  }
  const clusters = clusterTrending(entries);
  const listedKeys = listed.map((x) => ({ ...x, tk: x.trendKey ?? trendTopic(x.headline ?? x.title ?? '').key }));
  const recentPosts = posts.filter((p) => p.date && now - Date.parse(p.date) < 3 * 86400e3);
  const items = [];
  for (const c of clusters) {
    const newest = Math.max(...c.members.map((m) => m.t));
    const label = c.members[0].title.slice(0, 90);
    if (!c.trending) {
      skipped.push({ title: label, why: `not trending (${c.outlets.size} reputable outlet(s), not on Techmeme)` });
      continue;
    }
    // Today's page lists today's news (or the last 6 hours, just after midnight IST).
    if (today && ist(newest) !== today && now - newest > 6 * 3600e3) continue;
    // Who reports it: a reputable outlet whose own headline is about the same story and clean; else its neutral fact.
    const reps = [];
    for (const m of c.members) {
      const outlet = reputableOutlet(m.outlet, m.link);
      if (outlet) reps.push({ ...m, outlet });
      for (const r of m.related ?? []) {
        const ro = reputableOutlet(r.outlet, r.link);
        if (ro && trendTopic(r.title).key === c.key) reps.push({ title: stripTags(r.title), outlet: ro, link: r.link, date: m.date, t: m.t, summary: '', sourceId: m.sourceId });
      }
    }
    const direct = (x) => (/news\.google\.com/.test(hostOf(x.link)) ? 1 : 0);
    // Headlines about the story itself, not a side angle ("sports teams scramble after ..."): keep those sharing the
    // most words with the rest of the cluster. Then wire services first, a direct article link over a Google News
    // redirect, the latest (most complete) headline.
    const all = c.members.map((m) => m.title);
    const central = (x) => {
      const A = sig(x.title);
      return all.reduce((n, o) => (o === x.title ? n : n + A.filter((w) => new Set(sig(o)).has(w)).length), 0) / Math.sqrt(Math.max(1, A.length));
    };
    for (const r of reps) r.central = central(r);
    const top = Math.max(0, ...reps.map((r) => r.central));
    reps.sort((a, b) => (SIDE_ANGLE.test(a.title) - SIDE_ANGLE.test(b.title)) || (b.central >= top * 0.6) - (a.central >= top * 0.6) ||
      rank(a.outlet) - rank(b.outlet) || direct(a) - direct(b) ||
      (STOCK.test(a.title) - STOCK.test(b.title)) || (b.t ?? 0) - (a.t ?? 0) || a.title.length - b.title.length);
    let pick = null;
    let headline = null;
    for (const r of reps) {
      if (STOCK.test(r.title) && c.topic !== 'ipo') continue;
      const h = neutralHeadline(r.title, c.key);
      if (h) {
        pick = r;
        headline = h;
        break;
      }
    }
    if (!reps.length) {
      skipped.push({ title: label, why: 'no reputable outlet to attribute' });
      continue;
    }
    if (!pick) {
      skipped.push({ title: label, why: 'safety filter: no neutral headline fact' });
      continue;
    }
    const dup = listedKeys.find((x) => x.tk === c.key || (x.key && x.key === normalizeUrl(pick.link)));
    if (dup) {
      skipped.push({ title: headline, why: `already listed${dup.day ? ` ${dup.day}` : ''} (${c.key})` });
      continue;
    }
    const post = recentPosts.find((p) => trendTopic(p.title ?? '').key === c.key || sameTopic(headline, `${p.title} ${p.slug.replace(/-/g, ' ')}`));
    if (post) {
      skipped.push({ title: headline, why: `covered by /blog/${post.slug}` });
      continue;
    }
    const cleanSummary = headline === pick.title ? String(pick.summary ?? '') : '';
    const ai = c.topic === 'milestone' ? detectAiModel({ title: headline, link: '' }, {}) : null;
    const time = pick.t <= now ? new Date(pick.t).toISOString() : new Date(now).toISOString();
    const x = {
      id: hashText(normalizeUrl(pick.link)).padStart(8, '0'),
      key: normalizeUrl(pick.link),
      time,
      seen: new Date(now).toISOString(),
      kind: c.topic === 'infra-outage' ? 'outage' : ai?.kind === 'release' ? 'ai-model' : 'trending',
      topic: c.topic,
      tier: 2,
      trending: true,
      trendKey: c.key,
      techmeme: c.techmeme,
      headline: briefHeadline(headline),
      summary: stripTags(cleanSummary).slice(0, 700),
      lines: [],
      linesBy: null,
      source: { name: pick.outlet, url: pick.link },
      sourceId: pick.sourceId,
      sourceMax: BRIEF.trendingMaxPerDay,
      reported: true,
      also: [...c.outlets].filter((o) => o !== pick.outlet).sort((a, b) => rank(a) - rank(b)),
      post: null,
      device: null,
      ai: ai?.kind === 'release' ? { model: ai.model, kind: ai.kind } : null,
      score: 6 + (c.techmeme ? 2 : 0) + Math.min(c.outlets.size, 6) + (TOPIC_POINTS[c.topic] ?? 0),
    };
    x.story = x.ai ? `ai:${x.ai.model.toLowerCase().replace(/\s+/g, ' ')}:${x.ai.kind}` : `trend:${c.key}`;
    items.push(x);
  }
  items.sort((a, b) => b.score - a.score);
  return { items, skipped, clusters: clusters.length };
}
