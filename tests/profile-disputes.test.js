// Profile disputes (services/profile-disputes.js, routes/profile-disputes.js,
// migrations/005-profile-disputes.sql).
//
// Two layers:
//   1. Pure checks (always run): input validation, the 410 body, rendered
//      page/email content, and source-text assertions that server.js wires
//      the gate, the sitemap, the directory/search predicate, and the footer.
//   2. Database checks (run when DISPUTE_TEST_DATABASE_URL is set, e.g.
//      postgresql://localhost/dispute_test_law): the real routes on a real
//      express app against a real Postgres. POST hides the profile, writes the
//      dispute, suppresses the address, sends both emails; the gate answers
//      410; the sitemap predicate excludes the row; resolve=restored brings it
//      back; resolve=removed keeps it hidden; rate limit fires.

const fs = require('fs');
const path = require('path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const disputes = require('../services/profile-disputes');
const { createProfileDisputeRoutes } = require('../routes/profile-disputes');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TABLE = disputes.PLATFORM.table;

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

// ---------------------------------------------------------------- pure

test('this copy is the ACC copy', () => {
  assert.strictEqual(disputes.PLATFORM.code, 'ACC');
  assert.strictEqual(TABLE, 'scraped_cpas');
  assert.match(read('migrations/005-profile-disputes.sql'), /ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS dispute_pending/);
});

test('validateDisputeInput: id, reason, email, details', () => {
  const ok = disputes.validateDisputeInput({ profileId: '42', reason: 'remove', details: ' x ', requesterEmail: ' Someone@Example.COM ' });
  assert.deepStrictEqual(ok, { id: 42, reason: 'remove', email: 'someone@example.com', details: 'x' });
  assert.throws(() => disputes.validateDisputeInput({ profileId: 'abc', reason: 'remove', requesterEmail: 'a@b.co' }), /BAD_ID|positive integer/);
  assert.throws(() => disputes.validateDisputeInput({ profileId: '1', reason: 'delete', requesterEmail: 'a@b.co' }), (e) => e.code === 'BAD_REASON');
  assert.throws(() => disputes.validateDisputeInput({ profileId: '1', reason: 'other', requesterEmail: 'not-an-email' }), (e) => e.code === 'BAD_EMAIL');
  assert.throws(() => disputes.validateDisputeInput({ profileId: '1', reason: 'other', requesterEmail: '' }), (e) => e.code === 'BAD_EMAIL');
  assert.throws(() => disputes.validateDisputeInput({ profileId: '1', reason: 'other', requesterEmail: 'a@b.co', details: 'x'.repeat(disputes.MAX_DETAILS + 1) }), (e) => e.code === 'BAD_DETAILS');
  // the requester's address does not have to match the profile's
  assert.strictEqual(disputes.validateDisputeInput({ profileId: '1', reason: 'correct', requesterEmail: 'assistant@otherfirm.ca' }).email, 'assistant@otherfirm.ca');
});

test('hiddenReason and VISIBLE_SQL agree on what hidden means', () => {
  assert.strictEqual(disputes.hiddenReason({ dispute_pending: false, removed_at: null }), null);
  assert.strictEqual(disputes.hiddenReason({ dispute_pending: true, removed_at: null }), 'dispute_pending');
  assert.strictEqual(disputes.hiddenReason({ dispute_pending: false, removed_at: new Date() }), 'removed');
  assert.strictEqual(disputes.hiddenReason({ dispute_pending: true, removed_at: new Date() }), 'removed');
  assert.strictEqual(disputes.VISIBLE_SQL, '(removed_at IS NULL AND dispute_pending = false)');
  assert.strictEqual(disputes.visibleSql('p.'), '(p.removed_at IS NULL AND p.dispute_pending = false)');
});

test('410 body for a hidden profile carries no personal data', () => {
  const row = { id: 7, first_name: 'Gill', last_name: 'Fruchter', full_name: 'Gill Fruchter', dispute_pending: true, removed_at: null };
  const res = mockRes();
  disputes.sendGone(res, 'Test', row);
  assert.strictEqual(res.statusCode, 410);
  assert.strictEqual(res.body.code, 'PROFILE_REMOVED');
  assert.doesNotMatch(JSON.stringify(res.body), /Gill|Fruchter/);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store', 'a pending dispute may be restored: do not cache');
  const res2 = mockRes();
  disputes.sendGone(res2, 'Test', { ...row, removed_at: new Date() });
  assert.match(res2.headers['Cache-Control'], /max-age=86400/);
  assert.match(res2.body.message, /will not be re-listed/);
});

test('dispute page: name + form when visible, no form once removed', () => {
  const row = { id: 7, first_name: 'Gill', last_name: 'Fruchter', firm_name: 'Fruchter Law', city: 'Toronto', province: 'ON', dispute_pending: false, removed_at: null };
  const html = disputes.renderDisputePage({ profile: row });
  assert.match(html, /Gill Fruchter/);
  assert.match(html, /<form method="POST" action="[^"]*\/api\/profiles\/7\/dispute"/);
  for (const r of Object.keys(disputes.REASONS)) assert.match(html, new RegExp(`name="reason" value="${r}"`));
  assert.match(html, /name="email" type="email" required/);
  assert.match(html, /three business days/);
  assert.match(html, /noindex/);
  const removed = disputes.renderDisputePage({ profile: { ...row, removed_at: new Date() } });
  assert.doesNotMatch(removed, /<form/);
  assert.doesNotMatch(removed, /Gill|Fruchter/, 'a removed profile is not named on the form page');
  const withErr = disputes.renderDisputePage({ profile: row, error: 'Bad <email>', values: { reason: 'correct', email: 'x@y.z' } });
  assert.match(withErr, /Bad &lt;email&gt;/);
  assert.match(withErr, /value="correct" required checked/);
});

test('acknowledgement promises a decision within three business days; alert is tagged [REMOVAL REQUEST]', () => {
  const dispute = { id: 12, reason: 'not_private_practice', details: 'I retired in 2019.', requester_email: 'req@example.com', requester_ip: '1.2.3.4', created_at: new Date('2026-09-07T12:00:00Z') };
  const profile = { id: 7, first_name: 'Gill', last_name: 'Fruchter', firm_name: 'Fruchter Law', city: 'Toronto', province: 'ON', claim_status: null };
  const ack = disputes.ackEmail({ dispute, profile });
  assert.match(ack.subject, /D-12/);
  assert.match(ack.text, /three business days/);
  assert.match(ack.html, /hidden from public view/);
  const alert = disputes.alertEmail({ dispute, profile, suppressed: [{ email: 'gill@fruchterlaw.ca', inserted: true }], alreadyHidden: null });
  assert.ok(alert.subject.startsWith('[REMOVAL REQUEST] ACC D-12'), alert.subject);
  assert.match(alert.text, /Requester: req@example.com from 1\.2\.3\.4/);
  assert.match(alert.text, /I retired in 2019\./);
  assert.match(alert.text, /\/api\/admin\/disputes\/12\/resolve/);
  assert.match(alert.text, /gill@fruchterlaw\.ca/);
});

test('server.js wires the gate, sitemap, listings, boot migration, and routes', () => {
  const src = read('server.js');
  assert.ok(src.includes("require('./services/profile-disputes')"), 'service required');
  assert.ok(src.includes('profileDisputes.ensureSchema(pool)'), 'migration applied at boot');
  const umbrella = src.indexOf("app.use('/api/admin', authenticateToken, requireAdmin);");
  const mount = src.indexOf('createProfileDisputeRoutes({');
  assert.ok(umbrella > 0 && mount > umbrella, 'dispute router mounted after the /api/admin umbrella');
  assert.ok(src.includes('adminAuth: [authenticateToken, requireAdmin]'), 'admin routes get the middlewares explicitly');

  // public profile route: SELECT includes the flags, gate runs before the misclassified gate
  const routeIdx = src.indexOf("app.get('/api/profiles/:id'");
  const selectIdx = src.indexOf('FROM scraped_cpas WHERE id = $1', routeIdx);
  const gateIdx = src.indexOf('profileDisputes.hiddenReason(rows[0])', routeIdx);
  const oldGateIdx = src.indexOf('rows[0].is_misclassified === true', routeIdx);
  assert.ok(routeIdx > 0 && selectIdx > routeIdx && gateIdx > selectIdx && gateIdx < oldGateIdx, '/api/profiles/:id dispute gate sits at the existing 410 gate');
  assert.match(src.slice(routeIdx, selectIdx), /collision_count, dispute_pending, removed_at/);

  // claim-by-token route
  const claimIdx = src.indexOf("app.get('/api/claim/profile/:refToken'");
  const claimGate = src.indexOf("profileDisputes.sendGone(res, 'Claim Profile', p)", claimIdx);
  assert.ok(claimIdx > 0 && claimGate > claimIdx && claimGate < routeIdx, 'claim route gated');

  // sitemap and listings
  const sitemapIdx = src.indexOf("app.get('/api/sitemap-profiles.xml'");
  const sitemapEnd = src.indexOf('</urlset>', sitemapIdx);
  assert.match(src.slice(sitemapIdx, sitemapEnd), /AND \$\{profileDisputes\.VISIBLE_SQL\}/, 'sitemap excludes hidden rows');
  // sitemap count + rows (2), directory city (2), province (3), designation (2), search (1), related (1)
  const listingUses = (src.match(/AND \$\{profileDisputes\.VISIBLE_SQL\}/g) || []).length;
  assert.strictEqual(listingUses, 11, `every public listing query carries the dispute predicate (found ${listingUses})`);
  for (const route of ["app.get('/api/directory/city/:city'", "app.get('/api/directory/:province'", "app.get('/api/directory/:province/:designation'", "app.get('/api/professionals/search'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} exists`);
    assert.ok(src.slice(at, at + 2500).includes('${profileDisputes.VISIBLE_SQL}'), `${route} filters hidden rows`);
  }
  const relatedIdx = src.indexOf('Related profiles for internal SEO linking');
  assert.match(src.slice(relatedIdx, relatedIdx + 600), /AND \$\{profileDisputes\.VISIBLE_SQL\}/, 'related profiles exclude hidden rows');
});

test('every professional-facing footer carries the dispute link and every send path fills it', () => {
  const tpl = read('utils/email-template.js');
  assert.match(tpl, /href="\{\{dispute_url\}\}"[^>]*>Correct or remove this profile</);
  const outreach = read('services/outreach.js');
  assert.match(outreach, /vars\.dispute_url = profileDisputes\.disputeUrl\(emailRecord\.recipient_id\)/);
  const engine = read('services/render-engine.js');
  assert.ok(engine.includes('out.replace(/\\{\\{dispute_url\\}\\}/g, profileDisputes.disputeUrl(context.profileId))'), 'render engine fills {{dispute_url}}');
  const runner = read('services/sequence-runner-v2.js');
  assert.match(runner, /profileId: recipient\.id/);
  const src = read('server.js');
  assert.ok(src.includes('.replace(/\\{\\{dispute_url\\}\\}/g, profileDisputes.disputeUrl(emailRow.recipient_id))'), 'direct-send fills {{dispute_url}}');
  assert.match(disputes.disputeUrl(99), /\/api\/profiles\/99\/dispute$/);
});

test('migration is idempotent by construction and constrains reason/resolution', () => {
  const sql = read('migrations/005-profile-disputes.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS profile_disputes/);
  assert.match(sql, /CHECK \(reason IN \('remove', 'correct', 'not_private_practice', 'other'\)\)/);
  assert.match(sql, /CHECK \(resolution IS NULL OR resolution IN \('removed', 'corrected', 'restored'\)\)/);
  assert.match(sql, /\(\(resolved_at IS NULL\) = \(resolution IS NULL\)\)/);
  assert.deepStrictEqual(Object.keys(disputes.REASONS), ['remove', 'correct', 'not_private_practice', 'other']);
  assert.deepStrictEqual(disputes.RESOLUTIONS, ['removed', 'corrected', 'restored']);
});

// ---------------------------------------------------------------- database

const DB_URL = process.env.DISPUTE_TEST_DATABASE_URL;

describe('against Postgres', { skip: DB_URL ? false : 'set DISPUTE_TEST_DATABASE_URL (e.g. postgresql://localhost/dispute_test_law) to run' }, () => {
  const { Pool } = require('pg');
  let pool, server, base, sent, firstId;

  const sendEmail = async (args) => { sent.push(args); return { success: true, id: `resend-${sent.length}` }; };

  function app(extraRouterOpts = {}) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json());
    a.use(createProfileDisputeRoutes({ getPool: () => pool, sendEmail, adminAuth: [(req, _res, next) => { req.user = { email: 'admin@test' }; next(); }], logger: { warn() {}, error: console.error }, ...extraRouterOpts }));
    return a;
  }

  async function post(id, body, { json = false, headers = {} } = {}) {
    const r = await fetch(`${base}/api/profiles/${id}/dispute`, {
      method: 'POST',
      headers: json ? { 'content-type': 'application/json', ...headers } : { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
    const text = await r.text();
    return { status: r.status, text, json: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  }

  async function row(id) {
    return (await pool.query(`SELECT id, dispute_pending, removed_at FROM ${TABLE} WHERE id = $1`, [id])).rows[0];
  }

  // Mirrors the sitemap query in server.js (same flags, same predicate).
  async function inSitemap(id) {
    const r = await pool.query(
      `SELECT id FROM ${TABLE}
        WHERE status != 'invalid'
          AND COALESCE(is_misclassified, false) = false
          AND COALESCE(has_enrichment_collision, false) = false
          AND COALESCE(is_generic_inbox, false) = false
          AND ${disputes.VISIBLE_SQL}
          AND id = $1`, [id]);
    return r.rows.length === 1;
  }

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await pool.query(`DROP TABLE IF EXISTS profile_disputes; DROP TABLE IF EXISTS outreach_unsubscribes; DROP TABLE IF EXISTS ${TABLE};`);
    await pool.query(`CREATE TABLE ${TABLE} (
      id SERIAL PRIMARY KEY, first_name VARCHAR(255), last_name VARCHAR(255), full_name VARCHAR(500), firm_name VARCHAR(500),
      city VARCHAR(255), province VARCHAR(100), designation VARCHAR(100), email VARCHAR(255), enriched_email VARCHAR(255),
      claim_status VARCHAR(50), status VARCHAR(50) DEFAULT 'active', is_misclassified BOOLEAN, has_enrichment_collision BOOLEAN,
      is_generic_inbox BOOLEAN, collision_count INTEGER, generated_bio TEXT)`);
    await pool.query(`CREATE TABLE outreach_unsubscribes (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, unsubscribe_token VARCHAR(255), reason TEXT, unsubscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await disputes.ensureSchema(pool);
    await disputes.ensureSchema(pool);   // idempotent
    await pool.query(`INSERT INTO ${TABLE} (first_name, last_name, full_name, firm_name, city, province, designation, email, enriched_email)
      VALUES ('Taylor', 'Minato', 'Taylor Minato', 'Minato Law', 'Regina', 'SK', 'Lawyer', 'Taylor@MinatoLaw.ca', 'taylor@minatolaw.ca'),
             ('Decoy', 'Person', 'Decoy Person', NULL, 'Regina', 'SK', 'Lawyer', 'decoy@example.ca', NULL)`);
    sent = [];
    server = app().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) server.close();
    if (pool) await pool.end();
  });

  test('schema: flags default to visible, dispute table constrained', async () => {
    assert.deepStrictEqual(await row(1), { id: 1, dispute_pending: false, removed_at: null });
    await assert.rejects(pool.query(`INSERT INTO profile_disputes (profile_id, reason, requester_email) VALUES (1, 'delete', 'a@b.co')`), /profile_disputes_reason_chk/);
    await assert.rejects(pool.query(`INSERT INTO profile_disputes (profile_id, reason, requester_email, resolution) VALUES (1, 'remove', 'a@b.co', 'removed')`), /profile_disputes_resolved_pair_chk/);
  });

  test('GET form renders the display name and the form', async () => {
    const r = await fetch(`${base}/api/profiles/1/dispute`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /Taylor Minato/);
    assert.match(html, /Minato Law, Regina, SK/);
    assert.match(html, /<form method="POST"/);
    assert.strictEqual((await fetch(`${base}/api/profiles/999999/dispute`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/profiles/abc/dispute`)).status, 400);
  });

  test('POST rejects a malformed email and an unknown reason without touching the row', async () => {
    const bad = await post(1, { reason: 'remove', email: 'nope', details: '' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.text, /valid email address/);
    assert.match(bad.text, /Taylor Minato/, 'form re-rendered with the name');
    const badJson = await post(1, { reason: 'purge', email: 'a@b.co' }, { json: true });
    assert.strictEqual(badJson.status, 400);
    assert.strictEqual(badJson.json.code, 'BAD_REASON');
    assert.deepStrictEqual(await row(1), { id: 1, dispute_pending: false, removed_at: null });
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM profile_disputes')).rows[0].n, 0);
    assert.strictEqual(sent.length, 0);
  });

  test('POST hides the profile, writes the dispute, suppresses the address, sends ack + alert', async () => {
    const r = await post(1, { reason: 'not_private_practice', details: 'Retired <2019>', email: 'Assistant@OtherFirm.ca' });
    assert.strictEqual(r.status, 201);
    assert.match(r.text, /Request received/);
    assert.match(r.text, /Reference D-\d+/);
    assert.match(r.text, /assistant@otherfirm\.ca/);
    firstId = parseInt(r.text.match(/Reference D-(\d+)/)[1], 10);

    assert.deepStrictEqual(await row(1), { id: 1, dispute_pending: true, removed_at: null });
    assert.deepStrictEqual(await row(2), { id: 2, dispute_pending: false, removed_at: null }, 'other rows untouched');
    const d = (await pool.query('SELECT * FROM profile_disputes WHERE id = $1', [firstId])).rows[0];
    assert.strictEqual(d.profile_id, 1);
    assert.strictEqual(d.reason, 'not_private_practice');
    assert.strictEqual(d.details, 'Retired <2019>');
    assert.strictEqual(d.requester_email, 'assistant@otherfirm.ca');
    assert.ok(d.requester_ip, 'ip recorded');
    assert.strictEqual(d.resolved_at, null);
    const sup = (await pool.query('SELECT email, reason FROM outreach_unsubscribes ORDER BY email')).rows;
    assert.deepStrictEqual(sup, [{ email: 'taylor@minatolaw.ca', reason: 'dispute' }], 'both spellings of the row address collapse to one suppression, reason=dispute');

    assert.strictEqual(sent.length, 2);
    const [ack, alert] = sent;
    assert.strictEqual(ack.to, 'assistant@otherfirm.ca');
    assert.match(ack.subject, new RegExp(`D-${firstId}`));
    assert.match(ack.text, /three business days/);
    assert.strictEqual(alert.to, disputes.PLATFORM.adminEmail);
    assert.ok(alert.subject.startsWith(`[REMOVAL REQUEST] ACC D-${firstId}`), alert.subject);
    assert.match(alert.text, /Retired <2019>/);
    assert.strictEqual(alert.replyTo, 'assistant@otherfirm.ca');
  });

  test('after POST: the 410 gate fires and the sitemap predicate excludes the row', async () => {
    const r = await disputes.getProfile(pool, 1);
    assert.strictEqual(disputes.hiddenReason(r), 'dispute_pending');
    const res = mockRes();
    disputes.sendGone(res, 'Public Profile', r);
    assert.strictEqual(res.statusCode, 410);
    assert.doesNotMatch(JSON.stringify(res.body), /Minato/);
    assert.strictEqual(await inSitemap(1), false);
    assert.strictEqual(await inSitemap(2), true);
    const dirQ = await pool.query(`SELECT id FROM ${TABLE} WHERE city ILIKE $1 AND designation IN ('Lawyer','Barrister','Partner','Counsel') AND ${disputes.VISIBLE_SQL} ORDER BY id`, ['%Regina%']);
    assert.deepStrictEqual(dirQ.rows.map((x) => x.id), [2], 'directory-style query drops the hidden row');
    const form = await (await fetch(`${base}/api/profiles/1/dispute`)).text();
    assert.match(form, /already hidden/);
    assert.doesNotMatch(form, /Taylor Minato/, 'hidden profile is not named on the form page');
  });

  test('admin list shows the open dispute; resolve=restored brings the profile back', async () => {
    const list = await (await fetch(`${base}/api/admin/disputes`)).json();
    assert.strictEqual(list.count, 1);
    assert.strictEqual(list.disputes[0].id, firstId);
    assert.strictEqual(list.disputes[0].profile.display_name, 'Taylor Minato');
    assert.strictEqual(list.disputes[0].profile.hidden, 'dispute_pending');

    const r = await fetch(`${base}/api/admin/disputes/${firstId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'restored' }) });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.visible, true);
    assert.strictEqual(body.dispute.resolution, 'restored');
    assert.strictEqual(body.dispute.resolved_by, 'admin@test');
    assert.deepStrictEqual(await row(1), { id: 1, dispute_pending: false, removed_at: null });
    assert.strictEqual(await inSitemap(1), true);
    assert.strictEqual(disputes.hiddenReason(await disputes.getProfile(pool, 1)), null);
    assert.strictEqual((await (await fetch(`${base}/api/admin/disputes`)).json()).count, 0);

    const again = await fetch(`${base}/api/admin/disputes/${firstId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'removed' }) });
    assert.strictEqual(again.status, 409, 'a resolved dispute cannot be resolved twice');
    const badRes = await fetch(`${base}/api/admin/disputes/${firstId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'deleted' }) });
    assert.strictEqual(badRes.status, 400);
    assert.strictEqual((await fetch(`${base}/api/admin/disputes/999999/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'removed' }) })).status, 404);
  });

  test('resolve=removed hides permanently; a second open dispute keeps the row hidden through a corrected resolution', async () => {
    const a = await post(1, { reason: 'remove', email: 'taylor@minatolaw.ca' }, { json: true });
    assert.strictEqual(a.status, 201);
    const b = await post(1, { reason: 'correct', email: 'colleague@minatolaw.ca', details: 'wrong firm' }, { json: true });
    assert.strictEqual(b.status, 201);
    assert.ok(a.json.dispute_id > firstId && b.json.dispute_id > a.json.dispute_id);
    assert.deepStrictEqual(a.json.emails, { acknowledgement: true, alert: true });

    // resolve the correction first: the removal request is still open, so the row stays hidden
    let r = await (await fetch(`${base}/api/admin/disputes/${b.json.dispute_id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'corrected' }) })).json();
    assert.strictEqual(r.other_open, 1);
    assert.strictEqual(r.visible, false);
    assert.deepStrictEqual(await row(1), { id: 1, dispute_pending: true, removed_at: null });

    r = await (await fetch(`${base}/api/admin/disputes/${a.json.dispute_id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'removed' }) })).json();
    assert.strictEqual(r.visible, false);
    const after = await row(1);
    assert.strictEqual(after.dispute_pending, false);
    assert.ok(after.removed_at instanceof Date, 'removed_at set');
    assert.strictEqual(disputes.hiddenReason(after), 'removed');
    assert.strictEqual(await inSitemap(1), false);
    const form = await (await fetch(`${base}/api/profiles/1/dispute`)).text();
    assert.match(form, /already been removed/);
    assert.doesNotMatch(form, /<form/);
    // fresh app: the shared one has used its 5-per-hour POST allowance by now
    const fresh = app().listen(0);
    await new Promise((r) => fresh.once('listening', r));
    try {
      const gone = await fetch(`http://127.0.0.1:${fresh.address().port}/api/profiles/1/dispute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'remove', email: 'x@y.ca' }) });
      assert.strictEqual(gone.status, 201, 'a further request on a removed profile is still recorded');
      assert.strictEqual((await row(1)).removed_at instanceof Date, true, 'and removed_at stays set');
    } finally {
      fresh.close();
    }
  });

  test('POST is rate-limited per IP', async () => {
    const limited = app().listen(0);
    await new Promise((r) => limited.once('listening', r));
    const b = `http://127.0.0.1:${limited.address().port}`;
    try {
      const statuses = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${b}/api/profiles/2/dispute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'other', email: `r${i}@example.ca` }) });
        statuses.push(r.status);
      }
      assert.deepStrictEqual(statuses, [201, 201, 201, 201, 201, 429]);
    } finally {
      limited.close();
    }
  });
});
