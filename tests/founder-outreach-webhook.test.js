// Proof that bounce/complaint webhook events for founder-outreach sends reach
// the suppression list. Founder sends have no campaign-table row, so the
// engine's primary lookup misses; _handleFounderOutreachEvent must catch the
// resend id in founder_outreach_log, stamp the row, and suppress the address.
const test = require('node:test');
const assert = require('node:assert');
const { OutreachEngine } = require('../services/outreach');

function mockPool({ founderRow } = {}) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      if (/FROM founder_outreach_log WHERE resend_id/.test(sql)) {
        return Promise.resolve({ rows: founderRow ? [founderRow] : [] });
      }
      // campaign-table lookup (outreach_emails on ACC/LAW, outreach_recipients on INV): no match
      return Promise.resolve({ rows: [] });
    },
  };
}

function bounceEvent(type, id) {
  return { type, data: { email_id: id } };
}

test('bounced founder send: log row stamped, address suppressed lowercase', async () => {
  const pool = mockPool({ founderRow: { id: 7, recipient_email: 'Bounce@Firm.CA' } });
  const engine = new OutreachEngine(pool);
  await engine.handleResendWebhook(bounceEvent('email.bounced', 'resend-abc'));
  const update = pool.calls.find(c => /UPDATE founder_outreach_log SET status/.test(c.sql));
  assert.ok(update, 'expected founder_outreach_log status update');
  assert.deepStrictEqual(update.params, [7, 'bounced']);
  const insert = pool.calls.find(c => /INSERT INTO outreach_unsubscribes/.test(c.sql));
  assert.ok(insert, 'expected suppression insert');
  assert.strictEqual(insert.params[0], 'bounce@firm.ca');
  assert.strictEqual(insert.params[1], 'bounced');
});

test('complained founder send is suppressed too', async () => {
  const pool = mockPool({ founderRow: { id: 9, recipient_email: 'c@firm.ca' } });
  const engine = new OutreachEngine(pool);
  await engine.handleResendWebhook(bounceEvent('email.complained', 'resend-def'));
  assert.ok(pool.calls.some(c => /INSERT INTO outreach_unsubscribes/.test(c.sql)));
});

test('opened event for a founder send does not suppress or stamp', async () => {
  const pool = mockPool({ founderRow: { id: 7, recipient_email: 'x@firm.ca' } });
  const engine = new OutreachEngine(pool);
  await engine.handleResendWebhook(bounceEvent('email.opened', 'resend-ghi'));
  assert.ok(!pool.calls.some(c => /UPDATE founder_outreach_log/.test(c.sql)));
  assert.ok(!pool.calls.some(c => /INSERT INTO outreach_unsubscribes/.test(c.sql)));
});

test('bounce with no founder log row is a no-op', async () => {
  const pool = mockPool({});
  const engine = new OutreachEngine(pool);
  await engine.handleResendWebhook(bounceEvent('email.bounced', 'resend-unknown'));
  assert.ok(!pool.calls.some(c => /INSERT INTO outreach_unsubscribes/.test(c.sql)));
});
