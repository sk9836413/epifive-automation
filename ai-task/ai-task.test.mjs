// AI Tasks helper: pure functions (task file, result parsing, final outcome, dispatch allow-list, email) and the
// claim -> prepare -> collect -> report commands against a fake CRM (local HTTP server). Also checks that nothing
// private (prompt, summary, links) reaches stdout, because this repo's Actions logs are public.
// Run: node --test ai-task/ai-task.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { allowedTools, buildTaskFile, emailText, filterDispatches, finalOutcome, normalizeResult } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK = { id: 7, title: 'Refresh chroma article', prompt: 'SECRET-PROMPT-TEXT refresh the chroma article', target: 'site', priority: 'normal', needs_approval: true, approved: false, dry_run: false, with_report: false, publish_allowed: false, branch: null, attempts: 1, previous_summary: null };

describe('lib', () => {
  test('task file: rules first, publishing state, thread, finish contract', () => {
    const md = buildTaskFile(TASK, [{ author: 'owner', body: 'FAQ bhi', at: '2026-11-21T10:00:00Z' }], { target: 'site', today: '2026-11-21', rulesPath: '.ai-task/OWNER-RULES.md' });
    assert.match(md, /Read `\.ai-task\/OWNER-RULES\.md` completely/);
    assert.match(md, /Publishing is NOT allowed yet/);
    assert.match(md, /branch `ai-task\/7`/);
    assert.match(md, /\*\*Owner\*\* \(2026-11-21T10:00:00Z\): FAQ bhi/);
    assert.match(md, /\.ai-task\/result\.json/);
    assert.match(buildTaskFile({ ...TASK, publish_allowed: true }, [], { target: 'site', today: 'x', rulesPath: 'r' }), /Publishing is ALLOWED/);
    assert.match(buildTaskFile({ ...TASK, publish_allowed: true }, [], { target: 'site', today: 'x', rulesPath: 'r', dryRunAll: true }), /DRY RUN/);
    assert.match(buildTaskFile({ ...TASK, with_report: true }, [], { target: 'site', today: 'x', rulesPath: 'r', reportFile: '.ai-task/performance.txt' }), /performance\.txt/);
  });

  test('tools: never git push, curl or generic node', () => {
    for (const t of ['site', 'automation', 'shyam', 'crm', 'research']) {
      const tools = allowedTools(t);
      assert.ok(!/git push|curl|Bash\(node:\*\)|Bash\(npm:\*\)|Bash\(gh/.test(tools), t);
      assert.match(tools, /^Read,Write,Edit/);
    }
    assert.match(allowedTools('site'), /check-posts/);
    assert.match(allowedTools('crm'), /npm run typecheck/);
  });

  test('result parsing: missing/garbage -> failed; links and commit message cleaned', () => {
    assert.equal(normalizeResult(null).status, 'failed');
    assert.equal(normalizeResult('{bad').parsed, false);
    const r = normalizeResult(JSON.stringify({
      status: 'done', summary: 'Ho gaya', commit_message: 'Refresh chroma post\nwith `rm -rf` $(x)',
      links: [{ label: 'ok', url: 'https://www.epifive.com/blog/x' }, { label: 'js', url: 'javascript:alert(1)' }],
      dispatch: [{ workflow: 'social.yml', inputs: { slug: 'x', evil: 'y' } }, { workflow: 'deploy.yml' }],
    }));
    assert.equal(r.status, 'done');
    assert.equal(r.links.length, 1);
    assert.ok(!/[`$\n]/.test(r.commit_message));
    assert.deepEqual(r.dispatch, [{ workflow: 'social.yml', inputs: { slug: 'x' } }]);
    assert.equal(normalizeResult('{"status":"weird","summary":"x"}').status, 'failed');
  });

  test('dispatch allow-list drops odd input values', () => {
    assert.deepEqual(filterDispatches([{ workflow: 'social.yml', inputs: { slug: 'a; rm -rf /', brief: 'Hook: AI agent?' } }]), [{ workflow: 'social.yml', inputs: { slug: 'a; rm -rf /', brief: 'Hook: AI agent?' } }]);
    assert.deepEqual(filterDispatches([{ workflow: 'social.yml', inputs: { slug: 'x`id`' } }]), [{ workflow: 'social.yml', inputs: {} }]);
    assert.equal(filterDispatches(new Array(5).fill({ workflow: 'control.yml' })).length, 3);
  });

  test('final outcome: branch push needs approval; main push links the commit; gate failure fails', () => {
    const res = normalizeResult('{"status":"done","summary":"Article refreshed"}');
    const br = finalOutcome({ task: TASK, result: res, agentOutcome: 'success', changes: ['content/posts/x.md'], gate: { outcome: 'success' }, push: { ref: 'ai-task/7', sha: 'abc' } });
    assert.equal(br.status, 'needs-input');
    assert.equal(br.branch, 'ai-task/7');
    assert.match(br.links[0].url, /compare\/main\.\.\.ai-task\/7$/);
    const main = finalOutcome({ task: { ...TASK, publish_allowed: true }, result: res, agentOutcome: 'success', changes: ['a'], gate: { outcome: 'success' }, push: { ref: 'main', sha: 'abc' } });
    assert.equal(main.status, 'done');
    assert.equal(main.links[0].url, 'https://github.com/sk9836413/EPIVIFE/commit/abc');
    const gate = finalOutcome({ task: TASK, result: res, agentOutcome: 'success', changes: ['a'], gate: { outcome: 'failure', name: 'site', tail: 'check-posts: 2 errors' }, push: {} });
    assert.equal(gate.status, 'failed');
    assert.match(gate.summary, /Quality gate FAIL \(site\)[\s\S]*2 errors/);
    const dry = finalOutcome({ task: { ...TASK, dry_run: true }, result: res, agentOutcome: 'failure', changes: ['a'], gate: { outcome: 'success' }, push: {} });
    assert.equal(dry.status, 'done');
    assert.match(dry.summary, /Dry run: kuch push nahi kiya/);
    assert.match(dry.summary, /Agent step ended: failure/);
    const pushErr = finalOutcome({ task: TASK, result: res, changes: ['a'], push: { error: 'git push nahi hua' } });
    assert.equal(pushErr.status, 'failed');
  });

  test('email: Hinglish subject per status and the CRM link', () => {
    const m = emailText({ task: TASK, outcome: { status: 'needs-input', summary: 'Approve karo', links: [{ label: 'Branch', url: 'https://github.com/x' }] }, crmUrl: 'https://crm.test' });
    assert.match(m.subject, /^AI task #7 aapka jawab \/ approval chahiye/);
    assert.match(m.text, /https:\/\/crm\.test\/#\/ai\/7/);
    assert.match(m.text, /Branch: https:\/\/github\.com\/x/);
  });
});

describe('commands against a fake CRM', () => {
  let server;
  let base;
  const got = [];
  let claimAnswer;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        got.push({ url: req.url, token: req.headers['x-ingest-token'], body: body ? JSON.parse(body) : null });
        if (req.headers['x-ingest-token'] !== 'test-token') { res.writeHead(401); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/api/ingest/ai-tasks/claim') return res.end(JSON.stringify(claimAnswer));
        if (/^\/api\/ingest\/ai-tasks\/\d+\/result$/.test(req.url)) return res.end(JSON.stringify({ ok: true, status: JSON.parse(body).status, queued_left: 1 }));
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.closeAllConnections?.() ?? server.close());

  // Async: the fake CRM lives in this process, so the child must not block our event loop.
  const run = async (args, cwd, extra = {}) => (await promisify(execFile)(process.execPath, [path.join(HERE, 'task.mjs'), ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, CRM_URL: base, INGEST_TOKEN: 'test-token', GITHUB_RUN_ID: '555', GITHUB_REPOSITORY: 'sk9836413/epifive-automation', ...extra },
  })).stdout;

  test('no queued task: id output empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-'));
    claimAnswer = { ok: true, task: null, queued_left: 0 };
    const out = await run(['claim', '--dir', dir], dir);
    assert.match(out, /No queued task/);
    assert.match(fs.readFileSync(path.join(dir, 'outputs.txt'), 'utf8'), /^id=$/m);
  });

  test('claim -> prepare -> collect -> report, with nothing private on stdout', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-'));
    const dir = path.join(tmp, 'state');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.md'), 'old\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    claimAnswer = { ok: true, task: { ...TASK, dry_run: true }, messages: [{ author: 'owner', body: 'PRIVATE-FOLLOWUP', at: '2026-11-21T00:00:00Z' }], queued_left: 0 };

    let out = await run(['claim', '--dir', dir], repo);
    const outputs = fs.readFileSync(path.join(dir, 'outputs.txt'), 'utf8');
    assert.match(outputs, /^id=7$/m);
    assert.match(outputs, /^repo=sk9836413\/EPIVIFE$/m);
    assert.match(outputs, /^dry_run=true$/m);
    assert.match(outputs, /^publish=false$/m);
    assert.deepEqual(got.at(-1).body, { run_id: '555', run_url: 'https://github.com/sk9836413/epifive-automation/actions/runs/555' });

    // No SITE_REPO_TOKEN in the test: the rules come from the checkout (site target).
    fs.mkdirSync(path.join(repo, 'automation'));
    fs.writeFileSync(path.join(repo, 'automation', 'OWNER-RULES.md'), '# rules\n');
    out += await run(['prepare', '--dir', dir], repo);
    const md = fs.readFileSync(path.join(repo, '.ai-task', 'TASK.md'), 'utf8');
    assert.match(md, /SECRET-PROMPT-TEXT/);
    assert.match(md, /PRIVATE-FOLLOWUP/);
    assert.match(md, /automation\/OWNER-RULES\.md/);
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /\.ai-task\//);

    // The "agent": edits a file and writes its result.
    fs.writeFileSync(path.join(repo, 'a.md'), 'new\n');
    fs.writeFileSync(path.join(repo, '.ai-task', 'result.json'), JSON.stringify({ status: 'done', summary: 'PRIVATE-SUMMARY all good', commit_message: 'Update a', links: [{ label: 'x', url: 'https://www.epifive.com/blog/a' }] }));
    out += await run(['collect', '--dir', dir], repo);
    const outputs2 = fs.readFileSync(path.join(dir, 'outputs.txt'), 'utf8');
    assert.match(outputs2, /^changes=2$/m, 'a.md + the untracked rules file of this fake repo; never .ai-task/');
    assert.match(outputs2, /^pending=true$/m);
    assert.match(fs.readFileSync(path.join(dir, 'changes.txt'), 'utf8'), /^a\.md$/m);
    assert.ok(!fs.readFileSync(path.join(dir, 'changes.txt'), 'utf8').includes('.ai-task'));

    out += await run(['report', '--dir', dir], repo, { DRY_RUN_ALL: 'false' });
    const posted = got.at(-1);
    assert.equal(posted.url, '/api/ingest/ai-tasks/7/result');
    assert.equal(posted.body.status, 'done');
    assert.equal(posted.body.run_id, '555');
    assert.match(posted.body.summary, /PRIVATE-SUMMARY[\s\S]*Dry run: kuch push nahi kiya/);
    assert.deepEqual(posted.body.links, [{ label: 'x', url: 'https://www.epifive.com/blog/a' }]);
    assert.match(fs.readFileSync(path.join(dir, 'outputs.txt'), 'utf8'), /^queued_left=1$/m);
    assert.match(out, /Email: skipped/);
    for (const secret of ['SECRET-PROMPT-TEXT', 'PRIVATE-FOLLOWUP', 'PRIVATE-SUMMARY', 'Refresh chroma', 'epifive.com/blog/a', 'test-token']) assert.ok(!out.includes(secret), `stdout leaks ${secret}`);
  });

  test('a run that never got a result reports failed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-'));
    fs.writeFileSync(path.join(tmp, 'task.json'), JSON.stringify({ task: TASK, messages: [] }));
    await run(['report', '--dir', tmp], tmp, { AGENT_OUTCOME: 'failure', CHECKOUT_OUTCOME: 'success', PREPARE_OUTCOME: 'success' });
    assert.equal(got.at(-1).body.status, 'failed');
    assert.match(got.at(-1).body.summary, /result\.json nahi likha/);
  });

  test('a failed checkout says which secret to check', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-'));
    fs.writeFileSync(path.join(tmp, 'task.json'), JSON.stringify({ task: { ...TASK, target: 'crm' }, messages: [] }));
    await run(['report', '--dir', tmp], tmp, { CHECKOUT_OUTCOME: 'failure' });
    assert.match(got.at(-1).body.summary, /CRM_REPO_TOKEN/);
  });
});
