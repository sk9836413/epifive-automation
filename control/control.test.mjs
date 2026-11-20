// Control Center snapshot helpers (control/lib.mjs): backlog, publish log, social log, Shyam calendar and footage queue,
// workflow and token health, Cloudflare totals. Run: node --test control/control.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryHealth, footageQueue, metaTokenHealth, parseBacklog, parseSocialLog, platformValue, publishedOn, rumTotals, rumTrend, runHealth, socialSummary, upcomingFestivals } from './lib.mjs';

test('parseBacklog: unchecked items in order with their section', () => {
  const md = [
    '# Article backlog', 'Format: `- [ ] slug | working title | topic | goal`', '',
    '## Priority NOW 24 (owner, 20 Nov 2026: Chroma)', '<!-- notes -->',
    '- [ ] chroma-cloud | Chroma Cloud Is Shutting Down | databases | export data',
    '## Normal', '- [x] done-one | Done | x | y — published 2026-11-01',
    '- [ ] second | Second title | cloud | goal', '- [ ] third | Third | ai',
  ].join('\n');
  const b = parseBacklog(md, 2);
  assert.equal(b.unchecked, 3);
  assert.deepEqual(b.top, [
    { section: 'Priority NOW 24', slug: 'chroma-cloud', title: 'Chroma Cloud Is Shutting Down', topic: 'databases' },
    { section: 'Normal', slug: 'second', title: 'Second title', topic: 'cloud' },
  ]);
});

test('publishedOn: only that day\'s published lines', () => {
  const log = '2026-11-20 | a-post | published | ~1900 words\n2026-11-21 | b-post | published | ~2000 words\n2026-11-21 | c | skipped | x';
  assert.deepEqual(publishedOn(log, '2026-11-21'), [{ slug: 'b-post', note: '~2000 words' }]);
});

test('platformValue: ok, scheduled, error (URLs hidden), skipped, queued', () => {
  assert.deepEqual(platformValue('https://youtube.com/shorts/abc (thumbnail: 403 phone-verify)'), { state: 'ok', url: 'https://youtube.com/shorts/abc', text: 'https://youtube.com/shorts/abc (thumbnail: 403 phone-verify)' });
  assert.equal(platformValue('https://youtube.com/shorts/x (scheduled 2026-11-21T00:30:00Z)').state, 'scheduled');
  const e = platformValue('error: Upload to https://rupload.facebook.com/x/1 failed: Request processing failed');
  assert.equal(e.state, 'error');
  assert.ok(!e.text.includes('rupload'));
  assert.equal(platformValue('make error: Make webhook returned HTTP 500').state, 'error');
  assert.equal(platformValue('skipped').state, 'skipped');
  assert.equal(platformValue('queued 2026-11-18T00:30:00Z').state, 'queued');
});

test('social log: per-platform state, Instagram failures, last shares', () => {
  const log = [
    '# Social log',
    '- 2026-11-18 | a-post | fb: skipped | fb-reel: https://www.facebook.com/reel/1 | ig: error: Upload to https://r/x failed | yt: https://youtube.com/shorts/a | linkedin: make error: HTTP 500',
    '- 2026-11-19 | b-post | fb: skipped | fb-reel: https://www.facebook.com/reel/2 | ig: https://www.instagram.com/reel/B/ | yt: https://youtube.com/shorts/b (scheduled 2026-11-20T00:30:00Z) | linkedin: make error: HTTP 500 | ig-en: queued 2026-11-20T00:30:00Z',
    '- 2026-11-20 | c-post | fb: skipped | fb-reel: https://www.facebook.com/reel/3 | ig: error: Upload to https://r/y failed | yt: https://youtube.com/shorts/c | linkedin: make error: HTTP 500',
  ].join('\n');
  const entries = parseSocialLog(log);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].fields['ig-en'].state, 'queued');
  const s = socialSummary(entries, '2026-11-21');
  assert.equal(s.per_platform.ig.state, 'bad');
  assert.equal(s.per_platform.ig.last_ok_date, '2026-11-19');
  assert.equal(s.per_platform.ig.last_url, 'https://www.instagram.com/reel/B/');
  assert.equal(s.per_platform.ig.errors_7d, 2);
  assert.equal(s.per_platform['fb-reel'].state, 'good');
  assert.equal(s.per_platform.fb.state, 'warn');
  assert.equal(s.per_platform.linkedin.last_ok_date, null);
  assert.equal(s.ig_failures.length, 2);
  assert.deepEqual(s.last.map((x) => x.slug), ['c-post', 'b-post', 'a-post']);
});

