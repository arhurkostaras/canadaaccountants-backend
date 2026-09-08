// Daily digest builder proof. Two fixtures: a zero-activity day and a busy day.
// The builder is pure, so these run with no database and no network. The
// collector is exercised once through a mock pool to prove the removal /
// manual-review split and the Monday founder fold.
const test = require('node:test');
const assert = require('node:assert');
const digest = require('../services/daily-digest');

// A Wednesday 07:00 America/Toronto in September (EDT = UTC-4).
const WEDNESDAY = new Date('2026-09-09T11:00:00Z');
// A Monday 07:00 America/Toronto.
const MONDAY = new Date('2026-09-07T11:00:00Z');

const NUMBERS_HTML = '<table id="pipeline-numbers"><tr><td>ACC</td><td>12</td></tr></table>';

function quietDay() {
  return {
    now: WEDNESDAY,
    actions: { removalRequests: [], clientRequests: [], applicationsAwaitingPayment: [], inboundNeedingHuman: [], failures: [] },
    numbers: { html: NUMBERS_HTML, notes: ['ACC: 0 active campaigns with 4729 queued (dark state unless a campaign is meant to be live)'] },
    quiet: [
      { platform: 'ACC', ok: true, line: 'poller ran 3m ago (ok) · classifier processed 0 in 24h · health ok (sent 0, queued 4729, active 0) · webhook health ok' },
      { platform: 'LAW', ok: true, line: 'digest feed not deployed yet (sibling port pending) · health ok (sent 0, queued 0, active 0) · webhook health ok' },
      { platform: 'INV', ok: true, line: 'digest feed not deployed yet (sibling port pending) · health ok (sent 0, queued 0, active 0) · webhook health ok' },
      { platform: 'CBE', ok: true, line: 'webhook health ok' }
    ],
    founder: null
  };
}

function busyDay() {
  const h = (hours) => new Date(WEDNESDAY.getTime() - hours * 3600 * 1000).toISOString();
  return {
    now: WEDNESDAY,
    actions: {
      removalRequests: [
        { platform: 'ACC', fromEmail: 'jane.doe@firm.ca', toEmail: 'support@canadaaccountants.app', subject: 'Please remove my profile', receivedAt: h(5) }
      ],
      clientRequests: [
        { platform: 'ACC', name: 'Priya <Sharma>', province: 'ON', service: 'tax_planning', createdAt: h(2), source: 'friction form' },
        { platform: 'LAW', name: null, province: null, service: 'estate', createdAt: h(20), source: 'friction form (demand-attribution)' }
      ],
      applicationsAwaitingPayment: [
        { platform: 'ACC', name: 'Marc Tremblay', email: 'marc@cabinet.qc.ca', firm: 'Cabinet Tremblay', province: 'QC', tier: 'professional', submittedAt: h(30) }
      ],
      inboundNeedingHuman: [
        { platform: 'ACC', fromEmail: 'cpa@example-firm.ca', subject: 'Re: quick question', receivedAt: h(9), reason: 'manual review' },
        { platform: 'LAW', fromEmail: 'lawyer@example-firm.ca', subject: 'breakdown reply awaiting approval', receivedAt: h(11), reason: 'breakdown pending approval' }
      ],
      failures: [
        { platform: 'INV', message: 'webhook health: INV: health status=fail (last event never)' }
      ]
    },
    numbers: { html: NUMBERS_HTML, notes: [] },
    quiet: [
      { platform: 'ACC', ok: true, line: 'poller ran 2m ago (ok) · health ok (sent 40, queued 100, active 1)' },
      { platform: 'LAW', ok: true, line: 'digest feed ok · health ok (sent 12, queued 30, active 1)' },
      { platform: 'INV', ok: false, line: 'health ok (sent 0, queued 0, active 0)' },
      { platform: 'CBE', ok: true, line: 'webhook health ok' }
    ],
    founder: null
  };
}

