// Retirement calendar data model (radar/retirements.mjs). Run: node --test radar/retirements.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToText, brief, datesIn, changeDate, section, productFor, fromMessage, fromAzure, fromGithub, parseChangelog, linkGuides,
  mergeRows, actionSentence, DROP_PAST_DAYS,
} from './retirements.mjs';

const NOW = Date.parse('2026-11-19T06:00:00Z');

test('datesIn reads day and month dates, in order, without double counting', () => {
  const d = datesIn('Starting November 30, 2026 and by 15 January 2027, then mid-December 2026, ISO 2027-03-31, Feb. 3 2027.');
  assert.deepEqual(d.map((x) => [x.date, x.precision]), [
    ['2026-11-30', 'day'],
    ['2027-01-15', 'day'],
    ['2026-12-01', 'month'],
    ['2027-03-31', 'day'],
    ['2027-02-03', 'day'],
  ]);
  // An impossible day is not read as a day date.
  assert.equal(datesIn('February 30, 2027').filter((x) => x.precision === 'day').length, 0);
});

test('changeDate prefers the retirement sentence over rollout dates', () => {
  const text = 'Rollout begins October 1, 2026.\nThe feature will be retired on December 7, 2026. More info later.';
  const d = changeDate(text, NOW);
  assert.equal(d.date, '2026-12-07');
  assert.equal(d.precision, 'day');
  assert.match(d.dateText, /retired on December 7, 2026/);
  assert.equal(changeDate('Nothing dated here.', NOW), null);
  // Dates more than a year old are history, not the deadline.
  assert.equal(changeDate('We retired it on January 5, 2025.', NOW), null);
});

test('brief and sentences keep dotted names (vibe.powerapps.com) intact', () => {
  const s = brief('Use vibe.powerapps.com until then. Exchange.ManageV2 is replaced. A third sentence that is long enough to be cut off here.', 70);
  assert.equal(s, 'Use vibe.powerapps.com until then. Exchange.ManageV2 is replaced.');
});

test('section reads list sections and inline headings', () => {
  const text = htmlToText('<h2>Who is affected</h2><ul><li>Makers who built apps</li><li>Admins</li></ul><h2>Action required and recommendations</h2><p>Migrate apps before the date.</p><h2>Learn more</h2><p>x</p>');
  assert.equal(section(text, ['who is affected']), 'Makers who built apps; Admins');
  assert.equal(section(text, ['action required and recommendations']), 'Migrate apps before the date.');
  assert.equal(section('How this will affect your organization: Users lose access.', ['how this will affect your organization']), 'Users lose access.');
  assert.equal(section(text, ['what will happen']), '');
});

test('productFor uses the title prefix, then services, then the title', () => {
  assert.equal(productFor('Microsoft Teams: Retirement of Translate slides', ['Microsoft 365 apps']), 'teams');
  assert.equal(productFor('Retirement of -Credential parameter', ['Exchange Online']), 'exchange');
  assert.equal(productFor('Power Apps - end of support', ['Power Apps']), 'power-platform');
  assert.equal(productFor('Microsoft Entra: Passkeys by default', ['Microsoft Entra']), 'entra');
  assert.equal(productFor('Retirement of Microsoft 365 Companion apps', ['Microsoft 365 suite']), 'microsoft-365');
});

const MSG = {
  Id: 'MC1532259',
  Title: 'Microsoft Teams: Retirement of Translate slides in PowerPoint Live',
  Tags: ['User impact', 'Retirement'],
  Services: ['Microsoft 365 apps'],
  ActionRequiredByDateTime: null,
  StartDateTime: '2026-10-30T22:11:35Z',
  Body: {
    Content:
      '<p>What and why</p><p>Starting November 30, 2026, attendees will no longer be able to translate slides.</p><p>Who is affected</p><ul><li>Attendees who use Translate slides</li></ul><p>Action required and recommendations</p><p>No action is required to prepare for this change.</p>',
  },
};

test('fromMessage: stated date, official link, public copy, sections', () => {
  const r = fromMessage(MSG, NOW);
  assert.equal(r.id, 'MC1532259');
  assert.equal(r.product, 'teams');
  assert.equal(r.date, '2026-11-30');
  assert.equal(r.dateBasis, 'stated');
  assert.match(r.dateText, /Starting November 30, 2026/);
  assert.equal(r.url, 'https://admin.microsoft.com/#/MessageCenter/:/messages/MC1532259');
  assert.equal(r.mirror, 'https://mc.merill.net/message/MC1532259');
  assert.equal(r.affected, 'Attendees who use Translate slides');
  assert.equal(r.action, 'No action is required to prepare for this change.');
});

