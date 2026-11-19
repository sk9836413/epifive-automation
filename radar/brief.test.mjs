// Tests for the tiered news system (brief.mjs) and the parsers it added to lib.mjs. Run: node --test radar/brief.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BRIEF, detectDevice, findDeviceSlug, detectAiModel, tier1Floor, classifyBrief, storyKey, sameStory, mergeIntoDays, briefItem,
  emptyDay, templateLines, validateLines, parseLinesAnswer, applyLines, linesPrompt, touchDay, updateIndex, deviceFocus, briefHeadline,
} from './brief.mjs';
import { parseDatedMarkdown, parseHfModels, parseSource, parseTechmeme, parseGoogleNews } from './lib.mjs';
import { trendTopic, reputableOutlet, similarTitles, clusterTrending, neutralHeadline, selectTrending } from './trending.mjs';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const src = (o = {}) => ({ id: 'src', name: 'Source', weight: 0, ...o });
const item = (title, link, o = {}) => ({ title, link, summary: '', date: '2026-11-14T08:00:00Z', categories: [], ...o });
const apple = src({ id: 'apple-newsroom', name: 'Apple Newsroom', weight: 1 });
const verge = src({ id: 'the-verge', name: 'The Verge', role: 'signal', weight: -3, briefWeight: 0 });
const samsungIn = src({ id: 'samsung-india', name: 'Samsung Newsroom India' });

// ---------- Tier 3: device detection ----------

test('detectDevice: official flagship phone launch on the maker newsroom', () => {
  const d = detectDevice(item('Apple unveils iPhone 18 Pro and iPhone 18 Pro Max', 'https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-18-pro/'), apple);
  assert.equal(d.brand, 'Apple');
  assert.equal(d.model, 'Apple iPhone 18 Pro');
  assert.equal(d.category, 'phone');
  assert.equal(d.official, true);
  assert.equal(d.flagship, true);
  assert.equal(d.key, 'apple iphone 18 pro');
});

test('detectDevice: India launch with price, laptop, tablet, wearable and desktop categories', () => {
  const g = detectDevice(item('Samsung Galaxy S27 Ultra launched in India, price starts at Rs 1,29,999', 'https://news.samsung.com/in/x'), samsungIn);
  assert.equal(g.model, 'Samsung Galaxy S27 Ultra');
  assert.equal(g.flagship, true);
  assert.equal(g.official, true);
  const lenovo = src({ id: 'lenovo-news' });
  assert.equal(detectDevice(item('Lenovo unveils ThinkPad X1 Carbon Gen 14', 'https://news.lenovo.com/x'), lenovo).model, 'Lenovo ThinkPad X1 Carbon Gen 14');
  assert.equal(detectDevice(item('Lenovo unveils ThinkPad X1 Carbon Gen 14', 'https://news.lenovo.com/x'), lenovo).category, 'laptop');
  assert.equal(detectDevice(item('Introducing the new iPad Air', 'https://www.apple.com/newsroom/x'), apple).category, 'tablet');
  assert.equal(detectDevice(item('Galaxy Watch 9 Classic now available', 'https://news.samsung.com/global/x'), src()).category, 'wearable');
  assert.equal(detectDevice(item('Apple introduces the new iMac', 'https://www.apple.com/newsroom/x'), apple).category, 'desktop');
  const surface = detectDevice(item('Surface Pro 12th Edition now available', 'https://blogs.windows.com/devices/x'), src());
  assert.equal(surface.model, 'Microsoft Surface Pro 12th Edition');
  assert.equal(surface.official, true);
  assert.equal(surface.flagship, false);
});

test('detectDevice: rumours, leaks, updates, deals and reviews are not launches', () => {
  const g = src({ id: 'gsmarena-news', role: 'signal' });
  assert.equal(detectDevice(item('Oppo Reno17 Pro full specs tipped ahead of November 16 launch', 'https://www.gsmarena.com/x'), g), null);
  assert.equal(detectDevice(item('Redmi Note 18 series spotted online, charging speed revealed', 'https://www.gsmarena.com/x'), g), null);
  assert.equal(detectDevice(item('vivo X300 Ultra gets new OriginOS 7 update with camera optimizations', 'https://www.gsmarena.com/x'), g), null);
  assert.equal(detectDevice(item('Deals: the Galaxy S26 series is up to £570 off', 'https://www.gsmarena.com/x'), g), null);
  assert.equal(detectDevice(item('iPhone 18 Pro review: the best camera yet', 'https://www.theverge.com/x'), verge), null);
  assert.equal(detectDevice(item('Xiaomi 18 Pro gets one step closer to launching in India', 'https://www.gsmarena.com/x'), g), null);
});

test('detectDevice: an aggregator report is never official (no device page from it)', () => {
  const d = detectDevice(item('Samsung Galaxy A18 4G launched in Singapore', 'https://www.gsmarena.com/x'), src({ role: 'signal' }));
  assert.equal(d.model, 'Samsung Galaxy A18 4G');
  assert.equal(d.official, false);
  // An official-looking host on the wrong brand is not official either.
  assert.equal(detectDevice(item('Samsung unveils Galaxy S27', 'https://www.apple.com/newsroom/x'), apple).official, false);
});

test('findDeviceSlug: exact model only (Pro is a different device), region and 5G suffixes ignored', () => {
  const slugs = ['apple-iphone-18', 'samsung-galaxy-s27-ultra-in', 'oneplus-nord-5-5g'];
  assert.equal(findDeviceSlug({ key: 'apple iphone 18' }, slugs), 'apple-iphone-18');
  assert.equal(findDeviceSlug({ key: 'apple iphone 18 pro' }, slugs), null);
  assert.equal(findDeviceSlug({ key: 'samsung galaxy s27 ultra' }, slugs), 'samsung-galaxy-s27-ultra-in');
  assert.equal(findDeviceSlug({ key: 'oneplus nord 5' }, slugs), 'oneplus-nord-5-5g');
});

// ---------- AI models ----------