test('zero-activity day: subject says 0 actions, block says nothing needs you, numbers appear once', () => {
  const out = digest.buildDigest(quietDay());
  assert.strictEqual(out.subject, 'Platforms daily — 2026-09-09 — 0 actions required');
  assert.strictEqual(out.actionCount, 0);
  assert.match(out.html, /Nothing needs you today\./);
  assert.strictEqual(out.html.split('id="pipeline-numbers"').length - 1, 1, 'numbers table must render exactly once');
  assert.match(out.html, /0 active campaigns with 4729 queued/);
  for (const p of ['ACC', 'LAW', 'INV', 'CBE']) assert.match(out.html, new RegExp(`<strong>${p}</strong>: `));
  assert.match(out.text, /Nothing needs you today\./);
  assert.doesNotMatch(out.html, /Monday: founder-outreach/);
});

test('busy day: subject counts every action, blocks render in order with name, province, service, age', () => {
  const out = digest.buildDigest(busyDay());
  assert.strictEqual(out.subject, 'Platforms daily — 2026-09-09 — 7 actions required');
  assert.strictEqual(out.actionCount, 7);
  assert.doesNotMatch(out.html, /Nothing needs you today/);

  const html = out.html;
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at('1. Action required') < at('Removal / correction requests'), 'action block first');
  assert.ok(at('Removal / correction requests') < at('Real failures'));
  assert.ok(at('Real failures') < at('New client requests (24h)'));
  assert.ok(at('New client requests (24h)') < at('2. Numbers'));
  assert.ok(at('2. Numbers') < at('3. Quiet'));

  assert.match(html, /jane\.doe@firm\.ca to support@canadaaccountants\.app: "Please remove my profile" \(5h ago\)/);
  assert.match(html, /Priya &lt;Sharma&gt;, ON, tax_planning \(2h ago, via friction form\)/, 'user-supplied text is escaped');
  assert.match(html, /<strong>LAW<\/strong> \(no name\), province unknown, estate \(20h ago/);
  assert.match(html, /Marc Tremblay, Cabinet Tremblay, QC \(professional\): marc@cabinet\.qc\.ca \(submitted 30h ago\)/);
  assert.match(html, /<strong>INV<\/strong>: webhook health: INV: health status=fail/);
  assert.match(html, /\[breakdown pending approval\]/);
  assert.strictEqual(html.split('id="pipeline-numbers"').length - 1, 1);
});

test('one action pluralises as "1 action required"', () => {
  const data = quietDay();
  data.actions.failures.push({ platform: 'ACC', message: 'health check failed: timeout' });
  assert.strictEqual(digest.buildDigest(data).subject, 'Platforms daily — 2026-09-09 — 1 action required');
});

test('Monday edition folds the founder list in as a collapsed details block', () => {
  const data = quietDay();
  data.now = MONDAY;
  data.founder = { html: '<table id="founder-list"></table>', total: 20, autoSendPaused: true };
  const out = digest.buildDigest(data);
  assert.strictEqual(out.subject, 'Platforms daily — 2026-09-07 — 0 actions required');
  assert.match(out.html, /<details[^>]*>\s*<summary[^>]*>Monday: founder-outreach candidates \(20\) · auto-send paused<\/summary>/);
  assert.match(out.html, /id="founder-list"/);
});

test('isRemovalRequest matches the removal / correction vocabulary in subject or body, whole-word', () => {
  const yes = [
    { subject: 'Remove my listing', body_text: '' },
    { subject: '', body_text: 'I did not authorize this. Please cease publishing it.' },
    { subject: 'Demande de retrait', body_text: 'Merci de retirer mon profil.' },
    { subject: 'Profile issue', body_text: 'The bio is misgendering me and is inaccurate.' },
    { subject: 'Unauthorized use of my name', body_text: '' }
  ];
  const no = [
    { subject: 'Question about pricing', body_text: 'How much is the professional tier?' },
    { subject: 'Removable media policy', body_text: 'unrelated word boundary' },
    { subject: '', body_text: '' },
    {}
  ];
  yes.forEach(m => assert.strictEqual(digest.isRemovalRequest(m), true, JSON.stringify(m)));
  no.forEach(m => assert.strictEqual(digest.isRemovalRequest(m), false, JSON.stringify(m)));
});

