// Unit tests for the outage / security email alerts (radar/alert.mjs). Run: node --test radar/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT, alertGate, alertKindForCategory, alertSubject, buildAlertEmail, completeAddress, ensureAlertField, firstAction,
  looksResolved, readArticle, sentences,
} from './alert.mjs';
import { todayCounts } from './lib.mjs';

const NOW = Date.parse('2026-11-13T08:00:00Z');
const ARTICLE_MD = `---
title: 'Microsoft 365 Outage (Nov 12-13, 2026): Outlook Down, Status and What to Do'
description: >-
  Outlook, Teams calendars, Copilot and other Microsoft 365 services failed in
  every region from 12 November 2026. What Microsoft has said, how to check
  status, workarounds, admin steps and SLA credits.
date: '2026-11-13'
topic: microsoft-365
alert: outage
tags:
  - Microsoft 365
  - Outlook
takeaways:
  - A Microsoft 365 outage tracked as EX1550543 hit users in every region.
  - Admins should follow EX1550543 in Service health.
faqs:
  - question: Is it down?
    answer: Yes.
---

**Updated 2026-11-13, 11:50 IST:** Microsoft's 06:17 UTC update still lists the incident as "Service degradation".

A major Microsoft 365 outage began on 12 November 2026. **Status as of 11:47 IST, 13 November 2026 (06:17 UTC; 1:17 a.m. ET):** still "Service degradation"; recovery is partial and it has not been declared resolved. If Outlook is failing for you, it is very likely this incident.

## What happened

| ET | IST | What |
|---|---|---|
| 11:17 a.m. | 9:47 p.m. | Status as of nothing |

## What users can do now

- **Try another way in, but don't keep switching.** Try \`outlook.office.com\` in a browser, then your phone.
- **Read what's already on your PC.** Cached mail stays readable.

## Sources

- https://status.cloud.microsoft
`;
const article = readArticle(ARTICLE_MD);
const task = (over = {}) => ({ kind: 'new', key: 'https://example.com/m365-outage', category: 'outage', title: 'Massive Microsoft 365 outage', families: ['microsoft-365'], ...over });
const sent = (over = {}) => ({ type: 'alert', kind: 'alert', status: 'sent', alert: 'outage', at: '2026-11-13T06:00:00.000Z', key: 'https://example.com/other', slug: 'other-outage', ...over });
const gate = (over = {}) => alertGate({ task: task(), status: 'published', slug: 'microsoft-365-outage-november-2026-what-to-do', article, results: [], now: NOW, ...over });

// ---------- reading the article ----------

test('readArticle finds the description, status sentence and first action', () => {
  assert.equal(article.title, 'Microsoft 365 Outage (Nov 12-13, 2026): Outlook Down, Status and What to Do');
  assert.match(article.description, /^Outlook, Teams calendars, Copilot and other Microsoft 365 services failed in every region/);
  assert.equal(article.status, 'Status as of 11:47 IST, 13 November 2026 (06:17 UTC; 1:17 a.m. ET): still "Service degradation"; recovery is partial and it has not been declared resolved.');
  assert.equal(article.action, "Try another way in, but don't keep switching.");
  assert.equal(article.alert, 'outage');
  assert.equal(article.takeaways.length, 2);
});

test('firstAction reads numbered lists and "### 1." headings', () => {
  assert.equal(firstAction('Intro.\n\n1. Search your repositories for the indicators.\n2. Rotate.'), 'Search your repositories for the indicators.');
  assert.equal(firstAction('\n### 1. Be suspicious of calls that use your details\n\nText.'), 'Be suspicious of calls that use your details.');
  assert.equal(firstAction('No list here.'), '');
});

test('sentences does not split on a.m., p.m. or e.g.', () => {
  assert.deepEqual(sentences('Down since 1:17 a.m. ET today. Next update at 2 p.m. IST, e.g. soon. Done'), [
    'Down since 1:17 a.m. ET today.', 'Next update at 2 p.m. IST, e.g. soon.', 'Done',
  ]);
});

// ---------- gate: what is never alerted ----------

test('only new outage and incident guides get an alert', () => {
  assert.equal(gate().send, true);
  assert.equal(gate().kind, 'outage');
  assert.equal(alertKindForCategory('incident'), 'security');
  assert.equal(gate({ task: task({ category: 'launch' }) }).send, false);
  assert.equal(gate({ task: task({ category: undefined }) }).send, false);
  const upd = gate({ task: task({ kind: 'update' }) });
  assert.equal(upd.send, false);
  assert.match(upd.reason, /update-only/);
  assert.equal(gate({ status: 'failed' }).send, false);
  assert.equal(gate({ task: task({ dryRun: true }) }).send, false);
});

test('never alerts on a resolved outage', () => {
  const resolved = readArticle(ARTICLE_MD.replace('still "Service degradation"; recovery is partial and it has not been declared resolved.', 'Microsoft says the incident is resolved and service is restored.'));
  const g = gate({ article: resolved });
  assert.equal(g.send, false);
  assert.match(g.reason, /resolved/);
  assert.equal(gate({ task: task({ title: 'Microsoft 365 outage resolved after 14 hours' }) }).send, false);
  assert.equal(looksResolved('it has not been declared resolved'), false);
  assert.equal(looksResolved('not yet restored for all users'), false);
  assert.equal(looksResolved('PIR to follow once mitigated'), false);
  assert.equal(looksResolved('Service restored in Europe'), true);
});

