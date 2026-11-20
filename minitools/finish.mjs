// Mini-tools factory (mini-tools.yml), finish job helpers. THIS REPO IS PUBLIC: prints slugs and statuses only.
//   node minitools/finish.mjs profile <profile repo dir> <plan.json> <slug...>   add tools to the MINI array of scripts/build.mjs
//   node minitools/finish.mjs log <MINI-TOOLS-PIPELINE.md> <plan.json> <results dir> appends Release log rows
//   node minitools/finish.mjs email <plan.json> <results dir>                       emails the owner (RESEND_API_KEY)
// <results dir> holds one <slug>.json per built tool: { slug, status, demo, release, notes } from the build job.
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const results = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json')).map((f) => readJson(path.join(dir, String(f)))) : [];
const istDate = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const q = (s) => JSON.stringify(String(s));

if (cmd === 'profile') {
  const [dir, planFile, ...slugs] = rest;
  const plan = readJson(planFile);
  const file = path.join(dir, 'scripts', 'build.mjs');
  let src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const MINI = [');
  const end = src.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('MINI array not found in scripts/build.mjs');
  let added = 0;
  for (const slug of slugs) {
    const t = plan.find((x) => x.slug === slug);
    if (!t || src.slice(start, end).includes(`repo: "${slug}"`)) continue;
    const line = `  { repo: ${q(slug)}, title: ${q(t.name)}, tag: ${q(t.tag)}, demo: ${q(t.demo || `https://${slug}-demo.pages.dev`)} },\n`;
    src = src.slice(0, src.indexOf('];', start)) + line + src.slice(src.indexOf('];', start));
    added++;
  }
  fs.writeFileSync(file, src);
  console.log(`profile: ${added} tool(s) added`);
} else if (cmd === 'log') {
  const [pipeline, planFile, dir] = rest;
  const plan = readJson(planFile);
  let md = fs.readFileSync(pipeline, 'utf8').replace(/\s*$/, '\n');
  let n = 0;
  for (const r of results(dir).filter((x) => x.status === 'released')) {
    const t = plan.find((x) => x.slug === r.slug) || {};
    if (md.includes(`https://github.com/epifive/${r.slug} `)) continue;
    md += `| ${istDate()} | ${t.name || r.slug}${t.old_name ? ` (pipeline: ${t.old_name})` : ''} | https://github.com/epifive/${r.slug} | ${r.demo} | ${r.release} (₹${t.price_inr} / $${t.price_usd}) | email + AI task text (cloud) |\n`;
    n++;
  }
  fs.writeFileSync(pipeline, md);
  console.log(`release log: ${n} row(s) added`);
} else if (cmd === 'email') {
  const [planFile, dir] = rest;
  const plan = readJson(planFile);
  const rs = results(dir);
  if (!process.env.RESEND_API_KEY) { console.log('email: RESEND_API_KEY not set, skipped'); process.exit(0); }
  const lines = [`Mini tools run ${istDate()} (cloud: epifive-automation mini-tools.yml).`, ''];
  for (const t of plan) {
    const r = rs.find((x) => x.slug === t.slug) || { status: 'not built' };
    lines.push(`${t.name}: ${r.status}`);
    if (r.status === 'released') {
      lines.push(`  GitHub: https://github.com/epifive/${t.slug}`, `  Demo: ${r.demo}`, `  Pro: ${r.release} (Rs ${t.price_inr} / $${t.price_usd}), private repo epifive/${t.slug}-pro`);
      lines.push('  Agla kadam (CRM -> AI Tasks -> New task, target "EpiFive website"):');
      lines.push(`  "RELEASE HANDOFF - ${t.name} Pro: store page (automation/STORE.md) from automation/minitools/handoffs/${t.slug}.md, /open-source entry, blog guide and a Short/Reel. Free repo https://github.com/epifive/${t.slug}, demo ${r.demo}, Pro release ${r.release}."`);
    }
    if (r.notes) lines.push(`  Note: ${r.notes}`);
    lines.push('');
  }
  if (process.env.RUN_URL) lines.push(`Run: ${process.env.RUN_URL}`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.REPORT_FROM || 'EpiFive Agent <hello@epifive.com>',
      to: [process.env.REPORT_TO || 'info@epifive.com'],
      ...(process.env.REPORT_BCC ? { bcc: [process.env.REPORT_BCC] } : {}),
      subject: `Mini tools: ${rs.filter((x) => x.status === 'released').length} released, ${plan.length - rs.filter((x) => x.status === 'released').length} not`,
      text: lines.join('\n'),
    }),
  });
  console.log(`email: HTTP ${res.status}`);
} else {
  console.error('Usage: finish.mjs profile|log|email ...');
  process.exit(2);
}