test('removal alert carries the [REMOVAL REQUEST] prefix, platform, and a 3-business-day due date', () => {
  // Friday 2026-09-11 14:00 Toronto: three business days later is Wednesday 2026-09-16.
  const friday = new Date('2026-09-11T18:00:00Z');
  const alert = digest.buildRemovalAlert({
    from_email: 'jane@firm.ca', to_email: 'support@canadalawyers.app', subject: 'Retrait de profil',
    body_text: 'Bonjour, <b>merci</b> de retirer mon profil.', received_at: friday.toISOString()
  }, friday);
  assert.strictEqual(alert.subject, '[REMOVAL REQUEST] LAW: Retrait de profil');
  assert.match(alert.html, /due by 2026-09-16/);
  assert.match(alert.html, /&lt;b&gt;merci&lt;\/b&gt;/, 'body is escaped');
  assert.match(alert.text, /due 2026-09-16/);
  assert.strictEqual(digest.businessDaysFrom(friday, 3), '2026-09-16');
});

test('formatAge renders minutes, hours, and days', () => {
  const now = WEDNESDAY;
  assert.strictEqual(digest.formatAge(new Date(now - 5 * 60000).toISOString(), now), '5m ago');
  assert.strictEqual(digest.formatAge(new Date(now - 7 * 3600000).toISOString(), now), '7h ago');
  assert.strictEqual(digest.formatAge(new Date(now - 3 * 86400000).toISOString(), now), '3d ago');
  assert.strictEqual(digest.formatAge(null, now), 'unknown age');
});

// Mock pool for collectLocalFeed / collectDigestData: routes by table name.
function mockPool(rowsByTable) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      for (const [table, rows] of Object.entries(rowsByTable)) {
        if (sql.includes(`FROM ${table}`)) {
          if (rows instanceof Error) return Promise.reject(rows);
          return Promise.resolve({ rows, rowCount: rows.length });
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
  };
}

test('collectLocalFeed splits support@ mail into removal requests vs inbound needing a human, and reports a failing table', async () => {
  const h = (hours) => new Date(WEDNESDAY.getTime() - hours * 3600 * 1000).toISOString();
  const pool = mockPool({
    inbound_messages: [
      { id: 1, platform: 'acc', from_email: 'a@x.ca', to_email: 'support@canadaaccountants.app', subject: 'Please remove me from the directory', body_text: '', received_at: h(3), classification_status: 'manual_review', classification_decision: 'manual' },
      { id: 2, platform: 'law', from_email: 'b@x.ca', to_email: 'support@canadalawyers.app', subject: 'Billing question', body_text: 'How do I upgrade?', received_at: h(4), classification_status: 'manual_review', classification_decision: 'manual' },
      { id: 3, platform: 'acc', from_email: 'c@x.ca', to_email: 'arthur@canadaaccountants.app', subject: 'Re: hello', body_text: 'Long reply that mentions a breakdown '.repeat(20), received_at: h(6), classification_status: 'manual_review', classification_decision: 'manual' },
      { id: 4, platform: 'acc', from_email: 'd@x.ca', to_email: 'arthur@canadaaccountants.app', subject: 'in', body_text: 'in', received_at: h(7), classification_status: 'classified', classification_decision: 'touch7_in' }
    ],
    cpa_applications: [{ id: 9, full_name: 'Marc Tremblay', email: 'marc@cabinet.qc.ca', firm_name: 'Cabinet', province: 'QC', pricing_tier: 'professional', submitted_at: h(30) }],
    sme_friction_requests: [{ name: 'Priya', province: 'ON', service: 'tax_planning', created_at: h(2) }],
    contact_submissions: new Error('relation "contact_submissions" does not exist'),
    inbound_poll_status: [{ last_poll_at: h(0.05), last_poll_status: 'ok', consecutive_failures: 0 }],
    sequence_pause: []
  });
  const feed = await digest.collectLocalFeed(pool, h(24), { now: WEDNESDAY });
  assert.strictEqual(feed.platform, 'ACC');
  assert.deepStrictEqual(feed.removal_requests.map(r => r.fromEmail), ['a@x.ca']);
  assert.deepStrictEqual(feed.inbound_needing_human.map(m => [m.platform, m.reason]), [['LAW', 'support@'], ['ACC', 'manual review'], ['ACC', 'Touch 7 acceptance']]);
  assert.strictEqual(feed.client_requests.length, 1);
  assert.strictEqual(feed.client_requests[0].source, 'friction form');
  assert.strictEqual(feed.applications_awaiting_payment[0].name, 'Marc Tremblay');
  assert.strictEqual(feed.failures.length, 1);
  assert.match(feed.failures[0].message, /contact submissions query failed: relation "contact_submissions" does not exist/);
  assert.strictEqual(feed.crons.poller_status, 'ok');
  assert.strictEqual(feed.crons.gate_paused, false);
});