test("fromMessage: Microsoft's Act by date wins; non-retirements and undated notices are skipped", () => {
  const r = fromMessage({ ...MSG, ActionRequiredByDateTime: '2026-12-07T08:00:00Z' }, NOW);
  assert.equal(r.date, '2026-12-07');
  assert.equal(r.dateBasis, 'act-by');
  assert.equal(fromMessage({ ...MSG, Tags: ['New feature'], Title: 'Microsoft Teams: New onboarding workflow' }, NOW), null);
  assert.equal(fromMessage({ ...MSG, Body: { Content: '<p>We are retiring this feature.</p>' } }, NOW), null);
  assert.equal(fromMessage({ ...MSG, Id: 'not-an-id' }, NOW), null);
});

test('fromAzure: Retirements tag, date from the title, official update link', () => {
  const r = fromAzure(
    {
      Id: 'AZ578818',
      Title: 'Retirement: Azure Data Share will be retired on November 12, 2029',
      Tags: ['Retirements'],
      Services: ['Azure Data Share'],
      StartDateTime: '2026-11-13T19:54:45Z',
      Body: { Content: '<p>Azure Data Share will retire on November 12, 2029. Before that date, transition your workloads to Microsoft Fabric.</p>' },
    },
    NOW,
  );
  assert.equal(r.date, '2029-11-12');
  assert.equal(r.product, 'azure');
  assert.equal(r.title, 'Azure Data Share will be retired on November 12, 2029');
  assert.equal(r.url, 'https://azure.microsoft.com/en-us/updates?id=578818');
  assert.match(r.action, /^Before that date, transition/);
  assert.equal(fromAzure({ Id: 'AZ1', Title: 'Public preview: x', Tags: ['Features'], Body: { Content: '' } }, NOW), null);
});

test('GitHub changelog: deprecation posts become rows', () => {
  const xml = `<rss><channel><item><title>Upcoming deprecation of selected GitHub Copilot models</title><link>https://github.blog/changelog/2026-11-13-upcoming-deprecation-of-models</link><pubDate>Fri, 13 Nov 2026 18:00:00 +0000</pubDate><description><![CDATA[<p>We will deprecate the following models on December 14, 2026. Switch to a newer model before then.</p>]]></description><category domain="changelog-type"><![CDATA[Retired]]></category></item>
<item><title>Wait for pull request events with GitHub CLI</title><link>https://github.blog/changelog/2026-11-18-wait</link><description>New.</description></item></channel></rss>`;
  const items = parseChangelog(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].categories, ['Retired']);
  const rows = items.map((i) => fromGithub(i, NOW)).filter(Boolean);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'gh-2026-11-13-upcoming-deprecation-of-models');
  assert.equal(rows[0].date, '2026-12-14');
  assert.equal(rows[0].product, 'github');
  assert.match(rows[0].action, /Switch to a newer model/);
});

test('actionSentence finds the first instruction', () => {
  assert.equal(actionSentence('It is old. We recommend moving to v2. Thanks.'), 'We recommend moving to v2.');
  assert.equal(actionSentence('Nothing to do.'), '');
});

test('linkGuides prefers a retirement post that cites the MC number', () => {
  const rows = [{ id: 'MC1', source: 'message-center', url: 'x' }, { id: 'AZ5', source: 'azure-updates', url: 'https://azure.microsoft.com/en-us/updates?id=5' }];
  const posts = [
    { slug: 'weekly-roundup', title: 'Roundup', text: 'MC1 and others' },
    { slug: 'feature-retirement-guide', title: 'Feature retirement', text: 'see MC1' },
    { slug: 'azure-x', title: 'x', text: 'https://azure.microsoft.com/updates?id=5' },
  ];
  const out = linkGuides(rows, posts);
  assert.equal(out[0].guide, 'feature-retirement-guide');
  assert.equal(out[1].guide, 'azure-x');
});

test('mergeRows updates, keeps firstSeen and missing rows, drops long-past rows', () => {
  const old = [
    { id: 'MC1', date: '2026-12-01', title: 'Old title', firstSeen: '2026-11-01T00:00:00.000Z', guide: 'g' },
    { id: 'MC2', date: '2026-12-05', title: 'Gone from source', firstSeen: '2026-11-01T00:00:00.000Z' },
    { id: 'MC3', date: new Date(NOW - (DROP_PAST_DAYS + 5) * 864e5).toISOString().slice(0, 10), title: 'Long past' },
  ];
  const fresh = [
    { id: 'MC1', date: '2026-12-08', title: 'New title', guide: null },
    { id: 'MC4', date: '2026-11-25', title: 'Brand new', affected: undefined },
  ];
  const out = mergeRows(old, fresh, NOW);
  assert.deepEqual(out.map((r) => r.id), ['MC4', 'MC2', 'MC1']); // by date
  const mc1 = out.find((r) => r.id === 'MC1');
  assert.equal(mc1.date, '2026-12-08');
  assert.equal(mc1.title, 'New title');
  assert.equal(mc1.firstSeen, '2026-11-01T00:00:00.000Z');
  assert.equal(mc1.guide, 'g');
  assert.equal(out.find((r) => r.id === 'MC4').firstSeen, new Date(NOW).toISOString());
  assert.ok(!('affected' in out.find((r) => r.id === 'MC4')));
});
