// Inbound poller proof. The poller used to download the full source of every
// inbox message from the last 7 days on every 5-minute cycle, which ran into
// Gmail's IMAP bandwidth limit ("Command failed") and, once the connection
// dropped, logged one "Connection not available" error per remaining message.
// These tests run with no network: a fake ImapFlow client stands in for Gmail.
const test = require('node:test');
const assert = require('node:assert');
const poller = require('../services/inbound-poller');

const hdr = (to) => Buffer.from(`Delivered-To: ${to}\r\nTo: ${to}\r\n\r\n`);

function fakeClient(messages) {
  return {
    async *fetch(uids, query) {
      assert.ok(query.headers, 'phase 1 must fetch headers only');
      assert.ok(!query.source, 'phase 1 must not download message sources');
      for (const m of messages) if (uids.includes(m.uid)) yield { uid: m.uid, flags: new Set(m.flags || []), headers: hdr(m.to) };
    },
  };
}

test('phase 1 keeps only undispatched platform mail', async () => {
  const msgs = [
    { uid: 1, to: 'friend@gmail.com' },                                       // personal mail
    { uid: 2, to: 'arthur@canadalawyers.app' },                               // platform, new
    { uid: 3, to: 'arthur@canadainvesting.app', flags: [poller.POLLER_KEYWORD] }, // already dispatched
    { uid: 4, to: 'arthur@canadaaccountants.app' },                           // platform, new
  ];
  const r = await poller._listCandidates(fakeClient(msgs), msgs.map(m => m.uid));
  assert.deepStrictEqual(r.candidates, [2, 4]);
  assert.strictEqual(r.skipped, 2);
});

test('phase 1 with an empty window issues no fetch', async () => {
  const client = { fetch() { throw new Error('should not fetch'); } };
  const r = await poller._listCandidates(client, []);
  assert.deepStrictEqual(r, { candidates: [], skipped: 0 });
});

test('IMAP error detail carries the server response, not just "Command failed"', () => {
  const err = Object.assign(new Error('Command failed'), {
    serverResponseCode: 'OVERQUOTA',
    responseText: 'Account exceeded command or bandwidth limits.',
  });
  const d = poller._imapErrorDetail(err);
  assert.match(d, /Command failed/);
  assert.match(d, /OVERQUOTA/);
  assert.match(d, /bandwidth limits/);
  assert.strictEqual(poller._imapErrorDetail(new Error('plain')), 'plain');
});
