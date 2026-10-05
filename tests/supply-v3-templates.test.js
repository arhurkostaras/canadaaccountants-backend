// Contract tests for templates/supply_v3_3touch.json, the three-touch supply
// sequence for all four platforms (each backend's scripts/load-templates.js
// loads only its own platform's rows from the shared file).
//
// The v2 renderer runs in strict mode: any {{tag}} it does not know throws
// RenderOrphanError and halts the enrollment. Merge tags differ per backend,
// so each platform's rows are checked against that backend's resolvable set.
// ACC rows are additionally rendered through the real ACC render engine.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROWS = require(path.join(__dirname, '..', 'templates', 'supply_v3_3touch.json'));

// Resolvable tags per backend, from each repo's services/render-engine.js,
// services/founding-cohort.js and services/profile-tags.js (2026-10-05).
// CBE's render engine has no {{dispute_url}} handler.
const COMMON = ['first_name', 'province', 'unsubscribe_url', 'founding_filled', 'founding_cap',
  'founding_remaining', 'pricing_lock_months', 'firm_name_or_designation',
  'designation_or_firm_type', 'geography'];
const TAGS = {
  acc: [...COMMON, 'dispute_url'],
  law: [...COMMON, 'dispute_url', 'practice_area', 'practice_area_or_service_line'],
  inv: [...COMMON, 'dispute_url', 'specialization'],
  cbe: [...COMMON, 'sector_or_size_bracket'],
};

// Retired pitch lines, BP-009 claim classes, and words law societies restrict.
const BANNED = [/before clients see/i, /claim your profile in one click/i, /AI-generated/i,
  /just viewed/i, /guarantee/i, /\bspecialist/i, /\bexpert/i, /\bbest (lawyer|cpa|advisor)/i];

const tagsIn = s => [...String(s || '').matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
const fields = r => [r.subject_a, r.subject_b, r.body_text, r.body_html].filter(Boolean);

test('one default row per platform per touch, three touches', () => {
  for (const p of Object.keys(TAGS)) {
    const touches = ROWS.filter(r => r.platform === p).map(r => r.touch_number).sort();
    assert.deepStrictEqual(touches, [1, 2, 3], p);
  }
  for (const r of ROWS) {
    assert.strictEqual(r.sequence, 'supply_v3_3touch');
    assert.strictEqual(r.variant, 'default');
    assert.strictEqual(r.is_lite, false);
  }
});

test('every merge tag resolves on its own backend', () => {
  for (const r of ROWS) {
    for (const f of fields(r)) {
      for (const t of tagsIn(f)) {
        assert.ok(TAGS[r.platform].includes(t), `${r.platform} T${r.touch_number}: {{${t}}} is not resolvable on that backend`);
      }
    }
  }
});

test('text and html carry the same tags, and both carry a one-click unsubscribe', () => {
  for (const r of ROWS) {
    const t = new Set(tagsIn(r.body_text)), h = new Set(tagsIn(r.body_html));
    assert.deepStrictEqual([...t].sort(), [...h].sort(), `${r.platform} T${r.touch_number}`);
    assert.ok(t.has('unsubscribe_url'), `${r.platform} T${r.touch_number} text`);
  }
});

test('no banned phrasing and no hard-coded figures in copy', () => {
  for (const r of ROWS) {
    for (const f of fields(r)) {
      for (const re of BANNED) assert.ok(!re.test(f), `${r.platform} T${r.touch_number} matches ${re}`);
      // Numbers must come from merge tags (live data), never be typed into copy.
      const visible = f.replace(/\{\{[^}]+\}\}/g, '').replace(/https:\/\/\S+/g, '').replace(/<[^>]+>/g, '');
      assert.ok(!/\d/.test(visible), `${r.platform} T${r.touch_number} has a hard-coded figure`);
    }
  }
});

test('subject_b (founding-scarcity line) appears only on the founding touch', () => {
  for (const r of ROWS) {
    if (r.touch_number === 3) assert.match(r.subject_b, /\{\{founding_remaining\}\}/);
    else assert.strictEqual(r.subject_b, null);
  }
});

test('ACC rows render clean through the real strict-mode render engine', async () => {
  process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-secret-0123456789';
  const { renderMergeTags } = require('../services/render-engine');
  const ctx = {
    state: { filled: 12, cap: 50, remaining: 38, ratio: 0.24, lock_months: 24, success_fee_pct: null },
    recipient: { id: 42, first_name: 'Dana', province: 'ON', city: 'Oakville', firm_name: 'Dana Lee CPA' },
    unsubscribeEmail: 'dana@example.test',
    profileId: 42,
  };
  for (const r of ROWS.filter(x => x.platform === 'acc')) {
    for (const f of fields(r)) {
      const out = await renderMergeTags(f, ctx, { contextLabel: `acc T${r.touch_number}` });
      assert.ok(!/\{\{/.test(out));
      assert.ok(!/undefined|null/.test(out), `acc T${r.touch_number} rendered a missing value`);
    }
  }
});
