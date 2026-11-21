// Trending stories become articles, vertical AI launches, the missed-trends self-check and skipped fast-tracks
// (owner, 20 Nov 2026: "ye sab trending topics hote h, chhootne nahi chahiye"). Run: node --test radar/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  scoreItem, verticalAiKey, VERTICAL_AI, parkInBacklog, trendParkBlock, RADAR_TREND_MARK, RADAR_TOP_MARK, skipParkable, normalizeUrl, parseBacklog,
} from './lib.mjs';
import { securityTopic, articleKind, trendingArticles, trendCoverage, sameTrend, missedTrends, clusterTrending, trendTopic } from './trending.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-11-20T06:00:00Z'); // 11:30 IST
const tsrc = (id, o = {}) => ({ id, name: id, role: 'trending', weight: -4, ...o });
const news = (title, outlet, link, o = {}) => ({ title, outlet, link, date: '2026-11-20T03:00:00Z', summary: '', related: [], source: tsrc(o.sourceId ?? 'gnews-tech'), ...o });
const rel = (...outlets) => outlets.map((o, i) => ({ title: `Report ${i}`, outlet: o, link: `https://news.google.com/rss/articles/R${i}` }));

// ---------- vertical AI launches ----------

test('vertical AI launches from official feeds clear the threshold: ChatGPT for Healthcare, Gemini for healthcare', () => {
  const openai = { id: 'openai-news', weight: 2, categoryBoost: { Product: 2, '(none)': -2 } };
  const gcloud = { id: 'gcloud-blog', weight: -1, topic: 'cloud' };
  const press = { id: 'gcloud-press', weight: 0, topic: 'cloud' };
  const at = '2026-11-20T02:00:00Z';
  const chatgpt = scoreItem({ title: 'More ways to move care forward with ChatGPT for Healthcare', summary: 'Introducing computer-use agents, improved clinical answers, and new healthcare plugins that work across healthcare software to get real work done.', categories: ['Product'], date: at, link: 'https://openai.com/index/x' }, openai, { now: NOW });
  assert.ok(chatgpt.score >= 11, chatgpt.reasons.join('; '));
  assert.ok(chatgpt.reasons.some((r) => /vertical AI "ChatGPT for Healthcare"/.test(r)));
  const gemini = scoreItem({ title: 'Introducing Gemini for healthcare: agentic AI for providers and payers', summary: 'Available in preview for Gemini Enterprise customers in the US.', categories: [], date: at, link: 'https://cloud.google.com/blog/x' }, gcloud, { now: NOW });
  assert.ok(gemini.score >= 11, gemini.reasons.join('; '));
  const pr = scoreItem({ title: 'Google Cloud Launches Gemini for Healthcare', summary: '', categories: [], date: at, link: 'https://www.googlecloudpresscorner.com/x' }, press, { now: NOW });
  assert.ok(pr.score >= 11, pr.reasons.join('; '));
  // One story across feeds (radar.mjs uses it as the story key).
  assert.equal(verticalAiKey('Introducing Gemini for healthcare'), 'vertical:gemini:healthcare');
  assert.equal(verticalAiKey('Google Cloud Launches Gemini for Healthcare'), 'vertical:gemini:healthcare');
  assert.equal(verticalAiKey('Claude for Financial Services'), 'vertical:claude:financial services');
  assert.equal(verticalAiKey('Gemini for Google Workspace'), null);
  // Customer stories, aggregators and plain mentions never get the floor.
  const story = scoreItem({ title: 'How AdventHealth uses ChatGPT for Healthcare to cut paperwork', summary: 'Introducing ...', categories: [], date: at, link: 'https://openai.com/index/y' }, openai, { now: NOW });
  assert.ok(story.score < 10, story.reasons.join('; '));
  const verge = scoreItem({ title: 'OpenAI launches ChatGPT for Healthcare agents', summary: '', categories: [], date: at, link: 'https://www.theverge.com/x' }, { id: 'the-verge', role: 'signal', weight: -3 }, { now: NOW });
  assert.ok(verge.score < 10, verge.reasons.join('; '));
  assert.ok(VERTICAL_AI.test('Claude for Financial Services') && !VERTICAL_AI.test('Gemini for iPhone'));
});

// ---------- which trending stories are article material ----------

