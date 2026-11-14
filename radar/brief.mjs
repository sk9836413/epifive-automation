// Tiered news: pure functions for the hourly "Tech news today" page (Tier 2), device launches (Tier 3) and the
// Tier-1 promotions (flagship AI model, flagship device, AI model retirement). No network, no files: unit-tested in
// brief.test.mjs. radar.mjs does the fetching, the Claude call and the file writes.
//
//   Tier 1  full how-to article (radar fast-track, lib.mjs scoreItem + caps in sources.json settings). This module
//           only adds the flagship/retirement floors (tier1Floor).
//   Tier 2  every relevant item from every source: 2-4 factual lines in today's page radar/live/<IST date>.json,
//           served live by the site at /news/live/<date> (one page per day, never one page per item).
//   Tier 3  phone / laptop / desktop / tablet / wearable launches on a manufacturer's own newsroom: queued for the
//           device portal (devices.yml, launch mode, official spec page only) and listed in the day's page.
import { sameTopic, sameIncident, normalizeUrl, hashText, RUMOUR, stripTags, outageFamilies, istDate } from './lib.mjs';

export const BRIEF = {
  maxItemsPerDay: 80, // a day page never grows past this (best scores first)
  maxPerSourcePerDay: 8, // per source, unless the source sets briefMax (AWS What's New, Azure updates: a handful)
  minScore: 3, // briefScore needed for a launch-type item
  lookbackDays: 3, // the same story is not listed again within 3 days (it is upgraded instead)
  maxNewPerRun: 25, // items written per hourly run (one batched Claude call)
  maxLines: 4,
  maxLineChars: 320,
};

// ---------- device launches (Tier 3) ----------

