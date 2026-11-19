#!/usr/bin/env node
// Status snapshot for the site's "Is it down right now?" pages (https://www.epifive.com/status/<service>).
// The pages read each vendor's official status feed themselves (Pages Functions, 5-minute cache). This script adds
// what only the radar knows: the recent outage and status items it put on "Tech news today" (radar/live/<date>.json),
// grouped per service, with the official source link and our guide when there is one. The site renders them under
// "Recent <service> incidents" from radar/status/recent.json in this public repo, so there is no site rebuild.
//
//   node radar/status.mjs [--days 45] [--now ISO]
//
// Runs on every radar scan (radar.yml, after the news page step). Writes only when the content changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.join(HERE, 'live');
const OUT = path.join(HERE, 'status', 'recent.json');

// Keep in sync with SERVICES[].match in the site repo (src/lib/status.ts).
export const STATUS_SERVICES = {
  'microsoft-365': /\b(microsoft 365|m365|office 365|exchange online|outlook|teams|sharepoint|onedrive|copilot)\b/i,
  outlook: /\b(outlook|exchange( online)?|microsoft 365|office 365|m365)\b/i,
  teams: /\b(teams|microsoft 365|office 365|m365)\b/i,
  azure: /\b(azure|entra)\b/i,
  aws: /\b(aws|amazon web services|us-east-1|ec2|s3|dynamodb|lambda)\b/i,
  'google-workspace': /\b(google workspace|g suite|gmail|google (drive|meet|docs|sheets|calendar|chat))\b/i,
  gmail: /\b(gmail|google workspace)\b/i,
  'google-cloud': /\b(google cloud|gcp|bigquery|cloud run|gke|vertex ai)\b/i,
  cloudflare: /\bcloudflare\b/i,
  github: /\b(github|copilot)\b/i,
  chatgpt: /\b(chatgpt|openai)\b/i,
  slack: /\bslack\b/i,
};

// An item counts when the radar classed it as an outage, or it came from an official status feed.
const STATUS_SOURCE = /\b(status|health dashboard|service health)\b/i;
// "Copilot" alone is too broad for GitHub (Microsoft 365 Copilot items); require GitHub in the text there.
const NEEDS = { github: /\bgithub\b/i, chatgpt: /\b(chatgpt|openai)\b/i };

export const MAX_PER_SERVICE = 15;

const isDay = (d) => /^20\d{2}-\d{2}-\d{2}$/.test(d);

/** One recent-item row from a live-page item (only safe, public fields). */
export function recentRow(it, date) {
  return {
    time: it.time,
    headline: String(it.headline ?? '').slice(0, 200),
    source: it.source?.name ?? '',
    url: /^https:\/\//.test(it.source?.url ?? '') ? it.source.url : '',
    reported: !!it.reported,
    live: `/news/live/${date}#u-${it.id}`,
    post: it.post && /^[a-z0-9-]+$/.test(it.post) ? it.post : null,
  };
}

/**
 * days: [{ date, items }] (live pages). Returns { slug: rows[] } newest first, at most MAX_PER_SERVICE each, from the
 * last `keepDays` days.
 */
export function buildRecent(days, { now = Date.now(), keepDays = 45 } = {}) {
  const since = now - keepDays * 864e5;
  const out = Object.fromEntries(Object.keys(STATUS_SERVICES).map((s) => [s, []]));
  const seen = new Set();
  for (const day of days) {
    for (const it of day.items ?? []) {
      const t = Date.parse(it.time);
      if (Number.isNaN(t) || t < since || t > now + 36e5) continue;
      if (!(it.kind === 'outage' || STATUS_SOURCE.test(it.source?.name ?? ''))) continue;
      const key = it.key ?? it.id;
      if (seen.has(key)) continue;
      seen.add(key);
      // Headline and source only: the lines often mention other services for context ("like the Microsoft 365 outage").
      const text = `${it.headline ?? ''} ${it.source?.name ?? ''}`;
      for (const [slug, re] of Object.entries(STATUS_SERVICES)) {
        if (!re.test(text)) continue;
        if (NEEDS[slug] && !NEEDS[slug].test(text)) continue;
        out[slug].push(recentRow(it, day.date));
      }
    }
  }
  for (const slug of Object.keys(out)) {
    out[slug] = out[slug].sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, MAX_PER_SERVICE);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, f) => {
    const i = args.indexOf(`--${n}`);
    return i === -1 ? f : args[i + 1];
  };
  const now = opt('now') ? Date.parse(opt('now')) : Date.now();
  const keepDays = Number(opt('days', 45));
  const days = fs.existsSync(LIVE)
    ? fs.readdirSync(LIVE)
        .filter((f) => f.endsWith('.json') && isDay(f.slice(0, 10)))
        .filter((f) => Date.parse(`${f.slice(0, 10)}T00:00:00Z`) >= now - (keepDays + 1) * 864e5)
        .map((f) => ({ date: f.slice(0, 10), ...JSON.parse(fs.readFileSync(path.join(LIVE, f), 'utf8')) }))
    : [];
  const services = buildRecent(days, { now, keepDays });
  const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  const total = Object.values(services).reduce((n, r) => n + r.length, 0);
  if (old && JSON.stringify(old.services) === JSON.stringify(services)) {
    console.log(`Status snapshot unchanged (${total} rows).`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ generated: new Date(now).toISOString(), services }, null, 1)}\n`);
  console.log(`Status snapshot written: ${total} rows across ${Object.values(services).filter((r) => r.length).length} services.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