test('articleKind: launches, AI, security and payments outages are articles; business, space and politics are not', () => {
  const kind = (titles, key = null) => {
    const entries = titles.map((t) => ({ title: t, topic: securityTopic(t) ?? trendTopic(t), members: [] }));
    const [c] = clusterTrending(entries.filter((e) => e.topic.key).map((e) => ({ ...e, outlet: '', link: '', related: [] })));
    assert.ok(c, `no cluster for ${titles[0]}`);
    if (key) assert.equal(c.key, key);
    return articleKind(c);
  };
  assert.deepEqual(kind(['Google Cloud launches Gemini for Healthcare, an agentic AI platform for providers']), { category: 'launch', topic: 'ai-automation' });
  assert.deepEqual(kind(['Sarvam launches Token Factory, an inference platform for AI models hosted in India'], 'india:sarvam'), { category: 'launch', topic: 'ai-automation' });
  assert.deepEqual(kind(['Critical NGINX "nginx2root" flaw lets attackers run code on HTTP/2 servers'], 'security:nginx'), { category: 'incident', topic: 'security-identity' });
  assert.deepEqual(kind(['Java4Shell: critical OpenJDK flaw enables RCE in Jira and Jenkins'], 'security:java'), { category: 'incident', topic: 'security-identity' });
  assert.deepEqual(kind(['PHP fixes 7 critical flaws, including RCE bugs'], 'security:php'), { category: 'incident', topic: 'security-identity' });
  assert.deepEqual(kind(['CISA urges patching of Java4Shell flaw', 'Critical Java flaw lets attackers run code'], 'security:java'), { category: 'incident', topic: 'security-identity' });
  assert.deepEqual(kind(['Visa card payments outage hits shoppers across the US']), { category: 'outage', topic: 'online-safety', parkOnly: true });
  assert.match(kind(['FAA orders nationwide ground stop after system outage']).reject, /aviation outage/);
  assert.match(kind(['Nvidia CEO steps down']).reject, /business news \(leadership\)/);
  assert.match(kind(['Anthropic files for IPO on Nasdaq']).reject, /business news \(ipo\)/);
  assert.match(kind(['SpaceX catches Starship upper stage in historic first']).reject, /space or EV/);
  assert.match(kind(['Sarvam signs AI contract with defence ministry', 'Sarvam wins defence AI deal'], 'india:sarvam').reject, /business, finance, policy or legal/);
  assert.ok(trendTopic('Apple unveils smart glasses deal with Meta in lawsuit settlement').reject); // never even a cluster
  assert.match(kind(['Microsoft unveils new Copilot features, plans to expand in 2027 says sources']).reject ?? 'ok', /ok|not launched/);
  assert.match(trendTopic('Microsoft 365 outage: Microsoft releases preliminary report on Outlook and Teams').reject, /IT outage/);});

test('articleKind: a lawsuit or patent case against a product readers use is an article; settlements and fines are not', () => {
  const kind = (titles) => {
    const entries = titles.map((t) => ({ title: t, topic: trendTopic(t), members: [] }));
    const [c] = clusterTrending(entries.filter((e) => e.topic.key).map((e) => ({ ...e, outlet: '', link: '', related: [] })));
    assert.ok(c, `no cluster for ${titles[0]}`);
    return articleKind(c);
  };
  assert.equal(trendTopic('Startup sues Apple in India over tap-to-share contacts feature').key, 'product-legal:apple');
  assert.equal(trendTopic('US Startup Sues Apple for ₹1,500 Crore, Seeks Ban on NameDrop in India').key, 'product-legal:apple');
  assert.deepEqual(kind(['Startup sues Apple in India over tap-to-share contacts feature', 'Apple sued in India, startup seeks ban on iPhones with NameDrop']), { category: 'launch', topic: 'mobiles' });
  assert.ok(trendTopic('Apple unveils smart glasses deal with Meta in lawsuit settlement').reject);
  assert.ok(trendTopic('Google fined over Android antitrust case').reject);
});