test('detectAiModel: a new flagship from Google, OpenAI, Anthropic or Meta is flagship; small tiers and third parties are not', () => {
  const g = detectAiModel(item('Introducing Gemini 4 Hydrogen', 'https://blog.google/products/gemini/gemini-4-hydrogen/'), src({ ai: true }));
  assert.deepEqual([g.model, g.kind, g.flagship], ['Gemini 4 Hydrogen', 'release', true]);
  assert.equal(detectAiModel(item('Introducing GPT-6', 'https://openai.com/index/introducing-gpt-6/'), src({ ai: true })).flagship, true);
  assert.equal(detectAiModel(item('Introducing Claude Opus 5', 'https://www.anthropic.com/news/claude-opus-5'), src({ ai: true })).flagship, true);
  assert.equal(detectAiModel(item('Introducing GPT-6 mini', 'https://openai.com/index/gpt-6-mini/'), src({ ai: true })).flagship, false);
  assert.equal(detectAiModel(item('Gemini 4 Flash is now available', 'https://blog.google/x'), src({ ai: true })).flagship, false);
  // The same model on a reseller's changelog is AI model news, not a flagship launch.
  assert.equal(detectAiModel(item('Gemini 4 Hydrogen in GitHub Copilot', 'https://github.blog/changelog/x'), src()).flagship, false);
  assert.equal(detectAiModel(item('Introducing Gemini 4 Hydrogen', 'https://www.theverge.com/x'), verge).flagship, false);
  assert.equal(detectAiModel(item('Google DeepMind wins an award', 'https://deepmind.google/x'), src({ ai: true })), null);
});

test('detectAiModel: retirements of models businesses use, and big price drops', () => {
  const r = detectAiModel(item('Retirement: Azure OpenAI GPT-4o models will be retired on February 27, 2027', 'https://azure.microsoft.com/updates?id=1'), src({ ai: true }));
  assert.deepEqual([r.model, r.kind, r.business], ['GPT-4o', 'retire', true]);
  const p = detectAiModel(item('Claude Sonnet 5 price cut: 50% lower API prices', 'https://www.anthropic.com/news/x'), src({ ai: true }));
  assert.equal(p.kind, 'price');
  assert.equal(p.priceDrop, true);
});

// ---------- Tier 1 floors ----------

test('tier1Floor: flagship device, flagship model, AI price drop, AI retirement due soon; never for signals or incidents', () => {
  const iphone = item('Apple unveils iPhone 18', 'https://www.apple.com/newsroom/x');
  assert.equal(tier1Floor(iphone, apple, { score: 5, threshold: 10 }).points, 6);
  assert.match(tier1Floor(item('Introducing Gemini 4 Hydrogen', 'https://blog.google/x'), src({ ai: true }), { score: 7, threshold: 10 }).why, /flagship AI model/);
  assert.equal(tier1Floor(item('Introducing Gemini 4 Hydrogen', 'https://blog.google/x'), src({ ai: true }), { score: 12, threshold: 10 }).points, 3);
  const retire = item('Retirement: Azure OpenAI GPT-4o models will be retired on February 27, 2027', 'https://azure.microsoft.com/updates?id=1');
  assert.match(tier1Floor(retire, src({ ai: true }), { score: 2, threshold: 10, daysToDeadline: 105 }).why, /retirement due in 105 days/);
  assert.equal(tier1Floor(retire, src({ ai: true }), { score: 2, threshold: 10, daysToDeadline: null }), null);
  assert.equal(tier1Floor(iphone, verge, { score: 5 }), null);
  assert.equal(tier1Floor(iphone, src({ category: 'incident' }), { score: 5 }), null);
  assert.equal(tier1Floor(item('Samsung Galaxy A18 launched', 'https://news.samsung.com/x'), src(), { score: 5 }), null);
});

// ---------- Tier 2: classification ----------

test('classifyBrief: launches, retirements and model news go on the page; marketing, explainers and finance do not', () => {
  const inc = (t, s = src(), o = {}) => classifyBrief(item(t, 'https://example.com/x', o), s);
  assert.equal(inc('Introducing Spend Management: Spending limits and alerts for Cloudflare', src({ weight: -1 })).include, true);
  assert.equal(inc('Retirement: Azure Data Share will be retired on November 12, 2029', src({ weight: -2 })).kind, 'retirement');
  assert.equal(inc('Retirement: Azure Data Share will be retired on November 12, 2029', src({ weight: -2 })).include, true);
  assert.equal(inc('MC1551896: 60-Day Reminder: Windows Server 2016 reaches the end of extended support', src({ weight: -2, briefWeight: -1 })).include, true);
  for (const t of ['SAP Named a Leader in Two 2026 IDC MarketScapes', 'What is a webcast? A plain-English guide', 'How to track webinar analytics',
    'Intel Reports Third-Quarter 2026 Financial Results', 'HubSpot Announces Leadership Transition', 'AI Agent Vs. Chatbot: What is best for small biz?',
    "Liz Centoni: 'Users are an essential part of the technology stack'", 'Catch Microsoft Entra at Ignite 2026', 'Google Workspace Weekly Recap - November 13, 2026',
    'Auction of 91-Day, 182-Day and 364-Day Treasury Bills', 'Building always-on agents']) {
    assert.equal(inc(t, src({ weight: 0 })).include, false, t);
  }
  const hw = inc('Introducing Gemini 4 Hydrogen', src({ ai: true }));
  assert.equal(hw.kind, 'ai-model');
});

test('classifyBrief: aggregators are "reported" and only for device, AI model, outage or security stories', () => {
  const dev = classifyBrief(item('Samsung Galaxy A18 4G launched in Singapore', 'https://www.gsmarena.com/x'), src({ role: 'signal', weight: -3, briefWeight: 0 }));
  assert.deepEqual([dev.include, dev.kind, dev.reported], [true, 'device', true]);
  // A Cybercab story from an aggregator is not a device, AI model, outage or security story: it reaches the page only
  // through the trending tier (Techmeme or 3+ reputable outlets; see the trending tests below), never through this path.
  assert.equal(classifyBrief(item('Tesla starts taking Cybercab orders for personal use', 'https://www.engadget.com/x'), verge).include, false);
  assert.equal(classifyBrief(item('Amazon’s new Kindle Colorsoft is a premium e-reader', 'https://techcrunch.com/x'), verge).include, false);
  assert.equal(classifyBrief(item('Oppo Reno17 full specs tipped ahead of launch', 'https://www.gsmarena.com/x'), verge).include, false);
  const sec = classifyBrief(item('Uber confirms hackers stole thousands of drivers’ license information in data breach', 'https://techcrunch.com/x'), verge);
  assert.deepEqual([sec.include, sec.kind], [true, 'security']);
});

