import test from 'node:test';
import assert from 'node:assert/strict';
import { cvrfId, msrcReleased, patchTuesdayDue, patchTuesdayItem, secondTuesday, slugForMonth, summarize } from './patch-tuesday.mjs';
import { checkFastTrack, pickNewTask } from './lib.mjs';
import { alertKindForCategory, readArticle } from './alert.mjs';

test('second Tuesday of the month', () => {
  assert.equal(secondTuesday(2026, 10).toISOString().slice(0, 10), '2026-11-10');
  assert.equal(secondTuesday(2026, 11).toISOString().slice(0, 10), '2026-12-08');
  assert.equal(secondTuesday(2027, 0).toISOString().slice(0, 10), '2027-01-12');
  assert.equal(secondTuesday(2026, 8).toISOString().slice(0, 10), '2026-09-08'); // the 1st is a Tuesday
});

test('due from 18:00 UTC on release day for 3 days', () => {
  assert.equal(patchTuesdayDue(Date.parse('2026-12-08T17:59:00Z')), null);
  const due = patchTuesdayDue(Date.parse('2026-12-08T18:05:00Z'));
  assert.deepEqual(
    { month: due.month, key: due.key, slug: due.slug, link: due.link },
    { month: '2026-12', key: 'patch-tuesday-2026-12', slug: 'patch-tuesday-december-2026', link: 'https://msrc.microsoft.com/update-guide/releaseNote/2026-Dec' },
  );
  assert.ok(patchTuesdayDue(Date.parse('2026-12-11T17:00:00Z')));
  assert.equal(patchTuesdayDue(Date.parse('2026-12-12T00:00:00Z')), null);
  assert.equal(patchTuesdayDue(Date.parse('2026-12-01T20:00:00Z')), null);
});

test('ids and slugs', () => {
  assert.equal(cvrfId('2026-11'), '2026-Nov');
  assert.equal(slugForMonth('2027-01'), 'patch-tuesday-january-2027');
});

test('queued item: top score, patch-tuesday category, picked first within the caps', () => {
  const due = patchTuesdayDue(Date.parse('2026-12-08T18:30:00Z'));
  const item = patchTuesdayItem(due, Date.parse('2026-12-08T18:30:00Z'));
  assert.equal(item.category, 'patch-tuesday');
  assert.equal(item.status, 'queued');
  assert.equal(item.patchTuesday, '2026-12');
  const queued = [['https://example.com/launch', { score: 14, status: 'queued' }], [due.key, item]].sort((a, b) => b[1].score - a[1].score);
  assert.deepEqual(pickNewTask(queued, { newPublished: 0, attempts: 0 }), { key: due.key, extra: false });
  assert.equal(pickNewTask(queued, { newPublished: 2, attempts: 2, outageExtra: 0 }), null); // same daily caps
});

test('msrcReleased reads the MSRC updates API', async () => {
  const body = JSON.stringify({ value: [{ ID: '2026-Nov', CvrfUrl: 'https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/2026-Nov' }] });
  assert.equal(await msrcReleased('2026-11', async () => body), true);
  assert.equal(await msrcReleased('2026-12', async () => JSON.stringify({ value: [] })), false);
});

const vuln = (cve, { cna = 'Microsoft', date = '2026-11-10T08:00:00', severity = 'Important', impact = 'Elevation of Privilege', exploited = 'No', disclosed = 'No', product = 'Windows Kernel', kb = '5132061', build = '10.0.26100.9974' } = {}) => ({
  CVE: cve,
  Title: { Value: `${product} ${impact} Vulnerability` },
  Notes: [{ Type: 7, Value: product }, { Type: 8, Value: cna }, { Type: 6, Value: 'Yes' }],
  RevisionHistory: [{ Date: date }],
  Threats: [
    { Type: 0, Description: { Value: impact }, ProductID: ['1'] },
    { Type: 3, Description: { Value: severity }, ProductID: ['1'] },
    { Type: 1, Description: { Value: `Publicly Disclosed:${disclosed};Exploited:${exploited};Latest Software Release:${exploited === 'Yes' ? 'Exploitation Detected' : 'Exploitation Less Likely'}` } },
  ],
  CVSSScoreSets: [{ BaseScore: 7.8 }],
  Remediations: [{ Type: 2, Description: { Value: kb }, SubType: 'Security Update', FixedBuild: build, ProductID: ['1'] }],
});

