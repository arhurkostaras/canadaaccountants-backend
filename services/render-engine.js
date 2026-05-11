// Unified merge-tag renderer for v2 sequence runner.
//
// Single pipeline that applies ALL substitution rules to any string field
// (subject, body_text, body_html, or future fields). Subject and body share
// this exact code path by construction — there is no parallel render path.
//
// Substitution order:
//   1. founding-cohort tags ({{founding_filled}}, {{founding_cap}}, etc.)
//   2. personalization ({{first_name}}, {{province}})
//   3. profile tags ({{firm_name_or_designation}}, {{practice_area}}, etc.)
//   4. unsubscribe URL ({{unsubscribe_url}})
//   5. caller-supplied async handlers (e.g., LAW's {{province_specific_backlog}})
//
// Strict mode (default): after all handlers run, any remaining `{{...}}` is
// considered an orphan tag and the renderer throws RenderOrphanError. This
// makes the class of "subject got a different rendering than body" bug
// statically impossible — any tag the renderer doesn't know about fails loud.

const foundingCohort = require('./founding-cohort');
const profileTags = require('./profile-tags');
const unsubscribeToken = require('./unsubscribe-token');

class RenderOrphanError extends Error {
  constructor(orphans, contextLabel) {
    super(`Unresolved merge tag(s): ${orphans.join(', ')} (context: ${contextLabel || 'unknown'})`);
    this.name = 'RenderOrphanError';
    this.orphans = orphans;
    this.contextLabel = contextLabel || '';
  }
}

function _personalize(input, recipient) {
  if (!input) return input;
  const r = recipient || {};
  const firstName = r.first_name || (r.full_name || '').split(' ')[0] || 'there';
  const province = r.province || '';
  return String(input)
    .replace(/\{\{first_name\}\}/g, firstName)
    .replace(/\{\{province\}\}/g, province);
}

async function renderMergeTags(input, context, options = {}) {
  const { strict = true, contextLabel = '', extraHandlers = [] } = options;
  if (input == null) return input;
  let out = String(input);

  // 1. Founding-cohort tags
  out = foundingCohort.resolveMergeTags(out, context.state || {});

  // 2. Personalization
  out = _personalize(out, context.recipient);

  // 3. Profile tags (firm, designation, practice area, geography, etc.)
  out = profileTags.apply(out, context.recipient || {});

  // 4. Unsubscribe URL
  if (context.unsubscribeEmail) {
    out = out.replace(/\{\{unsubscribe_url\}\}/g, unsubscribeToken.makeUrl(context.unsubscribeEmail));
  }

  // 5. Caller-supplied async handlers (e.g., LAW's province-specific backlog)
  for (const h of extraHandlers) {
    out = await h(out, context);
  }

  if (strict) {
    const m = out.match(/\{\{[^}]+\}\}/g);
    if (m && m.length > 0) {
      throw new RenderOrphanError(m, contextLabel);
    }
  }
  return out;
}

// Send-time guard helper. Used by _send() to catch any orphan that somehow
// reached dispatch (e.g., if strict mode was disabled upstream). Defense in
// depth: even if the upstream renderer was misconfigured, this final scan
// blocks the send before it hits Resend.
function scanForOrphans(rendered) {
  const orphans = [];
  for (const field of ['subject', 'text', 'html']) {
    const v = rendered && rendered[field];
    if (!v) continue;
    const m = String(v).match(/\{\{[^}]+\}\}/g);
    if (m) {
      for (const tag of m) orphans.push(`${field}:${tag}`);
    }
  }
  return orphans;
}

module.exports = { renderMergeTags, RenderOrphanError, scanForOrphans };