test('classifyBrief: security feeds and status pages', () => {
  const thn = src({ id: 'thn', category: 'incident', newsOutlet: true, weight: 1 });
  const exploit = classifyBrief(item('Hackers Exploit PHP2Shell Flaws in Check Point Gateways', 'https://thehackernews.com/x'), thn, { incidentScore: null });
  assert.deepEqual([exploit.include, exploit.kind, exploit.reported], [true, 'security', true]);
  assert.equal(classifyBrief(item('MediaNama This Week: Top 10 Stories', 'https://www.medianama.com/x'), thn, { incidentScore: null }).include, false);
  assert.equal(classifyBrief(item('When an AI Agent Goes Wrong, Can You Stop It?', 'https://thehackernews.com/x'), thn, { incidentScore: null }).include, false);
  const vendor = classifyBrief(item('SCKit abuses ScreenConnect', 'https://www.microsoft.com/x'), src({ category: 'incident' }), { incidentScore: 7 });
  assert.deepEqual([vendor.include, vendor.reported], [true, false]);
  const status = src({ id: 'status-m365-consumer', category: 'outage' });
  assert.equal(classifyBrief(item('Users may be unable to access Microsoft 365 services', 'https://status.cloud.microsoft/#x'), status, { outageScore: 11 }).include, true);
  assert.equal(classifyBrief(item('Increased errors for R2', 'https://www.cloudflarestatus.com/x'), status, { outageScore: null }).include, false);
  const newsOutage = classifyBrief(item('Microsoft 365 applications hit by global outage', 'https://www.medianama.com/x'), thn, { outageScore: 11, outageCategory: true });
  assert.deepEqual([newsOutage.include, newsOutage.kind], [true, 'outage']);
});

// ---------- dedupe across sources and days ----------

const mk = (title, link, s, o = {}) => {
  const it = item(title, link, o);
  return briefItem(it, s, classifyBrief(it, s, o.scores ?? {}), { now: NOW });
};

test('sameStory: the same device or model from several sources is one story; different models are not', () => {
  const a = mk('Samsung Galaxy S27 Ultra launched in India, price starts at Rs 1,29,999', 'https://news.samsung.com/in/a', samsungIn);
  const b = mk('Samsung unveils Galaxy S27 Ultra', 'https://news.samsung.com/global/b', src({ id: 'samsung-global' }));
  const c = mk('Galaxy S27 Ultra launched with a 200MP camera', 'https://www.gsmarena.com/c', src({ id: 'gsmarena-news', role: 'signal', briefWeight: 0 }));
  assert.equal(a.story, 'device:samsung galaxy s27 ultra');
  assert.equal(sameStory(a, b), true);
  assert.equal(sameStory(a, c), true);
  const d = mk('Samsung unveils Galaxy S27', 'https://news.samsung.com/global/d', src());
  assert.equal(sameStory(a, d), false);
  const m1 = mk('Introducing Gemini 4 Hydrogen', 'https://blog.google/m1', src({ ai: true }));
  const m2 = mk('Gemini 4 Hydrogen is now available in the Gemini API', 'https://ai.google.dev/m2', src({ ai: true }));
  assert.equal(storyKey(m1), storyKey(m2));
});

test('mergeIntoDays: one item per story, official replaces reported, other outlets noted, 3-day lookback', () => {
  const today = '2026-11-14';
  const days = { [today]: emptyDay(today), '2026-11-13': { ...emptyDay('2026-11-13'), items: [mk('Introducing GPT-6', 'https://openai.com/gpt-6', src({ id: 'openai-news', name: 'OpenAI News', ai: true }))] } };
  const reported = mk('Samsung Galaxy S27 Ultra launched in India', 'https://www.gsmarena.com/s27', src({ id: 'gsmarena-news', name: 'GSMArena news', role: 'signal', briefWeight: 0 }));
  let r = mergeIntoDays([reported], days, today, { now: NOW });
  assert.equal(r.added.length, 1);
  assert.equal(days[today].items[0].reported, true);
  const official = mk('Samsung Galaxy S27 Ultra launched in India, price starts at Rs 1,29,999', 'https://news.samsung.com/in/s27', samsungIn);
  const again = mk('GPT-6 now available in the API', 'https://openai.com/blog/gpt-6-api', src({ id: 'openai-blog', name: 'OpenAI Blog', ai: true }));
  r = mergeIntoDays([official, again], days, today, { now: NOW });
  assert.equal(r.added.length, 0);
  assert.equal(days[today].items.length, 1);
  const it = days[today].items[0];
  assert.equal(it.reported, false);
  assert.equal(it.source.name, 'Samsung Newsroom India');
  assert.deepEqual(it.also, ['GSMArena news']);
  assert.deepEqual(it.lines, []); // re-written from the official text
  // GPT-6 was listed yesterday: noted as another source, not listed again.
  assert.deepEqual(days['2026-11-13'].items[0].also, ['OpenAI Blog']);
});

test('mergeIntoDays: per-source and per-day caps, best score first', () => {
  const today = '2026-11-14';
  const days = { [today]: emptyDay(today) };
  const aws = src({ id: 'aws-whats-new', name: "AWS What's New", weight: -2, briefMax: 2 });
  const items = ['Amazon S3 now supports alpha', 'AWS Lambda now supports beta runtime', 'Amazon EKS now supports gamma', 'AWS Glue now supports delta']
    .map((t, i) => Object.assign(mk(t, `https://aws.amazon.com/${i}`, aws), { score: i }));
  const r = mergeIntoDays(items, days, today, { now: NOW });
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.added.map((x) => x.score), [3, 2]);
  assert.match(r.skipped[0].why, /source cap 2/);
  const big = { [today]: emptyDay(today) };
  const many = ['Zoom launches Phone kiosk mode', 'Slack adds canvas templates', 'Notion releases offline mode', 'Dropbox introduces replay', 'Zoho unveils TouchPoint']
    .map((t, i) => mk(t, `https://e.com/${i}`, src({ id: `s${i}` })));
  assert.equal(mergeIntoDays(many, big, today, { now: NOW, caps: { ...BRIEF, maxItemsPerDay: 3 } }).added.length, 3);
});

// ---------- writing the lines ----------

const sample = () => ({
  id: 'abc', headline: 'Gemini 4 Hydrogen generally available', kind: 'ai-model', reported: false, source: { name: 'Gemini API release notes', url: 'https://ai.google.dev/x' },
  summary: 'Released Gemini 4 Hydrogen (gemini-4-hydrogen) for everyday coding and agentic workflows. Available on the free tier and at paid-tier pricing of $1.50 per 1M input tokens and $7.50 per 1M output tokens.',
});

test('validateLines: every number must come from the source; no first person, speculation, links or markup', () => {
  const it = sample();
  assert.deepEqual(validateLines(['Google released Gemini 4 Hydrogen in the Gemini API.', 'Paid tier: $1.50 per 1M input tokens and $7.50 per 1M output tokens; a free tier is offered.', 'Teams building coding agents can test it now.'], it), []);
  assert.match(validateLines(['Gemini 4 Hydrogen costs $2 per 1M input tokens.'], it).join(), /number not in the source: 2/);
  assert.match(validateLines(['We think Gemini 4 Hydrogen is great for teams.'], it).join(), /first person/);
  assert.match(validateLines(['Gemini 4 Hydrogen is expected to reach more regions soon.'], it).join(), /speculation/);
  assert.match(validateLines(['See https://ai.google.dev for Gemini 4 Hydrogen.'], it).join(), /URL/);
  assert.match(validateLines([], it).join(), /1-4 lines/);
  assert.match(validateLines(['a', 'b', 'c', 'd', 'e'], it).join(), /1-4 lines/);
  // Thousands separators are compared without commas.
  const india = { ...it, summary: 'Price starts at Rs 1,29,999 in India.' };
  assert.deepEqual(validateLines(['The phone starts at Rs 129999 in India, per Samsung.'], india), []);
});

