// Pure helpers of the AI Tasks agent (ai-task/task.mjs, .github/workflows/ai-task.yml). No I/O: covered by the tests.

/** Where each CRM target lives. `token` names the secret the workflow checks out / pushes with. */
export const TARGETS = {
  site: { repo: 'sk9836413/EPIVIFE', label: 'EpiFive website', token: 'SITE_REPO_TOKEN', gate: 'site' },
  automation: { repo: 'sk9836413/epifive-automation', label: 'EpiFive automation', token: 'GITHUB_TOKEN', gate: 'node-tests' },
  shyam: { repo: 'sk9836413/shyam-premi-sn', label: 'Shyam Premi SN', token: 'SHYAM_REPO_TOKEN', gate: 'node-tests' },
  crm: { repo: 'epifive/epifive-crm', label: 'EpiFive CRM', token: 'CRM_REPO_TOKEN', gate: 'crm' },
  research: { repo: 'sk9836413/epifive-automation', label: 'Research only', token: 'GITHUB_TOKEN', gate: 'none' },
};

/** Bash commands the agent may run, per target (no git push, no curl, no generic node: it holds no secrets anyway). */
const COMMON_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(date:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const TARGET_TOOLS = {
  site: ['Bash(node scripts/check-posts.mjs:*)', 'Bash(node scripts/check-errors.mjs:*)', 'Bash(node scripts/check-devices.mjs:*)', 'Bash(node scripts/check-news.mjs:*)', 'Bash(node --test:*)', 'Bash(npm test:*)'],
  automation: ['Bash(node --test:*)'],
  shyam: ['Bash(node --test:*)', 'Bash(node scripts/status-engine.mjs calendar:*)', 'Bash(node scripts/day-plan.mjs:*)'],
  crm: ['Bash(npm test:*)', 'Bash(npm run typecheck:*)', 'Bash(node --test:*)'],
  research: [],
};
export const allowedTools = (target) => [...COMMON_TOOLS, ...(TARGET_TOOLS[target] || [])].join(',');

/** Workflows the agent may ask the run to start after the work (only with publishing allowed), and their inputs. */
export const DISPATCH_ALLOW = {
  'social.yml': ['slug', 'force', 'brief', 'dry_run', 'allow_news'],
  'longvideo.yml': ['slug', 'force', 'dry_run'],
  'article.yml': ['dry_run'],
  'report.yml': ['dry_run', 'date', 'force'],
  'indexnow.yml': [],
  'control.yml': ['only'],
};

/** Keeps only allowed workflows and inputs; values become short single-line strings. */
export function filterDispatches(list) {
  const out = [];
  for (const d of Array.isArray(list) ? list.slice(0, 3) : []) {
    const wf = String(d?.workflow || '');
    if (!(wf in DISPATCH_ALLOW)) continue;
    const inputs = {};
    for (const [k, v] of Object.entries(d.inputs || {})) {
      if (!DISPATCH_ALLOW[wf].includes(k)) continue;
      const s = String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
      if (/^[\w .,:;!?'"()/@#&+=-]*$/.test(s)) inputs[k] = s;
    }
    out.push({ workflow: wf, inputs });
  }
  return out;
}

const IST = 330 * 60_000;
export const istDate = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);

/** .ai-task/TASK.md: everything the agent needs. Private (never printed; the folder is git-excluded). */
export function buildTaskFile(task, messages, { target, today, rulesPath, reportFile, dryRunAll = false }) {
  const t = TARGETS[target];
  const dry = dryRunAll || task.dry_run;
  const publish = task.publish_allowed && !dry;
  const thread = (messages || []).map((m) => `- **${m.author === 'owner' ? 'Owner' : m.author === 'agent' ? 'You (earlier run)' : 'System'}** (${m.at}): ${m.body}`).join('\n');
  return `# AI task #${task.id}: ${task.title}

Today (IST): ${today}. Attempt: ${task.attempts}. Priority: ${task.priority}.
Target: **${t.label}** (\`${t.repo}\`), checked out in the current directory${task.branch && task.approved ? ` on branch \`${task.branch}\` (your earlier work)` : ''}.

## House rules (read first, they override everything below)

Read \`${rulesPath}\` completely before you start and follow it. If the task conflicts with a rule, do not do that part:
finish with status "needs-input" and explain the conflict.

## Publishing for this task

${dry ? '- DRY RUN: do the work and checks only. Nothing is pushed, published, posted or emailed. Say what you WOULD publish.' : publish
    ? '- Publishing is ALLOWED (the owner approved). The workflow pushes your changes to `main` after the quality gates pass, and can start the allowed workflows you list in `dispatch`.'
    : `- Publishing is NOT allowed yet. Prepare the work completely; the workflow pushes it to branch \`ai-task/${task.id}\` only (not live). Finish with status "needs-input" and a summary that tells the owner exactly what will go live when he taps Approve.`}
- You never push, post, upload or email yourself: you have no credentials. Write files; the workflow does the rest.

## The task (from the owner)

${task.prompt}
${task.previous_summary ? `\n## Your result from the last run\n\n${task.previous_summary}\n` : ''}${thread ? `\n## Thread (oldest first; answer the newest owner message)\n\n${thread}\n` : ''}${reportFile ? `\n## Data\n\nToday's performance numbers (same as the owner's daily report email) are in \`${reportFile}\`. Use these numbers; do not invent any.\n` : ''}
## How to finish (required)

Write \`.ai-task/result.json\` (and nothing else in \`.ai-task/\`):

\`\`\`json
{
  "status": "done | needs-input | failed",
  "summary": "Short Hinglish summary for the owner's phone: what you did, results/numbers, what is left. If needs-input: your exact question(s).",
  "commit_message": "One neutral English line for the git commit (public repos: no names, no secrets, no private numbers)",
  "links": [{ "label": "Article", "url": "https://www.epifive.com/blog/<slug>" }],
  "dispatch": [{ "workflow": "social.yml", "inputs": { "slug": "<slug>" } }]
}
\`\`\`

- \`dispatch\` is optional and only runs when publishing is allowed. Allowed: social.yml (slug, force, brief), longvideo.yml (slug, force), article.yml, report.yml, indexnow.yml, control.yml.
- Ambiguous, risky or against a rule? Do not guess: status "needs-input" with a clear question.
- Never write secrets, tokens, the owner's personal phone number or real name into any file or the summary.
- Change only what the task needs. Run the target's checks (see the rules file) before you finish.
`;
}

