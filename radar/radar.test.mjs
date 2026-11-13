// Unit tests for the launch radar (scoring, de-duplication, parsing, site edits). Run: node --test radar/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeed, parseSitemap, parseHtmlList, parseDatedSections, normalizeUrl, scoreItem, mergeDuplicates, findCoverage,
  parseBacklog, sameTopic, todayCounts, parkInBacklog, markPublished, logLine, checkFastTrack, trendBoost, istDate, RADAR_MARK,
  datesIn, daysToDeadline, scoreIncident, sameIncident, markIncidentDuplicates, backlogLine, updateSignal,
  scoreOutage, outageTerm, outageFamilies, pickNewTask, parseSource, autoVideoPlan, isRootCauseNews, statusClosed,
} from './lib.mjs';

const NOW = Date.parse('2026-11-10T14:00:00Z');
const openai = { id: 'openai-news', weight: 2, categoryBoost: { Product: 2, Startup: -3, '(none)': -2 } };
const plain = { id: 'plain', weight: 0 };
const item = (over = {}) => ({ title: '', link: 'https://example.com/x', summary: '', categories: [], date: '2026-11-10T10:00:00Z', ...over });

// ---------- parsing ----------

test('parseFeed reads RSS items with CDATA, categories and dates', () => {
  const xml = `<rss><channel><item><title><![CDATA[Introducing Businesses in ChatGPT]]></title>
    <link>https://openai.com/index/introducing-businesses-chatgpt</link><guid>abc</guid>
    <category><![CDATA[Product]]></category><pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Set up a Business Hub &amp;amp; agents.&lt;/p&gt;</description></item></channel></rss>`;
  const [i] = parseFeed(xml);
  assert.equal(i.title, 'Introducing Businesses in ChatGPT');
  assert.equal(i.link, 'https://openai.com/index/introducing-businesses-chatgpt');
  assert.deepEqual(i.categories, ['Product']);
  assert.equal(i.date, '2026-11-10T10:00:00.000Z');
  assert.equal(i.summary, 'Set up a Business Hub & agents.');
});

test('parseFeed reads Atom entries and prefers the alternate link', () => {
  const xml = `<feed><entry><id>tag:1</id><published>2026-11-11T17:00:00.000-08:00</published><updated>2026-11-11T18:00:00Z</updated>
    <category term="Google Chat"/><title type="text">Nested lists in Google Chat</title>
    <link rel="replies" href="https://x/replies"/><link rel="alternate" type="text/html" href="http://workspaceupdates.googleblog.com/2026/11/lists.html"/>
    <content type="html">You can now use nested lists.</content></entry></feed>`;
  const [i] = parseFeed(xml);
  assert.equal(i.link, 'http://workspaceupdates.googleblog.com/2026/11/lists.html');
  assert.equal(i.date, '2026-11-12T01:00:00.000Z');
  assert.deepEqual(i.categories, ['Google Chat']);
});

