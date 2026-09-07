// stripBioHeader: the render-time strip of the "Name, CPA, CA" header line that stored bios
// often open with (2026-09-07 spot-check finding). Shared by /api/profiles/:id, the directory
// bio_snippet chokepoint and tools/tier1-pregen/gen-db.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { stripBioHeader, cleanBio } = require('../tools/tier1-pregen/normalize');

test('strips a name-plus-designation header line', () => {
  assert.strictEqual(stripBioHeader('Jane Doe, CPA, CA\n\nJane Doe is a CPA in Guelph.', 'Jane Doe'), 'Jane Doe is a CPA in Guelph.');
});

test('strips a bare-name header line and matches case-insensitively', () => {
  assert.strictEqual(stripBioHeader('JANE DOE\nJane Doe is a CPA.', 'Jane Doe'), 'Jane Doe is a CPA.');
});

test('accepts several name forms and uses any that matches', () => {
  assert.strictEqual(stripBioHeader('Doe, Jane, CPA\n\nBody.', ['Jane Doe', 'Doe, Jane']), 'Body.');
});

test('leaves a bio alone when the first line is a sentence, too long, unrelated, or single-line', () => {
  const sentence = 'Jane Doe is a CPA in Guelph.\n\nMore.';
  assert.strictEqual(stripBioHeader(sentence, 'Jane Doe'), sentence);
  const long = 'Jane Doe ' + 'x'.repeat(130) + '\n\nMore.';
  assert.strictEqual(stripBioHeader(long, 'Jane Doe'), long);
  const other = 'Overview\n\nJane Doe is a CPA.';
  assert.strictEqual(stripBioHeader(other, 'Jane Doe'), other);
  assert.strictEqual(stripBioHeader('Jane Doe', 'Jane Doe'), 'Jane Doe');
  assert.strictEqual(stripBioHeader(null, 'Jane Doe'), null);
  assert.strictEqual(stripBioHeader('Jane Doe\n\nBody.', null), 'Jane Doe\n\nBody.');
});

test('composes with cleanBio so a markdown header form is stripped too', () => {
  assert.strictEqual(stripBioHeader(cleanBio('# Jane Doe, CPA\n\n**Jane Doe** is a CPA.'), 'Jane Doe'), 'Jane Doe is a CPA.');
});