test('templateLines: the official text only, availability when stated, a label for reported items', () => {
  const lines = templateLines(sample());
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Released Gemini 4 Hydrogen/);
  assert.match(lines[1], /\$1\.50 per 1M input tokens/);
  const bare = templateLines({ headline: 'Samsung Galaxy A18 4G launched in Singapore', summary: '', reported: true, source: { name: 'GSMArena news' } });
  assert.match(bare[0], /GSMArena news: Samsung Galaxy A18 4G launched in Singapore/);
  assert.match(bare.at(-1), /Reported by GSMArena news; not yet confirmed on an official page/);
  const hf = templateLines({ headline: 'Qwen3.9 model published on Hugging Face by Qwen', summary: '', reported: true, source: { name: 'Hugging Face', label: 'Model card published on Hugging Face by the vendor account.' } });
  assert.equal(hf.at(-1), 'Model card published on Hugging Face by the vendor account.');
});

test('parseLinesAnswer and applyLines: Claude lines where valid, template lines otherwise', () => {
  assert.deepEqual(parseLinesAnswer('Here you go:\n```json\n{"abc": ["x"]}\n```'), { abc: ['x'] });
  assert.deepEqual(parseLinesAnswer('no json'), {});
  const good = sample();
  const bad = { ...sample(), id: 'bad' };
  const missing = { ...sample(), id: 'none' };
  const r = applyLines([good, bad, missing], {
    abc: ['Google released Gemini 4 Hydrogen for coding and agent work.', 'Paid tier: $1.50 per 1M input tokens.'],
    bad: ['Gemini 4 Hydrogen costs $9 per 1M tokens.'],
  });
  assert.deepEqual(r, { claude: 1, template: 2 });
  assert.equal(good.linesBy, 'claude');
  assert.equal(bad.linesBy, 'template');
  assert.match(bad.linesNote, /number not in the source: 9/);
  assert.equal(missing.linesNote, 'no answer');
  const prompt = linesPrompt([good]);
  assert.match(prompt, /never add a number/);
  assert.match(prompt, /"id": "abc"/);
});

// ---------- day pages ----------

test('touchDay and updateIndex: dateModified moves, description names the top items, newest day first', () => {
  const page = emptyDay('2026-11-14');
  assert.equal(page.title, 'Tech news today, 14 November 2026');
  page.items.push({ ...sample(), seen: '2026-11-14T05:00:00.000Z', tier: 2, score: 6 }, { ...sample(), headline: 'Second', seen: '2026-11-14T06:00:00.000Z', tier: 1, score: 3 });
  touchDay(page, NOW);
  assert.equal(page.published, '2026-11-14T05:00:00.000Z');
  assert.equal(page.updated, new Date(NOW).toISOString());
  assert.match(page.description, /^2 technology updates from official sources, updated hourly: Second; Gemini 4 Hydrogen/);
  const idx = updateIndex(updateIndex({ days: [] }, { ...page, date: '2026-11-13' }), page);
  assert.deepEqual(idx.days.map((d) => d.date), ['2026-11-14', '2026-11-13']);
  assert.equal(idx.days[0].count, 2);
});

test('deviceFocus: launch mode text for devices.yml names the device, the date, the official link and refresh slugs', () => {
  const f = deviceFocus([
    { model: 'Samsung Galaxy S27 Ultra', category: 'phone', date: '2026-11-14T08:00:00Z', link: 'https://news.samsung.com/in/x', slug: null },
    { model: 'Apple iPhone 18', category: 'phone', date: '2026-11-14T08:00:00Z', link: 'https://www.apple.com/newsroom/y', slug: 'apple-iphone-18' },
  ]);
  assert.match(f, /^Launch mode: Samsung Galaxy S27 Ultra \(phone, officially announced 2026-11-14: https:\/\/news\.samsung\.com\/in\/x\); refresh apple-iphone-18 = Apple iPhone 18/);
});

test('briefHeadline drops announcement wording', () => {
  assert.equal(briefHeadline('Introducing: ChatGPT Wallet.'), 'ChatGPT Wallet');
  assert.equal(briefHeadline('Introducing ChatGPT Wallet'), 'Introducing ChatGPT Wallet');
});

// ---------- new parsers ----------