// [brand, family regex (matched on title + summary), category]. The match is the model name as written.
export const DEVICE_MODELS = [
  ['Apple', /\biPhone \d{2}e?(?: (?:Pro Max|Pro|Plus|Air|Mini))?\b|\biPhone Air\b/i, 'phone'],
  ['Apple', /\biPad(?: (?:Pro|Air|mini))?(?: \(?(?:M\d|A\d{2}|\d+(?:st|nd|rd|th) generation)\)?)?(?=[\s,.;:)]|$)/i, 'tablet'],
  ['Apple', /\bMacBook (?:Air|Pro)\b|\biMac\b|\bMac (?:mini|Studio|Pro)\b/i, 'laptop'],
  ['Apple', /\bApple Watch(?: (?:Series \d+|Ultra(?: \d)?|SE(?: \d)?))?\b|\bAirPods(?: (?:Pro(?: \d)?|Max|\d))?\b|\bApple Vision Pro\b/i, 'wearable'],
  ['Samsung', /\bGalaxy (?:S\d{2}(?: ?(?:Ultra|Edge|FE|\+))?|Z (?:Fold|Flip) ?\d+(?: ?FE)?|[AMF]\d{2}(?: ?[45]G)?)\b/i, 'phone'],
  ['Samsung', /\bGalaxy Tab [AS]\d+\w*(?: (?:Ultra|FE|\+))?\b/i, 'tablet'],
  ['Samsung', /\bGalaxy Book ?\d+(?: (?:Pro|Ultra|Edge|360))*\b/i, 'laptop'],
  ['Samsung', /\bGalaxy (?:Watch ?\d+(?: (?:Classic|Ultra|FE))?|Ring|Buds ?\d*(?: (?:Pro|FE))?)\b/i, 'wearable'],
  ['Google', /\bPixel \d{1,2}a?(?: Pro(?: XL| Fold)?)?\b/i, 'phone'],
  ['Google', /\bPixel (?:Watch ?\d+|Buds(?: \d+)?(?: Pro(?: \d)?)?|Tablet)\b/i, 'wearable'],
  ['OnePlus', /\bOnePlus (?:\d{2}R?|Nord(?: CE)? ?\d+(?: Lite)?(?: 5G)?|Pad ?\d*)\b/i, 'phone'],
  ['Xiaomi', /\b(?:Xiaomi \d{2}(?: (?:Pro|Ultra|T Pro|T))?|Redmi (?:Note )?\d{2}\w*(?: (?:Pro\+?|5G))*|POCO [A-Z]\d+(?: Pro)?)\b/i, 'phone'],
  ['vivo', /\b(?:vivo [XVYT]\d{2,3}\w*(?: (?:Pro|FE|Ultra|5G))*|iQOO (?:Neo ?|Z)?\d{1,2}\w*(?: Pro)?)\b/i, 'phone'],
  ['OPPO', /\bOPPO (?:Find X\d+(?: (?:Pro|Ultra))?|Reno ?\d{1,2}(?: (?:Pro|F))?|[AFK]\d+\w*)\b/i, 'phone'],
  ['realme', /\brealme (?:GT ?\d+\w*(?: Pro)?|Narzo ?\d+\w*|P\d+\w*(?: Pro)?|\d{2}(?: Pro\+?)?)\b/i, 'phone'],
  ['Motorola', /\b(?:Motorola )?(?:moto (?:g|edge) ?\d+\w*|edge \d{2}\w*(?: (?:Pro|Ultra|Fusion))?|razr(?: \d{2})?(?: (?:Ultra|\+))?)\b/i, 'phone'],
  ['Nothing', /\bNothing Phone ?\(\d\w?\)|\bCMF Phone ?\d+(?: Pro)?\b/i, 'phone'],
  ['Dell', /\bDell (?:XPS ?\d+|Pro(?: Max)? ?\d+\w*|Inspiron ?\d+|Latitude ?\d+|Precision ?\d+|Alienware \w+ ?\d+\w*|\d{2} Plus)\b|\bAlienware (?:m|x|Area-?)\d+\w*\b/i, 'laptop'],
  ['HP', /\bHP (?:EliteBook|ProBook|Spectre x360|Spectre|Envy|Pavilion|OmniBook|ZBook|Victus|Omen|EliteDesk|ProDesk|EliteOne|Elite Dragonfly)(?: [A-Z]?\d+\w*)*/i, 'laptop'],
  ['Lenovo', /\b(?:Lenovo )?(?:ThinkPad [A-Z]\d+\w*(?: (?:Carbon|Yoga|Nano|Fold|2-in-1|Flip))?(?: Gen \d+)?|ThinkCentre [A-Z]\d+\w*|ThinkBook \d+\w*(?: Gen \d+)?|Yoga (?:Slim |Pro |Book )?\d+\w*|Legion (?:Pro |Go )?\d+\w*|IdeaPad (?:Slim |Pro )?\d+\w*|Lenovo Tab \w+)\b/i, 'laptop'],
  ['ASUS', /\b(?:ASUS )?(?:ROG (?:Zephyrus|Strix|Flow|Ally|Phone)\s?\w*|Zenbook (?:Duo |S |A)?\d*\w*|Vivobook (?:S |Pro )?\d+\w*|ProArt (?:P16|PX13|Studiobook)\w*|ExpertBook [A-Z]\d+\w*|TUF Gaming [A-Z]\d+\w*|Zenfone \d+(?: Ultra)?)\b/i, 'laptop'],
  ['Acer', /\bAcer (?:Swift (?:Go |Air |X )?\d+\w*|Aspire (?:Go |Vero )?\d+\w*|Predator (?:Helios|Triton) ?\w*|Nitro (?:V )?\d+\w*|TravelMate [A-Z]?\d+\w*|Chromebook (?:Plus )?\w+)\b/i, 'laptop'],
  ['Microsoft', /\bSurface (?:Pro|Laptop(?: Studio)?|Go|Studio)(?: \d+(?:th Edition)?)?(?:,? \d{2}(?:\.\d)?-inch)?\b/i, 'laptop'],
  ['MSI', /\bMSI (?:Prestige|Modern|Stealth|Raider|Titan|Katana|Cyborg|Claw|Venture|Summit)(?: [A-Z]?\d+\w*)*/i, 'laptop'],
];
// Sources whose own newsroom announces devices (a manufacturer). Only these start a device page (Tier 3).
export const DEVICE_VENDORS = {
  Apple: /apple\.com$/, Samsung: /samsung\.com$/, Google: /(blog\.google|store\.google\.com)$/, OnePlus: /oneplus\.(in|com)$/,
  Xiaomi: /mi\.com$/, vivo: /vivo\.com$/, OPPO: /oppo\.com$/, realme: /realme\.com$/, Motorola: /motorola(news)?\.com$/,
  Nothing: /nothing\.tech$/, Dell: /dell(technologies)?\.com$/, HP: /hp\.com$/, Lenovo: /lenovo\.com$/, ASUS: /asus\.com$/,
  Acer: /acer\.com$/, Microsoft: /(microsoft\.com|blogs\.windows\.com)$/, MSI: /msi\.com$/,
};
const DEVICE_LAUNCH = /\b(introduc(e|es|ed|ing)|launch(es|ed|ing)?|unveil(s|ed|ing)?|announc(e|es|ed|ing)|meet (the )?(new )?|now available|available (now|today|to (buy|order|pre-?order))|pre-?orders?|on sale|goes on sale|starts? at|priced at|price(d)? in india|debuts?|arrives?|all-new|new)\b/i;
const DEVICE_NOT_LAUNCH = /\b(reviews?|hands[- ]on|deals?|discount|sale event|offers?|how to|tips|tricks|guide|vs\.?|versus|compared?|comparison|best \w+ (for|to)|wallpapers?|case study|update brings|software update|one ui|ios \d+\.\d|android \d+ (beta|update)|tipped|teases?|teased|renders?|expected|rumou?r|leak(s|ed)?|reportedly|spotted|benchmark|certifi(ed|cation)|ahead of (its )?launch|launch date|will launch|to launch|set to|closer to|update|updates)\b/i;
const FLAGSHIP_DEVICE = /\biPhone \d{2}(?: (?:Pro Max|Pro|Plus|Air))?\b|\bGalaxy (?:S\d{2}|Z (?:Fold|Flip) ?\d+)\b|\bPixel \d{1,2}(?: Pro(?: XL| Fold)?)?\b(?!a)/i;

