#!/usr/bin/env node
// Launch radar: spots big product launches on official feeds and queues a same-day "fast-track" how-to.
// See README section "Launch radar" and the site's automation/RADAR.md (the writer's instructions).
//
//   node radar/radar.mjs scan --site <site checkout> [--dry-run] [--force-url <url> [--force-category incident|outage]] [--out task.json]
//        fetch every source, score and de-duplicate new items, log the run, pick at most one task
//   node radar/radar.mjs record --task task.json --status published|failed|skipped [--slug s] [--title t] [--auto-video YYYY-MM-DD]
//        append the write job's outcome to radar/results.jsonl (the next scan folds it into state.json);
//        --auto-video = the UTC day the trending Short + long video were started for it (the daily cap counts these)
//   node radar/radar.mjs video-plan --task task.json --status published --file content/posts/x.md [--site .] [--now ISO]
//        decide whether a published fast-track article gets the trending Short + long video now (lib.mjs autoVideoPlan);
//        prints one JSON line
//   node radar/radar.mjs site-apply --site . --task task.json --result published|failed [--file content/posts/x.md]
//        edit automation/backlog.md and automation/log.md in the site checkout for that outcome
//   node radar/radar.mjs check --file content/posts/x.md --kind new|update [--today YYYY-MM-DD] [--category launch|incident|outage]
//        fast-track structure check (sections, FAQ, sources; incident guides: their own sections, defanged IPs;
//        outage guides: their own sections, IST + ET timeline, a "status as of <time> IST" line)
//   node radar/radar.mjs alert --task task.json --status published --file content/posts/x.md [--site .] [--dry-run] [--now ISO]
//        email alert for a new outage / incident guide (radar/alert.mjs): gate (1 per incident, 2 a day, never an
//        update or a resolved outage), wait until the page is live, one Resend broadcast to "Alerts: outage" /
//        "Alerts: security", logged in radar/results.jsonl. --dry-run prints the decision and the email, sends nothing
//        and writes nothing. Env: RESEND_API_KEY, optional ALERT_POSTAL_ADDRESS.
//
// State (all in this public repo, no secrets): radar/state.json (items seen and their decisions),
// radar/results.jsonl (write outcomes and alert sends), radar/log/<YYYY-MM>.md (one block per run).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSource, normalizeUrl, scoreItem, trendBoost, searchPhrase, findCoverage, parseBacklog, hashText,
  istDate, todayCounts, mergeDuplicates, daysToDeadline, parkInBacklog, markPublished, logLine, checkFastTrack, updateSignal,
  markIncidentDuplicates, backlogLine, pickNewTask, autoVideoPlan, isRootCauseNews, statusClosed, pageDetail, sameTopic, sameIncident,
} from './lib.mjs';
import {
  BRIEF, classifyBrief, briefItem, mergeIntoDays, tier1Floor, storyKey, detectDevice, detectAiModel, findDeviceSlug, emptyDay,
  touchDay, updateIndex, linesPrompt, parseLinesAnswer, applyLines, templateLines, deviceFocus,
} from './brief.mjs';
import { ALERT, alertGate, buildAlertEmail, completeAddress, ensureAlertField, readArticle } from './alert.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const RESULTS = path.join(HERE, 'results.jsonl');
// Tier 2 day pages: radar/live/<IST date>.json + index.json, served by the site at /news/live/<date>.
const LIVE = path.join(HERE, 'live');
const SITE_URL = 'https://www.epifive.com';
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
    return { slug: f.replace(/\.mdx?$/, ''), title: frontValue(front, 'title'), date: frontValue(front, 'date'), topic: frontValue(front, 'topic'), body: text };
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
    if (r.type === 'alert' || !s || r.dryRun || (s.resultAt && s.resultAt >= r.at)) continue;
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
      const body = await get(source.url);
      const items = parseSource(body, source);
      // Status pages (allowEmpty) list nothing while all is well; anything but an empty feed or JSON is an error.
      if (!items.length && !(source.allowEmpty && /<channel|<feed|^\s*[[{]/.test(body))) throw new Error('no items parsed');
      for (const item of items) fetched.push({ ...item, source });
      source._count = items.length;
      source._ok = true;
    } catch (e) {
      errors.push(`${source.id}: ${e.message}`);
      source._count = 0;
    }
  }));

  // 2b. Sources with "detail": true list only a title and a line; read the article page of each new, fresh item
  // (at most S.detailPerSource per source) so connectors, plans and setup steps in the body count for the score.
  for (const source of CONFIG.sources.filter((x) => x.detail && x._ok)) {
    const fresh = fetched.filter((x) => x.source === source && !state.seen[normalizeUrl(x.link)] &&
      (!x.date || now - Date.parse(x.date) <= S.freshHours * 3600e3)).slice(0, S.detailPerSource ?? 6);
    await Promise.all(fresh.map(async (x) => {
      try {
        x.detail = pageDetail(await get(x.link, { timeout: 20000 }));
      } catch (e) {
        errors.push(`${source.id} detail ${x.link}: ${e.message}`);
      }
    }));
  }

  // 3. Score new items; look for updates to launches we already covered.
  const scored = [];
  const updates = [];
  const merged = mergeDuplicates(fetched);
  for (const item of merged) {
    // Aggregators and trending lists (role "signal") feed only the hourly news page, never a fast-track article.
    if (item.source.role === 'signal') continue;
    const key = normalizeUrl(item.link);
    const seen = state.seen[key];
    const hash = hashText(`${item.title} ${item.summary}`);
    if (seen) {
      // A launch we wrote about changed on the official source (title or an "updated" stamp).
      if (['published', 'updated'].includes(seen.status) && seen.slug && hash !== seen.hash &&
          ((item.updated && item.updated !== seen.updated) || item.title !== seen.title)) {
        updates.push({ key, item, slug: seen.slug, score: seen.score, why: 'official source changed' });
      } else if (seen.category === 'outage' && hash !== seen.hash && (statusClosed(item) || isRootCauseNews(item))) {
        // An outage post we saw while it was open (e.g. the status page) now says it is over or states the root
        // cause: update the guide that covers it. A picked update stores the new hash, so each change counts once.
        const cov = findCoverage(item, site, { category: 'outage', now, families: seen.families });
        if (cov.post) updates.push({ key, item, slug: cov.post.slug, score: Math.max(seen.score ?? 0, S.threshold), why: `outage closed or root cause: update to /blog/${cov.post.slug}` });
      }
      continue;
    }
    const s = scoreItem(item, item.source, { now, freshHours: S.freshHours, threshold: S.threshold });
    if (s.reject && key !== forceUrl) continue; // stale or rumour: never stored, re-checked for free next run
    // Tier-1 floors (brief.mjs): flagship device or AI model, big AI price drop, AI model retirement due soon.
    const floor = tier1Floor(item, item.source, { score: s.score, threshold: S.threshold, daysToDeadline: daysToDeadline(`${item.title} ${item.summary}`, now) });
    if (floor) s.score += floor.points, s.reasons.push(`+${floor.points} ${floor.why}`);
    s.story = storyKey({ device: detectDevice(item, item.source), ai: detectAiModel(item, item.source) }) ?? undefined;
    const cov = findCoverage(item, site, { loose: s.category === 'incident', now, category: s.category, families: s.families });
    if (cov.news) s.score -= 1, s.reasons.push(`-1 in /news ${cov.news.slug}`);
    if (cov.backlog) s.reasons.push(`backlog ${cov.backlog.slug}`);
    scored.push({ key, item, hash, ...s, cov });
  }

  // One guide per incident (and per outage, by platform family): drop other outlets' reports of the same incident,
  // and incidents already queued, being written or published in the last 3 days.
  const recentIncidents = Object.values(state.seen).filter((s) => ['incident', 'outage'].includes(s.category) &&
    ['queued', 'writing', 'published', 'updated'].includes(s.status) && now - Date.parse(s.first) < 3 * 86400e3);
  markIncidentDuplicates(scored, recentIncidents);
  // One fast-track per device or AI model: the Gemini blog, the API changelog and The Keyword announcing the same
  // model are one story (story key from brief.mjs), and so is a model already queued or covered in the last 3 days.
  const recentStories = Object.entries(state.seen).filter(([, s]) => s.story && ['queued', 'writing', 'published', 'updated'].includes(s.status) &&
    now - Date.parse(s.first) < 3 * 86400e3);
  const keptStories = new Map();
  for (const x of scored.filter((y) => y.story && !y.dupOf).sort((a, b) => b.score - a.score)) {
    const hit = recentStories.find(([k, s]) => s.story === x.story && k !== x.key)?.[1] ?? keptStories.get(x.story);
    if (hit) x.dupOf = hit.title, x.reasons.push(`same story as "${hit.title.slice(0, 60)}"`);
    else keptStories.set(x.story, { title: x.item.title });
  }

  // 4. Cheap search-demand signals for the best few (Google Trends RSS + autocomplete, as in trend-signals.mjs).
  const top = scored.filter((x) => x.score >= S.threshold - 2 && !x.cov.post && !x.dupOf).sort((a, b) => b.score - a.score).slice(0, S.trendLookups);
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
    // A resolved outage or a retrospective never starts a new article; it can only update an outage guide.
    if (x.resolved && status === 'queued') status = 'resolved';
    if (x.dupOf && !(x.category === 'outage' && x.cov.post)) status = 'duplicate';
    else if (x.cov.post) {
      const canUpdate = updateSignal(`${x.item.title} ${x.item.summary}`, x.category) && x.score >= S.threshold - 2;
      if (canUpdate) updates.push({ key: x.key, item: x.item, slug: x.cov.post.slug, score: x.score, why: `update to /blog/${x.cov.post.slug}` });
      status = canUpdate ? 'update-candidate' : 'duplicate';
      x.reasons.push(`covered by /blog/${x.cov.post.slug}`);
    }
    if (x.key === forceUrl) status = 'queued';
    x.status = status;
    state.seen[x.key] = {
      title: x.item.title, link: x.item.link, source: x.item.source.id, topic: x.topic ?? x.item.source.topic, category: x.category ?? 'launch',
      date: x.item.date, updated: x.item.updated,
      summary: x.item.summary.slice(0, 300), first: new Date(now).toISOString(), score: x.score, reasons: x.reasons, status, hash: x.hash,
      ...(x.families ? { families: x.families } : {}),
      ...(x.story ? { story: x.story } : {}),
      backlog: x.cov.backlog?.slug, news: x.cov.news?.slug, post: x.cov.post?.slug,
    };
  }

  // 6. Expire queued items that waited too long (daily cap) into the normal backlog.
  const parks = [];
  for (const [key, s] of Object.entries(state.seen)) {
    if (key === forceUrl) continue; // a forced item is written now, never parked
    // An outage counts from when the radar first saw it (a long incident can start days before it is found), and an
    // outage that waited too long is old news, so it expires without a backlog item.
    const age = (now - Date.parse(s.category === 'outage' ? s.first : s.date ?? s.first)) / 3600e3;
    if (s.status === 'queued' && age > S.freshHours + 12) {
      s.status = 'expired';
      if (s.category !== 'outage') parks.push({ key, line: backlogLine({ ...s, reason: 'daily cap' }) });
    }
  }

  // 7. Pick at most one task: a new launch first (within the daily caps; a major outage may use one extra slot
  // a day once they are used up), else an update.
  const counts = todayCounts(results, state, today);
  const maxExtra = S.maxOutageExtraPerDay ?? 1;
  const queued = Object.entries(state.seen).filter(([, s]) => s.status === 'queued').sort((a, b) => b[1].score - a[1].score);
  const pick = pickNewTask(queued, counts, { maxNewPerDay: S.maxNewPerDay, maxAttemptsPerDay: S.maxAttemptsPerDay, maxOutageExtraPerDay: maxExtra });
  let task = null;
  if (forceUrl && !state.seen[forceUrl]) note('Forced URL was not found in any fresh source item; using the URL alone.');
  if (forceUrl) {
    const forced = ['incident', 'outage'].includes(opt('force-category')) ? opt('force-category') : null;
    const s = state.seen[forceUrl] ?? { title: opt('force-title', forceUrl), link: opt('force-url'), source: 'manual',
      topic: forced === 'incident' ? 'security-identity' : forced === 'outage' ? 'microsoft-365' : 'ai-automation',
      category: forced ?? 'launch', date: new Date(now).toISOString(), summary: '', score: 0, reasons: ['forced'] };
    if (forced) s.category = forced;
    state.seen[forceUrl] = s;
    task = { kind: 'new', key: forceUrl, forced: true };
  } else if (pick) {
    task = { kind: 'new', key: pick.key, ...(pick.extra ? { extra: true } : {}) };
    if (pick.extra) note('Major outage: using the extra outage slot (daily cap reached).');
  } else if (updates.length && counts.updates < S.maxUpdatesPerDay) {
    const u = updates.sort((a, b) => b.score - a.score)[0];
    if (!state.seen[u.key]) state.seen[u.key] = { title: u.item.title, link: u.item.link, source: u.item.source.id, topic: u.item.source.topic, category: u.item.source.category ?? 'launch', date: u.item.date, first: new Date(now).toISOString(), score: u.score, reasons: [] };
    Object.assign(state.seen[u.key], { updated: u.item.updated, hash: hashText(`${u.item.title} ${u.item.summary}`), summary: u.item.summary.slice(0, 300) });
    task = { kind: 'update', key: u.key, slug: u.slug, why: u.why };
  }
  if (task) {
    const s = state.seen[task.key];
    const src = CONFIG.sources.find((x) => x.id === s.source);
    Object.assign(task, {
      today, title: s.title, link: s.link, published: s.date, summary: s.summary, score: s.score, reasons: s.reasons,
      source: { id: s.source, name: src?.name ?? 'manual', feed: src?.url ?? null }, topic: s.topic, category: s.category ?? 'launch',
      backlog: s.backlog ?? null, news: s.news ?? null, slug: task.slug ?? null, dryRun,
      ...(s.families?.length ? { families: s.families } : {}),
    });
    if (!dryRun) Object.assign(s, { status: 'writing', kind: task.kind, extra: Boolean(task.extra), taskAt: new Date(now).toISOString(), attempts: (s.attempts ?? 0) + 1 });
  }
  if (parks.length) task = { ...(task ?? { kind: 'none' }), parks };

  // 7b. Tier 2 (the hourly "Tech news today" page) and Tier 3 (device launches for the device portal).
  const brief = await buildBrief({ merged, state, site, siteDir: opt('site', '.'), now, today, task, dryRun, errors });

  // 8. Log, save, hand over.
  const ist = new Date(now + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const block = [
    `## ${ist} IST (${trigger}${dryRun ? ', dry run' : ''})`,
    '',
    `Fetched ${fetched.length} items from ${CONFIG.sources.filter((s) => s._ok).length}/${CONFIG.sources.length} sources; ${scored.length} new and fresh; today: ${counts.newPublished}/${S.maxNewPerDay} fast-track, ${counts.outageExtra}/${maxExtra} outage extra, ${counts.updates}/${S.maxUpdatesPerDay} updates.`,
    ...(errors.length ? [`Errors: ${errors.join('; ')}`] : []),
    '',
    '| Score | Source | Decision | Item |',
    '|---:|---|---|---|',
    ...scored.sort((a, b) => b.score - a.score).slice(0, 12).map((x) =>
      `| ${x.score} | ${x.item.source.id} | ${x.status} | [${x.item.title.replace(/\|/g, '/').slice(0, 90)}](${x.item.link}) — ${x.reasons.join('; ').replace(/\|/g, '/')} |`),
    ...updates.map((u) => `| ${u.score} | ${u.item.source.id} | update | [${u.item.title.slice(0, 90)}](${u.item.link}) — ${u.why} |`),
    '',
    ...brief.log,
    '',
    `Task: ${task?.kind && task.kind !== 'none' ? `${task.kind}${task.extra ? ' (outage extra slot)' : ''} "${task.title}"${task.slug ? ` -> /blog/${task.slug}` : ''}` : 'none'}${parks.length ? `; parked ${parks.length} expired item(s) in backlog.md` : ''}`,
    '',
  ];
  console.log(block.join('\n'));
  if (!dryRun) {
    state.lastScan = new Date(now).toISOString();
    // Keep the state small: forget non-published items after 14 days, and low scorers (most of the ~90 sources' items,
    // e.g. AWS What's New) after 3 days: by then they are stale, so a feed that still lists them never re-queues them.
    for (const [k, s] of Object.entries(state.seen)) {
      const keepDays = s.status === 'below' && (s.score ?? 0) < S.threshold - 4 ? 3 : 14;
      if (!['published', 'updated', 'writing'].includes(s.status) && now - Date.parse(s.first) > keepDays * 86400e3) delete state.seen[k];
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
  ghOutput('brief_pending', brief.pending ? 'true' : '');
  ghOutput('brief_ping', brief.ping ?? '');
  ghOutput('devices_count', brief.devices ? String(brief.devices.count) : '');
  ghOutput('devices_focus', brief.devices?.focus ?? '');
}

// ---------- Tier 2 / Tier 3: the hourly news page and device launches ----------

const dayFile = (date) => path.join(LIVE, `${date}.json`);
const shiftDate = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const deviceSlugs = (siteDir) => {
  const dir = path.join(siteDir, 'content', 'devices');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
};

/**
 * Put every relevant, fresh item from every source on today's page (radar/live/<date>.json), once per story across
 * sources and the last BRIEF.lookbackDays days; link items that became a Tier-1 article; queue official device launches
 * for the device portal. New items get template lines now (official text only) and are listed in the pending file for
 * the one batched Claude call (`brief-apply` swaps in Claude's lines where they pass validation).
 */
async function buildBrief({ merged, state, site, siteDir, now, today, task, dryRun, errors }) {
  const days = {};
  for (let i = 0; i < BRIEF.lookbackDays; i++) {
    const d = shiftDate(today, -i);
    const page = readJson(dayFile(d), null) ?? (i === 0 ? emptyDay(d) : null);
    if (page) days[d] = page;
  }
  const listed = new Set(Object.values(days).flatMap((d) => d.items.map((it) => it.key)));
  const candidates = [];
  for (const item of merged) {
    const key = normalizeUrl(item.link);
    const t = Date.parse(item.date ?? '');
    // Undated items are skipped: an old post with no date must never look like today's news.
    if (listed.has(key) || Number.isNaN(t) || now - t > S.freshHours * 3600e3 || t - now > 24 * 3600e3) continue;
    const src = item.source;
    const scores = {};
    if (src.category === 'incident' || src.category === 'outage') {
      const sc = scoreItem(item, src, { now, freshHours: S.freshHours, threshold: S.threshold });
      if (sc.category === 'outage') Object.assign(scores, { outageScore: sc.reject ? null : sc.score, outageCategory: src.category !== 'outage' });
      else scores.incidentScore = sc.reject ? null : sc.score;
    }
    const cls = classifyBrief(item, src, scores);
    if (!cls.include) continue;
    const it = briefItem(item, src, cls, { now });
    if (src.label) it.source.label = src.label;
    const cov = findCoverage(item, site, { loose: cls.kind === 'security', now, category: cls.kind === 'outage' ? 'outage' : undefined });
    // A guide that only cites the item's link (e.g. an outage guide quoting an Insider build post) is not its guide:
    // link it only when it is about the same thing.
    const about = (p) => `${p.title} ${p.slug.replace(/-/g, ' ')}`;
    if (cov.post && (cls.kind === 'outage' || (cls.kind === 'security' ? sameIncident(item.title, about(cov.post)) : sameTopic(item.title, about(cov.post))))) it.post = cov.post.slug;
    candidates.push(it);
  }
  const page = days[today];
  const before = Object.fromEntries(Object.entries(days).map(([d, pg]) => [d, JSON.stringify(pg)]));
  const { added, upgraded, skipped } = mergeIntoDays(candidates, days, today, { now });

  // Official text for items whose feed carries no summary (sitemaps, card lists): the page's own description.
  const thin = added.filter((it) => !it.reported && (it.summary ?? '').length < 80).slice(0, 12);
  await Promise.all(thin.map(async (it) => {
    try {
      it.summary = pageDetail(await get(it.source.url, { timeout: 20000 })).slice(0, 700);
    } catch (e) {
      errors.push(`brief detail ${it.sourceId}: ${e.message}`);
    }
  }));

  // Tier-1 links: an item whose official link became a fast-track article (now or earlier) links to it.
  const slugs = deviceSlugs(siteDir);
  for (const d of Object.values(days)) {
    for (const it of d.items) {
      const seen = state.seen[it.key];
      if (seen?.slug && ['published', 'updated'].includes(seen.status) && it.post !== seen.slug) it.post = seen.slug, it.tier = 1;
      if (task?.kind === 'new' && task.key === it.key && it.tier !== 1) it.tier = 1;
      if (it.device && !it.devicePage) {
        const slug = findDeviceSlug(it.device, slugs);
        if (slug) it.devicePage = slug;
      }
    }
  }

  // New and upgraded items: template lines now, Claude's lines in brief-apply (at most BRIEF.maxNewPerRun a run).
  const fresh = [...added, ...upgraded.filter((it) => !it.lines?.length)];
  for (const it of fresh) {
    it.lines = templateLines(it);
    it.linesBy = 'template';
  }
  // Plus today's items still on template lines that Claude never answered (over the per-run cap, or the call failed).
  const retry = page.items.filter((it) => it.linesBy === 'template' && !it.linesNote && (it.linesTries ?? 0) < 3 && !fresh.includes(it));
  const pending = [...fresh, ...retry].slice(0, BRIEF.maxNewPerRun);

  // Tier 3: official device launches go to the device portal (devices.yml, launch mode), at most
  // S.maxDeviceRunsPerDay runs a day and 3 devices a run.
  state.devices ??= {};
  for (const it of added) {
    const src = merged.find((m) => normalizeUrl(m.link) === it.key);
    const d = src ? detectDevice(src, src.source) : null;
    if (!d?.official || state.devices[d.key]) continue;
    state.devices[d.key] = {
      model: d.model, brand: d.brand, category: d.category, link: it.source.url, date: it.time, first: new Date(now).toISOString(),
      status: 'queued', slug: findDeviceSlug(d, slugs),
    };
  }
  let devices = null;
  const runsToday = new Set(Object.values(state.devices).filter((d) => d.dispatchedAt && istDate(Date.parse(d.dispatchedAt)) === today).map((d) => d.dispatchedAt));
  const queuedDevices = Object.values(state.devices).filter((d) => d.status === 'queued' && now - Date.parse(d.first) < 7 * 86400e3);
  if (queuedDevices.length && runsToday.size < (S.maxDeviceRunsPerDay ?? 2)) {
    const batch = queuedDevices.slice(0, 3);
    devices = { count: batch.length, focus: deviceFocus(batch) };
    if (!dryRun) for (const d of batch) Object.assign(d, { status: 'dispatched', dispatchedAt: new Date(now).toISOString() });
  }
  for (const [k, d] of Object.entries(state.devices)) if (now - Date.parse(d.first) > 30 * 86400e3) delete state.devices[k];

  // dateModified moves only when a page really changed.
  const changedDays = Object.values(days).filter((d) => JSON.stringify(d) !== before[d.date]);
  for (const d of changedDays) touchDay(d, now);
  const changed = changedDays.includes(page);
  let ping = null;
  if (!dryRun) {
    fs.mkdirSync(LIVE, { recursive: true });
    let index = readJson(path.join(LIVE, 'index.json'), { days: [] });
    for (const d of changedDays) {
      fs.writeFileSync(dayFile(d.date), `${JSON.stringify(d, null, 1)}\n`);
      if (d.items.length) index = updateIndex(index, d);
    }
    // IndexNow at most once an hour, and only when today's page changed.
    if (changed && page.items.length && (!index.lastIndexNow || now - Date.parse(index.lastIndexNow) >= 55 * 60e3)) {
      ping = `${SITE_URL}/news/live/${today}`;
      index.lastIndexNow = new Date(now).toISOString();
    }
    fs.writeFileSync(path.join(LIVE, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
    const out = opt('brief-out');
    if (typeof out === 'string') {
      const dateOf = (it) => Object.values(days).find((d) => d.items.includes(it))?.date ?? today;
      fs.writeFileSync(out, JSON.stringify({ items: pending.map((it) => ({ id: it.id, date: dateOf(it) })) }));
      fs.writeFileSync(`${out}.prompt.txt`, linesPrompt(pending));
    }
  }
  const byKind = {};
  for (const it of added) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  const kinds = Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ');
  const log = [
    `Tech news today (${SITE_URL}/news/live/${today}): +${added.length} item(s)${kinds ? ` (${kinds})` : ''}, ${upgraded.length} upgraded, ` +
      `${page.items.length} on the page; ${skipped.length} skipped (already listed or capped)${pending.length ? `; ${pending.length} sent for Claude lines` : ''}.`,
    ...added.slice(0, 20).map((it) => `- [${it.kind}${it.reported ? ', reported' : ''}] ${it.headline.slice(0, 100)} (${it.sourceId}, score ${it.score})`),
    ...(devices ? [`Device portal: ${devices.focus.slice(0, 400)}`] : []),
  ];
  return { log, pending: pending.length > 0, ping, devices };
}

/**
 * Swap in Claude's lines for the items listed by `scan --brief-out` where they pass validateLines (every number from the
 * source, no speculation, no first person); the template lines from the official text stay otherwise.
 */
function briefApply() {
  const pending = readJson(opt('pending'), { items: [] });
  const answerFile = opt('answer');
  let answer = typeof answerFile === 'string' && fs.existsSync(answerFile) ? parseLinesAnswer(fs.readFileSync(answerFile, 'utf8')) : {};
  // claude -p --output-format json wraps the answer text in { result }.
  if (typeof answer.result === 'string') answer = parseLinesAnswer(answer.result);
  const byDate = {};
  for (const p of pending.items) (byDate[p.date] ??= []).push(p.id);
  let claude = 0;
  let template = 0;
  const noAnswer = !Object.keys(answer).length;
  for (const [date, ids] of Object.entries(byDate)) {
    const page = readJson(dayFile(date), null);
    if (!page) continue;
    const items = page.items.filter((it) => ids.includes(it.id));
    if (noAnswer) {
      // The Claude call failed (usage limit, timeout): keep the template lines and let the next scan retry (twice).
      for (const it of items) it.linesTries = (it.linesTries ?? 0) + 1;
      template += items.length;
      fs.writeFileSync(dayFile(date), `${JSON.stringify(page, null, 1)}\n`);
      continue;
    }
    const r = applyLines(items, answer);
    claude += r.claude;
    template += r.template;
    for (const it of items) if (it.linesBy === 'template') console.log(`  template: ${it.headline.slice(0, 80)} (${it.linesNote})`);
    fs.writeFileSync(dayFile(date), `${JSON.stringify(page, null, 1)}\n`);
  }
  console.log(`Brief lines: ${claude} by Claude (validated), ${template} from the official text (template).`);
}

/** IndexNow ping for the day page (the scan decides when: the page changed, at most once an hour). */
async function indexNow() {
  const url = opt('url');
  if (typeof url !== 'string' || !url.startsWith(`${SITE_URL}/`)) throw new Error('--url must be an epifive.com URL');
  const key = '5bbd01230376e7468f09aef0ef85403c'; // public: served at https://www.epifive.com/<key>.txt
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: 'www.epifive.com', key, keyLocation: `${SITE_URL}/${key}.txt`, urlList: [url] }),
  });
  console.log(`IndexNow: HTTP ${res.status} for ${url}`);
}