test('parseDatedMarkdown: Gemini API release notes (Markdown in the page, one item per bullet)', () => {
  const html = `<noscript><pre># Release notes\n\n## November 12, 2026  {% id=&quot;11-12-2026&quot; %}\n\n*   **Gemini 4 Hydrogen (\`gemini-4-hydrogen\`) generally available (GA)**: Released\n  [Gemini 4 Hydrogen](/docs/models/x) at $1.50 per 1M input tokens.\n\n*   **Gemini Embedding 2 Preview deprecation**: gemini-embedding-2-preview is deprecated.\n\n## November 10, 2026\n\n*   Plain bullet without bold. Second sentence.\n</pre></noscript>`;
  const items = parseDatedMarkdown(html, { url: 'https://ai.google.dev/gemini-api/docs/changelog' });
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Gemini 4 Hydrogen (gemini-4-hydrogen) generally available (GA)');
  assert.equal(items[0].date, '2026-11-12T12:00:00.000Z');
  assert.match(items[0].summary, /^Released Gemini 4 Hydrogen at \$1\.50 per 1M input tokens\.$/);
  assert.match(items[0].link, /^https:\/\/ai\.google\.dev\/gemini-api\/docs\/changelog#2026-11-12-gemini-4-hydrogen/);
  assert.equal(items[2].title, 'Plain bullet without bold.');
  assert.equal(parseSource(html, { type: 'dated-markdown', url: 'https://ai.google.dev/gemini-api/docs/changelog' }).length, 3);
});

test('parseHfModels: only the official lab accounts, titled with the model name', () => {
  const body = JSON.stringify([
    { id: 'Qwen/Qwen3.9-32B', createdAt: '2026-11-14T01:00:00.000Z', pipeline_tag: 'text-generation' },
    { id: 'someone/DeepSeek-V5-uncensored', createdAt: '2026-11-14T01:00:00.000Z' },
    { id: 'deepseek-ai/DeepSeek-V5', createdAt: '2026-11-13T01:00:00.000Z' },
  ]);
  const items = parseHfModels(body, { orgs: ['Qwen', 'deepseek-ai'] });
  assert.deepEqual(items.map((i) => i.link), ['https://huggingface.co/Qwen/Qwen3.9-32B', 'https://huggingface.co/deepseek-ai/DeepSeek-V5']);
  assert.match(items[1].title, /^DeepSeek-V5 model published on Hugging Face by deepseek-ai$/);
  assert.equal(detectAiModel(items[1], { ai: true, role: 'signal' }).model, 'DeepSeek-V5');
});

// ---------- sources.json ----------

test('sources.json: every source has a fetch status; signals never reach Tier 1; incident news outlets are labelled', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
  const ids = new Set();
  for (const s of cfg.sources) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.match(s.verified ?? '', /^\d{4}-\d{2}-\d{2}$/, `${s.id} has no verified date`);
    assert.ok(s.url && s.type && s.topic, s.id);
    if (s.role === 'signal') assert.ok((s.weight ?? 0) <= -3, `${s.id}: signals stay far below the Tier-1 threshold`);
  }
  for (const id of ['the-verge', 'techcrunch', 'engadget', 'gsmarena-news', 'hf-trending']) assert.equal(cfg.sources.find((s) => s.id === id)?.role, 'signal', id);
  for (const id of ['thn', 'bleepingcomputer', 'theprint-tech', 'medianama']) assert.equal(cfg.sources.find((s) => s.id === id)?.newsOutlet, true, id);
  assert.ok(cfg.notUsed.every((n) => n.name && n.url && n.reason));
  assert.ok(cfg.settings.maxNewPerDay <= 2 && cfg.settings.maxOutageExtraPerDay <= 1, 'Tier-1 cap stays 2 a day + 1 outage extra');
});

test('sameStory: an outage on a status page and a news report of it are one story (by platform family, across days)', () => {
  const status = mk('Users may be unable to access Microsoft 365 services', 'https://status.cloud.microsoft/#a', src({ id: 'status-m365-consumer', category: 'outage' }), { date: '2026-11-13T10:00:00Z', scores: { outageScore: 11 } });
  const news = mk('Microsoft 365 applications hit by global outage for over 10 hours', 'https://www.medianama.com/b', src({ id: 'medianama', category: 'incident', newsOutlet: true }), { scores: { outageScore: 11, outageCategory: true } });
  assert.equal(status.kind, 'outage');
  assert.equal(news.kind, 'outage');
  assert.equal(storyKey(status), 'outage:microsoft');
  assert.equal(sameStory(status, news), true);
  const gh = mk('GitHub is down for many users', 'https://www.bleepingcomputer.com/c', src({ id: 'bleepingcomputer', category: 'incident', newsOutlet: true }), { scores: { outageScore: 10, outageCategory: true } });
  assert.equal(sameStory(status, gh), false);
});

// ---------- trending tier (radar/trending.mjs): Techmeme / Google News, 3+ reputable outlets, safety, own cap ----------

const T_NOW = Date.parse('2026-11-15T06:00:00Z'); // 11:30 IST
const T_TODAY = '2026-11-15';
const tsrc = (id) => ({ id, name: id, role: 'trending', weight: -4 });
const news = (title, outlet, link, o = {}) => ({ title, outlet, link, date: '2026-11-15T03:00:00Z', summary: '', related: [], source: tsrc(o.sourceId ?? 'gnews-bigtech'), ...o });

test('parseTechmeme and parseGoogleNews: outlet, original link (gift token dropped), grouped outlets', () => {
  const tm = `<rss><channel><item><title>Tesla opens Cybercab orders to select customers in the US (Reuters)</title>
<link>https://www.techmeme.com/261115/p1#a261115p1</link>
<description><![CDATA[<A HREF="https://www.reuters.com/business/autos/tesla-cybercab-orders-2026-11-14/?accessToken=abc&utm_source=x"><IMG SRC="x.jpg"></A>
<P><A HREF="https://www.techmeme.com/261115/p1#a261115p1" TITLE="Techmeme permalink"><IMG SRC="pml.png"></A> <A HREF="https://www.reuters.com/">Reuters</A>:<BR>
<SPAN><B><A HREF="https://www.reuters.com/business/autos/tesla-cybercab-orders-2026-11-14/?accessToken=abc&utm_source=x">Tesla opens Cybercab orders to select customers in the US</A></B></SPAN>&nbsp; &mdash;&nbsp; Tesla began taking orders for its two-seat Cybercab on Friday.</P>]]></description>
<pubDate>Sat, 14 Nov 2026 21:05:01 -0500</pubDate><guid>https://www.techmeme.com/261115/p1#a261115p1</guid></item></channel></rss>`;
  const [t] = parseTechmeme(tm);
  assert.equal(t.title, 'Tesla opens Cybercab orders to select customers in the US');
  assert.equal(t.outlet, 'Reuters');
  assert.equal(t.link, 'https://www.reuters.com/business/autos/tesla-cybercab-orders-2026-11-14/');
  assert.equal(t.techmeme, true);
  assert.match(t.summary, /^Tesla began taking orders for its two-seat Cybercab on Friday\.$/);
  assert.equal(parseSource(tm, { type: 'techmeme-rss' }).length, 1);
  const gn = `<rss><channel><item><title>SpaceX catches Starship upper stage in historic first - CNBC</title><link>https://news.google.com/rss/articles/A1?oc=5</link>
<guid isPermaLink="false">A1</guid><pubDate>Sat, 14 Nov 2026 21:14:00 GMT</pubDate><description>&lt;ol&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/A1?oc=5" target="_blank"&gt;SpaceX catches Starship upper stage in historic first&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;CNBC&lt;/font&gt;&lt;/li&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/B2?oc=5" target="_blank"&gt;SpaceX Starship returns to landing pad from orbit&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;&lt;/li&gt;&lt;/ol&gt;</description><source url="https://www.cnbc.com">CNBC</source></item></channel></rss>`;
  const [g] = parseGoogleNews(gn);
  assert.deepEqual([g.title, g.outlet], ['SpaceX catches Starship upper stage in historic first', 'CNBC']);
  assert.deepEqual(g.related, [{ link: 'https://news.google.com/rss/articles/B2?oc=5', title: 'SpaceX Starship returns to landing pad from orbit', outlet: 'Reuters' }]);
});

