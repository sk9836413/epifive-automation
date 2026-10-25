# EpiFive automation

Scheduled jobs for [EpiFive](https://www.epifive.com): the daily article and news brief, social video shares, the email digest, syndication, community drafts and IndexNow pings.

The jobs are started by a Cloudflare Worker scheduler. Each run checks out the site repository, does its work and pushes the result there; Cloudflare Pages then deploys the site.
