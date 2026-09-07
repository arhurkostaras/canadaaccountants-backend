// Scheduled-email inventory guard. Arthur's inbox took ~70 platform mails a
// week from ACC alone (nine pipeline monitors a day, Monday founder digest and
// auto-send report, twice-daily inbound summaries, hourly webhook alerts). The
// 2026-09-07 consolidation left exactly one scheduled email (the 07:00 daily
// digest); the [REMOVAL REQUEST] alert is event-driven from the poller, not a
// cron. This test fails loud when a new cron.schedule() lands in server.js so
// the next email-producing schedule has to be a deliberate decision.
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const EXPECTED = [
  '0 9 14 4 *',     // tax-season campaign launch (dated, operational, no email)
  '0 18 28 4 *',    // tax-season campaign end (dated, operational, no email)
  '0 7 * * *',      // THE daily digest, America/Toronto (the only scheduled email)
  '*/5 * * * *',    // inbound IMAP poller (fires the removal alert on ingestion)
  '*/2 * * * *',    // inbound classifier
  '*/30 * * * *',   // deliverability gate
  '*/5 * * * *',    // v2 sequence runner
  '15 * * * *',     // webhook health probe (log-only; failures reach the digest)
];

test('server.js schedules exactly the expected crons (one daily digest email)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const found = [...src.matchAll(/cron\.schedule\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
  const sortedFound = [...found].sort();
  const sortedExpected = [...EXPECTED].sort();
  assert.deepStrictEqual(
    sortedFound,
    sortedExpected,
    `cron.schedule inventory drifted.\nExpected: ${sortedExpected.join(' | ')}\nActual:   ${sortedFound.join(' | ')}\n` +
    'Cause: a schedule was added or removed in server.js.\n' +
    'Fix: if the new schedule emails Arthur, fold it into services/daily-digest.js instead; ' +
    'if it is operational (no email), add it to EXPECTED in tests/cron-inventory.test.js with a comment.'
  );
});

test('the daily digest cron is the only schedule that calls a digest or monitor sender', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const digestCrons = [...src.matchAll(/cron\.schedule\(\s*['"`]([^'"`]+)['"`][^\n]*monitorCronFire/g)].map(m => m[1]);
  assert.deepStrictEqual(digestCrons, ['0 7 * * *'], `expected one digest cron at 07:00, got: ${digestCrons.join(', ')}`);
  assert.ok(/cron\.schedule\('0 7 \* \* \*'[^\n]*timezone: 'America\/Toronto'/.test(src), 'daily digest must be scheduled in America/Toronto');
  assert.doesNotMatch(src, /runPipelineMonitor\(/, 'legacy per-slot monitor sender must not return');
  assert.doesNotMatch(src, /inboundSummary\.sendSummary/, 'twice-daily inbound summary must stay folded into the digest');
});
