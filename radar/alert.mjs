// Email alerts for the "Outage alerts" and "Security alerts" lists on www.epifive.com.
//
// Readers sign up in the box on outage and incident guides (site: src/components/AlertSignup.tsx, POST /api/subscribe
// magnet "alerts:outage-alerts" | "alerts:security-alerts"). The Resend plan allows 3 segments (General, Daily,
// Alerts), so every alert reader is in the one segment "Alerts" (formerly "Alerts: outage", same id) and the kinds
// they want are the contact property `alerts` ("outage", "security" or "outage,security"; site src/lib/alerts.ts).
// When the radar's write job publishes a NEW outage guide (or security incident guide) and the page is live,
// `node radar/radar.mjs alert` emails each member of that segment whose property includes the alert's kind, one
// email per contact (never a broadcast), built from the article: subject, what is down, the "Status as of ... IST"
// sentence, the first thing to do, the link, a one-click unsubscribe link (site /api/alerts, also the
// List-Unsubscribe header) and the postal footer. Each send carries a Resend Idempotency-Key per alert and contact,
// and the contact property `alert_last` records "<kind>:<slug>", so a retry never emails anyone twice.
//
// Rules (alertGate): new fast-track articles only (never an update), outage or incident only, never a resolved outage,
// at most 1 alert per incident (same radar key, slug, or outage platform family within 3 days), at most 2 alerts in
// any 24 hours, of which at most 1 security alert (so an outage always has a slot left). Every decision on an outage
// or incident is logged in radar/results.jsonl as { type: "alert", ... } (no email addresses, no keys).
// Pure functions here (tested in radar/alert.test.mjs); radar.mjs does the I/O.

export const ALERT = {
  maxPerDay: 2,
  maxSecurityPerDay: 1,
  windowHours: 24,
  familyDays: 3,
  /** An article older than this (by its frontmatter date) is not news any more. */
  maxArticleAgeDays: 2,
  // Must match the site's src/lib/alerts.ts (ALERTS_SEGMENT, ALERTS_SEGMENT_OLD_NAMES, PROP_ALERTS, PROP_ALERT_LAST).
  segment: 'Alerts',
  segmentOldNames: ['Alerts: outage'],
  property: 'alerts',
  lastProperty: 'alert_last',
  /** The site page behind every alert's unsubscribe link and List-Unsubscribe header (functions/api/alerts.ts). */
  unsubscribePath: '/api/alerts',
  from: 'EpiFive <newsletter@epifive.com>',
  replyTo: 'epifive2@gmail.com',
  site: 'https://www.epifive.com',
  /** Used until ALERT_POSTAL_ADDRESS is set: the outreach footer's default (owner 15 Nov 2026: never an NCR address). */
  defaultAddress: 'Adarsh Colony, Deoghar, Jharkhand 814112, India',
};

/** outage -> outage list, incident and patch-tuesday -> security list, anything else (launch how-tos) -> no alert. */
export function alertKindForCategory(category) {
  // A Patch Tuesday summary goes to the Security alerts list (owner, 19 Nov 2026: "a security alert").
  return category === 'outage' ? 'outage' : category === 'incident' || category === 'patch-tuesday' ? 'security' : null;
}

/** "alert: outage|security" in the frontmatter of a new radar article (the site's alert box); added once if missing. */
export function ensureAlertField(text, category) {
  const kind = alertKindForCategory(category);
  if (!kind) return text;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m || /^alert:/m.test(m[1])) return text;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^topic:/.test(l));
  lines.splice(at === -1 ? lines.length : at + 1, 0, `alert: ${kind}`);
  return `---${nl}${lines.join(nl)}${nl}---${text.slice(m[0].length)}`;
}

// ---------- reading the article ----------

const plain = (s = '') => String(s)
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\*\*|__|`/g, '')
  .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?)]|$)/g, '$1$2')
  .replace(/\s+/g, ' ')
  .trim();

/** Sentences of a plain-text paragraph; "a.m.", "p.m.", "e.g.", "i.e.", "U.S." and decimals do not end a sentence. */
export function sentences(text) {
  const out = [];
  let start = 0;
  const re = /[.!?](?=["')\]]?\s+["'(]?[A-Z0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 4), m.index + 1);
    if (/(\b[ap]\.m\.|\be\.g\.|\bi\.e\.|\bU\.S\.|\bvs\.|\bNo\.|\bSt\.|\bInc\.)$/i.test(before)) continue;
    const end = m.index + 1 + (text.slice(m.index + 1).match(/^["')\]]?/)[0].length);
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

const cap = (s, n) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)).replace(/[\s,;:]+$/, '')}…`;
};