test('trendTopic: leadership, IPO, space/EV/product milestones and infrastructure outages; not earnings, stocks, funding, deals or opinion', () => {
  const key = (t) => trendTopic(t).key ?? `x:${trendTopic(t).reject}`;
  assert.equal(key('Nvidia CEO Jensen Huang resigns; company names interim chief executive'), 'leadership:nvidia');
  assert.equal(key('NVIDIA Announces CEO Transition'), 'leadership:nvidia');
  assert.equal(key('Anthropic sets IPO price range, implying a valuation of about $1.3 trillion'), 'ipo:anthropic');
  assert.equal(key('Nvidia and Alphabet agree to buy Anthropic stock at its IPO price'), 'ipo:anthropic'); // the company next to "IPO"
  assert.equal(key('SpaceX catches Starship upper stage with launch tower for first time'), 'milestone:spacex');
  assert.equal(key('Google CEO hails SpaceX Starship catch as historic'), 'milestone:spacex');
  assert.equal(key('Tesla starts taking Cybercab orders for personal use'), 'milestone:tesla');
  assert.equal(key('FAA orders nationwide ground stop after telecom failure'), 'infra-outage:aviation');
  assert.equal(key('Nationwide 911 outage leaves callers unable to reach dispatchers in three states'), 'infra-outage:911');
  assert.equal(key('Chase customers report bank outage as app and ATMs go down'), 'infra-outage:banking');
  // A clearly-IT outage uses the existing outage logic, not this tier.
  assert.equal(key('Microsoft 365 outage disrupts Outlook and Teams worldwide'), 'x:IT outage (existing outage logic)');
  for (const t of ['Nvidia reports record third-quarter revenue, beats estimates', 'Tesla shares jump 8% as investors cheer robotaxi plans',
    'AI startup Databento raises $100M Series C at a $1.1B valuation', 'Best Black Friday deals on Apple MacBooks', 'Why Anthropic angered its peers',
    'Opinion | What Nvidia gets wrong', 'Unconfirmed: iPhone 20 Pro leaked in video', 'Italy fines Meta over Android photo access',
    'Space Shuttle Endeavour new LA home opens at science center']) {
    assert.ok(!trendTopic(t).key, t);
  }
});

test('reputableOutlet: allowlist by name or article host; Google News links say nothing', () => {
  assert.equal(reputableOutlet('AP News'), 'AP');
  assert.equal(reputableOutlet('Bloomberg.com'), 'Bloomberg');
  assert.equal(reputableOutlet('The Wall Street Journal'), 'WSJ');
  assert.equal(reputableOutlet('', 'https://www.theverge.com/news/1'), 'The Verge');
  assert.equal(reputableOutlet('Forbes', 'https://www.forbes.com/x'), null);
  assert.equal(reputableOutlet('Fox Business', 'https://news.google.com/rss/articles/x'), null);
});

test('clustering: one story across outlets by topic, company and title; Google News grouping counts toward 3 outlets', () => {
  assert.equal(similarTitles('SpaceX catches upper stage of Starship rocket in historic first', 'SpaceX Starship returns to landing pad from orbit, acing test for reusable rockets'), true);
  assert.equal(similarTitles('Apple unveils new iPad Pro with M6 chip', 'Apple launches Home Collection smart speakers'), false);
  const e = (title, outlet, o = {}) => ({ title, outlet, link: `https://example.com/${encodeURIComponent(title)}`, related: [], topic: trendTopic(title), ...o });
  const clusters = clusterTrending([
    e('SpaceX catches upper stage of Starship rocket in historic first', 'CNBC'),
    e('SpaceX Starship returns to landing pad from orbit, acing test for reusable rockets', 'Reuters'),
    e('SpaceX makes history as Starship spacecraft caught by launch tower', 'Fox Business'),
    e('Apple unveils new iPad Pro with M6 chip', 'The Verge'),
    e('Apple launches Home Collection smart speakers', 'Engadget'),
    e('FAA orders nationwide ground stop', 'Local TV', { related: [{ title: 'Flights halted nationwide', outlet: 'AP News', link: 'https://news.google.com/a' }, { title: 'x', outlet: 'Reuters', link: 'https://news.google.com/b' }] }),
    e('Ground stop lifted as FAA restores telecom system', 'BBC'),
  ]);
  const by = Object.fromEntries(clusters.map((c) => [c.members[0].title.slice(0, 12), c]));
  assert.equal(clusters.length, 4);
  assert.equal(by['SpaceX catch'].members.length, 3);
  assert.deepEqual([...by['SpaceX catch'].outlets].sort(), ['CNBC', 'Reuters']); // Fox Business is not on the allowlist
  assert.equal(by['SpaceX catch'].trending, false);
  assert.deepEqual([...by['FAA orders n'].outlets].sort(), ['AP', 'BBC', 'Reuters']);
  assert.equal(by['FAA orders n'].trending, true);
  assert.equal(by['Apple unveil'].members.length, 1); // two different Apple launches are two stories
});