test('parseSitemap builds titles from slugs and filters by pattern', () => {
  const xml = `<urlset><url><loc>https://blog.whatsapp.com/invite-anyone-to-a-call</loc><lastmod>2026-11-05T07:02:56-08:00</lastmod></url>
    <url><loc>https://blog.whatsapp.com/</loc></url></urlset>`;
  const items = parseSitemap(xml, { linkPattern: '^https://blog\\.whatsapp\\.com/[a-z0-9-]+$' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Invite anyone to a call');
  assert.equal(items[0].date, '2026-11-05T15:02:56.000Z');
});

test('parseHtmlList keeps headed links once, with the following <time> and <p>', () => {
  const html = `<a href="/news/claude-for-chrome"><span><h3>Claude for Chrome</h3></span></a>
    <a href="/news/claude-for-chrome"><p>Use Claude in your browser.</p></a><a href="/news/policy">Policy</a><time>Nov 9, 2026</time>`;
  const items = parseHtmlList(html, { base: 'https://www.anthropic.com/news', linkPattern: '^/news/[a-z0-9-]+$' });
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://www.anthropic.com/news/claude-for-chrome');
  assert.equal(items[0].title, 'Claude for Chrome');
  assert.equal(items[0].summary, 'Use Claude in your browser.');
  assert.ok(items[0].date.startsWith('2026-11-'));
});

test('parseDatedSections splits release notes by date and feature', () => {
  const html = `<h2 class="x">2026.10.13</h2><div><h3 class="t">Introducing Gemini 4 Argon</h3><ul><li><p><b>What:</b> Rolling out globally.</p></li></ul>
    <h3>Code in the macOS app</h3><p>What: Antigravity.</p></div><h2>2026.09.30</h2><h3>Older thing</h3>`;
  const items = parseDatedSections(html, { url: 'https://gemini.google/us/release-notes/' });
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Introducing Gemini 4 Argon');
  assert.equal(items[0].date, '2026-10-13T12:00:00.000Z');
  assert.match(items[0].summary, /Rolling out globally/);
  assert.equal(items[0].link, 'https://gemini.google/us/release-notes/#2026-10-13-introducing-gemini-4-argon');
  assert.equal(items[2].date, '2026-09-30T12:00:00.000Z');
});

// ---------- keys ----------

test('normalizeUrl strips tracking, www, trailing slash and http, but keeps ids and our anchors', () => {
  assert.equal(normalizeUrl('http://www.Example.com/a/b/?utm_source=x&id=5#top'), 'https://example.com/a/b?id=5');
  assert.equal(normalizeUrl('https://www.microsoft.com/microsoft-365/roadmap?id=566523'), 'https://microsoft.com/microsoft-365/roadmap?id=566523');
  assert.equal(normalizeUrl('https://gemini.google/us/release-notes/#2026-10-13-x'), 'https://gemini.google/us/release-notes#2026-10-13-x');
});

// ---------- scoring ----------

test('a product launch with user steps clears the threshold (10)', () => {
  const s = scoreItem(item({ title: 'Introducing Businesses in ChatGPT', summary: 'Businesses can set up a Business Hub. Available to Plus and Pro plans.', categories: ['Product'] }), openai, { now: NOW });
  assert.equal(s.reject, null);
  assert.ok(s.score >= 10, `score ${s.score}: ${s.reasons.join('; ')}`);
});

test('customer stories and corporate news score low', () => {
  const story = scoreItem(item({ title: 'Singapore Airlines elevates travel & work with OpenAI technology', summary: 'ChatGPT Enterprise rollout.' }), openai, { now: NOW });
  const corp = scoreItem(item({ title: 'Closing the AI guidance gap in education', categories: ['Company'] }), openai, { now: NOW });
  assert.ok(story.score < 5, `story ${story.score}`);
  assert.ok(corp.score < 5, `corp ${corp.score}`);
});

test('a how-to-able launch outranks a pure announcement from the same source', () => {
  const howto = scoreItem(item({ title: 'You can now turn on passkeys for WhatsApp backups', summary: 'Rolling out to all users. Go to Settings to enable.' }), { id: 'whatsapp', weight: 2 }, { now: NOW });
  const announce = scoreItem(item({ title: 'WhatsApp celebrates three billion users', summary: 'A milestone.' }), { id: 'whatsapp', weight: 2 }, { now: NOW });
  assert.ok(howto.score > announce.score + 3, `${howto.score} vs ${announce.score}`);
});

test('rumours are rejected and stale items are not eligible', () => {
  assert.equal(scoreItem(item({ title: 'iPhone 18 leak reportedly shows new button' }), plain, { now: NOW }).reject, 'rumour');
  const stale = scoreItem(item({ title: 'Introducing ChatGPT Go', date: '2026-11-07T00:00:00Z' }), openai, { now: NOW, freshHours: 36 });
  assert.match(stale.reject, /^stale/);
});

test('datesIn reads exact and month-level dates; daysToDeadline keeps the next 120 days only', () => {
  const t = datesIn('Retirement starts mid-January 2027, completes by the end of November 2026; act by January 31, 2027 or 1 February 2027.');
  for (const d of ['2027-01-15', '2026-11-30', '2027-01-31', '2027-02-01']) assert.ok(t.includes(Date.parse(d)), d);
  assert.equal(daysToDeadline('Retires by the end of November 2026.', NOW), 20);
  assert.equal(daysToDeadline('Retires in December 2027.', NOW), null);
  assert.equal(daysToDeadline('Retired on March 1, 2026.', NOW), null);
});

test('an M365 retirement due within 120 days clears the threshold even from a low-weight Message Center feed', () => {
  const mc = { id: 'mc-merill', weight: -2 };
  const near = scoreItem(item({
    title: 'MC1220762: Retirement notice: MDE and XDR Advanced Hunting APIs retiring; migrate to Microsoft Graph Security API',
    summary: 'Full retirement February 1, 2027.', categories: ['Message Center', 'Microsoft Defender XDR'],
  }), mc, { now: NOW });
  assert.ok(near.score >= 10, `score ${near.score}: ${near.reasons.join('; ')}`);
  assert.ok(near.reasons.some((r) => /M365 retirement due in \d+ days/.test(r)));

  const viaCategory = scoreItem(item({ title: 'MC1546409: Retirement of off-network invitations', summary: 'Retires in late January 2027.', categories: ['Message Center', 'Microsoft Teams'] }), mc, { now: NOW });
  assert.ok(viaCategory.score >= 10, `category match ${viaCategory.score}`);

  const far = scoreItem(item({ title: 'MC1: Exchange Online feature retirement', summary: 'Retires in September 2027.', categories: ['Message Center'] }), mc, { now: NOW });
  assert.ok(far.score < 10, `far ${far.score}`);
  const offTopic = scoreItem(item({ title: 'MC2: Dynamics 365 Sales retirement of a legacy view', summary: 'Retires December 15, 2026.', categories: ['Message Center', 'Dynamics 365 Apps'] }), mc, { now: NOW });
  assert.ok(offTopic.score < 10, `off-topic ${offTopic.score}`);
  const routine = scoreItem(item({ title: 'MC3: Microsoft Teams: new meeting reactions rolling out', summary: 'Rolling out in December 2026.', categories: ['Message Center', 'Microsoft Teams'] }), mc, { now: NOW });
  assert.ok(routine.score < 10, `routine ${routine.score}`);
});

test('feed categories adjust the score, including items without a category', () => {
  const a = scoreItem(item({ title: 'Cogent and OpenAI build cyber defense', categories: ['Startup'] }), openai, { now: NOW });
  const b = scoreItem(item({ title: 'JioStar chief architect on AI discovery' }), openai, { now: NOW });
  assert.ok(a.reasons.some((r) => r.startsWith('-3 category')));
  assert.ok(b.reasons.some((r) => r.startsWith('-2 category')));
});

test('an item on two official feeds gets one entry with a cross-source bonus', () => {
  const merged = mergeDuplicates([
    { ...item({ title: 'Gemini now on Apple CarPlay', link: 'https://blog.google/x/' }), source: { id: 'keyword', weight: 0 } },
    { ...item({ title: 'Gemini now on Apple CarPlay', link: 'https://blog.google/x?utm_source=rss' }), source: { id: 'gemini', weight: 1 } },
    { ...item({ title: 'Something else', link: 'https://blog.google/y' }), source: { id: 'keyword', weight: 0 } },
  ]);
  assert.equal(merged.length, 2);
  const g = merged.find((m) => m.title.startsWith('Gemini'));
  assert.equal(g.source.id, 'gemini');
  assert.deepEqual(g.alsoIn, ['keyword']);
  assert.ok(scoreItem(g, g.source, { now: NOW }).reasons.some((r) => r.includes('also on keyword')));
});

test('trendBoost: +2 for a matching trending query, +1 for autocomplete', () => {
  const it = item({ title: 'Introducing Businesses in ChatGPT' });
  assert.equal(trendBoost(it, { trending: ['chatgpt businesses'], suggestions: [] }).boost, 2);
  assert.equal(trendBoost(it, { trending: ['nfl scores'], suggestions: ['a', 'b'] }).boost, 1);
  assert.equal(trendBoost(it, { trending: ['business news'], suggestions: ['a'] }).boost, 0);
});

// ---------- de-duplication ----------

const posts = [
  { slug: 'businesses-in-chatgpt-business-hub-business-agent', title: 'Businesses in ChatGPT: set up the Business Hub and Business Agents', body: 'See https://openai.com/index/introducing-businesses-chatgpt for details.' },
  { slug: 'chatgpt-team-vs-claude-team-vs-gemini-business-pricing', title: 'ChatGPT Team vs Claude Team vs Gemini Business pricing', body: '' },
  { slug: 'turn-on-passkeys-whatsapp', title: 'How to turn on WhatsApp passkeys on Android and iPhone', body: '' },
];

test('findCoverage matches a post that cites the official URL', () => {
  const cov = findCoverage(item({ title: 'Introducing Businesses in ChatGPT', link: 'https://openai.com/index/introducing-businesses-chatgpt/' }), { posts });
  assert.equal(cov.post.slug, 'businesses-in-chatgpt-business-hub-business-agent');
});

test('findCoverage matches by topic only when enough words agree (no false positive on short titles)', () => {
  assert.equal(findCoverage(item({ title: 'WhatsApp passkeys now on iPhone and Android', link: 'https://blog.whatsapp.com/p' }), { posts }).post.slug, 'turn-on-passkeys-whatsapp');
  assert.equal(findCoverage(item({ title: 'ChatGPT Plus for veterans', link: 'https://openai.com/index/v' }), { posts }).post, null);
  assert.equal(sameTopic('Introducing Businesses in ChatGPT', 'ChatGPT Business vs Microsoft 365 Copilot'), false);
});

test('findCoverage reports /news and open backlog matches, ignoring done backlog items', () => {
  const backlog = parseBacklog('- [ ] gemini-gmail-workspace-expand | Gemini in Gmail for more Google Workspace users | ai | x\n- [x] old-done | Gemini in Gmail for more Google Workspace users | 2026-10-01');
  const news = [{ slug: '2026-11-11-brief', body: 'Read [Google](https://workspaceupdates.googleblog.com/2026/11/expanding-gemini.html).' }];
  const cov = findCoverage(item({ title: 'Expanding Gemini in Gmail to more Google Workspace users', link: 'http://workspaceupdates.googleblog.com/2026/11/expanding-gemini.html' }), { posts: [], news, backlog });
  assert.equal(cov.news.slug, '2026-11-11-brief');
  assert.equal(cov.backlog.slug, 'gemini-gmail-workspace-expand');
});

// ---------- caps ----------

test('todayCounts counts today\'s published fast-tracks and in-flight tasks, not dry runs', () => {
  const today = istDate(NOW);
  const results = [
    { date: today, kind: 'new', status: 'published' },
    { date: today, kind: 'new', status: 'failed' },
    { date: today, kind: 'new', status: 'published', dryRun: true },
    { date: '2026-11-09', kind: 'new', status: 'published' },
    { date: today, kind: 'update', status: 'published' },
  ];
  const state = { seen: { a: { status: 'writing', kind: 'new', taskAt: new Date(NOW).toISOString() } } };
  assert.deepEqual(todayCounts(results, state, today), { newPublished: 2, updates: 1, attempts: 3, outageExtra: 0 });
});

// ---------- site edits ----------

const BACKLOG = '# Article backlog\n\n## Queue\n\n<!-- trends -->\n- [ ] a-topic | A | x | y\n\n## Published\n- [x] old | Old | 2026-11-01\n';

test('parkInBacklog adds failed items at the top of the queue under the radar marker, once', () => {
  const line = '- [ ] chatgpt-business-hub | How to use X | ai-automation | set up (fast-track, failed gate)';
  const once = parkInBacklog(BACKLOG, line);
  const twice = parkInBacklog(once, line);
  assert.equal(once, twice);
  const lines = once.split('\n');
  assert.equal(lines[lines.indexOf(RADAR_MARK) + 1], line);
  assert.ok(lines.indexOf(RADAR_MARK) < lines.indexOf('- [ ] a-topic | A | x | y'));
});

test('markPublished removes the open item and adds a fast-track line under Published', () => {
  const md = markPublished(`${BACKLOG}- [ ] new-slug | Draft | x | y\n`, { slug: 'new-slug', title: 'Final title', date: '2026-11-12' });
  assert.ok(!md.includes('- [ ] new-slug'));
  assert.match(md, /## Published\n- \[x\] new-slug \| Final title \| 2026-11-12 \(fast-track\)/);
});

test('fast-track log lines never trip the daily writer\'s once-a-day guard', () => {
  const log = logLine('2026-11-11 | a | published | ~2000 words\n', { date: '2026-11-12', slug: 'x', status: 'fast-track', words: 1500 });
  assert.match(log, /2026-11-12 \| x \| fast-track \| ~1500 words\n$/);
  // article.yml: grep -q "^$today | .* | published |" automation/log.md
  assert.ok(!log.split('\n').some((l) => /^2026-11-12 \| .* \| published \|/.test(l)));
});

// ---------- article checks ----------

const GOOD = `---
title: x
faqs:
  - question: q
    answer: a
---
Intro.

## What Businesses in ChatGPT is
## Who it is for and availability
## Requirements
## How to set up the Business Hub, step by step
## Limitations
## Privacy and admin notes
## What we checked
Last tested: 2026-11-12
## Sources
- https://openai.com/index/introducing-businesses-chatgpt
`;

test('checkFastTrack passes a complete how-to and names missing sections', () => {
  assert.deepEqual(checkFastTrack(GOOD), []);
  const bad = checkFastTrack(GOOD.replace('## Limitations\n', '').replace(/faqs:[\s\S]*?answer: a\n/, ''));
  assert.ok(bad.some((e) => e.includes('limitations')));
  assert.ok(bad.some((e) => e.includes('faqs')));
});

test('checkFastTrack in update mode wants an updated date and a dated note', () => {
  assert.equal(checkFastTrack(GOOD, { kind: 'update', today: '2026-11-12' }).length, 2);
  const updated = GOOD.replace('faqs:', "updated: '2026-11-12'\nfaqs:").replace('Intro.', '**Updated 2026-11-12:** Now available in India.\n\nIntro.');
  assert.deepEqual(checkFastTrack(updated, { kind: 'update', today: '2026-11-12' }), []);
});

test('cleanTitle drops announcement wording for backlog titles', async () => {
  const { cleanTitle } = await import('./lib.mjs');
  assert.equal(cleanTitle('Now available: OAuth authentication for Exchange migrations'), 'OAuth authentication for Exchange migrations');
  assert.equal(cleanTitle('Introducing Businesses in ChatGPT'), 'Businesses in ChatGPT');
});

test('checkFastTrack accepts Windows line endings', () => {
  assert.deepEqual(checkFastTrack(GOOD.replace(/\n/g, '\r\n')), []);
});

// ---------- security incidents ----------

const thn = { id: 'thn', weight: 1, topic: 'security-identity', category: 'incident' };
const theprint = { id: 'theprint-tech', weight: 1, topic: 'online-safety', category: 'incident' };

test('a large incident on a major platform clears the threshold and is tagged as an incident', () => {
  const r = scoreItem(item({
    title: 'Attacker Used 4,837 Hijacked GitHub Accounts to Run a CI Secret Stealer in 1,806+ Repositories',
    summary: 'Probe pull requests from compromised accounts; rotate secrets.',
  }), thn, { now: NOW });
  assert.equal(r.reject, null);
  assert.equal(r.category, 'incident');
  assert.equal(r.topic, 'security-identity');
  assert.ok(r.score >= 10, r.reasons.join('; '));
});

test('an Indian bank leak scores high, goes to online-safety, and claims are flagged instead of rejected', () => {
  const r = scoreItem(item({
    title: 'AU Small Finance Bank probes potential data leak after hacker group claims breach',
    summary: 'The bank said a SaaS platform holds limited data relating to its vehicle loan customers. The group allegedly holds KYC records.',
  }), theprint, { now: NOW });
  assert.equal(r.reject, null);
  assert.equal(r.topic, 'online-safety');
  assert.ok(r.score >= 10, r.reasons.join('; '));
  assert.ok(r.reasons.some((x) => x.includes('label them as claims')));
  // The same "allegedly" wording on a launch feed is still a rumour.
  assert.equal(scoreItem(item({ title: 'Galaxy phone allegedly leaked' }), plain, { now: NOW }).reject, 'rumour');
});

test('incident items need a concrete user action and must be incidents at all', () => {
  assert.equal(scoreIncident(item({ title: 'The evolution of ransomware families since 2020' }), thn, { now: NOW }).reject, 'incident without a user action');
  assert.equal(scoreIncident(item({ title: 'Google AI hub to begin operations in 2028' }), theprint, { now: NOW }).reject, 'not an incident');
  assert.match(scoreIncident(item({ title: 'Old breach exposed customer emails', date: '2026-11-01T00:00:00Z' }), thn, { now: NOW }).reject, /^stale/);
});

test('an exploited zero-day on a major platform beats a routine patch for a niche product', () => {
  const zeroDay = scoreIncident(item({ title: 'Google Issues Chrome Security Update for Actively Exploited Zero-Day' }), thn, { now: NOW });
  const routine = scoreIncident(item({ title: 'Citrix Patches 12 NetScaler Flaws, Including Authentication Bypass' }), thn, { now: NOW });
  assert.ok(zeroDay.score >= 10, zeroDay.reasons.join('; '));
  assert.ok(routine.score < 10, routine.reasons.join('; '));
  assert.ok(routine.reasons.some((x) => x.includes('vulnerability')));
});

test('sponsored posts and webinars on security feeds are pushed down', () => {
  const r = scoreIncident(item({ title: 'Webinar: how to stop GitHub account takeover and rotate secrets' }), thn, { now: NOW });
  assert.ok(r.score < 10);
  assert.ok(r.reasons.some((x) => x.includes('not an incident report')));
});

test('sameIncident matches different outlets\' headlines but not unrelated advisories', () => {
  assert.ok(sameIncident('Attacker Used 4,837 Hijacked GitHub Accounts to Run a CI Secret Stealer',
    'Hijacked GitHub accounts push CI secret stealer to thousands of repositories'));
  assert.ok(!sameIncident('SAP Patches Four CVSS 10.0 Flaws, Including Two Enabling Remote Code Execution',
    'PTC Patches Critical Windchill and FlexPLM Flaw That Could Enable Remote Code Execution'));
  assert.ok(!sameIncident('HDFC Bank customers targeted by phishing SMS', 'AU Small Finance Bank data leak: what happened and what to do'));
});

test('markIncidentDuplicates keeps the best report of an incident and drops ones already queued or written', () => {
  const mk = (title, score) => ({ item: { title }, score, reasons: [], category: 'incident' });
  const a = mk('Hijacked GitHub Accounts Push CI Secret Stealer to Thousands of Repositories', 12);
  const b = mk('Attacker Used 4,837 Hijacked GitHub Accounts to Run a CI Secret Stealer', 10);
  const c = mk('SBI says 3,897 customer records found on dark web', 11);
  const launch = { item: { title: 'Hijacked GitHub accounts CI secret stealer' }, score: 9, reasons: [], category: 'launch' };
  markIncidentDuplicates([a, b, c, launch], [{ title: 'SBI customer records on the dark web: 3,897 found' }]);
  assert.equal(a.dupOf, undefined);
  assert.equal(b.dupOf, a.item.title);
  assert.ok(c.dupOf);
  assert.equal(launch.dupOf, undefined);
});

test('findCoverage (loose) finds a recent incident post through its opening paragraph, not old how-tos', () => {
  const posts = [{
    slug: 'sbi-data-leak-dark-web-what-customers-should-do', title: 'SBI Data Leak on the Dark Web: What SBI Said and What to Do',
    date: '2026-11-09', topic: 'online-safety',
    body: "---\ntitle: x\n---\n\nState Bank of India said 3,897 customer records were found among records on the dark web.",
  }];
  const it = { title: 'SBI says 3,897 customer records found on dark web, probe on', link: 'https://example.com/sbi' };
  assert.equal(findCoverage(it, { posts }, { loose: true, now: NOW }).post?.slug, posts[0].slug);
  assert.equal(findCoverage(it, { posts }).post, null);
  // The same words in an old post's intro, or in a post on another topic, do not count.
  const old = [{ ...posts[0], date: '2026-08-01' }];
  assert.equal(findCoverage(it, { posts: old }, { loose: true, now: NOW }).post, null);
  const howto = [{ ...posts[0], topic: 'microsoft-365' }];
  assert.equal(findCoverage(it, { posts: howto }, { loose: true, now: NOW }).post, null);
});

test('updateSignal uses incident wording for incidents', () => {
  assert.ok(updateSignal('Bank confirms which customers were affected', 'incident'));
  assert.ok(!updateSignal('Bank confirms which customers were affected', 'launch'));
  assert.ok(updateSignal('Now available in India', 'launch'));
});

test('backlogLine parks incidents as incident guides and launches as how-tos', () => {
  const base = { title: 'Introducing Widget Sync', date: '2026-11-12T10:00:00Z', topic: 'online-safety', link: 'https://example.com/a', reason: 'daily cap' };
  assert.equal(backlogLine(base), '- [ ] widget-sync | How to use Widget Sync (official launch 2026-11-12) | online-safety | set up or use the new feature, from https://example.com/a (fast-track, daily cap)');
  const inc = backlogLine({ ...base, title: 'SBI says customer records found on dark web', category: 'incident', reason: 'failed gate' });
  assert.match(inc, /^- \[ \] sbi-say-customer-record-found-dark-web \| SBI says customer records found on dark web: what happened and what to do \(incident 2026-11-12\) \| online-safety \|/);
  assert.match(inc, /\(fast-track incident, failed gate\)$/);
  assert.deepEqual(parseBacklog(inc).map((b) => b.slug), ['sbi-say-customer-record-found-dark-web']);
});

const INCIDENT_GOOD = `---
title: X
faqs:
  - question: q
    answer: a
---

Intro.

## What happened
a
## Am I affected?
b
## What to do now
c
## How to prevent it
d
## What we checked
- e

Last tested: 2026-11-12

## Sources
- https://example.com/filing.pdf
`;

test('checkFastTrack (incident) wants the incident sections and defanged IP addresses', () => {
  assert.deepEqual(checkFastTrack(INCIDENT_GOOD, { category: 'incident' }), []);
  // A launch how-to check would reject the same article.
  assert.ok(checkFastTrack(INCIDENT_GOOD).length > 0);
  const missing = checkFastTrack(INCIDENT_GOOD.replace('## Am I affected?\n', ''), { category: 'incident' });
  assert.ok(missing.some((e) => e.includes('am I affected')));
  const bare = checkFastTrack(INCIDENT_GOOD.replace('c\n', 'Block 194.150.166.244 now.\n'), { category: 'incident' });
  assert.ok(bare.some((e) => e.includes('not defanged')));
  assert.deepEqual(checkFastTrack(INCIDENT_GOOD.replace('c\n', 'Block 194.150.166[.]244 now.\n'), { category: 'incident' }), []);
});

// ---------- service outages ----------

const bc = { id: 'bleepingcomputer', weight: 1, topic: 'security-identity', category: 'incident',
  categoryBoost: { Security: 1, Technology: -2, Software: -1, Mobile: -1, Gaming: -3, Deals: -6 } };
const statusSrc = (over = {}) => ({ id: 'status-x', category: 'outage', weight: 0, platform: 'cloudflare', topic: 'cloud', minImpact: 'major', minComponents: 2, ...over });
const statusItem = (over = {}) => item({ title: 'Increased errors', status: 'investigating', impact: 'major', components: ['CDN/Cache', 'Workers', 'DNS'], ...over });

test('the BleepingComputer Microsoft 365 outage report clears the threshold as an outage on its own', () => {
  const r = scoreItem(item({
    title: 'Massive Microsoft 365 outage disrupts Outlook, Teams, Copilot worldwide',
    summary: 'Microsoft is investigating a widespread outage affecting multiple Microsoft 365 services, including Outlook, Microsoft Teams, and Copilot, as users report connectivity problems worldwide. [...]',
    categories: ['Microsoft'],
  }), bc, { now: NOW });
  assert.equal(r.reject, null);
  assert.equal(r.category, 'outage');
  assert.equal(r.topic, 'microsoft-365');
  assert.equal(r.resolved, false);
  assert.deepEqual(r.families, ['microsoft']);
  assert.ok(r.score >= 10, `${r.score}: ${r.reasons.join('; ')}`);
});

test('"Outlook down for thousands" and Indian bank / UPI outages clear the threshold', () => {
  for (const title of ['Outlook down for thousands of users worldwide', 'Gmail is down: users unable to send email', 'UPI down: PhonePe, Google Pay payments failing nationwide']) {
    const r = scoreItem(item({ title }), bc, { now: NOW });
    assert.equal(r.category, 'outage', title);
    assert.ok(r.score >= 10, `${title}: ${r.score} ${r.reasons.join('; ')}`);
  }
  assert.equal(scoreItem(item({ title: 'SBI down: YONO app and net banking outage hits customers' }), bc, { now: NOW }).topic, 'online-safety');
});

test('outageTerm ignores download, crackdown, shutdown, "shuts down", "cracks down", "down payment" and money "down"', () => {
  for (const t of ['How to download Outlook for Windows', 'Government crackdown on UPI fraud apps', 'Microsoft announces shutdown of Skype for Business',
    'WhatsApp shuts down feature for older phones', 'RBI cracks down on UPI apps', 'HDFC Bank cuts down payment for car loans',
    'Microsoft shares are down 3% after earnings', 'Breakdown of the Microsoft 365 price changes']) {
    assert.equal(outageTerm(t), null, t);
  }
  for (const t of ['Outlook down for thousands', 'Microsoft 365 is down', 'AWS went down again', 'GitHub down worldwide', 'Teams outage']) {
    assert.ok(outageTerm(t)?.strong, t);
  }
  // Not routed to outages at all: still scored (and rejected) as security news.
  assert.notEqual(scoreItem(item({ title: 'How to download Outlook for Windows' }), bc, { now: NOW }).category, 'outage');
});

test('outages need a major platform, and feature/explainer headlines are pushed down', () => {
  assert.equal(scoreOutage(item({ title: 'Small hosting firm suffers outage' }), bc, { now: NOW }).reject, 'outage outside the major platforms');
  assert.ok(scoreItem(item({ title: 'Microsoft Teams adds outage alerts for admins' }), bc, { now: NOW }).score < 10);
  assert.deepEqual(outageFamilies('Outage at HDFC Bank and UPI'), ['upi', 'hdfc']);
});

test('a security incident that mentions a disruption stays a security incident', () => {
  const r = scoreItem(item({ title: 'Ransomware attack on HDFC Bank vendor exposed customer data; bank urges customers to reset passwords', summary: 'Some disruption to services.' }), bc, { now: NOW });
  assert.equal(r.category, 'incident');
});

test('scheduled maintenance never qualifies and resolved outages never start a new article', () => {
  const cf = statusSrc();
  assert.equal(scoreItem(statusItem({ title: 'Scheduled maintenance in FRA (Frankfurt) on 2026-11-20', status: 'scheduled', components: ['Frankfurt, Germany - (FRA)'] }), cf, { now: NOW }).reject, 'scheduled maintenance');
  assert.equal(scoreItem(statusItem({ title: 'FRA (Frankfurt) on 2026-11-20', status: 'scheduled' }), cf, { now: NOW }).reject, 'scheduled maintenance');
  assert.equal(scoreOutage(item({ title: 'Cloudflare scheduled maintenance in FRA causes outage warnings' }), bc, { now: NOW }).reject, 'scheduled maintenance');
  assert.notEqual(scoreItem(item({ title: 'Cloudflare scheduled maintenance in FRA causes outage warnings' }), bc, { now: NOW }).reject, null);
  const done = scoreItem(statusItem({ status: 'resolved', impact: 'critical' }), cf, { now: NOW });
  assert.equal(done.reject, null);
  assert.equal(done.resolved, true);
  const news = scoreItem(item({ title: 'Microsoft 365 outage resolved after 14 hours, Outlook and Teams restored' }), bc, { now: NOW });
  assert.equal(news.category, 'outage');
  assert.equal(news.resolved, true);
  assert.ok(updateSignal('Microsoft 365 outage resolved', 'outage'));
  assert.ok(!updateSignal('Microsoft 365 outage continues', 'outage'));
  assert.equal(scoreItem(item({ title: 'Microsoft explains what caused the Microsoft 365 outage' }), bc, { now: NOW }).resolved, true);
});

test('status-page incidents: only open, large incidents qualify (impact and components gate, single PoPs ignored)', () => {
  const cf = statusSrc();
  const big = scoreItem(statusItem({ title: 'Cloudflare dashboard and API errors', impact: 'major' }), cf, { now: NOW });
  assert.equal(big.reject, null);
  assert.equal(big.category, 'outage');
  assert.ok(big.score >= 10, big.reasons.join('; '));
  assert.equal(scoreItem(statusItem({ impact: 'minor' }), cf, { now: NOW }).reject, 'below the major-incident gate');
  assert.equal(scoreItem(statusItem({ title: 'Network performance issues in St. Louis', impact: 'major', components: [] }), cf, { now: NOW }).reject, 'below the major-incident gate');
  // GitHub: critical needs 4 components (it marks several incidents a week critical).
  const gh = statusSrc({ platform: 'github', minComponents: 4, minComponentsCritical: 4 });
  assert.ok(scoreItem(statusItem({ title: 'Incident with Actions and Pages', impact: 'critical', components: ['Actions', 'Pages', 'Webhooks'] }), gh, { now: NOW }).reject);
  assert.equal(scoreItem(statusItem({ title: 'Impact across multiple GitHub products', impact: 'critical', components: ['Actions', 'Pages', 'Webhooks', 'Copilot'] }), gh, { now: NOW }).reject, null);
  // Google Workspace: Gmail alone is big enough when critical, Google Keep is not.
  const gws = statusSrc({ platform: 'google', minComponentsCritical: 2, criticalProducts: '^(Gmail|Google Drive)$' });
  assert.equal(scoreItem(statusItem({ impact: 'critical', components: ['Gmail'] }), gws, { now: NOW }).reject, null);
  assert.ok(scoreItem(statusItem({ impact: 'critical', components: ['Google Keep'] }), gws, { now: NOW }).reject);
  // A pages that only posts big incidents (assumeMajor), and an open incident kept fresh by its latest update.
  const m365 = statusSrc({ platform: 'microsoft', assumeMajor: true, topic: 'microsoft-365' });
  const old = scoreItem(statusItem({ components: [], date: '2026-11-08T16:17:00Z', updated: '2026-11-10T12:00:00Z' }), m365, { now: NOW });
  assert.equal(old.reject, null);
});

test('status parsers: Statuspage, Google incidents.json, status.cloud.microsoft, AWS RSS anchors', () => {
  const sp = parseSource(JSON.stringify({ incidents: [{ id: 'abc', name: 'Increased errors', status: 'investigating', impact: 'major', started_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T11:00:00Z',
    incident_updates: [{ body: 'We are investigating.' }], components: [{ name: 'Workers' }, { name: 'St. Louis, United States - (STL)' }] }] }),
  { type: 'statuspage-json', url: 'https://www.cloudflarestatus.com/api/v2/incidents.json' });
  assert.equal(sp[0].link, 'https://www.cloudflarestatus.com/incidents/abc');
  assert.deepEqual(sp[0].components, ['Workers']);
  assert.equal(sp[0].impact, 'major');

  const g = parseSource(JSON.stringify([{ id: 'x', begin: '2026-11-10T09:00:00+00:00', end: null, modified: '2026-11-10T10:00:00+00:00', severity: 'high', status_impact: 'SERVICE_OUTAGE',
    service_name: 'Gmail', external_desc: '**Summary:**\nUsers cannot send email. **Description:** more', most_recent_update: { status: 'SERVICE_OUTAGE', text: '**Summary:** Investigating.' },
    affected_products: [{ title: 'Gmail' }], uri: 'incidents/x' }]), { type: 'google-status-json', page: 'https://www.google.com/appsstatus/dashboard/' });
  assert.equal(g[0].title, 'Gmail: Users cannot send email.');
  assert.equal(g[0].link, 'https://www.google.com/appsstatus/dashboard/incidents/x');
  assert.equal(g[0].impact, 'critical');
  assert.equal(g[0].status, 'investigating');

  const ms = { type: 'ms-status-json', page: 'https://status.cloud.microsoft/' };
  assert.deepEqual(parseSource(JSON.stringify({ Id: null, Title: null, Message: 'No issues', Status: 'Available' }), ms), []);
  const m = parseSource(JSON.stringify({ Id: '274b', AuthoredDateTime: '2026-11-13T04:22:48+00:00', LastUpdatedTime: '2026-11-13T04:22:48+00:00',
    Title: 'Users may be unable to connect to multiple Microsoft 365 services', Status: 'Service degradation',
    Message: '<div>User impact: x</div><div>- Exchange Online: Users may be unable to access their mailbox.</div><div>- Microsoft Teams: Presence may be delayed.</div>' }), ms);
  assert.ok(m[0].link.startsWith('https://status.cloud.microsoft/#2026-11-13-users-may-be-unable-to-connect'), m[0].link);
  assert.ok(normalizeUrl(m[0].link).includes('#2026-11-13-users-may-be'), 'the dated anchor survives normalizeUrl');
  assert.deepEqual(m[0].components, ['Exchange Online', 'Microsoft Teams']);
  assert.throws(() => parseSource('{"hello":1}', { type: 'statuspage-json', url: 'https://x.example/' }));

  const aws = parseSource(`<rss><channel>
    <item><title>Service disruption: Increased Error Rates</title><link>https://status.aws.amazon.com/</link><pubDate>Tue, 10 Nov 2026 10:00:00 PST</pubDate>
      <guid isPermaLink="false">https://status.aws.amazon.com/#multipleservices-us-east-1_1794431489</guid><description>x</description></item>
    <item><title>Service is operating normally: [RESOLVED] Elevated API errors</title><link>https://status.aws.amazon.com/</link><pubDate>Tue, 10 Nov 2026 09:00:00 PST</pubDate>
      <guid isPermaLink="false">https://status.aws.amazon.com/#ec2-ap-south-1_1794431000</guid><description>y</description></item></channel></rss>`,
  { type: 'rss', anchorFromGuid: true });
  assert.notEqual(normalizeUrl(aws[0].link), normalizeUrl(aws[1].link));
  const awsSrc = statusSrc({ platform: 'aws', minComponents: 3, minComponentsCritical: 2 });
  const first = scoreItem(aws[0], awsSrc, { now: NOW });
  assert.equal(first.reject, null, first.reasons.join('; '));
  assert.equal(scoreItem(aws[1], awsSrc, { now: NOW }).reject, 'below the major-incident gate');
});

test('one outage per platform family: a status post and a news report of the same outage are one', () => {
  const mk = (title, score, families, resolved = false) => ({ item: { title }, score, reasons: [], category: 'outage', families, resolved });
  const news = mk('Massive Microsoft 365 outage disrupts Outlook, Teams, Copilot worldwide', 12, ['microsoft']);
  const status = mk('Users may be unable to connect to multiple Microsoft 365 services', 11, ['microsoft']);
  const gh = mk('Impact across multiple GitHub products', 11, ['github']);
  markIncidentDuplicates([news, status, gh], []);
  assert.equal(news.dupOf, undefined);
  assert.equal(status.dupOf, news.item.title);
  assert.equal(gh.dupOf, undefined);
  const again = mk('Outlook down for second day', 11, ['microsoft']);
  markIncidentDuplicates([again], [{ title: 'Microsoft 365 outage', category: 'outage', families: ['microsoft'] }]);
  assert.ok(again.dupOf);
  // Security incidents are not de-duplicated against outages.
  const inc = { item: { title: 'Microsoft 365 outage phishing campaign steals credentials' }, score: 10, reasons: [], category: 'incident' };
  markIncidentDuplicates([inc], [{ title: 'Microsoft 365 outage', category: 'outage', families: ['microsoft'] }]);
  assert.equal(inc.dupOf, undefined);
});

test('findCoverage (outage) matches only a recent outage post on the same platform', () => {
  const post = { slug: 'microsoft-365-outage-outlook-teams-what-to-do', title: 'Microsoft 365 outage: Outlook and Teams down, what to do', date: '2026-11-10', topic: 'microsoft-365', body: '---\n---\n## Post-incident review\n' };
  const it = { title: 'Microsoft 365 outage resolved', link: 'https://example.com/m' };
  assert.equal(findCoverage(it, { posts: [post] }, { category: 'outage', now: NOW }).post?.slug, post.slug);
  assert.equal(findCoverage(it, { posts: [{ ...post, date: '2026-10-01' }] }, { category: 'outage', now: NOW }).post, null);
  assert.equal(findCoverage({ title: 'GitHub outage', link: 'https://example.com/g' }, { posts: [post] }, { category: 'outage', now: NOW }).post, null);
  const howto = { slug: 'outlook-rules-how-to', title: 'How to set up Outlook rules', date: '2026-11-10', body: '---\n---\nx' };
  assert.equal(findCoverage(it, { posts: [howto] }, { category: 'outage', now: NOW }).post, null);
});

test('findCoverage (outage) sends root-cause news to the "pir: pending" follow-up, everything else to the guide', () => {
  const guide = { slug: 'microsoft-365-outage-november-2026-what-to-do', title: 'Microsoft 365 Outage: Outlook Down, Status and What to Do', date: '2026-11-10', body: '---\n---\n## Post-incident review\n' };
  const follow = { slug: 'microsoft-365-outage-november-2026-root-cause-it-admin-lessons', title: 'Microsoft 365 Outage: Root Cause and What IT Admins Should Learn', date: '2026-11-10', body: "---\npir: pending\n---\n## Post-incident review\n" };
  const posts = [follow, guide]; // alphabetical order, as loadSite reads them
  const opts = { category: 'outage', now: NOW };
  const status = { title: 'Users may be unable to connect to multiple Microsoft 365 services', link: 'https://status.cloud.microsoft/#2026-11-11-x',
    summary: 'Current status: recovery continues. We will share a full Post-Incident Report with root cause after mitigation is complete.' };
  assert.equal(findCoverage(status, { posts }, opts).post?.slug, guide.slug);
  assert.equal(findCoverage({ title: 'Microsoft 365 outage resolved', link: 'https://example.com/r' }, { posts }, opts).post?.slug, guide.slug);
  assert.equal(findCoverage({ title: 'Microsoft explains what caused the Microsoft 365 outage', link: 'https://example.com/c' }, { posts }, opts).post?.slug, follow.slug);
  const final = { ...status, link: 'https://status.cloud.microsoft/#2026-11-12-x', summary: 'Final status: resolved. Root cause: A configuration change to ...' };
  assert.equal(findCoverage(final, { posts }, opts).post?.slug, follow.slug);
  assert.equal(findCoverage({ ...status, summary: 'Root Cause: N/A' }, { posts }, opts).post?.slug, guide.slug);
  // Root-cause news 10 days later still finds the follow-up; other news does not, and nothing finds an old guide.
  const later = { category: 'outage', now: NOW + 10 * 86400e3 };
  assert.equal(findCoverage({ title: 'Microsoft 365 outage root cause: post-incident report', link: 'https://example.com/p' }, { posts }, later).post?.slug, follow.slug);
  assert.equal(findCoverage({ title: 'Microsoft 365 outage resolved', link: 'https://example.com/r' }, { posts }, later).post, null);
  // Once the follow-up has the cause (pir: published), it is an ordinary outage post again.
  const done = { ...follow, body: '---\npir: published\n---\n## Post-incident review\n' };
  assert.equal(findCoverage(status, { posts: [done, guide] }, opts).post?.slug, guide.slug);
});

test('statusClosed and isRootCauseNews: what makes a seen outage status post worth an update', () => {
  assert.ok(statusClosed({ title: 'Users may be unable to connect', status: 'service restored' }));
  assert.ok(statusClosed({ title: 'Users may be unable to connect', status: 'Post-incident report published' }));
  assert.ok(!statusClosed({ title: 'Users may be unable to connect', status: 'service degradation' }));
  assert.ok(isRootCauseNews({ title: 'x', summary: 'Final status: restored. Root cause: a configuration change' }));
  assert.ok(!isRootCauseNews({ title: 'x', summary: 'We will share a full Post-Incident Report with root cause and defense-in-depth actions' }));
});

test('daily cap: one extra slot a day for a major outage, launches stay capped at 2', () => {
  const S = { maxNewPerDay: 2, maxAttemptsPerDay: 3, maxOutageExtraPerDay: 1 };
  const launch = ['l', { category: 'launch', score: 14 }];
  const outage = ['o', { category: 'outage', score: 11 }];
  // Normal slots free: the best item, no extra.
  assert.deepEqual(pickNewTask([launch, outage], { newPublished: 1, attempts: 1, outageExtra: 0 }, S), { key: 'l', extra: false });
  // Cap reached: a launch waits, an outage takes the extra slot (third fast-track of the day).
  assert.equal(pickNewTask([launch], { newPublished: 2, attempts: 2, outageExtra: 0 }, S), null);
  assert.deepEqual(pickNewTask([launch, outage], { newPublished: 2, attempts: 2, outageExtra: 0 }, S), { key: 'o', extra: true });
  // The extra slot is used: a fourth (another outage) waits.
  assert.equal(pickNewTask([outage], { newPublished: 2, attempts: 2, outageExtra: 1 }, S), null);
  // Attempts cap (3 incl. failures) also hands over to the extra slot for outages only.
  assert.deepEqual(pickNewTask([outage], { newPublished: 1, attempts: 3, outageExtra: 0 }, S), { key: 'o', extra: true });

  // todayCounts keeps extra-slot tasks out of the normal counts.
  const today = istDate(NOW);
  const results = [
    { date: today, kind: 'new', status: 'published' },
    { date: today, kind: 'new', status: 'published' },
    { date: today, kind: 'new', status: 'published', category: 'outage', extra: true },
  ];
  assert.deepEqual(todayCounts(results, { seen: {} }, today), { newPublished: 2, updates: 0, attempts: 2, outageExtra: 1 });
  const writing = { seen: { o: { status: 'writing', kind: 'new', extra: true, taskAt: new Date(NOW).toISOString() } } };
  assert.equal(todayCounts(results.slice(0, 2), writing, today).outageExtra, 1);
});

test('backlogLine parks outages as outage guides', () => {
  const line = backlogLine({ title: 'Massive Microsoft 365 outage disrupts Outlook', date: '2026-11-12T20:15:16Z', topic: 'microsoft-365', link: 'https://example.com/o', category: 'outage', reason: 'daily cap' });
  assert.match(line, /: what happened, status and what to do \(outage 2026-11-12\) \| microsoft-365 \| outage guide/);
  assert.match(line, /\(fast-track outage, daily cap\)$/);
});

const OUTAGE_GOOD = `---
title: X
faqs:
  - question: q
    answer: a
---

**Status as of 10:30 IST, 13 November 2026:** Microsoft says recovery is ongoing.

## What happened
| Time (IST) | Time (ET) | Update |
|---|---|---|
| 21:47, 12 Nov | 11:17, 12 Nov | Microsoft opened EX1550543 |
## How to check status
a
## What users can do now
b
## What admins should do
c
## SLA credits
d
## Post-incident review
e
## What we checked
- f

Last tested: 2026-11-13

## Sources
- https://status.cloud.microsoft/
`;

test('checkFastTrack (outage) wants the outage sections, an IST+ET timeline and a status-as-of line', () => {
  assert.deepEqual(checkFastTrack(OUTAGE_GOOD, { category: 'outage' }), []);
  assert.ok(checkFastTrack(OUTAGE_GOOD).length > 0);
  assert.ok(checkFastTrack(OUTAGE_GOOD.replace('## SLA credits\n', ''), { category: 'outage' }).some((e) => e.includes('SLA credits')));
  assert.ok(checkFastTrack(OUTAGE_GOOD.replace('## Post-incident review\n', ''), { category: 'outage' }).some((e) => e.includes('post-incident review')));
  assert.ok(checkFastTrack(OUTAGE_GOOD.replace('**Status as of 10:30 IST, 13 November 2026:**', 'Status:'), { category: 'outage' }).some((e) => e.includes('as of')));
  assert.ok(checkFastTrack(OUTAGE_GOOD.replace('| Time (ET) ', '| Time (UTC) ').replace('11:17, 12 Nov', '16:17, 12 Nov'), { category: 'outage' }).some((e) => e.includes('ET')));
  assert.ok(checkFastTrack(OUTAGE_GOOD.replace('Last tested: 2026-11-13\n', ''), { category: 'outage' }).some((e) => e.includes('Last tested')));
  // Update mode still wants the status line.
  const upd = OUTAGE_GOOD.replace('faqs:', "updated: '2026-11-14'\nfaqs:").replace('**Status as of', '**Updated 2026-11-14:** Resolved.\n\n**Status as of');
  assert.deepEqual(checkFastTrack(upd, { kind: 'update', today: '2026-11-14', category: 'outage' }), []);
});

test('radar.mjs check --category outage runs the outage structure check', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-check-'));
  const good = path.join(dir, 'good.md');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(good, OUTAGE_GOOD);
  fs.writeFileSync(bad, OUTAGE_GOOD.replace('## SLA credits\n', ''));
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('./radar.mjs', import.meta.url));
  const run = (f, cat) => spawnSync(process.execPath, [cli, 'check', '--file', f, '--kind', 'new', '--category', cat], { encoding: 'utf8' });
  assert.equal(run(good, 'outage').status, 0);
  const r = run(bad, 'outage');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SLA credits/);
  assert.equal(run(good, 'launch').status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- trending videos ----------

const AV_NOW = Date.parse('2026-11-13T04:50:00Z');
const avTask = (over = {}) => ({ kind: 'new', key: 'k', category: 'launch', score: 10, title: 'T', ...over });
const plan = (over = {}) => autoVideoPlan({ task: avTask(), status: 'published', slug: 'a-post', topic: 'microsoft-365', title: 'A post', now: AV_NOW, ...over });

test('autoVideoPlan starts the pair for outages, incidents and scores of 12+', () => {
  assert.equal(plan({ task: avTask({ category: 'outage', score: 0 }) }).dispatch, true);
  assert.equal(plan({ task: avTask({ category: 'incident' }) }).reason, 'category incident');
  assert.equal(plan({ task: avTask({ score: 12 }) }).dispatch, true);
  const low = plan({ task: avTask({ score: 11 }) });
  assert.equal(low.dispatch, false);
  assert.match(low.reason, /not trending/);
});

test('autoVideoPlan only acts on a published new article', () => {
  assert.equal(plan({ task: avTask({ kind: 'update', category: 'outage' }) }).dispatch, false);
  assert.equal(plan({ task: avTask({ category: 'outage' }), status: 'failed' }).dispatch, false);
  assert.equal(plan({ task: avTask({ category: 'outage' }), slug: null }).dispatch, false);
});

test('autoVideoPlan: at most one trending pair a UTC day', () => {
  const t = avTask({ category: 'outage' });
  const results = [{ autoVideo: '2026-11-12' }, { autoVideo: '2026-11-13', dryRun: true }];
  assert.equal(plan({ task: t, results }).dispatch, true);
  const capped = plan({ task: t, results: [...results, { autoVideo: '2026-11-13' }] });
  assert.equal(capped.dispatch, false);
  assert.match(capped.reason, /daily cap reached \(1\/1/);
  // 23:30 UTC on the 12th is still the 12th (UTC day, like longvideo.yml), even though it is the 13th in IST.
  assert.equal(plan({ task: t, results: [{ autoVideo: '2026-11-13' }], now: Date.parse('2026-11-12T23:30:00Z') }).dispatch, true);
});

test('autoVideoPlan replaces the daily long video only when it is not made yet', () => {
  const t = avTask({ category: 'outage' });
  assert.equal(plan({ task: t, longVideoLog: '- 2026-11-12 | x | yt: https://www.youtube.com/watch?v=1 | publish: x\n' }).replacesDaily, true);
  assert.equal(plan({ task: t, longVideoLog: '- 2026-11-13 | x | yt: retry next run (quota)\n' }).replacesDaily, true);
  assert.equal(plan({ task: t, longVideoLog: '- 2026-11-13 | x | yt: https://www.youtube.com/watch?v=1 | publish: x\r\n' }).replacesDaily, false);
});

test('autoVideoPlan: consumer topics get the Short only; the brief asks for a first-second hook', () => {
  const p = plan({ task: avTask({ category: 'incident' }), topic: 'online-safety', title: 'Bank "leak"\n$(x)' });
  assert.equal(p.short, true);
  assert.equal(p.long, false);
  assert.match(p.longSkipped, /online-safety/);
  assert.match(p.brief, /^TRENDING NOW \(incident\): "Bank leak \(x\)"/);
  assert.match(p.brief, /first second/);
  assert.doesNotMatch(p.brief, /[\n`$\\]/);
  assert.equal(plan({ task: avTask({ category: 'outage' }) }).long, true);
});

test('radar.mjs video-plan reads the article and the long video log from the site checkout', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-video-'));
  fs.mkdirSync(path.join(site, 'content', 'posts'), { recursive: true });
  fs.mkdirSync(path.join(site, 'automation'));
  fs.writeFileSync(path.join(site, 'content', 'posts', 'm365-outage.md'), '---\r\ntitle: "Microsoft 365 outage: what to do"\r\ntopic: microsoft-365\r\n---\r\nBody\r\n');
  fs.writeFileSync(path.join(site, 'automation', 'longvideo-log.md'), '- 2030-01-02 | other | yt: https://www.youtube.com/watch?v=1 | publish: x\n');
  fs.writeFileSync(path.join(site, 'task.json'), JSON.stringify(avTask({ category: 'outage', score: 9 })));
  const cli = fileURLToPath(new URL('./radar.mjs', import.meta.url));
  const run = (now) => JSON.parse(spawnSync(process.execPath, [cli, 'video-plan', '--site', site, '--task', path.join(site, 'task.json'),
    '--status', 'published', '--file', 'content/posts/m365-outage.md', '--now', now], { encoding: 'utf8' }).stdout);
  const p = run('2030-01-02T04:00:00Z');
  assert.equal(p.dispatch, true);
  assert.equal(p.slug, 'm365-outage');
  assert.equal(p.long, true);
  assert.equal(p.replacesDaily, false);
  assert.match(p.brief, /"Microsoft 365 outage: what to do"/);
  assert.equal(run('2030-01-03T04:00:00Z').replacesDaily, true);
  fs.rmSync(site, { recursive: true, force: true });
});
