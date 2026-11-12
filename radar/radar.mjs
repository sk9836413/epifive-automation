#!/usr/bin/env node
// Launch radar: spots big product launches on official feeds and queues a same-day "fast-track" how-to.
// See README section "Launch radar" and the site's automation/RADAR.md (the writer's instructions).
//
//   node radar/radar.mjs scan --site <site checkout> [--dry-run] [--force-url <url>] [--out task.json]
//        fetch every source, score and de-duplicate new items, log the run, pick at most one task
//   node radar/radar.mjs record --task task.json --status published|failed|skipped [--slug s] [--title t]
//        append the write job's outcome to radar/results.jsonl (the next scan folds it into state.json)
//   node radar/radar.mjs site-apply --site . --task task.json --result published|failed [--file content/posts/x.md]
//        edit automation/backlog.md and automation/log.md in the site checkout for that outcome
//   node radar/radar.mjs check --file content/posts/x.md --kind new|update [--today YYYY-MM-DD]
//        fast-track structure check (sections, FAQ, sources); exit 1 with the problems
//
// State (all in this public repo, no secrets): radar/state.json (items seen and their decisions),
// radar/results.jsonl (write outcomes), radar/log/<YYYY-MM>.md (one block per run).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSource, normalizeUrl, scoreItem, trendBoost, searchPhrase, findCoverage, parseBacklog, hashText,
  istDate, todayCounts, mergeDuplicates, cleanTitle, parkInBacklog, markPublished, logLine, checkFastTrack, UPDATE_SIGNAL, tokens,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const RESULTS = path.join(HERE, 'results.jsonl');
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
const S = CONFIG.settings;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
const readResults = () => (fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ghOutput = (key, value) => process.env.GITHUB_OUTPUT && fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const slugify = (title) => tokens(title).filter((w) => /^[a-z0-9]+$/.test(w)).slice(0, 7).join('-') || 'launch';

async function get(url, { timeout = 30000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': S.userAgent }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------- site data ----------

function frontValue(front, key) {
  const m = front.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function loadSite(site) {
  const dir = (d) => path.join(site, d);
  const read = (d) => (fs.existsSync(dir(d)) ? fs.readdirSync(dir(d)).filter((f) => /\.mdx?$/.test(f)) : []);
  const posts = read('content/posts').map((f) => {
    const text = fs.readFileSync(path.join(dir('content/posts'), f), 'utf8').replace(/\r\n/g, '\n');
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    return { slug: f.replace(/\.mdx?$/, ''), title: frontValue(front, 'title'), date: frontValue(front, 'date'), body: text };
  });
  const news = read('content/news').map((f) => ({ slug: f.replace(/\.md$/, ''), body: fs.readFileSync(path.join(dir('content/news'), f), 'utf8') }));
  const backlogFile = path.join(site, 'automation', 'backlog.md');
  const backlog = fs.existsSync(backlogFile) ? parseBacklog(fs.readFileSync(backlogFile, 'utf8')) : [];
  return { posts, news, backlog };
}

// ---------- scan ----------

async function scan() {
  const now = opt('now') ? Date.parse(opt('now')) : Date.now();
  const dryRun = Boolean(opt('dry-run'));
  const forceUrl = typeof opt('force-url') === 'string' ? normalizeUrl(opt('force-url')) : null;
  const trigger = opt('trigger', 'manual');
  const today = istDate(now);
  const state = readJson(STATE, { version: 1, lastScan: null, seen: {} });
  const results = readResults();
  const lines = [];
  const note = (s) => {
    lines.push(s);
    console.log(s);
  };

  if (!forceUrl && !dryRun && state.lastScan && now - Date.parse(state.lastScan) < S.minScanGapMinutes * 60e3) {
    console.log(`Skip: last scan ${Math.round((now - Date.parse(state.lastScan)) / 60e3)} min ago (gap ${S.minScanGapMinutes} min).`);
    return;
  }

  // 1. Fold write outcomes into state; a task that never reported back within 3 hours is retried once.
  for (const r of results) {
    const s = state.seen[r.key];
    if (!s || r.dryRun || (s.resultAt && s.resultAt >= r.at)) continue;
    // "error" = the write job broke before a verdict (e.g. Claude usage limit): retry once, then give up.
    const status = r.status === 'published' ? (r.kind === 'update' ? 'updated' : 'published')
      : r.status === 'error' ? ((s.attempts ?? 1) >= 2 ? 'failed' : 'queued') : r.status;
    Object.assign(s, { status, slug: r.slug ?? s.slug, resultAt: r.at });
  }
  for (const s of Object.values(state.seen)) {
    if (s.status === 'writing' && now - Date.parse(s.taskAt) > 3 * 3600e3) s.status = (s.attempts ?? 1) >= 2 ? 'failed' : 'queued';
  }

  // 2. Fetch and parse every source.
  const site = loadSite(opt('site', '.'));
  const fetched = [];
  const errors = [];
  await Promise.all(CONFIG.sources.map(async (source) => {
    try {
      const items = parseSource(await get(source.url), source);
      if (!items.length) throw new Error('no items parsed');
      for (const item of items) fetched.push({ ...item, source });
      source._count = items.length;
    } catch (e) {
      errors.push(`${source.id}: ${e.message}`);
      source._count = 0;
    }
  }));

  // 3. Score new items; look for updates to launches we already covered.
  const scored = [];
  const updates = [];
  for (const item of mergeDuplicates(fetched)) {
    const key = normalizeUrl(item.link);
    const seen = state.seen[key];
    const hash = hashText(`${item.title} ${item.summary}`);
    if (seen) {
      // A launch we wrote about changed on the official source (title or an "updated" stamp).
      if (['published', 'updated'].includes(seen.status) && seen.slug && hash !== seen.hash &&
          ((item.updated && item.updated !== seen.updated) || item.title !== seen.title)) {
        updates.push({ key, item, slug: seen.slug, score: seen.score, why: 'official source changed' });
      }
      continue;
    }
    const s = scoreItem(item, item.source, { now, freshHours: S.freshHours });
    if (s.reject && key !== forceUrl) continue; // stale or rumour: never stored, re-checked for free next run
    const cov = findCoverage(item, site);
    if (cov.news) s.score -= 1, s.reasons.push(`-1 in /news ${cov.news.slug}`);
    if (cov.backlog) s.reasons.push(`backlog ${cov.backlog.slug}`);
    scored.push({ key, item, hash, ...s, cov });
  }

  // 4. Cheap search-demand signals for the best few (Google Trends RSS + autocomplete, as in trend-signals.mjs).
  const top = scored.filter((x) => x.score >= S.threshold - 2 && !x.cov.post).sort((a, b) => b.score - a.score).slice(0, S.trendLookups);
  if (top.length) {
    const trending = [];
    for (const geo of ['US', 'IN']) {
      try {
        const xml = await get(`https://trends.google.com/trending/rss?geo=${geo}`, { timeout: 15000 });
        trending.push(...[...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1].trim()));
      } catch (e) {
        errors.push(`trends ${geo}: ${e.message}`);
      }
    }
    for (const x of top) {
      let suggestions = [];
      const phrase = searchPhrase(x.item.title);
      try {
        const body = await get(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(phrase)}`, { timeout: 10000 });
        suggestions = (JSON.parse(body)[1] ?? []).filter((q) => q.toLowerCase() !== phrase);
      } catch (e) {
        errors.push(`suggest "${phrase}": ${e.message}`);
      }
      const t = trendBoost(x.item, { trending, suggestions });
      if (t.boost) x.score += t.boost, x.reasons.push(`+${t.boost} ${t.why.join(', ')}`);
    }
  }

  // 5. Decide per item.
  for (const x of scored) {
    let status = x.score >= S.threshold ? 'queued' : 'below';
    if (x.cov.post) {
      const canUpdate = UPDATE_SIGNAL.test(`${x.item.title} ${x.item.summary}`) && x.score >= S.threshold - 2;
      if (canUpdate) updates.push({ key: x.key, item: x.item, slug: x.cov.post.slug, score: x.score, why: `update to /blog/${x.cov.post.slug}` });
      status = canUpdate ? 'update-candidate' : 'duplicate';
      x.reasons.push(`covered by /blog/${x.cov.post.slug}`);
    }
    if (x.key === forceUrl) status = 'queued';
    x.status = status;
    state.seen[x.key] = {
      title: x.item.title, link: x.item.link, source: x.item.source.id, topic: x.item.source.topic, date: x.item.date, updated: x.item.updated,
      summary: x.item.summary.slice(0, 300), first: new Date(now).toISOString(), score: x.score, reasons: x.reasons, status, hash: x.hash,
      backlog: x.cov.backlog?.slug, news: x.cov.news?.slug, post: x.cov.post?.slug,
    };
  }

  // 6. Expire queued items that waited too long (daily cap) into the normal backlog.
  const parks = [];
  for (const [key, s] of Object.entries(state.seen)) {
    const age = (now - Date.parse(s.date ?? s.first)) / 3600e3;
    if (s.status === 'queued' && age > S.freshHours + 12) {
      s.status = 'expired';
      parks.push({ key, line: `- [ ] ${slugify(cleanTitle(s.title))} | How to use ${cleanTitle(s.title)} (official launch ${String(s.date).slice(0, 10)}) | ${s.topic} | set up or use the new feature, from ${s.link} (fast-track, daily cap)` });
    }
  }

  // 7. Pick at most one task: a new launch first (within the daily caps), else an update.
  const counts = todayCounts(results, state, today);
  const queued = Object.entries(state.seen).filter(([, s]) => s.status === 'queued').sort((a, b) => b[1].score - a[1].score);
  let task = null;
  if (forceUrl && !state.seen[forceUrl]) note('Forced URL was not found in any fresh source item; using the URL alone.');
  if (forceUrl) {
    const s = state.seen[forceUrl] ?? { title: opt('force-title', forceUrl), link: opt('force-url'), source: 'manual', topic: 'ai-automation', date: new Date(now).toISOString(), summary: '', score: 0, reasons: ['forced'] };
    state.seen[forceUrl] = s;
    task = { kind: 'new', key: forceUrl, forced: true };
  } else if (queued.length && counts.newPublished < S.maxNewPerDay && counts.attempts < S.maxAttemptsPerDay) {
    task = { kind: 'new', key: queued[0][0] };
  } else if (updates.length && counts.updates < S.maxUpdatesPerDay) {
    const u = updates.sort((a, b) => b.score - a.score)[0];
    if (!state.seen[u.key]) state.seen[u.key] = { title: u.item.title, link: u.item.link, source: u.item.source.id, topic: u.item.source.topic, date: u.item.date, first: new Date(now).toISOString(), score: u.score, reasons: [] };
    Object.assign(state.seen[u.key], { updated: u.item.updated, hash: hashText(`${u.item.title} ${u.item.summary}`), summary: u.item.summary.slice(0, 300) });
    task = { kind: 'update', key: u.key, slug: u.slug, why: u.why };
  }
  if (task) {
    const s = state.seen[task.key];
    const src = CONFIG.sources.find((x) => x.id === s.source);
    Object.assign(task, {
      today, title: s.title, link: s.link, published: s.date, summary: s.summary, score: s.score, reasons: s.reasons,
      source: { id: s.source, name: src?.name ?? 'manual', feed: src?.url ?? null }, topic: s.topic,
      backlog: s.backlog ?? null, news: s.news ?? null, slug: task.slug ?? null, dryRun,
    });
    if (!dryRun) Object.assign(s, { status: 'writing', kind: task.kind, taskAt: new Date(now).toISOString(), attempts: (s.attempts ?? 0) + 1 });
  }
  if (parks.length) task = { ...(task ?? { kind: 'none' }), parks };

  // 8. Log, save, hand over.
  const ist = new Date(now + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const block = [
    `## ${ist} IST (${trigger}${dryRun ? ', dry run' : ''})`,
    '',
    `Fetched ${fetched.length} items from ${CONFIG.sources.filter((s) => s._count).length}/${CONFIG.sources.length} sources; ${scored.length} new and fresh; today: ${counts.newPublished}/${S.maxNewPerDay} fast-track, ${counts.updates}/${S.maxUpdatesPerDay} updates.`,
    ...(errors.length ? [`Errors: ${errors.join('; ')}`] : []),
    '',
    '| Score | Source | Decision | Item |',
    '|---:|---|---|---|',
    ...scored.sort((a, b) => b.score - a.score).slice(0, 12).map((x) =>
      `| ${x.score} | ${x.item.source.id} | ${x.status} | [${x.item.title.replace(/\|/g, '/').slice(0, 90)}](${x.item.link}) — ${x.reasons.join('; ').replace(/\|/g, '/')} |`),
    ...updates.map((u) => `| ${u.score} | ${u.item.source.id} | update | [${u.item.title.slice(0, 90)}](${u.item.link}) — ${u.why} |`),
    '',
    `Task: ${task?.kind && task.kind !== 'none' ? `${task.kind} "${task.title}"${task.slug ? ` -> /blog/${task.slug}` : ''}` : 'none'}${parks.length ? `; parked ${parks.length} expired item(s) in backlog.md` : ''}`,
    '',
  ];
  console.log(block.join('\n'));
  if (!dryRun) {
    state.lastScan = new Date(now).toISOString();
    // Keep the state small: forget non-published items after 14 days.
    for (const [k, s] of Object.entries(state.seen)) {
      if (!['published', 'updated', 'writing'].includes(s.status) && now - Date.parse(s.first) > 14 * 86400e3) delete state.seen[k];
    }
    fs.writeFileSync(STATE, `${JSON.stringify(state, null, 1)}\n`);
    const logFile = path.join(HERE, 'log', `${ist.slice(0, 7)}.md`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, `# Launch radar runs, ${ist.slice(0, 7)}\n\nNewest last. Scores and decisions per run (top 12 new items).\n\n`);
    fs.appendFileSync(logFile, block.join('\n'));
  }
  const json = JSON.stringify(task ?? {});
  if (opt('out')) fs.writeFileSync(opt('out'), json);
  ghOutput('task', json);
  ghOutput('kind', task?.kind && task.kind !== 'none' ? task.kind : '');
  ghOutput('parks', parks.length ? 'true' : '');
}

// ---------- record / site-apply / check ----------

function record() {
  const task = readJson(opt('task'), {});
  if (!task.key) throw new Error('task has no key');
  const entry = {
    at: new Date().toISOString(), date: istDate(), key: task.key, kind: task.kind, status: opt('status'),
    slug: typeof opt('slug') === 'string' ? opt('slug') : task.slug ?? null, title: typeof opt('title') === 'string' ? opt('title') : task.title, dryRun: Boolean(task.dryRun),
  };
  fs.appendFileSync(RESULTS, `${JSON.stringify(entry)}\n`);
  console.log(`Recorded ${entry.kind} ${entry.status}: ${entry.slug ?? entry.title}`);
}

function siteApply() {
  const site = opt('site', '.');
  const task = readJson(opt('task'), {});
  const today = opt('date', istDate());
  const backlogFile = path.join(site, 'automation', 'backlog.md');
  const logFile = path.join(site, 'automation', 'log.md');
  let backlog = fs.readFileSync(backlogFile, 'utf8');
  let log = fs.readFileSync(logFile, 'utf8');
  for (const p of task.parks ?? []) backlog = parkInBacklog(backlog, p.line);
  const file = opt('file');
  const result = opt('result');
  if (result === 'published' && typeof file === 'string') {
    const text = fs.readFileSync(path.join(site, file), 'utf8').replace(/\r\n/g, '\n');
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const slug = path.basename(file).replace(/\.mdx?$/, '');
    const words = text.slice(front.length + 8).replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
    if (task.kind === 'new') backlog = markPublished(backlog, { slug, title: frontValue(front, 'title'), date: today });
    log = logLine(log, { date: today, slug, status: task.kind === 'update' ? 'fast-track update' : 'fast-track', words });
  } else if (result === 'failed' && task.kind === 'new') {
    const slug = typeof opt('slug') === 'string' ? opt('slug') : slugify(cleanTitle(task.title));
    backlog = parkInBacklog(backlog, `- [ ] ${slug} | How to use ${cleanTitle(task.title)} (official launch ${String(task.published).slice(0, 10)}) | ${task.topic} | set up or use the new feature, from ${task.link} (fast-track, failed gate)`);
  }
  fs.writeFileSync(backlogFile, backlog);
  fs.writeFileSync(logFile, log);
  console.log(`Applied ${result ?? 'parks'} to backlog.md and log.md`);
}

function check() {
  const file = opt('file');
  const errors = checkFastTrack(fs.readFileSync(file, 'utf8'), { kind: opt('kind', 'new'), today: typeof opt('today') === 'string' ? opt('today') : undefined });
  if (errors.length) {
    console.error(`Fast-track check failed for ${file}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Fast-track check passed (${file}).`);
}

const commands = { scan, record, 'site-apply': siteApply, check };
if (!commands[cmd]) {
  console.error(`Usage: node radar/radar.mjs <${Object.keys(commands).join('|')}> ...`);
  process.exit(2);
}
await commands[cmd]();