// ---------- record / site-apply / check ----------

function record() {
  const task = readJson(opt('task'), {});
  if (!task.key) throw new Error('task has no key');
  const entry = {
    at: new Date().toISOString(), date: istDate(), key: task.key, kind: task.kind, category: task.category ?? 'launch', status: opt('status'),
    ...(task.extra ? { extra: true } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(opt('auto-video') ?? '') ? { autoVideo: opt('auto-video') } : {}),
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
    // A new outage / incident guide gets "alert: outage|security" (the site's email alert box) if the writer left it out.
    if (task.kind === 'new') {
      const original = fs.readFileSync(path.join(site, file), 'utf8');
      const withAlert = ensureAlertField(original, task.category);
      if (withAlert !== original) fs.writeFileSync(path.join(site, file), withAlert);
    }
    const text = fs.readFileSync(path.join(site, file), 'utf8').replace(/\r\n/g, '\n');
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const slug = path.basename(file).replace(/\.mdx?$/, '');
    const words = text.slice(front.length + 8).replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
    if (task.kind === 'new') backlog = markPublished(backlog, { slug, title: frontValue(front, 'title'), date: today });
    log = logLine(log, { date: today, slug, status: task.kind === 'update' ? 'fast-track update' : 'fast-track', words });
  } else if (result === 'failed' && task.kind === 'new') {
    const slug = typeof opt('slug') === 'string' ? opt('slug') : undefined;
    backlog = parkInBacklog(backlog, backlogLine({ title: task.title, date: task.published, topic: task.topic, link: task.link, category: task.category, reason: 'failed gate', slug }));
  }
  fs.writeFileSync(backlogFile, backlog);
  fs.writeFileSync(logFile, log);
  console.log(`Applied ${result ?? 'parks'} to backlog.md and log.md`);
}

