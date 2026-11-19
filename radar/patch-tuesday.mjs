#!/usr/bin/env node
// Patch Tuesday (owner approved 19 Nov 2026): on the second Tuesday of each month, after about 18:00 UTC (Microsoft
// releases at 10:00 Pacific), the radar scan queues "patch-tuesday-<yyyy-mm>" as a Tier 1 fast-track article
// (category "patch-tuesday", top score, same daily caps). The write job runs `summary` first, so the writer gets the
// official counts from Microsoft's own data instead of reading a 19 MB file:
//   - MSRC CVRF for the month (https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/<yyyy-Mon>): every CVE, its severity,
//     impact, "Exploited"/"Publicly Disclosed" flags, CVSS, product tag and the KB + fixed build per product;
//   - CISA's Known Exploited Vulnerabilities feed: which CVEs CISA added on or after release day.
// The site page is a normal post, content/posts/patch-tuesday-<month name>-<yyyy>.md, listed on
// https://www.epifive.com/patch-tuesday (/patch-tuesday/<yyyy-mm> 301s to it). Writer rules: EPIVIFE
// automation/RADAR.md "Patch Tuesday".
//
//   node radar/patch-tuesday.mjs due [--now ISO]                      which month is due now (JSON or "none")
//   node radar/patch-tuesday.mjs summary --month 2026-11 --out f.json  official counts for the writer
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Hours after midnight UTC on release day when the radar starts trying (10:00 PST = 18:00 UTC). */
export const RELEASE_HOUR_UTC = 18;
/** Days after release during which a missed Patch Tuesday is still queued. */
export const DUE_DAYS = 3;
/** Fast-track score: above every normal item, so it is the next task picked within the daily caps. */
export const PATCH_TUESDAY_SCORE = 30;

export const monthKey = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;
export const cvrfId = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${y}-${MONTH_ABBR[m - 1]}`;
};
export const slugForMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `patch-tuesday-${MONTH_NAMES[m - 1]}-${y}`;
};
export const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  const n = MONTH_NAMES[m - 1];
  return `${n[0].toUpperCase()}${n.slice(1)} ${y}`;
};

/** Second Tuesday of a month, as a UTC midnight Date. */
export function secondTuesday(year, month) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return new Date(Date.UTC(year, month, 1 + ((2 - first + 7) % 7) + 7));
}

/**
 * The Patch Tuesday that is due at `now`: from 18:00 UTC on the second Tuesday until DUE_DAYS later. Returns
 * { month, key, slug, releaseDate, title, link } or null.
 */
export function patchTuesdayDue(now = Date.now()) {
  const d = new Date(now);
  const day = secondTuesday(d.getUTCFullYear(), d.getUTCMonth());
  const start = day.getTime() + RELEASE_HOUR_UTC * 3600e3;
  if (now < start || now > start + DUE_DAYS * 86400e3) return null;
  const month = monthKey(d.getUTCFullYear(), d.getUTCMonth());
  return {
    month,
    key: `patch-tuesday-${month}`,
    slug: slugForMonth(month),
    releaseDate: day.toISOString().slice(0, 10),
    title: `Microsoft ${monthLabel(month)} Patch Tuesday security updates`,
    link: `https://msrc.microsoft.com/update-guide/releaseNote/${cvrfId(month)}`,
  };
}

/** The radar state entry for a due Patch Tuesday (category "patch-tuesday", queued at the top score). */
export function patchTuesdayItem(due, now = Date.now()) {
  return {
    title: due.title,
    link: due.link,
    source: 'patch-tuesday',
    topic: 'security-identity',
    category: 'patch-tuesday',
    date: new Date(now).toISOString(),
    first: new Date(now).toISOString(),
    summary: `Microsoft's monthly security release of ${due.releaseDate}. Write the month's summary as /blog/${due.slug} (RADAR.md "Patch Tuesday").`,
    score: PATCH_TUESDAY_SCORE,
    reasons: [`Patch Tuesday ${due.month} (monthly security release, Tier 1)`],
    status: 'queued',
    patchTuesday: due.month,
    backlog: due.slug,
  };
}