/** Reads the agent's result.json text into a safe shape. */
export function normalizeResult(raw) {
  let r;
  try { r = JSON.parse(String(raw || '')); } catch { return { parsed: false, status: 'failed', summary: 'Agent ne result.json nahi likha (ya JSON galat tha). Run me time ya turn limit khatam ho gayi hogi.', links: [], dispatch: [], commit_message: '' }; }
  const status = ['done', 'needs-input', 'failed'].includes(r?.status) ? r.status : 'failed';
  const summary = String(r?.summary || '').trim().slice(0, 5000) || (status === 'failed' ? 'Agent failed without a summary.' : 'Done (no summary).');
  const links = (Array.isArray(r?.links) ? r.links : []).slice(0, 15)
    .map((l) => ({ label: String(l?.label || '').replace(/[\r\n]+/g, ' ').slice(0, 100), url: String(l?.url || '').trim() }))
    .filter((l) => /^https:\/\/[^\s<>"']{4,490}$/.test(l.url));
  const commit = String(r?.commit_message || '').replace(/[\r\n]+/g, ' ').replace(/[^\w .,:;()/#&+'-]/g, '').trim().slice(0, 100);
  return { parsed: true, status, summary, links, dispatch: filterDispatches(r?.dispatch), commit_message: commit };
}

/** Final status after the workflow steps (gates, push) and the CRM summary text. */
export function finalOutcome({ task, result, agentOutcome, changes, gate, push, dryRunAll = false }) {
  const notes = [];
  let status = result.status;
  const links = [...result.links];
  const dry = dryRunAll || task.dry_run;
  if (agentOutcome && agentOutcome !== 'success') notes.push(`Agent step ended: ${agentOutcome}${result.parsed ? ' (result.json likh diya tha)' : ''}.`);
  if (gate && gate.outcome === 'failure') {
    status = 'failed';
    notes.push(`Quality gate FAIL (${gate.name}): kuch push nahi hua.${gate.tail ? `\n${gate.tail}` : ''}`);
  }
  if (changes?.length) {
    notes.push(`Files changed (${changes.length}): ${changes.slice(0, 12).join(', ')}${changes.length > 12 ? ', ...' : ''}`);
    if (dry) notes.push('Dry run: kuch push nahi kiya.');
    else if (task.target === 'research') notes.push('Research task: changes discard kiye (push nahi).');
  }
  if (push?.ref === 'main' && push.sha) {
    links.unshift({ label: 'Commit (live)', url: `https://github.com/${TARGETS[task.target].repo}/commit/${push.sha}` });
  } else if (push?.ref && push.sha) {
    links.unshift({ label: `Branch ${push.ref} (approval ke liye)`, url: `https://github.com/${TARGETS[task.target].repo}/compare/main...${push.ref}` });
    if (status === 'done') status = 'needs-input';
    notes.push(`Kaam branch ${push.ref} par ready hai, live NAHI hua. Approve dabao to main par publish hoga.`);
  } else if (push?.error) {
    status = 'failed';
    notes.push(`Push fail: ${push.error}`);
  }
  if (push?.dispatched?.length) notes.push(`Started: ${push.dispatched.join(', ')}`);
  const summary = [result.summary, ...notes].join('\n\n').slice(0, 5900);
  return { status, summary, links: links.slice(0, 20), branch: push?.ref && push.ref !== 'main' ? push.ref : null };
}

/** Short Hinglish email for the owner (text only). */
export function emailText({ task, outcome, crmUrl }) {
  const head = { done: 'ho gaya', failed: 'fail hua', 'needs-input': 'aapka jawab / approval chahiye' }[outcome.status] || outcome.status;
  return {
    subject: `AI task #${task.id} ${head}: ${task.title}`.slice(0, 150),
    text: `Namaste,\n\nAI task #${task.id} "${task.title}" ${head}.\n\n${outcome.summary.slice(0, 1800)}\n\n${outcome.links.slice(0, 6).map((l) => `${l.label}: ${l.url}`).join('\n')}\n\nCRM me dekho / jawab do: ${crmUrl}/#/ai/${task.id}\n\n- EpiFive AI agent`,
  };
}