test('selectTrending: a Cybercab story is listed only through the trending tier (Techmeme, or 3+ reputable outlets)', () => {
  const engadget = news('Tesla starts taking Cybercab orders for personal use', 'Engadget', 'https://www.engadget.com/transportation/tesla-cybercab-orders.html', { source: { id: 'engadget', name: 'Engadget', role: 'signal', outlet: 'Engadget' } });
  // One outlet only: not trending.
  let r = selectTrending([engadget], { now: T_NOW, today: T_TODAY });
  assert.equal(r.items.length, 0);
  assert.match(r.skipped[0].why, /not trending \(1 reputable outlet/);
  // Three reputable outlets: listed, attributed to the first-ranked outlet with a link, the others noted.
  r = selectTrending([engadget,
    news('Tesla invites select customers to buy Cybercab for personal use', 'Reuters', 'https://news.google.com/rss/articles/R1'),
    news('Tesla Opens Sales of Autonomous Cybercab for Select Customers', 'WSJ', 'https://news.google.com/rss/articles/W1')], { now: T_NOW, today: T_TODAY });
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.deepEqual([it.trending, it.trendKey, it.reported, it.source.name, it.tier], [true, 'milestone:tesla', true, 'Reuters', 2]);
  assert.deepEqual(it.also, ['WSJ', 'Engadget']);
  assert.equal(it.story, 'trend:milestone:tesla');
  const lines = templateLines(it);
  assert.equal(lines[0], 'Reported by Reuters: Tesla invites select customers to buy Cybercab for personal use.');
  assert.equal(lines.at(-1), 'Also reported by WSJ, Engadget.');
  assert.ok(lines.length >= 2 && lines.length <= 4);
  // On Techmeme's top headlines with one reputable outlet: listed too.
  const tm = news('Tesla opens Cybercab orders to select customers in the US', 'Reuters', 'https://www.reuters.com/autos/cybercab', { techmeme: true, source: tsrc('techmeme') });
  r = selectTrending([tm], { now: T_NOW, today: T_TODAY });
  assert.deepEqual([r.items.length, r.items[0].techmeme], [1, true]);
  assert.equal(templateLines(r.items[0]).at(-1), 'Listed among the top headlines on Techmeme.');
  // Yesterday's story (IST) older than 6 hours is not today's news.
  assert.equal(selectTrending([{ ...tm, date: '2026-11-14T10:00:00Z' }], { now: T_NOW, today: T_TODAY }).items.length, 0);
});

test('safety filter: scandal and allegation headlines are dropped or cut to the neutral headline fact', () => {
  assert.equal(neutralHeadline('Oracle president Alex Example resigns amid board investigation into conduct', 'leadership:oracle'), 'Oracle president Alex Example resigns');
  assert.equal(neutralHeadline('Oracle president resigns; affair allegations detailed', 'leadership:oracle'), 'Oracle president resigns');
  assert.equal(neutralHeadline('Affair allegations end Oracle president tenure', 'leadership:oracle'), null);
  // Only a scandal headline (Techmeme lists it): nothing neutral left, so the story is dropped.
  const onlyScandal = news('Oracle president resigned after affair with a staffer, sources say', 'Bloomberg', 'https://www.bloomberg.com/x', { techmeme: true, source: tsrc('techmeme') });
  const scandal = selectTrending([{ ...onlyScandal, title: 'Oracle president steps down as affair allegations mount' }], { now: T_NOW, today: T_TODAY });
  assert.equal(scandal.items[0].headline, 'Oracle president steps down');
  const none = selectTrending([{ ...onlyScandal, title: 'Affair allegations: Oracle president steps down' }], { now: T_NOW, today: T_TODAY });
  assert.equal(none.items.length, 0);
  assert.match(none.skipped[0].why, /safety filter/);
  // A blocked headline is cut to its first clause, and the outlet's snippet is then not used.
  const r = selectTrending([{ ...onlyScandal, summary: 'The executive had a relationship with a staffer, people said.' }], { now: T_NOW, today: T_TODAY });
  assert.equal(r.items[0].headline, 'Oracle president resigned');
  assert.equal(r.items[0].summary, '');
  // Lines: blocked words, names that are not in the headline, and investment advice fail validation.
  const it = r.items[0];
  assert.deepEqual(validateLines(['Reported by Bloomberg: Oracle president resigned.', 'Listed among the top headlines on Techmeme.'], it), []);
  assert.match(validateLines(['Reported by Bloomberg: the president resigned after an affair.'], it).join(), /blocked word: affair/);
  assert.match(validateLines(['Reported by Bloomberg: Oracle president resigned; Jane Roe was involved.'], it).join(), /name not in the headline: Jane Roe/);
  assert.match(validateLines(['Reported by Bloomberg: Oracle president resigned; investors should buy the dip.'], it).join(), /investment advice/);
  assert.match(linesPrompt([it]), /never mention personal allegations/);
});

test('trending caps and dedupe: 4 a day on top of the other items, never twice for one story, not when an article covers it', () => {
  const story = (n, title) => selectTrending([news(title, 'Reuters', `https://www.reuters.com/${n}`, { techmeme: true })], { now: T_NOW, today: T_TODAY }).items[0];
  const titles = ['Nvidia CEO resigns, company names interim chief', 'SpaceX catches Starship upper stage', 'Anthropic files for IPO',
    'Tesla starts Cybercab deliveries', 'FAA orders nationwide ground stop', 'OpenAI CFO steps down'];
  const cands = titles.map((t, i) => story(i, t));
  assert.ok(cands.every(Boolean), 'every headline is a trending candidate');
  const official = item('Introducing Spend Management for Cloudflare', 'https://blog.cloudflare.com/x');
  const days = { [T_TODAY]: { ...emptyDay(T_TODAY), items: [briefItem(official, src({ id: 'cloudflare-blog' }), classifyBrief(official, src({ id: 'cloudflare-blog' })), { now: T_NOW })] } };
  const r = mergeIntoDays(cands, days, T_TODAY, { now: T_NOW });
  assert.equal(r.added.length, 4);
  assert.equal(r.skipped.filter((x) => /trending cap 4\/day/.test(x.why)).length, 2);
  assert.equal(days[T_TODAY].items.length, 5); // the official item does not count toward the trending cap
  assert.equal(BRIEF.trendingMaxPerDay, 4);
  // The next run: the cap is already used.
  assert.equal(mergeIntoDays([story(9, 'Intel CEO steps down')], days, T_TODAY, { now: T_NOW }).added.length, 0);
  // Dedupe against the day pages (another wording of a listed story, also a manual item without a trendKey) ...
  const listed = [{ headline: 'SpaceX catches the Starship upper stage with its launch tower for the first time', key: 'manual:1', day: T_TODAY }];
  const again = selectTrending([news('SpaceX Starship returns from orbit and is caught by launch tower', 'Reuters', 'https://www.reuters.com/s', { techmeme: true })], { now: T_NOW, today: T_TODAY, listed });
  assert.equal(again.items.length, 0);
  assert.match(again.skipped[0].why, /already listed 2026-11-15 \(milestone:spacex\)/);
  // ... and against recent articles.
  const posts = [{ slug: 'faa-ground-stop-what-happened', title: 'FAA ground stop: what happened and what travelers can do', date: '2026-11-14' }];
  const covered = selectTrending([news('FAA orders nationwide ground stop', 'Reuters', 'https://www.reuters.com/f', { techmeme: true })], { now: T_NOW, today: T_TODAY, posts });
  assert.match(covered.skipped[0].why, /covered by \/blog\/faa-ground-stop-what-happened/);
});

test('trending sources: never a Tier-1 article (IT outages use the existing outage logic) and never on the page outside the tier', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
  const trending = cfg.sources.filter((s) => s.role === 'trending');
  assert.deepEqual(trending.map((s) => s.id), ['techmeme', 'gnews-tech', 'gnews-leadership', 'gnews-ipo', 'gnews-milestones', 'gnews-infra']);
  for (const s of trending) {
    assert.ok(s.weight <= -4, `${s.id}: below every other source, so a merged duplicate keeps the outlet's own item`);
    assert.ok(['techmeme-rss', 'gnews-rss'].includes(s.type), s.id);
    assert.ok(!/key=|api[_-]?key|token=/i.test(s.url), `${s.id}: no API keys`);
  }
  for (const id of ['the-verge', 'techcrunch', 'engadget', 'bleepingcomputer']) assert.ok(reputableOutlet(cfg.sources.find((s) => s.id === id).outlet), id);
  const tm = cfg.sources.find((s) => s.id === 'techmeme');
  assert.equal(tier1Floor(item('Apple unveils iPhone 18 Pro', 'https://www.apple.com/x'), tm, { score: 5 }), null);
  assert.equal(classifyBrief(item('SpaceX catches Starship upper stage', 'https://www.reuters.com/x'), tm).include, false);
  const it = classifyBrief(item('Microsoft 365 outage hits Outlook and Teams for thousands', 'https://www.reuters.com/x'), { ...tm, newsOutlet: true }, { outageScore: 9, outageCategory: true });
  assert.deepEqual([it.include, it.kind, it.reported], [true, 'outage', true]);
});