/** Is the month's release published in the Security Update Guide? (MSRC "updates" API; small JSON.) */
export async function msrcReleased(month, fetchText) {
  const body = await fetchText(`https://api.msrc.microsoft.com/cvrf/v3.0/updates/${cvrfId(month)}`);
  const json = JSON.parse(body);
  return (json.value ?? []).some((u) => u.ID === cvrfId(month) && u.CvrfUrl);
}

// ---------- summary for the writer ----------

const notes = (v, type) => (v.Notes ?? []).filter((n) => n.Type === type).map((n) => n.Value);
const threats = (v, type) => [...new Set((v.Threats ?? []).filter((t) => t.Type === type).map((t) => t.Description?.Value).filter(Boolean))];
const SEVERITIES = ['Critical', 'Important', 'Moderate', 'Low'];
const maxSeverity = (v) => SEVERITIES.find((s) => threats(v, 3).includes(s)) ?? 'Unrated';
const firstPublished = (v) => (v.RevisionHistory ?? []).map((r) => r.Date).sort()[0] ?? '';
const flags = (v) => {
  const s = threats(v, 1).join(';');
  return {
    exploited: /Exploited:Yes/i.test(s),
    disclosed: /Publicly Disclosed:Yes/i.test(s),
    assessment: (s.match(/Latest Software Release:([^;]+)/) ?? [])[1] ?? '',
  };
};
const cvss = (v) => (v.CVSSScoreSets ?? []).map((c) => c.BaseScore).filter((x) => typeof x === 'number').sort((a, b) => b - a)[0] ?? null;
const inc = (o, k, n = 1) => ((o[k] = (o[k] ?? 0) + n), o);
const cmpBuild = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

function productNames(cvrf) {
  const names = {};
  const walk = (branches) => {
    for (const b of [].concat(branches ?? [])) {
      for (const item of b.Items ?? []) {
        if (item.ProductID) names[item.ProductID] = item.Value;
        if (item.Items) walk(item);
      }
    }
  };
  walk(cvrf.ProductTree?.Branch);
  for (const p of cvrf.ProductTree?.FullProductName ?? []) names[p.ProductID] = p.Value;
  return names;
}

/**
 * Official counts for one month. Totals count CVEs whose assigning CNA is Microsoft and that were first published on
 * release day (Chromium/Edge, Azure Linux and other third-party CVEs that the guide republishes are counted apart).
 */
