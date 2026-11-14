// Tests for the tiered news system (brief.mjs) and the parsers it added to lib.mjs. Run: node --test radar/brief.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BRIEF, detectDevice, findDeviceSlug, detectAiModel, tier1Floor, classifyBrief, storyKey, sameStory, mergeIntoDays, briefItem,
  emptyDay, templateLines, validateLines, parseLinesAnswer, applyLines, linesPrompt, touchDay, updateIndex, deviceFocus, briefHeadline,
} from './brief.mjs';
import { parseDatedMarkdown, parseHfModels, parseSource } from './lib.mjs';

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
