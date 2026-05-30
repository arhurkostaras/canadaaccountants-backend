// F2 regression test — asserts no JWT_SECRET fallback patterns or weak literals
// remain in server.js. Belongs in every backend in the personal-platforms fleet.
//
// Forbidden literals are reconstructed from char codes so this test file itself
// does not contain them — the assertion below greps server.js for these exact
// strings and a positive match would otherwise fail the test on its own source.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const decode = arr => String.fromCharCode(...arr);
const WEAK_LITERALS = [
  decode([121,111,117,114,95,106,119,116,95,115,101,99,114,101,116,95,107,101,121]),
  decode([102,97,108,108,98,97,99,107,95,115,101,99,114,101,116]),
  decode([99,98,101,45,100,101,118,45,115,101,99,114,101,116,45,99,104,97,110,103,101,45,105,110,45,112,114,111,100]),
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('no JWT_SECRET fallback patterns remain in server.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const re = /process\.env\.JWT_SECRET\s*\|\|\s*['"][^'"]*['"]/g;
  const hits = src.match(re) || [];
  assert.strictEqual(
    hits.length,
    0,
    `Found ${hits.length} JWT_SECRET fallback pattern(s) in server.js`
  );
});

test('no known weak literal strings remain in server.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const lit of WEAK_LITERALS) {
    const hits = (src.match(new RegExp(escapeRe(lit), 'g')) || []).length;
    assert.strictEqual(
      hits,
      0,
      `Weak literal of length ${lit.length} found in server.js (${hits} occurrence(s))`
    );
  }
});
