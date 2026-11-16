#!/usr/bin/env node
// The English Instagram Reel of the day, posted hours after the Hinglish one (owner, 16 Nov 2026: both versions on
// Facebook, Instagram and YouTube, 5+ hours apart). YouTube and Facebook schedule the English version natively;
// Instagram's API cannot, so social.yml queues it here and reels-later.yml posts it once it is due.
//
//   node reels/queue.mjs add  --file reels/queue.jsonl --slug <slug> --run <run id> --artifact <name> --due <ISO>
//   node reels/queue.mjs due  --file reels/queue.jsonl [--now <ISO>]      one JSON line: the item to post now, or {}
//   node reels/queue.mjs done --file reels/queue.jsonl --slug <slug> --result <meta-post result.json> --log reels/log.md
//
// queue.jsonl: one JSON object per line {slug, run, artifact, due, status: pending|posted|error|expired, ...}.
// reels/log.md: "- <date> | <slug> | ig-en: <url>" lines in the social-log format, so the comment-reply job maps the
// Reel to its article (comment-replies.mjs --extra-log). No secrets or personal data: public repo.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_LATE_HOURS = 20; // never post a "tonight" Reel the next afternoon: it would sit on top of the next share
export const MAX_ATTEMPTS = 3;

export const readQueue = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
export const writeQueue = (file, items) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep the last 60 entries (about two months).
  fs.writeFileSync(file, items.slice(-60).map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
};

/** Marks stale items expired and returns the oldest pending item that is due now (or null). Mutates items. */
export function dueItem(items, now = new Date()) {
  const t = now.getTime();
  for (const it of items) {
    if (it.status !== 'pending') continue;
    const due = Date.parse(it.due);
    if (!Number.isFinite(due)) { it.status = 'error'; it.error = 'bad due time'; continue; }
    if (t - due > MAX_LATE_HOURS * 3600e3) { it.status = 'expired'; it.expiredAt = now.toISOString(); }
  }
  return items.filter((it) => it.status === 'pending' && Date.parse(it.due) <= t)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))[0] || null;
}

export function addItem(items, { slug, run, artifact, due, now = new Date() }) {
  if (!/^[a-z0-9-]+$/.test(slug || '') || !/^\d+$/.test(String(run || '')) || !artifact || !Number.isFinite(Date.parse(due))) {
    throw new Error('add needs --slug, a numeric --run, --artifact and an ISO --due');
  }
  if (items.some((it) => it.slug === slug && it.status === 'pending')) return items;
  items.push({ slug, run: String(run), artifact, due, status: 'pending', added: now.toISOString(), attempts: 0 });
  return items;
}

/** Records a meta-post.mjs result for the item; returns the reels/log.md line when the Reel went out. */
export function recordResult(items, slug, result, now = new Date()) {
  const it = items.find((x) => x.slug === slug && x.status === 'pending');
  if (!it) return null;
  it.attempts = (it.attempts || 0) + 1;
  const ig = result?.instagram;
  if (result?.status === 'ok' && ig?.url) {
    Object.assign(it, { status: 'posted', posted: now.toISOString(), url: ig.url });
    return `- ${now.toISOString().slice(0, 10)} | ${slug} | ig-en: ${ig.url}`;
  }
  it.error = String(ig?.error || result?.error || result?.status || 'no result').slice(0, 200);
  if (it.attempts >= MAX_ATTEMPTS || result?.authFailed) it.status = 'error';
  return null;
}

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  return a;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const file = a.file || 'reels/queue.jsonl';
  const items = readQueue(file);
  if (cmd === 'add') {
    writeQueue(file, addItem(items, a));
    console.log(JSON.stringify({ status: 'queued', slug: a.slug, due: a.due }));
  } else if (cmd === 'due') {
    const before = JSON.stringify(items);
    const it = dueItem(items, a.now ? new Date(a.now) : new Date());
    if (JSON.stringify(items) !== before) writeQueue(file, items);
    console.log(JSON.stringify(it || {}));
  } else if (cmd === 'done') {
    let result = {};
    try { result = JSON.parse(fs.readFileSync(a.result, 'utf8').trim().split(/\r?\n/).pop()); } catch (e) { result = { status: 'error', error: `no result: ${e.message}` }; }
    const line = recordResult(items, a.slug, result);
    writeQueue(file, items);
    if (line && a.log) {
      if (!fs.existsSync(a.log)) fs.writeFileSync(a.log, '# English Instagram Reels posted later (reels-later.yml)\n\n');
      fs.appendFileSync(a.log, `${line}\n`);
    }
    console.log(JSON.stringify({ status: line ? 'posted' : 'not-posted', line, item: items.find((x) => x.slug === a.slug) || null }));
  } else {
    console.error('Usage: node reels/queue.mjs add|due|done ... (see the top of this file)');
    process.exitCode = 2;
  }
}
