#!/usr/bin/env node
// AI Tasks agent helper (.github/workflows/ai-task.yml). The owner writes tasks in the CRM (AI Tasks screen); this
// script talks to the CRM with INGEST_TOKEN and prepares/collects the work of the Claude step.
//   claim    --dir <tmp>   claim the next queued task (POST /api/ingest/ai-tasks/claim); writes <tmp>/task.json and
//                          the house rules; step outputs: id, target, repo, ref, publish, dry_run, with_report, tools, gate
//   prepare  --dir <tmp>   (in the target checkout) writes .ai-task/TASK.md + OWNER-RULES.md, git-excludes .ai-task/
//   collect  --dir <tmp>   reads .ai-task/result.json + git status; outputs: status, pending, commit_message
//   dispatch --dir <tmp>   starts the allowed workflows the agent asked for (publishing allowed only)
//   report   --dir <tmp>   posts the final result to the CRM and emails the owner a short Hinglish summary
//
// THIS REPO IS PUBLIC and so are its Actions logs: this script prints task ids, targets, statuses and counts only.
// The prompt, the thread, the summary and the links go to files under the runner's temp dir and to the CRM, never to
// stdout. The .ai-task/ folder is git-excluded so it is never committed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TARGETS, allowedTools, buildTaskFile, emailText, finalOutcome, istDate, normalizeResult } from './lib.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const env = process.env;
const DIR = arg('dir', env.AI_TASK_DIR || '');
if (!DIR) throw new Error('--dir is required');
const CRM = (env.CRM_URL || 'https://epifive-crm.pages.dev').replace(/\/$/, '');
const CRM_PUBLIC = (env.CRM_PUBLIC_URL || CRM).replace(/\/$/, '');
const RUN_ID = env.GITHUB_RUN_ID || '';
const RUN_URL = RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${RUN_ID}` : '';
const DRY_ALL = env.DRY_RUN_ALL === 'true';
const file = (n) => path.join(DIR, n);
const readJson = (n, d = null) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const writeJson = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 1));
function output(k, v) {
  const line = `${k}=${String(v).replace(/[\r\n]+/g, ' ')}\n`;
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, line);
  else fs.appendFileSync(file('outputs.txt'), line);
}

async function crm(method, p, body) {
  if (!env.INGEST_TOKEN) throw new Error('INGEST_TOKEN is not set');
  const res = await fetch(`${CRM}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': env.INGEST_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CRM ${p.replace(/\d+/g, ':id')} HTTP ${res.status}`);
  return j;
}