test('summarize counts Microsoft CVEs published on release day only', () => {
  const cvrf = {
    DocumentTracking: { InitialReleaseDate: '2026-11-10T08:00:00' },
    ProductTree: { Branch: [{ Items: [{ Items: [{ ProductID: '1', Value: 'Windows 11 Version 25H2 for x64-based Systems' }] }] }] },
    Vulnerability: [
      vuln('CVE-2026-1', { severity: 'Critical', impact: 'Remote Code Execution' }),
      vuln('CVE-2026-2', { severity: 'Moderate', impact: 'Spoofing', exploited: 'Yes', product: 'Microsoft Office Outlook' }),
      vuln('CVE-2026-3'),
      vuln('CVE-2026-4', { date: '2026-11-16T08:00:00' }),
      vuln('CVE-2026-5', { cna: 'Chrome' }),
    ],
  };
  const kev = { vulnerabilities: [{ cveID: 'CVE-2026-2', vendorProject: 'Microsoft', product: 'Office', vulnerabilityName: 'x', dateAdded: '2026-11-10', dueDate: '2026-11-24' }, { cveID: 'CVE-2025-9', vendorProject: 'Other', dateAdded: '2026-10-01' }] };
  const s = summarize(cvrf, { month: '2026-11', kev });
  assert.equal(s.total, 3);
  assert.deepEqual(s.bySeverity, { Critical: 1, Moderate: 1, Important: 1 });
  assert.deepEqual(s.exploited.map((x) => x.cve), ['CVE-2026-2']);
  assert.deepEqual(s.criticalRce.map((x) => x.cve), ['CVE-2026-1']);
  assert.deepEqual(s.publishedOtherDays.map((x) => x.cve), ['CVE-2026-4']);
  assert.deepEqual(s.thirdPartyCves, { Chrome: 1 });
  assert.deepEqual(s.kbByProduct['Windows 11 Version 25H2 for x64-based Systems'], [{ kb: 'KB5132061', type: 'Security Update', build: '10.0.26100.9974' }]);
  assert.deepEqual(s.cisaKevAddedSinceRelease.map((x) => x.cve), ['CVE-2026-2']);
});

test('structure check and alert for a patch-tuesday article', () => {
  const md = `---\ntitle: x\nfaqs:\n  - question: q\n    answer: a\n---\n\nIntro.\n\n## November 2026 at a glance\n\nx\n\n## Zero-day: CVE-2026-2\n\nx\n\n## Critical remote code execution bugs\n\nx\n\n## Products affected\n\nx\n\n## KB numbers for each Windows version\n\n| Windows 11 | KB5132061 |\n\n## Known issues from Windows release health\n\nx\n\n## What to patch first\n\n1. **Outlook and Microsoft 365 Apps** for the zero-day.\n\n## How to deploy the updates\n\nx\n\n## What we checked\n\n- x\n\nLast tested: 2026-11-19\n\n## References\n\n- https://msrc.microsoft.com/update-guide/releaseNote/2026-Nov\n`;
  assert.deepEqual(checkFastTrack(md, { category: 'patch-tuesday' }), []);
  const errors = checkFastTrack(md.replace('KB5132061', 'pending').replace('## What to patch first', '## Patch order'), { category: 'patch-tuesday' });
  assert.ok(errors.some((e) => /what to patch first/.test(e)));
  assert.ok(errors.some((e) => /KB numbers/.test(e)));
  assert.equal(alertKindForCategory('patch-tuesday'), 'security');
  assert.equal(readArticle(md).action, 'Outlook and Microsoft 365 Apps.');
});
