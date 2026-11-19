// Status snapshot for the site's /status pages (radar/status.mjs). Run: node --test radar/status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecent, recentRow, MAX_PER_SERVICE } from './status.mjs';

const NOW = Date.parse('2026-11-19T06:00:00Z');
const item = (over) => ({
  id: 'a1',
  key: 'k-a1',
  time: '2026-11-18T10:00:00.000Z',
  kind: 'outage',
  headline: 'Users may be unable to access Microsoft 365 services',
  lines: ['Line.'],
  source: { name: 'Microsoft 365 consumer status (status.cloud.microsoft)', url: 'https://status.cloud.microsoft/' },
  reported: false,
  post: 'microsoft-365-outage-guide',
  ...over,
});

test('recentRow keeps only public, safe fields', () => {
  const r = recentRow(item({ post: 'Bad Slug!', source: { name: 'X', url: 'javascript:alert(1)' } }), '2026-11-18');
  assert.deepEqual(r, {
    time: '2026-11-18T10:00:00.000Z',
    headline: 'Users may be unable to access Microsoft 365 services',
    source: 'X',
    url: '',
    reported: false,
    live: '/news/live/2026-11-18#u-a1',
    post: null,
  });
});

test('buildRecent groups outage and status items by service, headline only', () => {
  const days = [
    {
      date: '2026-11-18',
      items: [
        item(),
        // An outage elsewhere whose lines mention Microsoft 365 must not land on the Microsoft pages.
        item({ id: 'b2', key: 'k-b2', headline: 'Apple services hit by outage', lines: ['Like the Microsoft 365 outage last week.'], source: { name: 'TechCrunch', url: 'https://techcrunch.com/x' }, reported: true }),
        // A launch from a non-status source is not an incident.
        item({ id: 'c3', key: 'k-c3', kind: 'launch', headline: 'New Teams feature', source: { name: 'Microsoft 365 Blog', url: 'https://m365.example/x' } }),
        // From an official status feed, whatever the kind.
        item({ id: 'd4', key: 'k-d4', kind: 'update', headline: 'Service impact: Increased Connectivity issues in US-EAST-1', source: { name: 'AWS Health Dashboard RSS (all services)', url: 'https://status.aws.amazon.com/' } }),
        // GitHub needs "GitHub" in the text, not only "Copilot".
        item({ id: 'e5', key: 'k-e5', headline: 'Microsoft 365 Copilot outage', source: { name: 'BleepingComputer', url: 'https://bc.example/x' } }),
      ],
    },
    { date: '2026-09-01', items: [item({ id: 'old', key: 'k-old', time: '2026-09-01T00:00:00.000Z' })] },
  ];
  const out = buildRecent(days, { now: NOW, keepDays: 45 });
  assert.deepEqual(out['microsoft-365'].map((r) => r.live), ['/news/live/2026-11-18#u-a1', '/news/live/2026-11-18#u-e5']);
  assert.deepEqual(out.aws.map((r) => r.headline), ['Service impact: Increased Connectivity issues in US-EAST-1']);
  assert.equal(out.github.length, 0);
  assert.equal(out.cloudflare.length, 0);
  assert.ok(!Object.values(out).flat().some((r) => /Apple/.test(r.headline)));
});

test('buildRecent dedupes by story key and caps each service', () => {
  const items = Array.from({ length: MAX_PER_SERVICE + 5 }, (_, i) =>
    item({ id: `x${i}`, key: `k${i}`, time: new Date(NOW - i * 36e5).toISOString(), headline: `Cloudflare incident ${i}`, source: { name: 'Cloudflare Status', url: 'https://www.cloudflarestatus.com/' } }),
  );
  const out = buildRecent([{ date: '2026-11-19', items: [...items, items[0]] }], { now: NOW });
  assert.equal(out.cloudflare.length, MAX_PER_SERVICE);
  assert.equal(out.cloudflare[0].headline, 'Cloudflare incident 0');
});