test('trendingArticles: Techmeme or 3+ reputable outlets, one story per cluster, with the outlets\' links and a score above the threshold', () => {
  const pool = [
    news('Google Cloud launches Gemini for Healthcare, an agentic AI platform for providers and payers', 'Engadget', 'https://www.engadget.com/ai/gemini-healthcare.html', { sourceId: 'engadget', source: { id: 'engadget', role: 'signal', outlet: 'Engadget' } }),
    news('Google launches Gemini for Healthcare with Epic and Oracle Health connectors', 'Reuters', 'https://news.google.com/rss/articles/G1', { related: [{ title: 'Google debuts Gemini for Healthcare', outlet: 'CNBC', link: 'https://www.cnbc.com/2026/11/10/google-gemini-healthcare.html' }] }),
    // Business news on the same day: never an article.
    news('Anthropic files for IPO on Nasdaq', 'Reuters', 'https://www.reuters.com/a', { techmeme: true, sourceId: 'techmeme', source: tsrc('techmeme') }),
    // One outlet only, not on Techmeme: not trending.
    news('Zoho launches new AI agents for small businesses', 'TechCrunch', 'https://techcrunch.com/z', { sourceId: 'techcrunch', source: { id: 'techcrunch', role: 'signal', outlet: 'TechCrunch' } }),
    // Security story on Techmeme.
    news('Critical NGINX "nginx2root" flaw lets attackers run code on HTTP/2 servers, patch now', 'BleepingComputer', 'https://www.bleepingcomputer.com/news/security/nginx2root/', { techmeme: true, sourceId: 'techmeme', source: tsrc('techmeme') }),
    // Old news (outside freshHours).
    news('OpenAI launches ChatGPT Atlas browser for Windows', 'The Verge', 'https://www.theverge.com/old', { techmeme: true, date: '2026-11-17T00:00:00Z' }),
  ];
  const { articles, rejected } = trendingArticles(pool, { now: NOW, freshHours: 36, threshold: 10 });
  assert.deepEqual(articles.map((a) => a.key).sort(), ['milestone:google', 'security:nginx']);
  const g = articles.find((a) => a.key === 'milestone:google');
  assert.equal(g.category, 'launch');
  assert.deepEqual(g.outlets, ['Reuters', 'CNBC', 'Engadget']);
  assert.ok(g.links.includes('https://www.engadget.com/ai/gemini-healthcare.html') && g.links.includes('https://www.cnbc.com/2026/11/10/google-gemini-healthcare.html'));
  assert.ok(!g.links.slice(0, 2).some((l) => /news\.google\.com/.test(l)), 'direct outlet links first');
  assert.equal(g.score, 11);
  const n = articles.find((a) => a.key === 'security:nginx');
  assert.deepEqual([n.category, n.score], ['incident', 11]);
  assert.ok(rejected.some((r) => /IPO/.test(r.title) && /business news/.test(r.why)));
});

test('trendCoverage: a post, an open backlog line or an official radar item about the story', () => {
  const story = { key: 'milestone:google', title: 'Google Cloud launches Gemini for Healthcare', titles: ['Google Cloud launches Gemini for Healthcare'], links: ['https://www.reuters.com/g'], category: 'launch' };
  const post = { slug: 'gemini-for-healthcare-explained', title: 'Gemini for Healthcare Explained: Features, Access and HIPAA', date: '2026-11-19', body: '---\ntitle: x\n---\nbody' };
  assert.equal(trendCoverage(story, { posts: [post] }, {}, { now: NOW }).post.slug, 'gemini-for-healthcare-explained');
  assert.deepEqual(trendCoverage(story, { posts: [{ ...post, date: '2026-09-01' }] }, {}, { now: NOW }), {}); // old posts: only by link or topic
  const backlog = parseBacklog('- [ ] gemini-for-healthcare-vs-chatgpt-claude-healthcare | Gemini for Healthcare Explained: Features, Access, HIPAA | ai-engineering | decide\n');
  assert.equal(trendCoverage(story, { backlog }, {}, { now: NOW }).backlog.slug, 'gemini-for-healthcare-vs-chatgpt-claude-healthcare');
  const seen = { 'https://cloud.google.com/blog/g': { title: 'Introducing Gemini for healthcare', source: 'gcloud-blog', status: 'below', score: 7, first: '2026-11-20T01:00:00Z' } };
  assert.equal(trendCoverage(story, {}, seen, { now: NOW, aggregators: new Set(['techmeme']) }).seen[0], 'https://cloud.google.com/blog/g');
  assert.deepEqual(trendCoverage(story, {}, { x: { ...seen['https://cloud.google.com/blog/g'], source: 'techmeme' } }, { now: NOW, aggregators: new Set(['techmeme']) }), {});
  assert.equal(sameTrend({ ...story }, { ...story, title: 'Google debuts Gemini for Healthcare', titles: ['Google debuts Gemini for Healthcare'], links: [] }), true);
  assert.equal(sameTrend(story, { ...story, titles: ['Google launches Pixel 11 phones'], links: [] }), false);
});

// ---------- backlog parking ----------