test('collectDigestData on a Monday: peers merged, real failures flagged, founder list attached, quiet lines per platform', async () => {
  const h = (hours) => new Date(MONDAY.getTime() - hours * 3600 * 1000).toISOString();
  const pool = mockPool({
    inbound_poll_status: [{ last_poll_at: h(0.05), last_poll_status: 'ok', consecutive_failures: 0 }],
    sequence_pause: [{ '?column?': 1 }]
  });
  const data = await digest.collectDigestData({
    pool,
    now: MONDAY,
    fetchPeerFeed: async (peer) => peer.platform === 'LAW'
      ? {
        platform: 'LAW', client_requests: [{ name: 'Lee', province: 'BC', service: 'estate', created_at: h(1) }], crons: { poller_last_at: h(0.1), classified_24h: 2, gate_paused: false },
        lead_loop: { enabled: true, matches: 2, lawyers_emailed: 6, distinct_lawyers: 5, opened: 3, claimed: 1, responded: 1, bounces: 1, unsubscribes: 0, min_scraped_score: 39, leads_under_three: 0 }
      }
      : { platform: 'INV', notDeployed: true },
    fetchPeerSummary: async (peer) => ({ platform: peer.platform, total: 1, manual_review: 0, pending_breakdowns: peer.platform === 'law' ? [{ recipient_email: 'x@law.ca', replied_at: h(2) }] : [] }),
    collectPipeline: async () => ({
      html: NUMBERS_HTML, notes: ['note-1'],
      failures: [{ platform: 'INV', message: 'health check failed: timeout' }],
      backends: [{ name: 'ACC', ok: true, sent: 1, queued: 2, active: 0 }, { name: 'LAW', ok: true, sent: 0, queued: 0, active: 0 }, { name: 'INV', ok: false, sent: 0, queued: 0, active: 0 }],
      lawRequests: [{ request_id: 'r1', pain_point: 'tax', created_at: h(5) }]
    }),
    webhookCheck: async () => ({ failures: ['CBE: health HTTP 502'], critical: false }),
    founderDigest: async () => ({ html: '<i id="founder"></i>', total: 20 }),
    breakerState: () => ({ zbConsecutiveErrors: 3 })
  });

  assert.strictEqual(data.dateLabel, '2026-09-07');
  // The LAW feed answered, so the demand-attribution fallback (name-less rows) is skipped.
  assert.deepStrictEqual(data.actions.clientRequests.map(c => [c.platform, c.name]), [['LAW', 'Lee']]);
  assert.ok(data.actions.inboundNeedingHuman.some(m => m.platform === 'LAW' && m.reason === 'breakdown pending approval'));
  const failures = data.actions.failures.map(f => `${f.platform}: ${f.message}`);
  assert.ok(failures.some(f => f.startsWith('ACC: deliverability gate has the platform PAUSED')), failures.join(' | '));
  assert.ok(failures.includes('INV: health check failed: timeout'));
  assert.ok(failures.includes('CBE: webhook health: CBE: health HTTP 502'));
  assert.ok(failures.some(f => f.startsWith('ACC: ZeroBounce circuit breaker open (3')));
  assert.strictEqual(data.founder.total, 20);
  assert.deepStrictEqual(data.numbers, { html: NUMBERS_HTML, notes: ['note-1'] });
  const quiet = Object.fromEntries(data.quiet.map(q => [q.platform, q]));
  assert.strictEqual(quiet.INV.ok, false);
  assert.match(quiet.INV.line, /digest feed not deployed yet/);
  assert.match(quiet.LAW.line, /digest feed ok/);
  // Lead loop: the line renders in Quiet, and the bounce is raised as a LAW action.
  assert.match(quiet.LAW.line, /lead loop: 2 matches, 6 lawyers emailed \(5 distinct\), 3 opened, 1 claimed, 1 responded, 1 bounces, 0 unsubscribes, gate 39: 0 lead\(s\) under three recipients/);
  assert.ok(failures.some(f => f.startsWith('LAW: 1 bounce(s) on lead notifications')), failures.join(' | '));
  assert.strictEqual(quiet.LAW.ok, false);

  const out = digest.buildDigest(data);
  assert.match(out.subject, /^Platforms daily — 2026-09-07 — \d+ actions required$/);
  assert.match(out.html, /Monday: founder-outreach candidates \(20\)/);
});

