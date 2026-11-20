// node --test report/report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, articlesOn, bucketSources, classifySource, dayLabel, delta, istDate, istDayBounds, istTime, nextDatedBacklog,
  parseDayPlanLine, pct, previousSnapshot, pruneSnapshot, renderHtml, renderText, seekh,
} from './lib.mjs';

test('IST date: the day flips at 18:30 UTC', () => {
  assert.equal(istDate(new Date('2026-11-19T18:29:59Z')), '2026-11-19');
  assert.equal(istDate(new Date('2026-11-19T18:30:00Z')), '2026-11-20');
  assert.equal(istDate(new Date('2026-11-18T18:30:00Z')), '2026-11-19');
  assert.equal(istDate(new Date('2026-12-31T19:00:00Z')), '2027-01-01');
});

test('IST day bounds in UTC, across month and year ends', () => {
  assert.deepEqual(istDayBounds('2026-11-19'), { from: '2026-11-18T18:30:00Z', to: '2026-11-19T18:30:00Z' });
  assert.deepEqual(istDayBounds('2026-12-01'), { from: '2026-11-30T18:30:00Z', to: '2026-12-01T18:30:00Z' });
  assert.deepEqual(istDayBounds('2027-01-01'), { from: '2026-12-31T18:30:00Z', to: '2027-01-01T18:30:00Z' });
  // Every moment inside the bounds has that IST date.
  const { from, to } = istDayBounds('2026-11-19');
  assert.equal(istDate(new Date(from)), '2026-11-19');
  assert.equal(istDate(new Date(Date.parse(to) - 1)), '2026-11-19');
});

test('addDays, dayLabel, istTime', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(dayLabel('2026-11-19'), '19 Nov');
  assert.equal(istTime(new Date('2026-11-19T14:16:00Z')), '19:46');
});

test('number formatting: delta and pct', () => {
  assert.equal(delta(120, 100), '+20');
  assert.equal(delta(90, 100), '-10');
  assert.equal(delta(5, 5), '0');
  assert.equal(delta(1500, undefined), '');
  assert.equal(pct(14, 10), '+40%');
  assert.equal(pct(5, 10), '-50%');
  assert.equal(pct(3, 0), 'new');
  assert.equal(pct(0, 0), '');
});

test('traffic sources', () => {
  assert.equal(classifySource(''), 'Direct');
  assert.equal(classifySource('www.epifive.com'), 'Direct');
  assert.equal(classifySource('www.google.com'), 'Google');
  assert.equal(classifySource('google.co.in'), 'Google');
  assert.equal(classifySource('www.bing.com'), 'Bing');
  assert.equal(classifySource('cn.bing.com'), 'Bing');
  assert.match(classifySource('chatgpt.com'), /^AI/);
  assert.match(classifySource('www.perplexity.ai'), /^AI/);
  assert.match(classifySource('claude.ai'), /^AI/);
  assert.match(classifySource('copilot.microsoft.com'), /^AI/);
  assert.match(classifySource('gemini.google.com'), /^AI/, 'Gemini is AI, not Google search');
  assert.equal(classifySource('l.facebook.com'), 'Facebook');
  assert.equal(classifySource('m.facebook.com'), 'Facebook');
  assert.equal(classifySource('teams.microsoft.com'), 'Teams');
  assert.equal(classifySource('duckduckgo.com'), 'Others');
  const b = bucketSources([{ host: '', visits: 10 }, { host: 'www.bing.com', visits: 4 }, { host: 'duckduckgo.com', visits: 2 }, { host: 'x.com', visits: 3 }]);
  assert.equal(b.by.Direct, 10);
  assert.equal(b.by.Bing, 4);
  assert.equal(b.by.Others, 5);
  assert.deepEqual(b.others, [['x.com', 3], ['duckduckgo.com', 2]]);
});