test('trendParkBlock + parkInBacklog: a writer-ready line with a source comment, above every section, once', () => {
  const block = trendParkBlock({ title: 'Google Cloud launches Gemini for Healthcare', date: '2026-11-20T03:00:00Z', topic: 'ai-automation', links: ['https://www.reuters.com/g', 'https://www.cnbc.com/g'], outlets: ['Reuters', 'CNBC', 'Engadget'], techmeme: true, why: 'no fast-track slot left today' });
  const [comment, line] = block.split('\n');
  assert.match(comment, /^<!-- radar trending 2026-11-20: "Google Cloud launches Gemini for Healthcare" \(Techmeme top headline; reported by Reuters, CNBC, Engadget\); no fast-track slot left today\. Sources: https:\/\/www\.reuters\.com\/g https:\/\/www\.cnbc\.com\/g\. .* -->$/);
  assert.match(line, /^- \[ \] google-cloud-gemini-healthcare \| Google Cloud launches Gemini for Healthcare: What It Is, Who Can Get It and How to Start \| ai-automation \| understand the launch/);
  assert.equal(parseBacklog(line)[0].slug, 'google-cloud-gemini-healthcare');
  assert.match(trendParkBlock({ title: 'Critical NGINX flaw', category: 'incident', topic: 'security-identity' }), /Am I Affected and What to Do Now \| security-identity \| check whether they are affected/);
  const md = '# Backlog\n\nintro\n\n## Priority NOW 11\n- [ ] x | X | t | g\n\n## Queue\n<!-- radar fast-track -->\n- [ ] y | Y | t | g\n';
  const out = parkInBacklog(md, block, { top: 'trend' });
  const lines = out.split('\n');
  const m = lines.indexOf(RADAR_TREND_MARK);
  assert.ok(m > 0 && m < lines.indexOf('## Priority NOW 11'));
  assert.equal(lines[m - 2], '## Radar trending (big stories with no EpiFive post yet; write first)');
  assert.deepEqual(lines.slice(m + 1, m + 3), [comment, line]);
  assert.equal(parseBacklog(out)[0].slug, 'google-cloud-gemini-healthcare'); // the daily writer takes it first
  assert.equal(parkInBacklog(out, block, { top: 'trend' }), out); // once per slug
  // Security parks keep their own section; a slug that only starts the same way is not a duplicate.
  const sec = parkInBacklog(out, '- [ ] nginx2root | N | security-identity | g', { top: true });
  assert.ok(sec.includes(RADAR_TOP_MARK) && sec.includes(RADAR_TREND_MARK));
  assert.notEqual(parkInBacklog(out, '- [ ] google-cloud | G | t | g', { top: 'trend' }), out);
});

test('skipParkable: only "covered by" and "news only" style skips are final', () => {
  assert.equal(skipParkable('RADAR-SKIP: covered by /blog/x'), false);
  assert.equal(skipParkable('RADAR-SKIP: news only (listed on /news/live)'), false);
  assert.equal(skipParkable('RADAR-SKIP: the official page returned HTTP 403 and gives too little to write a useful guide'), true);
  assert.equal(skipParkable(undefined), true); // no reason recorded (before 20 Nov 2026): park it
});

// ---------- missed-trends self-check ----------

test('missedTrends: big stories of the last 48 hours with no post or backlog line, trending first', () => {
  const seen = {
    a: { title: 'More ways to move care forward with ChatGPT for Healthcare', link: 'https://openai.com/index/a', source: 'openai-news', status: 'skipped', score: 10, first: '2026-11-19T06:00:00Z', category: 'launch', topic: 'ai-automation' },
    b: { title: 'Share skills from Google Drive to Gemini', source: 'workspace-updates', status: 'below', score: 8, first: '2026-11-19T06:00:00Z' },
    c: { title: 'Routine changelog line', source: 'github-changelog', status: 'below', score: 7, first: '2026-11-19T06:00:00Z' }, // under threshold - 2
    d: { title: 'Old launch', source: 'openai-news', status: 'below', score: 12, first: '2026-11-17T06:00:00Z' }, // older than 48 h
    e: { title: 'Covered launch Copilot Notebooks', source: 'ms365-blog', status: 'skipped', skipReason: 'RADAR-SKIP: covered by /blog/copilot-notebooks', score: 11, first: '2026-11-19T06:00:00Z' },
    f: { title: 'Published launch', source: 'openai-news', status: 'published', score: 12, first: '2026-11-19T06:00:00Z' },
    g: { title: 'Techmeme headline', source: 'techmeme', status: 'below', score: 9, first: '2026-11-19T06:00:00Z' }, // aggregator, not a trending story
    h: { title: 'Microsoft 365 outage hits Outlook', source: 'bleepingcomputer', status: 'below', score: 9, first: '2026-11-19T06:00:00Z', category: 'outage' },
  };
  const trends = {
    t1: { key: 'india:sarvam', title: 'Sarvam launches Token Factory', titles: ['Sarvam launches Token Factory'], links: ['https://www.bloomberg.com/s'], outlets: ['Bloomberg', 'Business Standard', 'MediaNama'], techmeme: false, category: 'launch', topic: 'ai-automation', first: '2026-11-19T04:00:00Z', last: '2026-11-19T10:00:00Z', score: 11, decision: 'cap' },
    t2: { key: 'milestone:google', title: 'Google launches Pixel feature drop', titles: ['Google launches Pixel feature drop'], links: [], outlets: [], first: '2026-11-19T04:00:00Z', last: '2026-11-19T10:00:00Z', score: 11, decision: 'queued' },
  };
  const site = { posts: [{ slug: 'gemini-skills-google-drive', title: 'Share skills from Google Drive to Gemini: how to', date: '2026-11-19', body: '' }], backlog: [] };
  const out = missedTrends({ seen, trends, site, now: NOW, threshold: 10, aggregators: new Set(['techmeme']) });
  assert.deepEqual(out.map((x) => x.title), ['Sarvam launches Token Factory', 'More ways to move care forward with ChatGPT for Healthcare', 'Share skills from Google Drive to Gemini']);
  assert.deepEqual(out.map((x) => x.covered), [null, null, '/blog/gemini-skills-google-drive']);
  assert.deepEqual(out[1].ref, ['seen', 'a']);
  assert.deepEqual(out[0].ref, ['trend', 't1']);
});