test('upcomingFestivals: from today, name and status Shorts, sources dropped', () => {
  const md = [
    '| Date | Festival / vrat |', '|---|---|',
    '| 2026-11-20 | Janmotsav (BIG, status Shorts: eve 11-19 20:00). Sources: D: x |',
    '| 2026-11-21 | Tulsi Vivah (Dwadashi); Tulsi Shaligram Vivah (status Shorts: status 11-21 00:30). Sources: D: festivals |',
    '| 2026-11-24 | Kartik Purnima; Dev Deepawali (BIG, status Shorts: eve 11-23 20:00, status 11-24 00:30). Sources: P |',
    '| 2026-11-25 | Something (no status Short). Sources: D |',
  ].join('\n');
  assert.deepEqual(upcomingFestivals(md, '2026-11-21', 2), [
    { date: '2026-11-21', name: 'Tulsi Vivah (Dwadashi)', status: 'status Shorts: status 11-21 00:30' },
    { date: '2026-11-24', name: 'Kartik Purnima', status: 'BIG, status Shorts: eve 11-23 20:00, status 11-24 00:30' },
  ]);
  assert.equal(upcomingFestivals(md, '2026-11-25')[0].status, 'no status Short');
});

test('footageQueue: posted from the log, skip list, one clip a day after today\'s post', () => {
  const plan = { start: '2026-11-20', at: '07:15', clips: [{ id: '01', name: 'safed' }, { id: '08', name: 'darshan' }, { id: '04', name: 'pandal' }, { id: '02', name: 'gulab' }] };
  const log = '2026-11-20 | owner | 2026-11-20-owner-safed | Khatu | clip 01\n2026-11-21 | owner | 2026-11-21-owner-darshan | x';
  const q = footageQueue(plan, { skip: '# comment\n04\n', log, today: '2026-11-21' });
  assert.deepEqual(q.posted, ['01', '08']);
  assert.deepEqual(q.skipped, ['04']);
  assert.deepEqual(q.queue, [{ id: '02', name: 'gulab', day: '2026-11-22' }]);
  assert.equal(q.total, 4);
  const future = footageQueue({ ...plan, start: '2026-12-01' }, { log: '', today: '2026-11-21' });
  assert.equal(future.queue[0].day, '2026-12-01');
});

test('runHealth: success, failure, stale, running, none', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const run = (o) => ({ status: 'completed', conclusion: 'success', created_at: '2026-11-21T10:00:00Z', ...o });
  assert.equal(runHealth(run(), now, 30).state, 'good');
  assert.equal(runHealth(run({ conclusion: 'failure' }), now, 30).state, 'bad');
  assert.equal(runHealth(run({ conclusion: 'cancelled' }), now, 30).state, 'warn');
  assert.equal(runHealth(run({ created_at: '2026-11-19T10:00:00Z' }), now, 30).state, 'warn');
  assert.equal(runHealth(run({ created_at: '2026-11-01T10:00:00Z' }), now, null).state, 'good');
  assert.equal(runHealth(run({ status: 'in_progress', conclusion: null }), now, 30).text, 'in progress');
  assert.equal(runHealth(null, now, 30).state, 'warn');
});

test('token expiry checks', () => {
  const now = Date.parse('2026-11-21T00:00:00Z');
  assert.equal(expiryHealth('', now).state, 'info');
  assert.equal(expiryHealth('2026-11-20', now).state, 'bad');
  assert.equal(expiryHealth('2026-11-25', now).state, 'warn');
  assert.equal(expiryHealth('2027-01-10', now).state, 'good');
  assert.equal(metaTokenHealth({ is_valid: false }, now).state, 'bad');
  assert.equal(metaTokenHealth({ is_valid: true, expires_at: 0 }, now).state, 'good');
  assert.equal(metaTokenHealth({ is_valid: true, expires_at: now / 1000 + 3 * 86400 }, now).state, 'warn');
  assert.equal(metaTokenHealth(null, now).state, 'warn');
});

test('Cloudflare totals keep China apart; trend per date', () => {
  const rows = [
    { count: 10, sum: { visits: 6 }, dimensions: { countryName: 'IN', date: '2026-11-20' } },
    { count: 40, sum: { visits: 30 }, dimensions: { countryName: 'CN', date: '2026-11-20' } },
    { count: 5, sum: { visits: 4 }, dimensions: { countryName: 'US', date: '2026-11-21' } },
  ];
  assert.deepEqual(rumTotals(rows), { visits: 40, views: 55, cn: 30, real: 10 });
  assert.deepEqual(rumTrend(rows, ['2026-11-20', '2026-11-21', '2026-11-22']).map((d) => d.real), [6, 4, 0]);
});