export function summarize(cvrf, { month, kev = null } = {}) {
  const [y, m] = month.split('-').map(Number);
  const releaseDate = secondTuesday(y, m - 1).toISOString().slice(0, 10);
  const all = cvrf.Vulnerability ?? [];
  const ms = all.filter((v) => notes(v, 8)[0] === 'Microsoft');
  const onDay = ms.filter((v) => firstPublished(v).startsWith(releaseDate));
  const otherDays = ms.filter((v) => !firstPublished(v).startsWith(releaseDate));
  const thirdParty = {};
  for (const v of all) if (notes(v, 8)[0] !== 'Microsoft') inc(thirdParty, notes(v, 8)[0] ?? 'unknown');

  const bySeverity = {};
  const byImpact = {};
  const byProduct = {};
  const assessments = {};
  for (const v of onDay) {
    inc(bySeverity, maxSeverity(v));
    for (const i of threats(v, 0)) inc(byImpact, i);
    inc(byProduct, notes(v, 7)[0] ?? 'unknown');
    inc(assessments, flags(v).assessment || 'none');
  }
  const brief = (v) => ({
    cve: v.CVE,
    title: v.Title?.Value ?? '',
    product: notes(v, 7)[0] ?? '',
    severity: maxSeverity(v),
    impact: threats(v, 0),
    cvss: cvss(v),
    ...flags(v),
    customerActionRequired: notes(v, 6)[0] ?? '',
    firstPublished: firstPublished(v).slice(0, 10),
    url: `https://msrc.microsoft.com/update-guide/vulnerability/${v.CVE}`,
  });

  // Highest fixed build (and its KB) per Windows / server product, from the remediation table.
  const names = productNames(cvrf);
  const kb = {};
  for (const v of onDay) {
    for (const r of v.Remediations ?? []) {
      if (r.Type !== 2) continue;
      const id = r.Description?.Value ?? '';
      for (const pid of r.ProductID ?? []) {
        const name = names[pid];
        if (!name || !/^(Windows|Microsoft Exchange|Microsoft SharePoint|Office Online Server|Microsoft SQL Server)/.test(name)) continue;
        if (/32-bit|ARM64|Server Core/.test(name)) continue;
        const entry = { kb: /^\d{6,8}$/.test(id) ? `KB${id}` : id, type: r.SubType ?? '', build: r.FixedBuild ?? '' };
        const list = (kb[name] ??= []);
        if (!list.some((e) => e.kb === entry.kb && e.type === entry.type)) list.push(entry);
      }
    }
  }
  for (const [name, list] of Object.entries(kb)) kb[name] = list.sort((a, b) => cmpBuild(b.build, a.build)).slice(0, 3);

  const kevAdded = kev
    ? (kev.vulnerabilities ?? []).filter((x) => x.dateAdded >= releaseDate).map((x) => ({
        cve: x.cveID, vendor: x.vendorProject, product: x.product, name: x.vulnerabilityName, dateAdded: x.dateAdded, dueDate: x.dueDate,
        microsoft: /microsoft/i.test(x.vendorProject),
      }))
    : null;

  return {
    month,
    label: monthLabel(month),
    releaseDate,
    slug: slugForMonth(month),
    source: `https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/${cvrfId(month)}`,
    releaseNotes: `https://msrc.microsoft.com/update-guide/releaseNote/${cvrfId(month)}`,
    documentTracking: { initial: cvrf.DocumentTracking?.InitialReleaseDate, current: cvrf.DocumentTracking?.CurrentReleaseDate },
    countingRule: 'Microsoft-issued CVEs (assigning CNA "Microsoft") first published on release day; third-party CVEs counted separately',
    total: onDay.length,
    bySeverity,
    byImpact,
    exploitabilityAssessment: assessments,
    exploited: onDay.filter((v) => flags(v).exploited).map(brief),
    publiclyDisclosed: onDay.filter((v) => flags(v).disclosed).map(brief),
    criticalRce: onDay.filter((v) => maxSeverity(v) === 'Critical' && threats(v, 0).includes('Remote Code Execution')).map(brief),
    critical: onDay.filter((v) => maxSeverity(v) === 'Critical').map(brief),
    moreLikely: onDay.filter((v) => /More Likely/i.test(flags(v).assessment)).map(brief),
    byProduct: Object.fromEntries(Object.entries(byProduct).sort((a, b) => b[1] - a[1])),
    publishedOtherDays: otherDays.map(brief),
    thirdPartyCves: thirdParty,
    kbByProduct: kb,
    cisaKevAddedSinceRelease: kevAdded,
  };
}

// ---------- CLI ----------

async function fetchText(url, timeout = 120000) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'EpiFive-radar/1.0 (+https://www.epifive.com)' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  if (args[0] === 'due') {
    const due = patchTuesdayDue(opt('now') ? Date.parse(opt('now')) : Date.now());
    console.log(due ? JSON.stringify(due) : 'none');
    return;
  }
  if (args[0] === 'summary') {
    const month = opt('month');
    if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new Error('--month yyyy-mm is required');
    const cvrf = JSON.parse(await fetchText(`https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/${cvrfId(month)}`));
    let kev = null;
    try {
      kev = JSON.parse(await fetchText('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', 60000));
    } catch (e) {
      console.error(`CISA KEV feed not read (${e.message}); open the catalog page instead.`);
    }
    const s = summarize(cvrf, { month, kev });
    const json = `${JSON.stringify(s, null, 1)}\n`;
    if (opt('out')) fs.writeFileSync(opt('out'), json);
    else process.stdout.write(json);
    console.error(`${s.label}: ${s.total} Microsoft CVEs (${Object.entries(s.bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')}), ${s.exploited.length} exploited, ${s.publiclyDisclosed.length} publicly disclosed.`);
    return;
  }
  console.error('Usage: patch-tuesday.mjs due [--now ISO] | summary --month yyyy-mm [--out file]');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