async function houseRules(target) {
  // The rules live in the private site repo (automation/OWNER-RULES.md). The site target has them in its checkout too.
  if (!env.SITE_REPO_TOKEN) return null;
  const res = await fetch('https://api.github.com/repos/sk9836413/EPIVIFE/contents/automation/OWNER-RULES.md', {
    headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${env.SITE_REPO_TOKEN}`, 'User-Agent': 'epifive-ai-task' },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) { console.log(`house rules: not fetched (HTTP ${res?.status ?? 'error'})${target === 'site' ? ', the checkout copy is used' : ''}`); return null; }
  return res.text();
}

async function claim() {
  fs.mkdirSync(DIR, { recursive: true });
  let r;
  try {
    r = await crm('POST', '/api/ingest/ai-tasks/claim', { run_id: RUN_ID, run_url: RUN_URL });
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
    console.log('::notice::The CRM has no AI Tasks yet (HTTP 404: migration/deploy pending). Nothing to do.');
    r = { task: null };
  }
  if (!r.task) {
    console.log('No queued task.');
    output('id', '');
    return;
  }
  const t = r.task;
  const target = TARGETS[t.target] ? t.target : 'research';
  writeJson('task.json', { task: t, messages: r.messages || [], queued_left: r.queued_left ?? 0 });
  const rules = await houseRules(target);
  if (rules) fs.writeFileSync(file('OWNER-RULES.md'), rules);
  const publish = !!t.publish_allowed && !t.dry_run && !DRY_ALL && target !== 'research';
  console.log(`Claimed AI task #${t.id} (target ${target}, attempt ${t.attempts}, ${publish ? 'publish allowed' : t.dry_run || DRY_ALL ? 'dry run' : 'approval pending'}).`);
  output('id', t.id);
  output('target', target);
  output('repo', TARGETS[target].repo);
  output('ref', t.branch && /^ai-task\/\d+$/.test(t.branch) ? t.branch : '');
  output('publish', publish);
  output('dry_run', !!t.dry_run || DRY_ALL);
  output('with_report', !!t.with_report);
  output('tools', allowedTools(target));
  output('gate', TARGETS[target].gate);
}

function prepare() {
  const { task, messages } = readJson('task.json');
  fs.mkdirSync('.ai-task', { recursive: true });
  const inRepo = fs.existsSync('automation/OWNER-RULES.md') && task.target === 'site';
  if (fs.existsSync(file('OWNER-RULES.md'))) fs.copyFileSync(file('OWNER-RULES.md'), '.ai-task/OWNER-RULES.md');
  const rulesPath = fs.existsSync('.ai-task/OWNER-RULES.md') ? '.ai-task/OWNER-RULES.md' : inRepo ? 'automation/OWNER-RULES.md' : null;
  if (!rulesPath) throw new Error('House rules (OWNER-RULES.md) not available: the agent does not run without them.');
  const reportFile = task.with_report && fs.existsSync('.ai-task/performance.txt') ? '.ai-task/performance.txt' : null;
  fs.writeFileSync('.ai-task/TASK.md', buildTaskFile(task, messages, { target: task.target, today: istDate(), rulesPath, reportFile, dryRunAll: DRY_ALL }));
  if (fs.existsSync('.git')) {
    fs.mkdirSync('.git/info', { recursive: true });
    fs.appendFileSync('.git/info/exclude', '\n.ai-task/\n');
  }
  console.log(`Prepared .ai-task/ (rules ${rulesPath === '.ai-task/OWNER-RULES.md' ? 'fetched' : 'from checkout'}${reportFile ? ', performance data attached' : ''}).`);
}

function git(...a) {
  // trimEnd only: porcelain lines start with a status column that may be a space.
  return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
}

function collect() {
  const { task } = readJson('task.json');
  let raw = null;
  try { raw = fs.readFileSync('.ai-task/result.json', 'utf8'); } catch { /* missing */ }
  const result = normalizeResult(raw);
  writeJson('result.json', result);
  let changes = [];
  try {
    changes = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).flatMap((l) => l.slice(3).split(' -> ').map((f) => f.replace(/^"|"$/g, ''))).filter((f) => !f.startsWith('.ai-task/'));
  } catch { /* not a repo */ }
  writeJson('changes.json', changes);
  fs.writeFileSync(file('changes.txt'), changes.length ? `${changes.join('\n')}\n` : '');
  // ON_BRANCH: the workflow checked out the task's own branch ai-task/<id> (earlier, not yet published work).
  const onBranch = !!task.branch && env.ON_BRANCH === 'true';
  const pending = task.target !== 'research' && result.status !== 'failed' && (changes.length > 0 || onBranch);
  console.log(`Agent result: ${result.status}; ${changes.length} changed file(s)${onBranch ? ', continuing the task branch' : ''}.`);
  output('status', result.status);
  output('changes', changes.length);
  output('pending', pending);
  output('commit_message', result.commit_message || `AI task #${task.id}`);
}

function dispatch() {
  const result = readJson('result.json', { dispatch: [] });
  const done = [];
  for (const d of result.dispatch || []) {
    const fl = Object.entries(d.inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`]);
    try {
      execFileSync('gh', ['workflow', 'run', d.workflow, '--repo', 'sk9836413/epifive-automation', '--ref', 'main', ...fl], { stdio: ['ignore', 'ignore', 'ignore'] });
      done.push(d.workflow);
      console.log(`Started ${d.workflow}.`);
    } catch {
      console.log(`Could not start ${d.workflow}.`);
    }
  }
  fs.writeFileSync(file('dispatched.txt'), done.join(','));
}

async function report() {
  const state = readJson('task.json');
  if (!state) { console.log('Nothing claimed: nothing to report.'); return; }
  const { task } = state;
  const result = readJson('result.json') || normalizeResult(null);
  const changes = readJson('changes.json', []);
  let tail = '';
  try { tail = fs.readFileSync(file('gate-tail.txt'), 'utf8').slice(-1500); } catch { /* none */ }
  let dispatched = [];
  try { dispatched = fs.readFileSync(file('dispatched.txt'), 'utf8').split(',').filter(Boolean); } catch { /* none */ }
  const outcome = finalOutcome({
    task,
    result,
    agentOutcome: env.AGENT_OUTCOME || '',
    changes,
    gate: env.GATE_OUTCOME ? { outcome: env.GATE_OUTCOME, name: env.GATE_NAME || 'checks', tail } : null,
    push: { ref: env.PUSH_REF || null, sha: env.PUSH_SHA || null, error: env.PUSH_OUTCOME === 'failure' ? 'git push nahi hua (token permission ya conflict). Re-run karo; dobara fail ho to owner check kare.' : null, dispatched },
    dryRunAll: DRY_ALL,
  });
  if (env.PREPARE_OUTCOME === 'failure' || env.CHECKOUT_OUTCOME === 'failure') {
    outcome.status = 'failed';
    outcome.summary = `Setup fail hua (${env.CHECKOUT_OUTCOME === 'failure' ? `repo checkout: ${TARGETS[task.target].token} secret check karo` : 'house rules / task file'}). Agent nahi chala.\n\n${outcome.summary}`;
  }
  writeJson('outcome.json', outcome);
  const r = await crm('POST', `/api/ingest/ai-tasks/${task.id}/result`, { run_id: RUN_ID, status: outcome.status, summary: outcome.summary, links: outcome.links, branch: outcome.branch });
  console.log(`Reported AI task #${task.id}: ${r.ignored ? `ignored by the CRM (${r.reason})` : r.status}; ${r.queued_left ?? 0} task(s) still queued.`);
  output('queued_left', r.queued_left ?? 0);
  if (r.ignored) return;

  if (DRY_ALL || !env.RESEND_API_KEY) { console.log(`Email: skipped (${DRY_ALL ? 'dry run' : 'RESEND_API_KEY not set'}).`); return; }
  const mail = emailText({ task, outcome: { ...outcome, status: r.status === 'queued' ? 'done' : outcome.status }, crmUrl: CRM_PUBLIC });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `ai-task-${task.id}-${RUN_ID}-${task.attempts}` },
    body: JSON.stringify({
      from: env.REPORT_FROM || 'EpiFive Agent <hello@epifive.com>',
      to: (env.REPORT_TO || 'info@epifive.com').split(',').map((s) => s.trim()),
      ...(env.REPORT_BCC ? { bcc: env.REPORT_BCC.split(',').map((s) => s.trim()) } : {}),
      subject: mail.subject,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  console.log(`Email: HTTP ${res?.status ?? 'error'}`);
}

const COMMANDS = { claim, prepare, collect, dispatch, report };
if (!COMMANDS[cmd]) throw new Error(`Usage: task.mjs ${Object.keys(COMMANDS).join('|')} --dir <tmp>`);
await COMMANDS[cmd]();