const clean = (s) => s.replace(/\s+/g, ' ').trim();
/** Stable key for one device across sources: brand + model, lowercase, words only ("samsung galaxy s27 ultra"). */
export const deviceKey = (brand, model) => `${brand} ${model.toLowerCase().startsWith(brand.toLowerCase()) ? model.slice(brand.length) : model}`
  .toLowerCase().replace(/[()]/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();

/**
 * Device launch in an item: { brand, model, category, key, flagship, official } or null. Official = the item comes from
 * that brand's own newsroom (the only kind that may start a device page). Launch wording must be in the title.
 */
export function detectDevice(item, source = {}) {
  const title = item.title ?? '';
  const text = `${title} ${item.summary ?? ''}`;
  if (!DEVICE_LAUNCH.test(title) || DEVICE_NOT_LAUNCH.test(title) || RUMOUR.test(text)) return null;
  for (const [brand, re, category] of DEVICE_MODELS) {
    const m = title.match(re);
    if (!m) continue;
    let model = clean(m[0]);
    if (!model.toLowerCase().startsWith(brand.toLowerCase()) && !['Apple', 'Google', 'Microsoft'].includes(brand)) model = `${brand} ${model}`;
    else if (brand === 'Google' && !/^google/i.test(model)) model = `Google ${model}`;
    else if (brand === 'Microsoft' && !/^microsoft/i.test(model)) model = `Microsoft ${model}`;
    else if (brand === 'Apple' && !/^apple/i.test(model)) model = `Apple ${model}`;
    const cat = /\b(watch|buds|airpods|ring|vision)\b/i.test(model) ? 'wearable'
      : /\b(ipad|tab|tablet)\b/i.test(model) ? 'tablet'
        : /\b(imac|mac mini|mac studio|mac pro|thinkcentre|elitedesk|prodesk|eliteone)\b/i.test(model) ? 'desktop' : category;
    let host = '';
    try {
      host = new URL(item.link).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    const official = source.role !== 'signal' && Boolean(DEVICE_VENDORS[brand]?.test(host));
    return { brand, model, category: cat, key: deviceKey(brand, model), flagship: FLAGSHIP_DEVICE.test(model), official };
  }
  return null;
}

/** An existing content/devices slug for this device, if the portal already has it (slugs are brand-first). */
export function findDeviceSlug(device, slugs = []) {
  const want = device.key.split(' ').filter(Boolean);
  const words = (slug) => slug.split('-');
  // Exact model words in order, nothing extra except a region or year suffix ("-in", "-2025", "-5g").
  return slugs.find((slug) => {
    const w = words(slug).filter((x) => !/^(in|5g|4g|\d{4}|wifi|wi|fi|lte)$/.test(x));
    const need = want.filter((x) => !/^(5g|4g)$/.test(x));
    // "apple iphone 18" vs slug "apple-iphone-18": the same; "iphone 18 pro" vs "apple-iphone-18": not.
    return w.length === need.length && need.every((x, i) => w[i] === x);
  }) ?? null;
}

// ---------- AI models ----------

// Model names as vendors write them. Group 0 is the model name.
const AI_MODEL = /\b(GPT-\d+(?:\.\d+)?o?(?:[- ](?:mini|nano|pro|turbo|codex|oss(?:-\d+b)?|realtime|audio|image(?:-\d(?:\.\d)?)?))*|o\d(?:-(?:mini|pro))?|Claude(?: (?:Opus|Sonnet|Haiku|Fable))? \d+(?:\.\d+)?(?: (?:Opus|Sonnet|Haiku))?|Gemini \d+(?:\.\d+)?(?: Deep Think| (?!(?:in|on|is|are|and|for|with|now|to|the|app|apps|api|model|models|gets|brings|comes|available|preview)\b)[a-z]+(?:-Lite)?)?|Gemma ?\d+\w*|Llama ?\d+(?:\.\d+)?(?: \w+)?|(?:Mistral|Magistral|Codestral|Devstral|Ministral|Pixtral)(?: (?:Large|Medium|Small))? ?\d+(?:\.\d+)?|Mixtral|Grok ?\d+(?:\.\d+)?(?: (?:mini|Heavy|Fast))?|Qwen ?\d+(?:\.\d+)?(?:-\w+)?|DeepSeek[- ](?:V|R)\d+(?:\.\d+)?(?:-\w+)?|Phi-\d+(?:\.\d+)?(?:-\w+)?|MAI[- ][A-Za-z]+(?:[- ]\d+(?:\.\d+)?)?(?: Flash)?|(?:Amazon )?Nova (?:Pro|Lite|Micro|Premier|Sonic|Canvas|Reel|Act|2)\w*|Command (?:A|R\+?)(?: \w+)?|Embed \d+|Rerank \d+|Stable (?:Diffusion|Audio|Video) ?\d+(?:\.\d+)?|Midjourney V\d+|Gen-\d+\w*|Eleven (?:v\d|Multilingual v\d|Flash v\d)\w*|Sora ?\d*|Veo \d+(?:\.\d+)?|Imagen \d+|Nemotron(?:[- ]\w+)?)\b/i;
const AI_RELEASE = /\b(introduc(e|es|ed|ing)|launch(es|ed|ing)?|releas(e|es|ed|ing)|publish(es|ed)|unveil(s|ed)?|announc(e|es|ed|ing)|now available|available (now|today|in|on|to)|generally available|general availability|\bga\b|preview|rolling out|roll(s|ing)? out|new model|meet|brings?|arrives?|open[- ]weights?|open[- ]sources?d?|(now )?(in|on) (github copilot|copilot|microsoft foundry|azure|amazon bedrock|bedrock|vertex ai|google cloud|the api|chatgpt|gemini app))\b/i;
const AI_RETIRE = /\b(deprecat\w*|retir(e|es|ed|ing|ement)|shut(ting)? down|sunset\w*|end of (life|support)|no longer available|will be removed)\b/i;
const AI_BUSINESS = /\b(api|azure|openai service|foundry|bedrock|vertex|gemini api|ai studio|platform|enterprise|copilot|deployments?|endpoints?)\b/i;
const PRICE_DROP = /\b(price (cut|drop|reduction)s?|cuts? (the )?prices?|lower(ed)? prices?|cheaper|reduc(e|es|ed) (the )?(price|cost)s?|\d{2}% (lower|cheaper|less|off)|half the (price|cost)|now free)\b/i;
// Flagship families from the four labs the owner named (OpenAI, Anthropic, Google, Meta). Small/cheap tiers are not.
const FLAGSHIP_MODEL = /^(GPT-\d+(?:\.\d+)?(?: pro)?|Claude (?:Opus|Sonnet)? ?\d+(?:\.\d+)?(?: (?:Opus|Sonnet))?|Gemini \d+(?:\.\d+)?(?: [a-z]+)?(?: Deep Think)?|Llama ?\d+(?:\.\d+)?(?: \w+)?)$/i;
const FLAGSHIP_LABS = /(openai\.com|anthropic\.com|claude\.com|blog\.google|deepmind\.google|ai\.google\.dev|aistudio\.google\.com|gemini\.google|ai\.meta\.com|about\.fb\.com)$/;

/** AI model news in an item: { model, kind: release|retire|price, flagship, business } or null. */
export function detectAiModel(item, source = {}) {
  const title = item.title ?? '';
  const text = `${title} ${item.summary ?? ''}`;
  const m = title.match(AI_MODEL) ?? (source.ai ? text.match(AI_MODEL) : null);
  if (!m || RUMOUR.test(title)) return null;
  const model = clean(m[0]);
  const kind = AI_RETIRE.test(text) ? 'retire' : PRICE_DROP.test(text) ? 'price' : AI_RELEASE.test(text) ? 'release' : null;
  if (!kind) return null;
  let host = '';
  try {
    host = new URL(item.link).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const lab = FLAGSHIP_LABS.test(host) && source.role !== 'signal';
  const flagship = lab && kind === 'release' && FLAGSHIP_MODEL.test(model) && !/\b(mini|nano|lite|flash|haiku|small|embedding|decision)\b/i.test(model) && AI_RELEASE.test(title);
  return { model, kind, flagship, priceDrop: kind === 'price' && lab, business: AI_BUSINESS.test(`${text} ${host}`) };
}

// ---------- Tier-1 floors ----------

/**
 * Extra Tier-1 points for what the owner wants as a full how-to regardless of headline wording: a flagship device
 * launch (new iPhone, Galaxy S/Z, Pixel) from the maker's newsroom, a new flagship model from OpenAI, Anthropic,
 * Google or Meta (or a big price drop there), and a retirement of an AI model businesses run in production (Azure
 * OpenAI, Bedrock, the OpenAI/Anthropic/Gemini APIs) due within the retirement window. Returns { points, why } or null.
 */
export function tier1Floor(item, source, { score, threshold = 10, daysToDeadline } = {}) {
  if (source.role === 'signal' || source.category === 'incident' || source.category === 'outage') return null;
  const floor = (why) => ({ points: Math.max(3, threshold + 1 - score), why });
  const device = detectDevice(item, source);
  if (device?.official && device.flagship) return floor(`flagship device launch (${device.model})`);
  const ai = detectAiModel(item, source);
  if (ai?.flagship) return floor(`flagship AI model (${ai.model})`);
  if (ai?.priceDrop) return floor(`AI price drop (${ai.model})`);
  if (ai?.kind === 'retire' && ai.business && daysToDeadline !== null && daysToDeadline !== undefined) {
    return floor(`AI model retirement due in ${Math.max(daysToDeadline, 0)} days (${ai.model})`);
  }
  return null;
}

// ---------- Tier 2: what goes on the day page ----------

const LAUNCH = /\b(introduc(e|es|ed|ing)|launch(es|ed|ing)?|unveil(s|ed)?|now available|available (now|today|in|on|to|for)|generally available|general availability|\bga\b|public preview|in preview|rolling out|roll(s|ing)? out|starting today|is here|now supports?|now supported|supported in|now in|now lets|you can now|adds?|new (feature|model|app|plan|tier|region|version)s?|releas(e|es|ed)|expands? to|arrives?|announc(e|es|ed|ing))\b/i;
const RETIRE = /\b(retir(e|es|ed|ing|ement)|deprecat\w*|end of (extended )?(life|support|sale|updates|servicing)|reach(es)? end of|sunset\w*|shut(ting)? down|will be removed|discontinu\w*|no longer (available|supported))\b/i;
const PRICE = /\b(pric(e|es|ing)|per (user|month|seat|1m tokens|million tokens)|free (tier|plan)|subscription|starts? at)\b|[$₹€£]\s?\d/i;
const SECURITY = /\b(vulnerabilit(y|ies)|cve-\d{4}-\d+|zero[- ]day|actively exploited|patch(es|ed)? (for|now)|security (update|advisory|fix)|breach|ransomware|out-of-band)\b/i;
// Not news for IT and business readers: marketing, explainers, customer stories, finance, events and corporate items.
const NOISE = new RegExp([
  'what is', 'what are', 'explained', 'guides?', 'plain-english', 'how to', 'tips?', 'support tip', 'best practices', 'checklist', 'lessons',
  'playbook', 'case study', 'customer stor(y|ies)', 'how .{1,40} uses?', 'how \\w+ (simplified|built|cut|saved|scaled|reduced|transformed|modernized)',
  'how (ai|\\w+) (is|are) (helping|changing|transforming|reshaping)', 'helps .{1,40} with (openai|chatgpt|claude|gemini|ai)',
  'with (openai|ai) technology', 'webinar', 'podcast', 'recap', 'round-?up', 'what[\'’]s new with', 'this week in', 'week in review', 'weekly',
  'newsletter', 'survey', 'report finds', 'study finds', 'data shows', 'research shows', 'new data', 'predictions?', 'named (a )?leader',
  'leader in', 'magic quadrant', 'forrester wave', 'idc marketscape', 'awards?', 'wins', 'recogni[sz]ed', 'ranked', 'anniversary',
  'celebrat\\w*', 'earnings', 'financial results', 'revenues?', 'quarter(ly)? results', 'fiscal', 'dividend', 'investors?', 'stock',
  'shares', 'acquir\\w*', 'acquisition', 'merger', 'funding', 'raises', 'valuation', 'ipo', 'appoints?', 'appointed',
  'names .{1,40} (ceo|cfo|cto|president|chief)', 'leadership transition', 'steps down', 'board of directors', 'hiring', 'careers?',
  'conference', 'summit', 'keynote', 'on-the-ground', 'catch .{1,40} at', 'join us', 'at (ignite|re:invent|dreamforce|build|next|web summit)',
  'sponsorship', 'partners? with', 'partnership', 'collaborat\\w*', 'alliance', 'teams up', 'joins forces', 'opinion', 'perspective',
  'thought leadership', 'why we', 'our (journey|vision|commitment)', 'sustainability', 'nonprofits?', 'grants?', 'deals?', 'discounts?',
  'holiday', 'black friday', 'gift guide', 'vs\\.?', 'versus', 'should you', 'which .{1,40} (is|are) (better|best|most)',
  'auction', 'treasury bills', 'government (stock|securities)', 'statement of position', 'balance of payments', 'bulletin',
].map((w) => `\\b${w}\\b`).join('|'), 'i');
const INDIA = /\b(india|indian|₹|rs\.?\s?\d|inr|upi|rbi|npci|aadhaar|delhi|mumbai|bengaluru|bangalore)\b/i;
const NICHE = /\b(microsoft 365|m365|copilot|teams|outlook|exchange|sharepoint|onedrive|windows (11|10|server)|azure|entra|intune|google workspace|gmail|gemini|chatgpt|openai|claude|anthropic|aws|amazon (bedrock|q)|salesforce|slack|agentforce|servicenow|sap|zoom|webex|cisco|vmware|okta|crowdstrike|zscaler|palo alto|fortinet|cloudflare|github|docker|kubernetes|terraform|iphone|ipad|mac|android|pixel|galaxy|whatsapp)\b/i;
const OUTAGE_WORDS = /\b(outages?|(is|are|went|goes) down|down for|service disruption|disrupted|not working|unable to (access|sign in|log ?in|send))\b/i;
const INCIDENT_WORDS = /\b(breach(ed|es)?|hack(ed|ers?)|stole|stolen|steal\w*|ransomware|malware|backdoor\w*|exploit(s|ed|ing)?|zero[- ]days?|vulnerabilit(y|ies)|flaws?|cve-\d{4}-\d+|patch(es|ed)?|hijack\w*|spyware|phishing|botnet|takedown|takes down|leak(ed|s)? data|data (leak|exposure))\b/i;

/** The headline without announcement wording ("Introducing: X" -> "X") and trailing punctuation. */
export const briefHeadline = (title = '') => clean(stripTags(title)).replace(/^(introducing|announcing|now available|new|update)\s*[:\-–—]\s*/i, '').replace(/[.!]+$/, '').slice(0, 160);

/**
 * Should an item appear on the day page, and as what? Returns
 * { include, kind, score, reasons, device, ai, reported } where kind is outage|security|retirement|price|ai-model|device|launch.
 *
 * Official sources (vendors, regulators, status pages) start from +2: anything that is not marketing, an explainer, a
 * customer story or corporate/finance news and scores minScore goes on the page; the source weight and briefMax keep
 * high-volume feeds (AWS What's New, the M365 roadmap) to their best few. Aggregators (role "signal") and security
 * news outlets (newsOutlet) are labelled "reported"; aggregators only for device, AI model, outage or security stories.
 * incidentScore / outageScore come from lib.mjs scoring for sources of those categories (computed by the caller).
 */
export function classifyBrief(item, source, { incidentScore = null, outageScore = null, outageCategory = false } = {}) {
  const title = item.title ?? '';
  const text = `${title} ${item.summary ?? ''}`;
  const reasons = [];
  const signalSource = source.role === 'signal';
  const reported = signalSource || Boolean(source.newsOutlet);
  let score = (source.briefWeight ?? source.weight ?? 0) + (signalSource ? 0 : 2);
  const add = (n, why) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`);
  };
  const out = (include, kind, extra = {}) => ({ include, kind, score, reasons, reported, device: null, ai: null, ...extra });

  if (!title || RUMOUR.test(title)) return out(false, 'rumour');
  if (source.category === 'outage') {
    // Status pages: open incidents the outage scorer did not reject (impact / component gates, no maintenance).
    if (outageScore !== null) score = outageScore;
    return out(outageScore !== null, 'outage');
  }
  if (outageCategory) {
    // An outage told by a security or news feed (scoreIncident hands outage wording to scoreOutage).
    if (outageScore !== null) score = outageScore;
    return out(outageScore !== null && outageScore >= 6, 'outage');
  }
  if (source.category === 'incident') {
    // Security feeds: a scored incident (4+), or a headline about an attack, breach or exploited flaw.
    if (NOISE.test(title)) return out(false, 'security');
    const words = INCIDENT_WORDS.test(title);
    score = incidentScore ?? (words ? 3 : -99);
    if (words) reasons.push(`security ("${title.match(INCIDENT_WORDS)[0]}")`);
    return out((incidentScore !== null && incidentScore >= 4) || words, 'security');
  }

  const device = detectDevice(item, source);
  const ai = detectAiModel(item, source);
  if (NOISE.test(title)) add(-5, `not news ("${title.match(NOISE)[0]}")`);
  else if (/^[^:]{3,40}:\s*['‘“"]/.test(title)) add(-5, 'quote headline (interview/opinion)');
  if (device) add(4, `device launch (${device.model})`);
  if (ai) add(ai.flagship ? 5 : 3, `AI model ${ai.kind} (${ai.model})`);
  if (LAUNCH.test(title)) add(2, `launch "${title.match(LAUNCH)[0]}"`);
  else if (LAUNCH.test(text) && !signalSource) add(1, 'launch wording');
  const retire = RETIRE.test(title);
  if (retire) add(3, 'retirement/deprecation');
  if (PRICE.test(text)) add(1, 'price/plans');
  const security = SECURITY.test(title) || (signalSource && INCIDENT_WORDS.test(title));
  if (security) add(signalSource ? 4 : 2, 'security');
  const outage = signalSource && OUTAGE_WORDS.test(title);
  if (outage) add(4, 'outage');
  if (NICHE.test(text)) add(1, `audience ("${text.match(NICHE)[0]}")`);
  if (INDIA.test(text)) add(1, 'India');
  const boosts = source.categoryBoost ?? {};
  let cat = 0;
  for (const c of item.categories ?? []) if (boosts[c] !== undefined) cat += boosts[c];
  if (!(item.categories ?? []).length && boosts['(none)'] !== undefined) cat += boosts['(none)'];
  add(cat, `category (${(item.categories ?? []).slice(0, 2).join(', ') || 'none'})`);
  if (item.alsoIn?.length) add(1, `also on ${item.alsoIn.slice(0, 2).join(', ')}`);

  const kind = outage ? 'outage' : retire ? 'retirement' : device ? 'device' : ai ? 'ai-model' : PRICE_DROP.test(title) ? 'price'
    : security ? 'security' : 'launch';
  // Aggregator-only stories need a device, AI model, outage or security angle and a higher bar.
  if (signalSource) return out(Boolean(device || ai || security || outage) && score >= BRIEF.minScore + 1, kind, { device, ai });
  // Official items without launch, retirement, price, security, device or model wording need one point more.
  const news = Boolean(device || ai || retire || security || LAUNCH.test(text) || PRICE_DROP.test(title));
  return out(score >= BRIEF.minScore + (news ? 0 : 1) + (source.briefMin ?? 0), kind, { device, ai });
}

// ---------- de-duplication across sources and days ----------

/** Entity key for a story: a device or AI model when there is one ("device:samsung galaxy s27", "ai:gpt-6.1:release"). */
export function storyKey(x) {
  if (x.device?.key) return `device:${x.device.key}`;
  if (x.kind === 'outage' && x.families?.length) return `outage:${[...x.families].sort().join('+')}:${istDate(Date.parse(x.time ?? '') || Date.now())}`;
  if (x.ai?.model) return `ai:${x.ai.model.toLowerCase().replace(/\s+/g, ' ')}:${x.ai.kind}`;
  return null;
}

/** Same story told by two sources (or two days): same link, same entity, or the same headline in other words. */
export function sameStory(a, b) {
  if (a.key && b.key && a.key === b.key) return true;
  const ka = a.story ?? storyKey(a);
  const kb = b.story ?? storyKey(b);
  if (ka && kb) return ka === kb;
  const ta = a.headline ?? a.title ?? '';
  const tb = b.headline ?? b.title ?? '';
  if (a.kind === 'security' || b.kind === 'security') return sameIncident(ta, tb);
  return sameTopic(ta, tb) || sameTopic(tb, ta);
}

const official = (x) => !x.reported;

/**
 * Merge new candidates into the day pages. days = { 'YYYY-MM-DD': page } for today and the lookback days (pages are
 * { date, items: [] }). Returns { added: [items placed on today's page], upgraded: [existing items that got an official
 * source or another outlet], skipped: [{ title, why }] }. Pages are edited in place.
 *
 * - The same story already listed within lookbackDays is not listed again: an official source replaces a "reported"
 *   one (and the item is re-written), other outlets are noted in "also".
 * - Candidates are taken best score first, within the per-source and per-day caps.
 */
export function mergeIntoDays(candidates, days, today, { now = Date.now(), caps = BRIEF } = {}) {
  const page = days[today];
  const added = [];
  const upgraded = [];
  const skipped = [];
  const listed = Object.values(days).flatMap((d) => d.items.map((it) => ({ it, day: d.date })));
  const perSource = {};
  for (const it of page.items) perSource[it.sourceId] = (perSource[it.sourceId] ?? 0) + 1;
  const ordered = [...candidates].sort((a, b) => (official(b) - official(a)) || b.score - a.score);
  for (const c of ordered) {
    const hit = listed.find(({ it }) => sameStory(c, it)) ?? added.map((it) => ({ it, day: today })).find(({ it }) => sameStory(c, it));
    if (hit) {
      const it = hit.it;
      if (official(c) && it.reported) {
        Object.assign(it, {
          reported: false, key: c.key, headline: c.headline, source: c.source, sourceId: c.sourceId, summary: c.summary,
          lines: [], linesBy: null, also: [...new Set([...(it.also ?? []), it.source.name])], upgradedAt: new Date(now).toISOString(),
        });
        upgraded.push(it);
      } else if (c.source.name !== it.source.name && !(it.also ?? []).includes(c.source.name)) {
        it.also = [...(it.also ?? []), c.source.name];
        upgraded.push(it);
      } else skipped.push({ title: c.headline, why: `already listed ${hit.day}` });
      continue;
    }
    const max = c.sourceMax ?? caps.maxPerSourcePerDay;
    if ((perSource[c.sourceId] ?? 0) >= max) {
      skipped.push({ title: c.headline, why: `source cap ${max}/day (${c.sourceId})` });
      continue;
    }
    if (page.items.length + added.length >= caps.maxItemsPerDay) {
      skipped.push({ title: c.headline, why: `day cap ${caps.maxItemsPerDay}` });
      continue;
    }
    perSource[c.sourceId] = (perSource[c.sourceId] ?? 0) + 1;
    added.push(c);
  }
  page.items.push(...added);
  return { added, upgraded: [...new Set(upgraded)], skipped };
}

/** A day-page item from a classified candidate. */
export function briefItem(item, source, cls, { now = Date.now() } = {}) {
  const headline = briefHeadline(item.title);
  const time = item.date && Date.parse(item.date) <= now ? item.date : new Date(now).toISOString();
  const x = {
    id: hashText(normalizeUrl(item.link)).padStart(8, '0'),
    key: normalizeUrl(item.link),
    time,
    seen: new Date(now).toISOString(),
    kind: cls.kind,
    tier: 2,
    headline,
    summary: stripTags(item.summary ?? '').slice(0, 700),
    lines: [],
    linesBy: null,
    source: { name: source.name, url: item.link },
    sourceId: source.id,
    sourceMax: source.briefMax,
    reported: cls.reported,
    also: (item.alsoIn ?? []).map((id) => id),
    post: null,
    device: cls.device ? { model: cls.device.model, brand: cls.device.brand, category: cls.device.category, key: cls.device.key } : null,
    ai: cls.ai ? { model: cls.ai.model, kind: cls.ai.kind } : null,
    ...(cls.kind === 'outage' ? { families: outageFamilies(`${item.title} ${item.summary ?? ''}`) } : {}),
    score: cls.score,
  };
  x.story = storyKey(x);
  return x;
}

// ---------- writing the lines ----------

const SENTENCES = (s) => String(s).split(/(?<=[.!?])\s+(?=[A-Z0-9"“'‘(])/).map((t) => t.trim()).filter((t) => t.length > 20);
const AVAIL = /\b(available|availability|rolling out|starts? at|pric(e|es|ed|ing)|per (user|month|seat)|regions?|countries|in india|generally available|preview|free|paid|plans?|pre-?order|on sale|from \w+ \d{1,2})\b|[$₹€£]\s?\d/i;

/**
 * Template lines from the official text only (used when the Claude call fails or its lines fail validation):
 * what happened (the source's own first sentence), and availability/price when the text states them.
 */
export function templateLines(it) {
  const sentences = SENTENCES(it.summary ?? '').filter((s) => !/^(read more|learn more|click|subscribe|the post .* appeared first)/i.test(s) &&
    !/https?:\/\/|aka\.ms\/|\.\.\.$|…$|\bvisit\b/i.test(s));
  const lines = [];
  const first = sentences[0];
  if (first && !sameTopic(first, it.headline)) lines.push(first.slice(0, BRIEF.maxLineChars));
  else lines.push(`${it.source.name}: ${it.headline}.`);
  const avail = sentences.slice(1).find((s) => AVAIL.test(s));
  if (avail) lines.push(avail.slice(0, BRIEF.maxLineChars));
  if (it.reported) lines.push(it.source.label ?? `Reported by ${it.source.name}; not yet confirmed on an official page.`);
  return lines;
}

/** Numbers as written ("1.5", "$7.50", "120", "2026"), for the no-invented-facts check. */
const numbersIn = (s) => (String(s).replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []);
const FIRST_PERSON = /\b(we|we're|we've|our|us|i|i'm|my)\b/i;
const SPECULATION = /\b(rumou?r\w*|leak\w*|reportedly|allegedly|is expected to|could launch|might launch|probably|likely to launch)\b/i;

/**
 * Check Claude's lines for one item against its source text. Every number must appear in the headline or summary
 * (prices, dates, versions: nothing invented), 2-4 lines, no first person, no speculation, no URLs or markup.
 * Returns the errors (empty = OK).
 */
export function validateLines(lines, it) {
  const errors = [];
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > BRIEF.maxLines) return ['need 1-4 lines'];
  const source = `${it.headline} ${it.summary ?? ''} ${it.source?.name ?? ''}`;
  const known = new Set(numbersIn(source));
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim().length < 15) {
      errors.push('line too short');
      continue;
    }
    if (line.length > BRIEF.maxLineChars) errors.push('line too long');
    if (/https?:\/\/|<[a-z/]|\]\(|\*\*|^#/i.test(line)) errors.push('markup or URL in a line');
    if (FIRST_PERSON.test(line.replace(/\b(US|U\.S\.)\b/g, ''))) errors.push(`first person: ${line.slice(0, 60)}`);
    if (SPECULATION.test(line) && !it.reported) errors.push(`speculation: ${line.slice(0, 60)}`);
    for (const n of numbersIn(line)) if (!known.has(n)) errors.push(`number not in the source: ${n}`);
  }
  return errors;
}

/** The batched prompt for one hourly Claude call (no tools): items in, JSON out. */
export function linesPrompt(items) {
  const input = items.map((it) => ({
    id: it.id, kind: it.kind, reported: it.reported, source: it.source.name, headline: it.headline, text: (it.summary ?? '').slice(0, 700),
  }));
  return [
    'Write the entries for an hourly technology news page for IT admins and business users.',
    'For each item below, write 2 to 4 short factual lines (each under 280 characters), in plain US English:',
    '1. What happened (who launched, changed, retired or fixed what).',
    '2. Availability, regions, dates or price, only if the text states them; otherwise skip this line.',
    '3. Why it matters for IT teams or business users, in general terms, adding no new facts.',
    'Rules: use only facts in the headline and text given; never add a number, price, date, version, region or name that',
    'is not there; no speculation, no first person, no marketing adjectives, no links, no Markdown. For items with',
    '"reported": true, start line 1 with "Reported by <source>:". If the text is too thin, write fewer lines.',
    'Answer with JSON only, no prose before or after: {"<id>": ["line", "line"], ...}',
    '',
    JSON.stringify(input, null, 1),
  ].join('\n');
}

/** Parse Claude's answer (JSON, possibly wrapped in prose or a code fence) into { id: lines }. */
export function parseLinesAnswer(text = '') {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/** Apply Claude's lines where they validate, else template lines. Returns { claude, template } counts. */
export function applyLines(items, answer = {}) {
  let claude = 0;
  let template = 0;
  for (const it of items) {
    const lines = answer[it.id];
    const errors = lines ? validateLines(lines, it) : ['no answer'];
    if (!errors.length) {
      it.lines = lines.map((l) => clean(l));
      it.linesBy = 'claude';
      claude++;
    } else {
      it.lines = templateLines(it);
      it.linesBy = 'template';
      it.linesNote = errors.slice(0, 3).join('; ');
      template++;
    }
  }
  return { claude, template };
}

// ---------- day pages ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

export function emptyDay(date) {
  return { date, title: `Tech news today, ${longDate(date)}`, published: null, updated: null, items: [] };
}

/** Recompute a page's dates and description after a change (dateModified = this run). */
export function touchDay(page, now = Date.now()) {
  const times = page.items.map((i) => i.seen).filter(Boolean).sort();
  page.published = page.published ?? times[0] ?? new Date(now).toISOString();
  page.updated = new Date(now).toISOString();
  const top = [...page.items].sort((a, b) => (a.tier - b.tier) || b.score - a.score).slice(0, 3).map((i) => i.headline);
  page.description = top.length
    ? `${page.items.length} technology update${page.items.length === 1 ? '' : 's'} from official sources, updated hourly: ${top.join('; ')}.`.slice(0, 300)
    : 'Technology updates from official sources, updated hourly.';
  return page;
}

/** Index of day pages for the site's live sitemap: newest first, at most `keep` days. */
export function updateIndex(index = { days: [] }, page, { keep = 400 } = {}) {
  const days = (index.days ?? []).filter((d) => d.date !== page.date);
  days.push({ date: page.date, count: page.items.length, published: page.published, updated: page.updated, title: page.title });
  days.sort((a, b) => b.date.localeCompare(a.date));
  return { ...index, days: days.slice(0, keep) };
}

/** Text for the device-portal job (devices.yml focus, launch mode). */
export function deviceFocus(queue) {
  return `Launch mode: ${queue.map((d) => `${d.slug ? `refresh ${d.slug} = ` : ''}${d.model} (${d.category}, officially announced ${String(d.date).slice(0, 10)}: ${d.link})`).join('; ')}`;
}
