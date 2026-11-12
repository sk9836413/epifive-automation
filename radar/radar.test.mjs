// Unit tests for the launch radar (scoring, de-duplication, parsing, site edits). Run: node --test radar/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeed, parseSitemap, parseHtmlList, parseDatedSections, normalizeUrl, scoreItem, mergeDuplicates, findCoverage,
  parseBacklog, sameTopic, todayCounts, parkInBacklog, markPublished, logLine, checkFastTrack, trendBoost, istDate, RADAR_MARK,
  datesIn, daysToDeadline, scoreIncident, sameIncident, markIncidentDuplicates, backlogLine, updateSignal,
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
  assert.deepEqual(todayCounts(results, state, today), { newPublished: 2, updates: 1, attempts: 3 });
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
