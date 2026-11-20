// Mini-tools factory (mini-tools.yml), plan job: validates .run/plan.json written by the planning agent and prints the
// build matrix. Rejects slugs that already exist in the epifive org (.run/existing.txt, one repo name per line).
//   node minitools/plan-check.mjs <plan.json> <existing.txt> <max>     -> stdout: {"slug":[...]} (empty list = nothing)
// THIS REPO IS PUBLIC: prints slugs and reasons only.
import fs from 'node:fs';

const [planFile, existingFile, maxArg = '2'] = process.argv.slice(2);
const max = Math.max(0, Math.min(2, Number(maxArg) || 2));
let plan;
try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch { console.error('plan: no valid JSON'); console.log('{"slug":[]}'); process.exit(0); }
const tools = Array.isArray(plan) ? plan : plan.tools || [];
const existing = new Set(fs.readFileSync(existingFile, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
const ok = [];
for (const t of tools) {
  const problems = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.slug || '') || t.slug.length > 40) problems.push('slug must be kebab-case, <= 40 chars');
  if (t.slug?.endsWith('-pro')) problems.push('slug must not end in -pro');
  if (existing.has(t.slug) || existing.has(`${t.slug}-pro`)) problems.push('a repo with this name already exists');
  if (!/^EpiFive [A-Z0-9]/.test(t.name || '')) problems.push('name must start with "EpiFive "');
  if (/zen\b/i.test(t.name || '')) problems.push('no invented *zen names');
  if (!t.description || t.description.length > 120) problems.push('description 1-120 chars');
  if (!Array.isArray(t.topics) || t.topics.length < 3 || t.topics.length > 8 || t.topics.some((x) => !/^[a-z0-9-]{1,35}$/.test(x))) problems.push('3-8 lowercase topics');
  if (!t.tag || t.tag.length > 48) problems.push('tag 1-48 chars');
  if (!Array.isArray(t.free_features) || !t.free_features.length || !Array.isArray(t.pro_features) || !t.pro_features.length) problems.push('free_features and pro_features needed');
  if (!(Number(t.price_inr) > 0) || !(Number(t.price_usd) > 0)) problems.push('price_inr and price_usd needed');
  if (ok.some((o) => o.slug === t.slug)) problems.push('duplicate slug');
  if (problems.length) console.error(`plan: ${t.slug || '?'} rejected (${problems.join('; ')})`);
  else ok.push(t);
}
const chosen = ok.slice(0, max);
fs.writeFileSync(planFile, JSON.stringify(chosen, null, 2));
console.error(`plan: ${chosen.length} tool(s): ${chosen.map((t) => t.slug).join(', ') || 'none'}`);
console.log(JSON.stringify({ slug: chosen.map((t) => t.slug) }));