test('trending: an official source for a trending story replaces it and is written from the official text', () => {
  const t = selectTrending([news('Anthropic files for IPO on Nasdaq', 'Reuters', 'https://www.reuters.com/a', { techmeme: true })], { now: T_NOW, today: T_TODAY }).items[0];
  const days = { [T_TODAY]: { ...emptyDay(T_TODAY), items: [t] } };
  const off = briefItem(item('Anthropic files for IPO on Nasdaq', 'https://www.anthropic.com/news/ipo'), src({ id: 'anthropic-news', name: 'Anthropic News' }), { include: true, kind: 'launch', score: 5, reported: false }, { now: T_NOW });
  const r = mergeIntoDays([off], days, T_TODAY, { now: T_NOW });
  assert.equal(r.upgraded.length, 1);
  const it = days[T_TODAY].items[0];
  assert.deepEqual([it.trending, it.reported, it.source.name, it.kind], [false, false, 'Anthropic News', 'launch']);
  assert.ok(it.also.includes('Reuters'));
  assert.notEqual(templateLines(it)[0].slice(0, 12), 'Reported by ');
});

test('India trending (owner, 19 Nov 2026): an Indian AI/tech business story in 3+ Indian reputable outlets is a trending candidate (Sarvam Token Factory)', () => {
  const NOW = Date.parse('2026-11-19T09:00:00Z'); // 14:30 IST
  const TODAY = '2026-11-19';
  const at = (h) => new Date(NOW - h * 3600e3).toISOString();
  const india = (title, outlet, link, h, o = {}) => ({ title, outlet, link, date: at(h), summary: '', related: [], source: tsrc(o.sourceId ?? 'india-feed'), ...o });
  const bs = india('Sarvam AI faces backlash for hosting Chinese AI models on its Token Factory platform', 'Business Standard', 'https://www.business-standard.com/technology/tech-news/sarvam-ai-token-factory-chinese-models-backlash-126111900123_1.html', 3);
  const mn = india("Sarvam's Token Factory offers DeepSeek, Kimi and GLM models, sparking sovereign AI debate", '', 'https://www.medianama.com/2026/11/223-sarvam-token-factory-chinese-models/', 9);
  const aim = india('Sarvam Launches Token Factory, an Inference Platform Built on Indian Compute', '', 'https://analyticsindiamag.com/ai-news/sarvam-launches-token-factory/', 20);
  const dc = india('Sarvam AI under fire over Chinese models on its platform', 'Deccan Chronicle', 'https://www.deccanchronicle.com/technology/sarvam-ai-under-fire-1912345', 2);
  // The launch and the backlash over it are one "india" story about Sarvam.
  for (const x of [bs, mn, aim, dc]) assert.equal(trendTopic(x.title).key, 'india:sarvam', x.title);
  for (const [o, want] of [['Business Standard', 'Business Standard'], ['ETtech', 'The Economic Times'], ['Mint', 'Mint'], ['BusinessLine', 'The Hindu'],
    ['Hindustan Times', 'Hindustan Times'], ['The Indian Express', 'The Indian Express'], ['Moneycontrol', 'Moneycontrol'], ['NDTV Profit', 'NDTV'],
    ['MediaNama', 'MediaNama'], ['Inc42', 'Inc42'], ['Analytics India Magazine', 'Analytics India Magazine'], ['YourStory', 'YourStory']]) {
    assert.equal(reputableOutlet(o), want, o);
  }
  assert.equal(reputableOutlet('', 'https://economictimes.indiatimes.com/tech/artificial-intelligence/x/articleshow/1.cms'), 'The Economic Times');
  assert.equal(reputableOutlet('', 'https://timesofindia.indiatimes.com/x'), null); // indiatimes.com is not all ET
  assert.equal(reputableOutlet('Deccan Chronicle'), null);
  // Two reputable outlets: not trending yet.
  let r = selectTrending([bs, dc], { now: NOW, today: TODAY });
  assert.equal(r.items.length, 0);
  assert.match(r.skipped[0].why, /not trending \(1 reputable outlet/);
  // Three Indian reputable outlets within 24 hours: a trending candidate, reported by one of them, the others noted.
  r = selectTrending([bs, mn, aim, dc], { now: NOW, today: TODAY });
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.deepEqual([it.trending, it.trendKey, it.kind, it.reported, it.tier, it.story], [true, 'india:sarvam', 'trending', true, 2, 'trend:india:sarvam']);
  assert.ok(['Business Standard', 'MediaNama', 'Analytics India Magazine'].includes(it.source.name), it.source.name);
  assert.deepEqual([it.source.name, ...it.also].sort(), ['Analytics India Magazine', 'Business Standard', 'MediaNama']);
  assert.match(templateLines(it)[0], /^Reported by (Business Standard|MediaNama|Analytics India Magazine): .*Sarvam/);
  // Google News' grouping of Indian outlets counts the same way.
  const grouped = india('Sarvam AI draws fire for offering Chinese AI models', 'The Economic Times', 'https://news.google.com/rss/articles/S1', 4,
    { related: [{ title: 'Sarvam AI criticised for hosting Chinese models on Token Factory', outlet: 'Mint', link: 'https://news.google.com/rss/articles/S2' },
      { title: 'Sarvam defends Token Factory as Chinese AI models row grows', outlet: 'Moneycontrol', link: 'https://news.google.com/rss/articles/S3' }] });
  assert.equal(selectTrending([grouped], { now: NOW, today: TODAY }).items[0]?.trendKey, 'india:sarvam');
  // Older than the freshness window: nothing.
  assert.equal(selectTrending([bs, mn, aim].map((x) => ({ ...x, date: at(40) })), { now: NOW, today: TODAY }).items.length, 0);
  // Indian company news that is not tech/AI business news stays out.
  for (const t of ['Flipkart Big Billion Days sale: best deals on iPhones', 'Infosys Q2 results beat estimates', 'Zepto raises $450 million in fresh funding',
    'Jio announces IPL streaming plans for cricket fans']) assert.ok(!trendTopic(t).key, t);
});