function frontValue(front, key) {
  // Plain, quoted or folded (">-") YAML scalars, which is what the site's posts use.
  const m = front.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return '';
  let v = m[1].trim();
  if (/^[>|][-+]?$/.test(v)) {
    const after = front.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
    const block = [];
    for (const l of after) {
      if (/^\s+\S/.test(l)) block.push(l.trim());
      else if (!l.trim()) block.push('');
      else break;
    }
    v = block.join(' ').trim();
  } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
  else if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
  return v.replace(/\s+/g, ' ').trim();
}

const section = (body, re) => {
  const m = body.match(re);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
};

/** The first concrete action in a "What users can do now" / "What to do now" section: a list item or "### 1." heading. */
export function firstAction(sectionText) {
  for (const raw of sectionText.split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^###\s+(?:\d+[.)]\s*)?(.+)$/);
    if (m) return cap(plain(m[1]).replace(/([^.!?])$/, '$1.'), 220);
    m = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (m) {
      const bold = m[1].match(/^\*\*(.+?)\*\*/);
      const text = bold ? bold[1] : sentences(plain(m[1]))[0] ?? '';
      return cap(plain(text).replace(/([^.!?])$/, '$1.'), 220);
    }
  }
  return '';
}

/** The facts an alert is built from. Text = the whole Markdown file. */
export function readArticle(text) {
  const md = String(text ?? '').replace(/\r\n/g, '\n');
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const front = fm?.[1] ?? '';
  const body = fm ? md.slice(fm[0].length) : md;
  const takeaways = [];
  const tk = front.match(/^takeaways:\n((?:[ \t]+.*\n?)+)/m);
  if (tk) {
    for (const l of tk[1].split('\n')) {
      const item = l.match(/^\s+-\s+(.*)$/);
      if (item) takeaways.push(item[1].replace(/^['"]|['"]$/g, ''));
      else if (takeaways.length && /^\s{3,}\S/.test(l)) takeaways[takeaways.length - 1] += ` ${l.trim()}`;
    }
  }
  const prose = plain(body.replace(/```[\s\S]*?```/g, ' ').replace(/^\|.*$/gm, ' ').replace(/^#+ .*$/gm, ' '));
  const statusAt = prose.search(/\bStatus as of\b/i);
  const status = statusAt === -1 ? '' : sentences(prose.slice(statusAt))[0] ?? '';
  return {
    title: frontValue(front, 'title'),
    description: frontValue(front, 'description'),
    date: frontValue(front, 'date'),
    alert: frontValue(front, 'alert'),
    takeaways: takeaways.map((t) => plain(t)),
    status: cap(status, 320),
    action: firstAction(section(body, /^## What (users can do|to do|to patch first)\b.*$/im)),
  };
}

// "Resolved", "restored" etc., unless negated ("has not been resolved", "not yet restored").
const RESOLVED_WORD = /\b(resolved|restored|fully recovered|mitigated|back to normal|back online|is over|has ended)\b/gi;
export function looksResolved(text = '') {
  for (const m of String(text).matchAll(RESOLVED_WORD)) {
    const before = String(text).slice(Math.max(0, m.index - 30), m.index);
    if (!/\b(not|no longer|never|yet to be|before it is|until it is|once)\b[\w\s'"]*$/i.test(before)) return true;
  }
  return false;
}

// ---------- the gate ----------

/**
 * Whether to email an alert for this write-job result. Returns { send, reason, kind }.
 * results = radar/results.jsonl entries (alert entries have type "alert" and status "sent" when one went out).
 */
export function alertGate({ task = {}, status, slug, article, results = [], now = Date.now(), settings = ALERT } = {}) {
  const kind = alertKindForCategory(task.category);
  const no = (reason) => ({ send: false, reason, kind });
  if (!kind) return no(`no alert for category ${task.category ?? 'launch'}`);
  if (task.kind !== 'new') return no('update-only: alerts go out for new guides only');
  if (task.dryRun) return no('dry-run task');
  if (status !== 'published') return no(`the article was not published (${status || 'no result'})`);
  if (!/^[a-z0-9-]+$/.test(slug ?? '')) return no('no valid slug');
  if (!article?.title) return no('article not found');
  if (article.alert === 'none') return no('the article has alert: none');
  const age = (now - Date.parse(`${article.date}T00:00:00+05:30`)) / 86400e3;
  if (!(age < settings.maxArticleAgeDays + 1)) return no(`the article is dated ${article.date || '(none)'}, too old for an alert`);
  if (kind === 'outage') {
    if (!article.status) return no('no "Status as of ... IST" sentence to quote');
    if (looksResolved(article.status) || looksResolved(article.title) || looksResolved(task.title)) return no('the outage looks resolved');
  }
  if (!article.action) return no('no first action found in the article');

  const sent = results.filter((r) => r.type === 'alert' && r.status === 'sent' && !r.dryRun);
  const same = sent.find((r) => r.key === task.key || r.slug === slug ||
    (kind === 'outage' && r.alert === 'outage' && (r.families ?? []).some((f) => (task.families ?? []).includes(f)) &&
      now - Date.parse(r.at) < settings.familyDays * 86400e3));
  if (same) return no(`already alerted for this incident (${same.slug} at ${same.at})`);
  const recent = sent.filter((r) => now - Date.parse(r.at) < settings.windowHours * 3600e3);
  if (recent.length >= settings.maxPerDay) return no(`daily cap reached (${recent.length}/${settings.maxPerDay} alerts in ${settings.windowHours} h)`);
  if (kind === 'security' && recent.filter((r) => r.alert === 'security').length >= settings.maxSecurityPerDay) {
    return no(`security cap reached (${settings.maxSecurityPerDay} security alert in ${settings.windowHours} h; the other slot is kept for outages)`);
  }
  return { send: true, reason: `new ${task.category} guide`, kind };
}

// ---------- the email ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A complete postal address (same test as the site's outreach footer): street or PO box first, city, postcode. */
export function completeAddress(a) {
  if (!a || a.length < 25) return false;
  const parts = a.split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length >= 3 && /\d|p\.?\s*o\.?\s*box/i.test(parts[0]) && /\b\d{5,6}(-\d{4})?\b/.test(parts.slice(1).join(' '));
}

/** Short subject: "Outage alert: <title up to its first colon>". */
export function alertSubject(kind, title) {
  const head = String(title).split(/:\s/)[0].trim() || String(title);
  return cap(`${kind === 'outage' ? 'Outage alert' : 'Security alert'}: ${head}`, 90);
}

export function buildAlertEmail({ kind, slug, article, address = ALERT.defaultAddress, settings = ALERT }) {
  const url = `${settings.site}/blog/${slug}?utm_source=alert&utm_medium=email&utm_campaign=${kind}-alert-${slug}`.slice(0, 300);
  const what = sentences(article.description)[0] ?? article.description;
  const lines = kind === 'outage'
    ? [
        ["What's down", what],
        ['Status', article.status.replace(/^Status as of\s*/i, 'As of ')],
        ['Do this first', article.action],
      ]
    : [
        ['What happened', what],
        ...(article.takeaways[0] ? [['What we know', cap(article.takeaways[0], 260)]] : []),
        ['Do this first', article.action],
      ];
  const subject = alertSubject(kind, article.title);
  const label = kind === 'outage' ? 'outage' : 'security';
  const why = `You are getting this because you signed up for EpiFive ${label} alerts at epifive.com. One email per major incident, at most two a day.`;
  const text = [
    article.title,
    '',
    ...lines.map(([k, v]) => `${k}: ${v}`),
    '',
    `Full guide, kept up to date: ${url}`,
    '',
    '--',
    why,
    'Stop these alerts: {{unsubscribe_url}}',
    `EpiFive, ${address}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #d9dee1;border-radius:8px;padding:8px 28px 24px">
  <tr><td style="padding:16px 0 4px;font:600 12px/1.4 Arial,sans-serif;color:#b42318;letter-spacing:.06em;text-transform:uppercase">EpiFive ${label} alert</td></tr>
  <tr><td style="padding:0 0 12px;font:700 21px/1.3 Arial,sans-serif;color:#14181d">${esc(article.title)}</td></tr>
  ${lines.map(([k, v]) => `<tr><td style="padding:0 0 10px;font:15px/1.55 Arial,sans-serif;color:#3a424c"><strong style="color:#14181d">${esc(k)}:</strong> ${esc(v)}</td></tr>`).join('\n  ')}
  <tr><td style="padding:6px 0 18px"><a href="${esc(url)}" style="display:inline-block;font:600 15px Arial,sans-serif;color:#fff;background:#0a7560;padding:10px 16px;border-radius:6px;text-decoration:none">Read the full guide</a></td></tr>
  <tr><td style="padding-top:16px;border-top:1px solid #d9dee1;font:12px/1.5 Arial,sans-serif;color:#65707b">
    ${esc(why)} <a href="{{unsubscribe_url}}" style="color:#65707b">Stop these alerts</a> in one click.<br>EpiFive, ${esc(address)}
  </td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html, previewText: cap(lines[1]?.[1] ?? what, 140), url, kind };
}

// ---------- recipients (one email per contact) ----------

/** A contact property value as Resend returns it ({ value, type } per key, or the bare value). */
export function propValue(props, key) {
  if (!props || typeof props !== 'object') return undefined;
  const raw = props[key];
  const v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

/** The alert kinds in a stored `alerts` value ("outage,security" -> ['outage', 'security']). */
export function alertKindsOf(value) {
  const have = new Set(String(value ?? '').split(',').map((x) => x.trim().toLowerCase()));
  return ['outage', 'security'].filter((k) => have.has(k));
}

/** The `alert_last` value for an alert: "<kind>:<slug>". */
export const alertTag = (kind, slug) => `${kind}:${slug}`;

/**
 * Whether one contact gets this alert. contact = { unsubscribed, properties } (a Resend contact).
 * Returns { send, reason }: never when globally unsubscribed, when the `alerts` property lacks the kind, or when
 * `alert_last` says this alert already went to them.
 */
export function recipientDecision(contact, kind, slug, settings = ALERT) {
  if (!contact || contact.unsubscribed === true) return { send: false, reason: 'unsubscribed' };
  const kinds = alertKindsOf(propValue(contact.properties, settings.property));
  if (!kinds.length) return { send: false, reason: 'no alert kinds' };
  if (!kinds.includes(kind)) return { send: false, reason: `wants ${kinds.join(',')} only` };
  if (propValue(contact.properties, settings.lastProperty) === alertTag(kind, slug)) return { send: false, reason: 'already sent' };
  return { send: true, reason: 'subscribed' };
}

/** One-click unsubscribe URL for a contact (Resend contact id) and kind. */
export const alertUnsubscribeUrl = (contactId, kind, settings = ALERT) =>
  `${settings.site}${settings.unsubscribePath}?unsubscribe=${encodeURIComponent(contactId)}&kind=${encodeURIComponent(kind)}`;

/** The Resend POST /emails body and headers for one contact. */
export function alertEmailFor(mail, contact, slug, settings = ALERT) {
  const unsub = alertUnsubscribeUrl(contact.id, mail.kind, settings);
  return {
    body: {
      from: settings.from,
      to: [contact.email],
      reply_to: settings.replyTo,
      subject: mail.subject,
      text: mail.text.replaceAll('{{unsubscribe_url}}', unsub),
      html: mail.html.replaceAll('{{unsubscribe_url}}', esc(unsub)),
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    },
    idempotencyKey: `alert-${mail.kind}-${slug}-${contact.id}`.slice(0, 256),
  };
}

/** The alerts segment among Resend's segments: "Alerts", else an old name. Null when there is none. */
export function findAlertsSegment(segments, settings = ALERT) {
  for (const name of [settings.segment, ...settings.segmentOldNames]) {
    const hit = (segments ?? []).find((s) => s.name === name);
    if (hit) return hit;
  }
  return null;
}