test('an outage guide without a status line, or an old article, gets no alert', () => {
  assert.equal(gate({ article: { ...article, status: '' } }).send, false);
  assert.equal(gate({ article: { ...article, date: '2026-11-01' } }).send, false);
  assert.equal(gate({ article: { ...article, alert: 'none' } }).send, false);
});

// ---------- gate: dedupe and caps ----------

test('at most 1 alert per incident (same key, slug or outage platform family within 3 days)', () => {
  assert.equal(gate({ results: [sent({ key: 'https://example.com/m365-outage' })] }).send, false);
  assert.equal(gate({ results: [sent({ slug: 'microsoft-365-outage-november-2026-what-to-do' })] }).send, false);
  const fam = gate({ results: [sent({ families: ['microsoft-365'] })] });
  assert.equal(fam.send, false);
  assert.match(fam.reason, /already alerted/);
  // The same platform a week later is a new incident.
  assert.equal(gate({ results: [sent({ families: ['microsoft-365'], at: '2026-11-05T06:00:00.000Z' })] }).send, true);
  // Skipped or failed attempts do not count; dry runs never count.
  assert.equal(gate({ results: [sent({ key: 'https://example.com/m365-outage', status: 'skipped' })] }).send, true);
  assert.equal(gate({ results: [sent({ key: 'https://example.com/m365-outage', dryRun: true })] }).send, true);
});

test('at most 2 alerts in 24 hours, and at most 1 of them a security alert', () => {
  const two = [sent({ key: 'a', slug: 'a', families: ['aws'] }), sent({ key: 'b', slug: 'b', families: ['cloudflare'], at: '2026-11-13T07:00:00.000Z' })];
  const capped = gate({ results: two });
  assert.equal(capped.send, false);
  assert.match(capped.reason, /daily cap/);
  // Older than 24 hours: the cap is free again.
  assert.equal(gate({ results: two.map((r) => ({ ...r, at: '2026-11-12T07:00:00.000Z' })) }).send, true);
  // One security alert already: a second security alert waits, an outage still goes.
  const oneSec = [sent({ alert: 'security', key: 'c', slug: 'c', families: undefined })];
  const sec = gate({ task: task({ category: 'incident', families: undefined }), results: oneSec, article: { ...article, alert: 'security' } });
  assert.equal(sec.send, false);
  assert.match(sec.reason, /security cap/);
  assert.equal(gate({ results: oneSec }).send, true);
});

test('alert entries in results.jsonl never count as fast-track publishes', () => {
  const results = [{ ...sent(), date: '2026-11-13', kind: 'alert' }, { date: '2026-11-13', kind: 'new', status: 'published' }];
  assert.equal(todayCounts(results, { seen: {} }, '2026-11-13').newPublished, 1);
  assert.equal(todayCounts(results, { seen: {} }, '2026-11-13').attempts, 1);
});

// ---------- the email ----------

test('the email has subject, 3 short lines, the link, unsubscribe and the postal footer', () => {
  const mail = buildAlertEmail({ kind: 'outage', slug: 'microsoft-365-outage-november-2026-what-to-do', article, address: 'Gurugram, Haryana 122001, India' });
  assert.equal(mail.subject, 'Outage alert: Microsoft 365 Outage (Nov 12-13, 2026)');
  assert.equal(mail.segment, 'Alerts: outage');
  assert.match(mail.text, /^What's down: Outlook, Teams calendars, Copilot and other Microsoft 365 services failed in every region from 12 November 2026\.$/m);
  assert.match(mail.text, /^Status: As of 11:47 IST, 13 November 2026/m);
  assert.match(mail.text, /^Do this first: Try another way in, but don't keep switching\.$/m);
  assert.match(mail.text, /https:\/\/www\.epifive\.com\/blog\/microsoft-365-outage-november-2026-what-to-do\?utm_source=alert/);
  for (const part of [mail.text, mail.html]) {
    assert.ok(part.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'), 'unsubscribe placeholder');
    assert.ok(part.includes('Gurugram, Haryana 122001, India'), 'postal footer');
  }
  assert.doesNotMatch(mail.html, /<script/i);
  assert.equal(ALERT.from, 'EpiFive <newsletter@epifive.com>');
});

test('security alerts use the security segment and subject', () => {
  const mail = buildAlertEmail({ kind: 'security', slug: 'sbi-data-leak', article: { ...article, title: 'SBI Data Leak on the Dark Web: What SBI Said and What to Do' } });
  assert.equal(mail.subject, 'Security alert: SBI Data Leak on the Dark Web');
  assert.equal(mail.segment, 'Alerts: security');
  assert.match(mail.text, /^What happened: /m);
  assert.equal(alertSubject('outage', 'x'.repeat(200)).length <= 90, true);
});

test('completeAddress needs a street or PO box, a city and a postcode', () => {
  assert.equal(completeAddress('Gurugram, Haryana 122001, India'), false);
  assert.equal(completeAddress('PO Box 123, Gurugram, Haryana 122001, India'), true);
});

// ---------- frontmatter field ----------

test('ensureAlertField adds alert: outage|security after topic, once', () => {
  const md = "---\ntitle: 'X'\ntopic: cloud\ntags:\n  - A\n---\n\nBody\n";
  const out = ensureAlertField(md, 'outage');
  assert.match(out, /^topic: cloud\nalert: outage\ntags:/m);
  assert.equal(ensureAlertField(out, 'outage'), out);
  assert.match(ensureAlertField(md, 'incident'), /^alert: security$/m);
  assert.equal(ensureAlertField(md, 'launch'), md);
  assert.equal(ensureAlertField(md.replace(/\n/g, '\r\n'), 'outage').includes('\r\nalert: outage\r\n'), true);
});