test('seekh picks the biggest move on a real base', () => {
  const line = seekh([
    { label: 'Website visits', now: 110, before: 100 },
    { label: 'Bing', now: 14, before: 10 },
    { label: 'Teams', now: 1, before: 0 }, // too small
  ]);
  assert.match(line, /^Bing \+40% \(10 -> 14/);
  assert.match(seekh([{ label: 'Google', now: 6, before: 20 }]), /^Google -70% .* gira hai/);
  assert.equal(seekh([{ label: 'Google', now: 2, before: 1 }]), null);
  assert.equal(seekh([]), null);
});

test('articles of one date from log.md', () => {
  const log = [
    '2026-11-18 | old-post | published | ~1750 words',
    '2026-11-19 | gemini-4-neon | fast-track | ~1619 words',
    '2026-11-19 | gta-6-errors | published | ~2450 words',
    '2026-11-19 | some-update | fast-track update',
    'random text',
  ].join('\n');
  assert.deepEqual(articlesOn(log, '2026-11-19').map((a) => [a.slug, a.status]), [['gemini-4-neon', 'fast-track'], ['gta-6-errors', 'published'], ['some-update', 'fast-track update']]);
  assert.deepEqual(articlesOn(log, '2026-11-20'), []);
});

test('next dated backlog item (GTA series)', () => {
  const b = [
    '- [x] gta-a | Done one (not before 2026-11-18) | devices | x',
    '- [ ] gta-b | GTA 6 on PS5 vs Xbox (not before 2026-11-20) | devices | x',
    '- [ ] gta-c | GTA 6 lag fix (not before 2026-11-21) | devices | x',
  ].join('\n');
  assert.equal(nextDatedBacklog(b, '2026-11-20').slug, 'gta-b');
  assert.equal(nextDatedBacklog(b, '2026-11-19'), null);
});

test("Shyam day-plan line", () => {
  assert.deepEqual(parseDayPlanLine('2026-11-21 Sat festival 3: status 00:30 (tulsi-vivah), evening 19:00 (temple), eve 20:00 (ravi-pradosh-nov)  | cap drops: morning, facts  [Tulsi Vivah (Dwadashi)]'),
    { kind: 'festival', plan: 'status 00:30 (tulsi-vivah), evening 19:00 (temple), eve 20:00 (ravi-pradosh-nov)', festival: 'Tulsi Vivah (Dwadashi)' });
  assert.deepEqual(parseDayPlanLine('2026-11-23 Mon normal   2: morning 06:00 (daystatus), evening 19:00 (temple)'),
    { kind: 'normal', plan: 'morning 06:00 (daystatus), evening 19:00 (temple)', festival: '' });
  assert.equal(parseDayPlanLine('nothing'), null);
});

test('snapshot: compare with yesterday, else the latest earlier day; prune', () => {
  const snap = { days: { '2026-11-15': { a: 1 }, '2026-11-17': { a: 2 }, '2026-11-18': { a: 3 }, '2026-11-19': { a: 4 } } };
  assert.deepEqual(previousSnapshot(snap, '2026-11-19'), { date: '2026-11-18', data: { a: 3 } });
  assert.deepEqual(previousSnapshot({ days: { '2026-11-15': { a: 1 } } }, '2026-11-19'), { date: '2026-11-15', data: { a: 1 } });
  assert.equal(previousSnapshot({ days: {} }, '2026-11-19'), null);
  assert.deepEqual(Object.keys(pruneSnapshot(snap, 2).days), ['2026-11-18', '2026-11-19']);
});

test('rendering: text, HTML escaping and private lines masked for logs', () => {
  const report = {
    title: 'EpiFive daily report - 19 Nov 2026',
    sections: [
      { title: '1. Website', items: [{ text: 'Aaj: 10 visits' }, { heading: 'Top' }, { text: '5  /blog/<x>', href: 'https://www.epifive.com/blog/x' }] },
      { title: '5. Leads', items: [{ text: 'Acme Corp: proposal, USD 800', private: true, href: 'https://crm.epifive.com/#/leads/6' }] },
    ],
    footer: 'Private',
  };
  const t = renderText(report);
  assert.match(t, /== 1\. Website ==/);
  assert.match(t, /- 5 {2}\/blog\/<x> {2}https:\/\/www\.epifive\.com\/blog\/x/);
  assert.match(t, /Acme Corp/);
  const masked = renderText(report, { redact: true });
  assert.doesNotMatch(masked, /Acme|USD 800|leads\/6/);
  assert.match(masked, /\[private: sirf email me\]/);
  const h = renderHtml(report);
  assert.match(h, /&lt;x&gt;/);
  assert.doesNotMatch(h, /<x>/);
  assert.match(h, /<a href="https:\/\/www\.epifive\.com\/blog\/x"/);
  assert.match(h, /<h3[^>]*>5\. Leads<\/h3>/);
});

test('LinkedIn token warnings: 7 days before the expiry, and after it', async () => {
  const { linkedinTokenNotes } = await import('./lib.mjs');
  const now = new Date('2026-11-20T12:00:00Z');
  assert.deepEqual(linkedinTokenNotes({}, now), []);
  assert.deepEqual(linkedinTokenNotes({ LINKEDIN_PAGE_TOKEN_EXPIRES: '2027-01-19' }, now), []);
  const soon = linkedinTokenNotes({ LINKEDIN_PAGE_TOKEN_EXPIRES: '2026-11-25', LINKEDIN_MEMBER_TOKEN_EXPIRES: '2026-11-10' }, now);
  assert.equal(soon.length, 2);
  assert.match(soon[0], /Page ka token 2026-11-25 ko expire hoga \(4 din baaki\).*linkedin-auth\.mjs page/);
  assert.match(soon[1], /profile ka token .*2026-11-10 ko expire ho gaya.*linkedin-auth\.mjs personal/);
});

test('missedTrendsLines: the radar\'s missed-trends check for today, or a note that it has not run yet', async () => {
  const { missedTrendsLines } = await import('./lib.mjs');
  assert.match(missedTrendsLines({}, '2026-11-20')[0].text, /abhi nahi chala/);
  assert.match(missedTrendsLines({ missedCheck: { day: '2026-11-19', items: [] } }, '2026-11-20')[0].text, /abhi nahi chala/);
  const state = { missedCheck: { day: '2026-11-20', checked: 5, covered: 3, items: [{ title: 'Sarvam launches Token Factory', link: 'https://x.test/s', parked: true }, { title: 'Other', link: 'https://x.test/o', parked: false }] } };
  const lines = missedTrendsLines(state, '2026-11-20');
  assert.match(lines[0].text, /5 bade items check, 3 already covered, 1 backlog ke top par park, 1 daily cap ke upar/);
  assert.deepEqual(lines.slice(1).map((l) => [l.text, l.href]), [['Parked: Sarvam launches Token Factory', 'https://x.test/s'], ['Cap ke upar: Other', 'https://x.test/o']]);
});