// ---------- the scan end to end ----------

function sandbox(name, { sources, feeds, state, results = [], posts = {}, backlog = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `radar-${name}-`));
  const rd = path.join(dir, 'radar');
  fs.mkdirSync(rd);
  for (const f of fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) fs.copyFileSync(path.join(HERE, f), path.join(rd, f));
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
  cfg.sources = sources;
  fs.writeFileSync(path.join(rd, 'sources.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'stub.mjs'), `const feeds = ${JSON.stringify(feeds)};
globalThis.fetch = async (url) => feeds[url] ? { ok: true, status: 200, text: async () => feeds[url] } : { ok: false, status: 404, text: async () => '' };\n`);
  fs.writeFileSync(path.join(rd, 'state.json'), JSON.stringify(state ?? { version: 1, lastScan: null, seen: {} }));
  fs.writeFileSync(path.join(rd, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''));
  const site = path.join(dir, 'site');
  fs.mkdirSync(path.join(site, 'content', 'posts'), { recursive: true });
  fs.mkdirSync(path.join(site, 'automation'), { recursive: true });
  for (const [slug, body] of Object.entries(posts)) fs.writeFileSync(path.join(site, 'content', 'posts', `${slug}.md`), body);
  fs.writeFileSync(path.join(site, 'automation', 'backlog.md'), backlog || '# Article backlog\n\nintro\n\n## Priority NOW\n- [ ] owner-item | Owner item | how-to-tips | g\n\n## Queue\n- [ ] q | Q | t | g\n\n## Published\n');
  fs.writeFileSync(path.join(site, 'automation', 'log.md'), '# log\n');
  const run = (args, now = NOW) => spawnSync(process.execPath, ['--import', pathToFileURL(path.join(dir, 'stub.mjs')).href, path.join(rd, 'radar.mjs'), ...args, '--now', new Date(now).toISOString()], { encoding: 'utf8', cwd: dir });
  const read = () => JSON.parse(fs.readFileSync(path.join(rd, 'state.json'), 'utf8'));
  const log = () => fs.readdirSync(path.join(rd, 'log')).map((f) => fs.readFileSync(path.join(rd, 'log', f), 'utf8')).join('');
  return { dir, rd, site, run, read, log, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${i.summary ?? ''}</description>${(i.categories ?? []).map((c) => `<category>${c}</category>`).join('')}</item>`).join('')}</channel></rss>`;
const OUTLETS = [
  { id: 'reuters-t', name: 'Reuters', outlet: 'Reuters', url: 'https://feeds.test/reuters', type: 'rss', role: 'signal', weight: -3, topic: 'how-to-tips' },
  { id: 'cnbc-t', name: 'CNBC', outlet: 'CNBC', url: 'https://feeds.test/cnbc', type: 'rss', role: 'signal', weight: -3, topic: 'how-to-tips' },
  { id: 'engadget-t', name: 'Engadget', outlet: 'Engadget', url: 'https://feeds.test/engadget', type: 'rss', role: 'signal', weight: -3, topic: 'how-to-tips' },
];
const story = (title, slug, date = '2026-11-20T03:00:00Z') => ({
  'https://feeds.test/reuters': { title, link: `https://www.reuters.com/technology/${slug}`, date },
  'https://feeds.test/cnbc': { title: `${title}, company says`, link: `https://www.cnbc.com/2026/11/20/${slug}.html`, date },
  'https://feeds.test/engadget': { title: title.replace(/^(\w+)/, '$1 officially'), link: `https://www.engadget.com/${slug}.html`, date },
});
const feedsFor = (...stories) => Object.fromEntries(Object.keys(stories[0]).map((url) => [url, rss(stories.map((s) => s[url]))]));