test('LAW demand-attribution fallback is used only while the LAW feed is not deployed', async () => {
  const h = (hours) => new Date(WEDNESDAY.getTime() - hours * 3600 * 1000).toISOString();
  const base = {
    pool: mockPool({}),
    now: WEDNESDAY,
    fetchPeerSummary: async (p) => ({ platform: p.platform, error: 'off' }),
    collectPipeline: async () => ({ html: NUMBERS_HTML, notes: [], failures: [], backends: [], lawRequests: [{ request_id: 'r1', pain_point: 'tax', created_at: h(5) }] })
  };
  const notDeployed = await digest.collectDigestData({ ...base, fetchPeerFeed: async (p) => ({ platform: p.platform, notDeployed: true }) });
  assert.deepStrictEqual(notDeployed.actions.clientRequests.map(c => [c.platform, c.service, c.source]), [['LAW', 'tax', 'friction form (demand-attribution)']]);
  const deployed = await digest.collectDigestData({ ...base, fetchPeerFeed: async (p) => ({ platform: p.platform, client_requests: [], crons: {} }) });
  assert.deepStrictEqual(deployed.actions.clientRequests, []);
});

test('sendDailyDigest and sendRemovalAlert address arthur@negotiateandwin.com through the injected sender', async () => {
  const sent = [];
  const sendEmail = async (args) => { sent.push(args); return { success: true, id: 'x' }; };
  const pool = mockPool({});
  await digest.sendDailyDigest({ pool, now: WEDNESDAY, sendEmail, fetchPeerFeed: async (p) => ({ platform: p.platform, notDeployed: true }), fetchPeerSummary: async (p) => ({ platform: p.platform, error: 'off' }) });
  await digest.sendRemovalAlert({ from_email: 'a@b.ca', to_email: 'support@canadaaccountants.app', subject: 'remove', body_text: '', received_at: WEDNESDAY.toISOString() }, { sendEmail, now: WEDNESDAY });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].to, 'arthur@negotiateandwin.com');
  assert.match(sent[0].subject, /^Platforms daily — 2026-09-09 — /);
  assert.strictEqual(sent[1].to, 'arthur@negotiateandwin.com');
  assert.strictEqual(sent[1].subject, '[REMOVAL REQUEST] ACC: remove');
});
