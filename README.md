# EpiFive automation

Scheduled jobs for [EpiFive](https://www.epifive.com): the daily article and news brief, social video shares, the email digest, syndication, community drafts and IndexNow pings.

The jobs are started by a Cloudflare Worker scheduler. Each run checks out the site repository, does its work and pushes the result there; Cloudflare Pages then deploys the site.

## Launch radar (`radar/`, `radar.yml`)

Watches official product feeds (`radar/sources.json`: OpenAI, Microsoft 365, Tech Community, Windows, Google Workspace, Gemini, Android, Apple, WhatsApp, Meta, Anthropic, GitHub, RBI) and publishes a same-day step-by-step how-to when a big launch clears the score threshold. Security incidents: sources with `"category": "incident"` (The Hacker News, BleepingComputer, GitHub Blog security, Microsoft Security Blog, ThePrint Tech, MediaNama) are scored by `scoreIncident` (boosts major platforms such as GitHub, Microsoft 365, Google and npm/PyPI, and Indian banks, UPI and Aadhaar; requires a concrete user action) and become a same-day "what happened / am I affected / what to do now / how to prevent it" guide, within the same daily cap. It has no cron: it starts when the scheduler requests the Daily article or Social media workflow (the scheduler's existing 5 daily slots). At most 2 fast-track articles and 2 updates a day; official sources only; a draft that fails the quality gate gets one fix attempt, then goes to the site backlog as "(fast-track, failed gate)". Logs: `radar/log/<YYYY-MM>.md` (every scan: items, scores, decisions) and `radar/results.jsonl` (every write). Writer instructions live in the site repo at `automation/RADAR.md`. Tests: `node --test radar/radar.test.mjs`.

Manual runs: Actions > Launch radar > Run workflow (`dry_run` drafts without publishing; `force_url` fast-tracks one official URL now; `force_category: incident` writes it as an incident guide).