function check() {
  const file = opt('file');
  const errors = checkFastTrack(fs.readFileSync(file, 'utf8'), {
    kind: opt('kind', 'new'), today: typeof opt('today') === 'string' ? opt('today') : undefined,
    category: ['incident', 'outage'].includes(opt('category')) ? opt('category') : 'launch',
  });
  if (errors.length) {
    console.error(`Fast-track check failed for ${file}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Fast-track check passed (${file}).`);
}

// Trending Short + long video for a just-published fast-track article (run in the site checkout of the write job).
function videoPlan() {
  const site = opt('site', '.');
  const file = opt('file');
  const text = typeof file === 'string' && fs.existsSync(path.join(site, file)) ? fs.readFileSync(path.join(site, file), 'utf8').replace(/\r\n/g, '\n') : '';
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const logFile = path.join(site, 'automation', 'longvideo-log.md');
  const plan = autoVideoPlan({
    task: readJson(opt('task'), {}), status: opt('status'),
    slug: typeof file === 'string' && text ? path.basename(file).replace(/\.mdx?$/, '') : null,
    topic: frontValue(front, 'topic'), title: frontValue(front, 'title'), results: readResults(),
    longVideoLog: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
    now: opt('now') ? Date.parse(opt('now')) : Date.now(),
  });
  console.log(JSON.stringify(plan));
}

// Email alert for a just-published outage / incident guide (radar/alert.mjs). Never throws on a send problem: the
// outcome is logged and the job carries on. Logs are public: statuses only, never addresses, keys or API bodies.
async function alert() {
  const site = opt('site', '.');
  const file = opt('file');
  const dryRun = Boolean(opt('dry-run'));
  const now = opt('now') ? Date.parse(opt('now')) : Date.now();
  const task = readJson(opt('task'), {});
  const text = typeof file === 'string' && fs.existsSync(path.join(site, file)) ? fs.readFileSync(path.join(site, file), 'utf8') : '';
  const slug = text ? path.basename(file).replace(/\.mdx?$/, '') : null;
  const article = text ? readArticle(text) : null;
  const status = opt('status');
  const gate = alertGate({ task, status, slug, article, results: readResults(), now });
  const log = (fields) => {
    if (dryRun) return;
    const entry = {
      at: new Date(now).toISOString(), date: istDate(now), type: 'alert', kind: 'alert', alert: gate.kind, category: task.category,
      key: task.key, slug, ...(task.families?.length ? { families: task.families } : {}), ...fields,
    };
    fs.appendFileSync(RESULTS, `${JSON.stringify(entry)}\n`);
  };
  if (!gate.kind) {
    console.log(`Alert: none (${gate.reason}).`);
    return;
  }
  const address = (process.env.ALERT_POSTAL_ADDRESS || '').trim() || ALERT.defaultAddress;
  const mail = article?.title ? buildAlertEmail({ kind: gate.kind, slug, article, address }) : null;
  if (dryRun) {
    console.log(`[dry run] gate: ${gate.send ? 'SEND' : 'skip'} (${gate.reason})`);
    if (mail) {
      console.log(`[dry run] to Resend segment "${mail.segment}", from ${ALERT.from}, reply-to ${ALERT.replyTo}`);
      console.log(`[dry run] subject: ${mail.subject}\n[dry run] preview: ${mail.previewText}\n----- text -----\n${mail.text}\n----------------`);
      if (opt('html')) console.log(mail.html);
    }
    console.log('[dry run] nothing sent, nothing logged.');
    return;
  }
  if (!gate.send) {
    console.log(`Alert: skipped (${gate.reason}).`);
    log({ status: 'skipped', reason: gate.reason });
    return;
  }
  if (!completeAddress(address)) console.log('::warning::ALERT_POSTAL_ADDRESS is not a complete postal address; the alert footer uses the city line only.');
  if (!process.env.RESEND_API_KEY) {
    console.log('Alert: RESEND_API_KEY not set; not sent.');
    log({ status: 'failed', reason: 'RESEND_API_KEY not set' });
    return;
  }

  // The link must work when the email lands: wait (up to ~10 min) for the page to be live.
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    try {
      live = (await fetch(`${ALERT.site}/blog/${slug}`, { signal: AbortSignal.timeout(15000) })).status === 200;
    } catch {
      live = false;
    }
    if (!live) await new Promise((r) => setTimeout(r, 20000));
  }
  if (!live) {
    console.log('Alert: the page is not live yet; not sent.');
    log({ status: 'skipped', reason: 'page not live after 10 minutes' });
    return;
  }

  const headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  let segment = null;
  try {
    let after = '';
    for (let page = 0; page < 20 && !segment; page++) {
      const res = await fetch(`https://api.resend.com/segments?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`, { headers });
      console.log(`Resend segments: HTTP ${res.status}`);
      if (!res.ok) break;
      const list = await res.json();
      segment = list.data?.find((s) => s.name === mail.segment)?.id ?? null;
      if (!list.has_more || !list.data?.length) break;
      after = list.data[list.data.length - 1].id;
    }
  } catch (e) {
    console.log(`Resend segments: ${e.name}`);
  }
  if (!segment) {
    console.log(`Alert: no "${mail.segment}" segment (no signups yet, or the lookup failed); not sent.`);
    log({ status: 'skipped', reason: 'segment missing (no signups yet) or lookup failed' });
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `${gate.kind === 'outage' ? 'Outage' : 'Security'} alert ${slug}`.slice(0, 120),
        segment_id: segment,
        from: ALERT.from,
        reply_to: ALERT.replyTo,
        subject: mail.subject,
        preview_text: mail.previewText,
        html: mail.html,
        text: mail.text,
        send: true,
      }),
    });
    console.log(`Resend broadcast: HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) log({ status: 'sent', broadcast: body.id ?? null, subject: mail.subject });
    else log({ status: 'failed', reason: `HTTP ${res.status}` });
  } catch (e) {
    console.log(`Resend broadcast: ${e.name}`);
    // A timeout may still have sent it: count it as sent so a retry can never send a second alert.
    log({ status: 'sent', broadcast: null, subject: mail.subject, reason: `uncertain (${e.name})` });
  }
}

const commands = { scan, record, 'site-apply': siteApply, check, 'video-plan': videoPlan, alert, 'brief-apply': briefApply, indexnow: indexNow };
if (!commands[cmd]) {
  console.error(`Usage: node radar/radar.mjs <${Object.keys(commands).join('|')}> ...`);
  process.exit(2);
}
await commands[cmd]();