test('scan: a trending launch with no post takes a fast-track slot, and the task carries where it was reported', () => {
  const sb = sandbox('trend-queue', { sources: OUTLETS, feeds: feedsFor(story('Google Cloud launches Gemini for Healthcare for providers and payers', 'gemini-healthcare')) });
  const r = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task.json')]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(fs.readFileSync(path.join(sb.dir, 'task.json'), 'utf8'));
  assert.equal(task.kind, 'new');
  assert.equal(task.category, 'launch');
  assert.match(task.title, /Gemini for Healthcare/);
  assert.deepEqual(task.trending.reportedBy, ['Reuters', 'CNBC', 'Engadget']);
  assert.equal(task.trending.links.length, 3);
  assert.ok(task.score >= 10);
  const st = sb.read();
  assert.equal(Object.values(st.trends)[0].decision, 'queued');
  assert.equal(st.trendBudget['2026-11-20'].length, 1);
  assert.match(sb.log(), /Trending articles: 1 trending story is article material; today 1\/4 taken/);
  assert.match(sb.log(), /trending queued for a fast-track/);
  // The next scan does not take the same story again.
  const r2 = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task2.json')], NOW + 3600e3);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(sb.read().trendBudget['2026-11-20'].length, 1);
  sb.done();
});

test('scan: with no fast-track slot left, trending stories are parked at the top of backlog.md (4 a day), business news never', () => {
  const stories = [
    story('Google Cloud launches Gemini for Healthcare for providers and payers', 'gemini-healthcare'),
    story('Sarvam launches Token Factory AI inference platform with Indian GPUs', 'sarvam-token-factory'),
    story('Microsoft unveils Copilot Vision for Windows 11 business users', 'copilot-vision'),
    story('Apple launches iPhone app for passkey sharing with families', 'apple-passkeys'),
    story('Amazon launches Alexa Plus AI assistant in India', 'alexa-plus-india'),
    story('Nvidia CEO steps down, interim chief named', 'nvidia-ceo'),
  ];
  // Two fast-tracks already published today: no slot left.
  const results = [1, 2].map((i) => ({ at: '2026-11-20T01:00:00Z', date: '2026-11-20', key: `https://x.test/${i}`, kind: 'new', category: 'launch', status: 'published', slug: `p${i}`, title: `P${i}`, dryRun: false }));
  const sb = sandbox('trend-park', { sources: OUTLETS, feeds: feedsFor(...stories), results });
  const r = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task.json')]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(fs.readFileSync(path.join(sb.dir, 'task.json'), 'utf8'));
  assert.equal(task.kind, 'none');
  assert.equal(task.parks.filter((p) => p.top === 'trend').length, 4); // the daily cap
  assert.ok(!task.parks.some((p) => /Nvidia/.test(p.line)));
  const st = sb.read();
  assert.equal(Object.values(st.trends).filter((c) => c.decision === 'cap').length, 1);
  assert.match(sb.log(), /trending over the daily cap \(4\/day\)/);
  assert.match(sb.log(), /trending, news page only: Nvidia CEO steps down.*business news \(leadership\)/);
  // site-apply writes them above every section, each with its source comment.
  const a = spawnSync(process.execPath, [path.join(sb.rd, 'radar.mjs'), 'site-apply', '--site', sb.site, '--task', path.join(sb.dir, 'task.json')], { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  const md = fs.readFileSync(path.join(sb.site, 'automation', 'backlog.md'), 'utf8');
  const first = parseBacklog(md).slice(0, 4).map((b) => b.slug);
  assert.equal(first.length, 4);
  assert.ok(!first.includes('owner-item'));
  assert.ok(md.indexOf(RADAR_TREND_MARK) < md.indexOf('## Priority NOW'));
  assert.equal((md.match(/<!-- radar trending 2026-11-20/g) ?? []).length, 4);
  sb.done();
});

test('scan: a trending story lifts the official "below" item about it, and a story with a post is left alone', () => {
  const official = { title: 'Introducing new agents in Gemini Enterprise for clinicians', link: 'https://cloud.google.com/blog/products/ai-machine-learning/gemini-for-healthcare', date: '2026-11-20T02:00:00Z', summary: 'Gemini for healthcare is in preview.' };
  const sources = [...OUTLETS, { id: 'gcloud-blog', name: 'Google Cloud Blog', url: 'https://feeds.test/gcloud', type: 'rss', weight: -1, topic: 'cloud' }];
  const feeds = { ...feedsFor(story('Google launches Gemini for Healthcare agents for clinicians', 'gemini-healthcare'), story('OpenAI launches ChatGPT Atlas browser for Windows', 'atlas-windows')), 'https://feeds.test/gcloud': rss([official]) };
  const posts = { 'chatgpt-atlas-windows-set-up': '---\ntitle: "ChatGPT Atlas browser for Windows: how to set it up"\ndate: 2026-11-20\ntopic: ai-automation\n---\nbody\n' };
  const sb = sandbox('trend-lift', { sources, feeds, posts });
  const r = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task.json')]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(fs.readFileSync(path.join(sb.dir, 'task.json'), 'utf8'));
  assert.equal(task.key, normalizeUrl(official.link)); // the vendor's own page, not a news report
  assert.ok(task.reasons.some((x) => /trending: Reuters, CNBC, Engadget/.test(x)), task.reasons.join('; '));
  assert.ok(task.coverage?.length >= 1, 'other outlets for cross-checking');
  assert.match(sb.log(), /trending covered: OpenAI launches ChatGPT Atlas.* -> \/blog\/chatgpt-atlas-windows-set-up/);
  sb.done();
});

test('scan: a fast-track the writer skipped (not "covered by") is parked at the top; the reason is recorded', () => {
  const key = 'https://openai.com/index/more-ways-to-move-care-forward-with-chatgpt-for-healthcare';
  const state = { version: 1, lastScan: null, seen: { [key]: {
    title: 'More ways to move care forward with ChatGPT for Healthcare', link: key, source: 'openai-news', topic: 'ai-automation', category: 'launch',
    date: '2026-11-20T00:00:00Z', summary: 'Introducing computer-use agents.', first: '2026-11-20T00:30:00Z', score: 10, reasons: [], status: 'writing', kind: 'new', taskAt: '2026-11-20T00:31:00Z', attempts: 1,
  }, 'https://ms.test/covered': { title: 'Copilot Notebooks', link: 'https://ms.test/covered', source: 'ms365-blog', category: 'launch', date: '2026-11-20T00:00:00Z', first: '2026-11-20T00:30:00Z', score: 11, reasons: [], status: 'writing', kind: 'new', taskAt: '2026-11-20T00:31:00Z', topic: 'microsoft-365' } } };
  const sb = sandbox('skip', { sources: OUTLETS, feeds: feedsFor(story('Unrelated quiet headline', 'x')), state });
  // The write job records the writer's RADAR-SKIP line (radar.yml passes .radar-skip.txt as --reason).
  for (const [k, reason] of [[key, 'RADAR-SKIP: openai.com returned HTTP 403; too little official detail'], ['https://ms.test/covered', 'RADAR-SKIP: covered by /blog/copilot-notebooks']]) {
    fs.writeFileSync(path.join(sb.dir, 't.json'), JSON.stringify({ kind: 'new', key: k, title: 'x', category: 'launch' }));
    const rec = spawnSync(process.execPath, [path.join(sb.rd, 'radar.mjs'), 'record', '--task', path.join(sb.dir, 't.json'), '--status', 'skipped', '--reason', reason], { encoding: 'utf8' });
    assert.equal(rec.status, 0, rec.stderr);
  }
  const lines = fs.readFileSync(path.join(sb.rd, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.match(lines[0].reason, /HTTP 403/);
  // record stamps the real time; scan "now" must be later.
  const r = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task.json')], Date.now() + 60e3);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(fs.readFileSync(path.join(sb.dir, 'task.json'), 'utf8'));
  const parks = task.parks ?? [];
  assert.equal(parks.length, 1);
  assert.equal(parks[0].top, 'trend');
  assert.match(parks[0].line, /More ways to move care forward with ChatGPT for Healthcare.*the fast-track writer skipped it \(RADAR-SKIP: openai\.com returned HTTP 403/);
  assert.match(parks[0].line, /\n- \[ \] way-move-care-forward-chatgpt-healthcare \| More ways to move care forward with ChatGPT for Healthcare: What It Is/);
  const st = sb.read().seen;
  assert.equal(st[key].status, 'parked');
  assert.equal(st['https://ms.test/covered'].status, 'skipped');
  sb.done();
});

test('scan --missed-check: uncovered big items of the last 48 hours are parked and listed under "Missed-trends check"', () => {
  const seen = {
    'https://openai.com/index/a': { title: 'Introducing ChatGPT Business Hub for teams', link: 'https://openai.com/index/a', source: 'openai-news', topic: 'ai-automation', category: 'launch', date: '2026-11-19T06:00:00Z', first: '2026-11-19T06:10:00Z', score: 9, reasons: [], status: 'below' },
    'https://workspace.test/b': { title: 'Share skills from Google Drive to Gemini', link: 'https://workspace.test/b', source: 'workspace-updates', topic: 'small-business-it', category: 'launch', date: '2026-11-19T06:00:00Z', first: '2026-11-19T06:10:00Z', score: 8, reasons: [], status: 'below' },
  };
  const posts = { 'gemini-skills-google-drive': '---\ntitle: "Share skills from Google Drive to Gemini: how to"\ndate: 2026-11-19\ntopic: ai-automation\n---\nbody\n' };
  const sb = sandbox('missed', { sources: OUTLETS, feeds: feedsFor(story('Unrelated quiet headline', 'x')), state: { version: 1, lastScan: null, seen }, posts });
  // 13:00 UTC = 18:30 IST: the first scan from then on runs the check (no flag needed).
  const r = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task.json')], Date.parse('2026-11-20T13:05:00Z'));
  assert.equal(r.status, 0, r.stderr);
  const log = sb.log();
  assert.match(log, /Missed-trends check \(last 48 h\): 2 big item\(s\) checked, 1 covered by a post or the backlog, 1 parked at the top of backlog\.md\./);
  assert.match(log, /- parked: \[Introducing ChatGPT Business Hub for teams\]\(https:\/\/openai\.com\/index\/a\) — below, score 9, openai-news/);
  assert.match(log, /- covered: Share skills from Google Drive to Gemini -> \/blog\/gemini-skills-google-drive/);
  const st = sb.read();
  assert.equal(st.missedCheck.day, '2026-11-20');
  assert.equal(st.missedCheck.items.length, 1);
  assert.equal(st.seen['https://openai.com/index/a'].status, 'parked');
  // Once a day: the next scan does not run it again.
  const r2 = sb.run(['scan', '--site', sb.site, '--out', path.join(sb.dir, 'task2.json')], Date.parse('2026-11-20T14:05:00Z'));
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal((sb.log().match(/Missed-trends check/g) ?? []).length, 1);
  sb.done();
});

test('sources.json: the official vendor launch feeds added on 20 Nov 2026 are verified, low-weight and capped on the news page', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
  for (const id of ['aws-news-blog', 'gcloud-press', 'ms-official-blog', 'ms-source', 'ibm-newsroom', 'manageengine-blog']) {
    const s = cfg.sources.find((x) => x.id === id);
    assert.ok(s, id);
    assert.equal(s.verified, '2026-11-20', id);
    assert.ok(s.weight <= 0 && s.briefMax <= 4 && s.note, id);
    assert.ok(!['signal', 'trending'].includes(s.role), id);
    assert.ok(!/news\.google\.com/.test(s.url), `${id}: no new Google News feeds`);
  }
  assert.equal(cfg.settings.maxTrendingArticlesPerDay, 4);
  assert.equal(cfg.sources.filter((s) => /news\.google\.com/.test(s.url)).length, 5); // unchanged (owner keeps the existing gnews-* feeds)
  assert.equal(new Set(cfg.sources.map((s) => s.id)).size, cfg.sources.length);
  assert.ok(cfg.notUsed.some((n) => /azure\.microsoft\.com\/en-us\/blog\/feed/.test(n.url) && /robots/.test(n.reason)));
});

test('IPO day of an AI lab readers use becomes an article; filings and other IPOs stay news-only (owner 20 Nov 2026)', async () => {
  const { articleKind } = await import('./trending.mjs');
  const c = (topic, entity, titles) => ({ topic, entity, members: titles.map((title) => ({ title })) });
  assert.equal(articleKind(c('ipo', 'anthropic', ["Anthropic's 7 founders cashed out nearly $2B in record-breaking IPO"])).category, 'launch');
  assert.equal(articleKind(c('ipo', 'openai', ['OpenAI prices IPO at $90 a share'])).category, 'launch');
  assert.match(articleKind(c('ipo', 'anthropic', ['Anthropic files for IPO on Nasdaq'])).reject, /business news/);
  assert.match(articleKind(c('ipo', 'spacex', ['SpaceX shares debut on Nasdaq'])).reject, /business news/);
});
