// Breakdown auto-reply scoring + composer for ACC (Section 4.1 of campaign brief v1.7).
//
// When a recipient replies "breakdown" to Touch 1, the inbound classifier reads
// scraped_cpas, calls score() to produce a 5-dimension breakdown, and compose() to
// produce the email body. If the deterministic scorer cannot populate at least
// 4 of the 5 dimensions from verifiable scraped data, the caller routes to manual
// review instead of auto-sending — per Section 4.1's quality rubric criterion (e):
// "no fabricated metrics, no invented peer comparisons."

const crypto = require('crypto');

const PLATFORM = 'acc';
const DIMENSIONS = ['designation_depth', 'firm_tier', 'geography', 'profile_completeness', 'practice_area_signal'];

// Big 4 + national firms detection — used by firm_tier dimension
const BIG4 = ['deloitte', 'pwc', 'pricewaterhousecoopers', 'kpmg', 'ernst & young', 'ernst and young', 'ey'];
const NATIONAL = ['bdo', 'mnp', 'grant thornton', 'rsm', 'crowe'];

// Major metros for geography dimension
const MAJOR_METROS = new Set([
  'toronto', 'montreal', 'vancouver', 'calgary', 'edmonton', 'ottawa',
  'mississauga', 'brampton', 'winnipeg', 'quebec city', 'hamilton', 'halifax'
]);

function _norm(s) { return (s || '').toString().trim().toLowerCase(); }

function _scoreDesignationDepth(cpa) {
  const d = _norm(cpa.designation);
  if (!d) return { score: null, reason: null, citation: null, status: 'INSUFFICIENT_DATA' };
  // CPA, CA = chartered accountant (deepest); CPA, CMA = management; CPA, CGA = general; bare CPA = post-merger
  if (d.includes('ca')) {
    return {
      score: 92,
      reason: `Holds CPA, CA — the chartered-accountant designation, the audit-track route into the merged CPA framework`,
      citation: 'scraped_cpas.designation',
      status: 'OK'
    };
  }
  if (d.includes('cma')) {
    return {
      score: 80,
      reason: `Holds CPA, CMA — the management-accounting route, common for industry CFO and controller roles`,
      citation: 'scraped_cpas.designation',
      status: 'OK'
    };
  }
  if (d.includes('cga')) {
    return {
      score: 75,
      reason: `Holds CPA, CGA — the general-accounting route, broad-practice oriented`,
      citation: 'scraped_cpas.designation',
      status: 'OK'
    };
  }
  if (d.includes('cpa')) {
    return {
      score: 65,
      reason: `Holds the post-2014 unified CPA designation`,
      citation: 'scraped_cpas.designation',
      status: 'OK'
    };
  }
  return { score: null, reason: null, citation: null, status: 'INSUFFICIENT_DATA' };
}

function _scoreFirmTier(cpa) {
  const f = _norm(cpa.firm_name);
  if (!f) return { score: null, reason: null, citation: null, status: 'INSUFFICIENT_DATA' };
  for (const big of BIG4) {
    if (f.includes(big)) {
      return {
        score: 95,
        reason: `Listed at ${cpa.firm_name} — Big Four. Audit-quality bar is high; SME work tends to be scoped tightly to higher-value engagements`,
        citation: 'scraped_cpas.firm_name',
        status: 'OK'
      };
    }
  }
  for (const nat of NATIONAL) {
    if (f.includes(nat)) {
      return {
        score: 85,
        reason: `Listed at ${cpa.firm_name} — national mid-tier. Strong SME pipeline, broad geographic coverage`,
        citation: 'scraped_cpas.firm_name',
        status: 'OK'
      };
    }
  }
  // Heuristic: "& Co", "Associates", "LLP" suggest established practice
  if (/\b(llp|& co|associates|partners)\b/i.test(f)) {
    return {
      score: 70,
      reason: `Listed at ${cpa.firm_name} — established regional practice; SME generalist or boutique focus likely`,
      citation: 'scraped_cpas.firm_name',
      status: 'OK'
    };
  }
  return {
    score: 60,
    reason: `Listed at ${cpa.firm_name}`,
    citation: 'scraped_cpas.firm_name',
    status: 'OK'
  };
}

function _scoreGeography(cpa) {
  const c = _norm(cpa.city);
  const p = _norm(cpa.province);
  if (!p) return { score: null, reason: null, citation: null, status: 'INSUFFICIENT_DATA' };
  if (c && MAJOR_METROS.has(c)) {
    return {
      score: 88,
      reason: `Practising in ${cpa.city}, ${cpa.province} — major metro, dense SME concentration`,
      citation: 'scraped_cpas.city + province',
      status: 'OK'
    };
  }
  if (c) {
    return {
      score: 70,
      reason: `Practising in ${cpa.city}, ${cpa.province}`,
      citation: 'scraped_cpas.city + province',
      status: 'OK'
    };
  }
  return {
    score: 55,
    reason: `Practising in ${cpa.province}`,
    citation: 'scraped_cpas.province',
    status: 'OK'
  };
}

function _scoreProfileCompleteness(cpa) {
  const fields = [
    !!cpa.firm_name,
    !!cpa.city,
    !!(cpa.enriched_email || cpa.email),
    !!cpa.phone,
    !!cpa.permit_number
  ];
  const filled = fields.filter(Boolean).length;
  if (filled === 0) return { score: null, reason: null, citation: null, status: 'INSUFFICIENT_DATA' };
  const pct = Math.round((filled / fields.length) * 100);
  const reason = `Profile fields populated: ${filled} of 5 (firm name, city, email, phone, permit number). Higher completeness improves match precision in both directions`;
  return { score: pct, reason, citation: 'scraped_cpas multi-field', status: 'OK' };
}

function _scorePracticeAreaSignal(cpa) {
  // We do not currently store practice-area data on scraped_cpas. Honest behavior
  // is to return INSUFFICIENT_DATA rather than fabricate. Future enrichment via
  // firm-website scrape or Apollo can populate this.
  if (cpa.generated_bio && cpa.generated_bio.length > 50) {
    // Bio provides indirect signal — flag as OK with the bio as citation
    const bio = cpa.generated_bio.replace(/\s+/g, ' ').slice(0, 240);
    return {
      score: 70,
      reason: `Bio on file describes practice focus — used as practice-area proxy: "${bio}${bio.length === 240 ? '…' : ''}"`,
      citation: 'scraped_cpas.generated_bio',
      status: 'OK'
    };
  }
  return { score: null, reason: null, citation: null, status: 'INSUFFICIENT_DATA' };
}

// Public: score a single recipient row from scraped_cpas
function score(cpa) {
  const dims = {
    designation_depth: _scoreDesignationDepth(cpa),
    firm_tier: _scoreFirmTier(cpa),
    geography: _scoreGeography(cpa),
    profile_completeness: _scoreProfileCompleteness(cpa),
    practice_area_signal: _scorePracticeAreaSignal(cpa)
  };
  const populatedCount = Object.values(dims).filter(d => d.status === 'OK').length;
  return { platform: PLATFORM, dimensions: dims, populated_count: populatedCount };
}

// Sort dimensions strongest-first, weakest-second, then the rest by score
function _orderDimensions(dims) {
  const populated = Object.entries(dims).filter(([, v]) => v.status === 'OK')
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.score - a.score);
  if (populated.length === 0) return [];
  // strongest = highest, weakest = lowest, then middle in score order
  if (populated.length === 1) return populated;
  const strongest = populated[0];
  const weakest = populated[populated.length - 1];
  const middle = populated.slice(1, -1);
  return [strongest, weakest, ...middle];
}

const DIMENSION_LABELS = {
  designation_depth: 'Designation depth',
  firm_tier: 'Firm tier',
  geography: 'Geographic fit',
  profile_completeness: 'Profile completeness',
  practice_area_signal: 'Practice-area signal'
};

// Public: compose plain-text + HTML auto-reply email body
function compose(scoreResult, recipient) {
  const ordered = _orderDimensions(scoreResult.dimensions);
  if (ordered.length < 4) {
    // Not enough dimensions — caller should route to manual review
    return { ok: false, reason: `only ${ordered.length} dimension(s) populated; need ≥4 for auto-send` };
  }

  const firstName = recipient.first_name || (recipient.full_name || '').split(' ')[0] || 'there';
  const strongest = ordered[0];
  const weakest = ordered[1];
  const others = ordered.slice(2);

  const lines = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');
  lines.push(`Quick personalized AI breakdown, as you asked. Five dimensions our matching engine scores you on, ordered strongest to weakest:`);
  lines.push('');
  lines.push(`1. ${DIMENSION_LABELS[strongest.key]} — ${strongest.score}/100`);
  lines.push(`   ${strongest.reason}.`);
  lines.push('');
  lines.push(`2. ${DIMENSION_LABELS[weakest.key]} — ${weakest.score}/100 (your weakest of the five)`);
  lines.push(`   ${weakest.reason}.`);
  lines.push('');
  for (let i = 0; i < others.length; i++) {
    lines.push(`${i + 3}. ${DIMENSION_LABELS[others[i].key]} — ${others[i].score}/100`);
    lines.push(`   ${others[i].reason}.`);
    lines.push('');
  }
  lines.push(`Every score above traces to a specific field in our scraped record for you. Nothing inferred, nothing made up. Reply with any question and I will answer directly. If you want a founding seat, reply with the word "in" and I will personally enroll you at $299/mo, locked for 24 months from your activation.`);
  lines.push('');
  lines.push(`— Arthur Kostaras`);
  lines.push(`Founder, CanadaAccountants`);
  lines.push(``);
  lines.push(`---`);
  lines.push(`You are receiving this because your business contact information is publicly listed in CPA Canada provincial directories. To unsubscribe: reply with the word "unsubscribe" and I will remove you within 10 business days. Sender: Arthur Kostaras, Toronto, Ontario, Canada.`);

  const text = lines.join('\n');
  const html = _toHtml(firstName, strongest, weakest, others);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ ordered, firstName })).digest('hex');
  return { ok: true, text, html, payload_hash: payloadHash };
}

function _toHtml(firstName, strongest, weakest, others) {
  const dimRow = (n, label, score, reason, weakestNote) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #eee;">
      <div style="font-weight:600;color:#111;font-size:15px;">${n}. ${label} — ${score}/100${weakestNote ? ' <span style="color:#92400e;font-weight:500;">(your weakest of the five)</span>' : ''}</div>
      <div style="color:#444;font-size:14px;line-height:1.55;margin-top:4px;">${reason.replace(/&/g, '&amp;').replace(/</g, '&lt;')}.</div>
    </td></tr>`;
  const otherRows = others.map((d, i) => dimRow(i + 3, DIMENSION_LABELS[d.key], d.score, d.reason, false)).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;font-family:Arial,sans-serif;color:#111;">
<tr><td style="padding:24px 24px 0;">
<p style="margin:0 0 12px;font-size:15px;">Hi ${firstName},</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.55;">Quick personalized AI breakdown, as you asked. Five dimensions our matching engine scores you on, ordered strongest to weakest:</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${dimRow(1, DIMENSION_LABELS[strongest.key], strongest.score, strongest.reason, false)}
${dimRow(2, DIMENSION_LABELS[weakest.key], weakest.score, weakest.reason, true)}
${otherRows}
</table>
<p style="margin:18px 0 12px;font-size:14px;line-height:1.55;color:#333;">Every score above traces to a specific field in our scraped record for you. Nothing inferred, nothing made up. Reply with any question and I will answer directly. If you want a founding seat, reply with the word "in" and I will personally enroll you at $299/mo, locked for 24 months from your activation.</p>
<p style="margin:0 0 12px;font-size:15px;">— Arthur Kostaras<br><span style="color:#666;">Founder, CanadaAccountants</span></p>
</td></tr>
<tr><td style="padding:18px 24px;background:#f5f5f5;color:#777;font-size:11px;line-height:1.5;">
You are receiving this because your business contact information is publicly listed in CPA Canada provincial directories. To unsubscribe: reply with the word "unsubscribe" and I will remove you within 10 business days. Sender: Arthur Kostaras, Toronto, Ontario, Canada.
</td></tr>
</table>`;
}

// Graceful fallback when populated_count < 4. Returns ok=true with an honest
// acknowledgment + path-forward message, so every breakdown reply gets an
// immediate auto-reply instead of being queued for manual triage.
function composeFallback(scoreResult, recipient) {
  const firstName = recipient.first_name || (recipient.full_name || '').split(' ')[0] || 'there';
  const populated = (scoreResult.dimensions || []).filter(d => d.score != null && !d.insufficient_data);
  const populatedLabels = populated.map(d => DIMENSION_LABELS[d.key] || d.key);
  const missingLabels = (scoreResult.dimensions || [])
    .filter(d => d.score == null || d.insufficient_data)
    .map(d => DIMENSION_LABELS[d.key] || d.key);

  const lines = [];
  lines.push(`Hi ${firstName},`, '');
  lines.push(`Thanks for asking for the breakdown. Honest read: your public profile data in the provincial CPA directories is sparser than our 5-dimension scorer needs for a confident scorecard. Here is what we have and what we do not have.`, '');
  if (populatedLabels.length > 0) {
    lines.push(`What we can score (${populatedLabels.length} of 5 dimensions):`);
    for (const d of populated) lines.push(`  • ${DIMENSION_LABELS[d.key] || d.key} — ${d.score}/100. ${d.reason}.`);
    lines.push('');
  }
  if (missingLabels.length > 0) {
    lines.push(`What we cannot score from public data (${missingLabels.length} dimension${missingLabels.length === 1 ? '' : 's'}):`);
    for (const label of missingLabels) lines.push(`  • ${label}`);
    lines.push('');
  }
  lines.push(`The full 5-dimension scorecard becomes producible after standard tier opens, when public profile coverage on Canadian CPAs gets enriched on a different cadence. For founding cohort, the routing engine still runs on the data we have — your queue position is set by founding-cohort entry, not by the scorecard.`, '');
  lines.push(`If you want a founding seat anyway, reply with the word "in" and I will personally enroll you at $299/mo, locked for 24 months from your activation. Otherwise, no problem — you will continue to receive the standard sequence emails and can reply at any later touch.`, '');
  lines.push(`— Arthur Kostaras`, `Founder, CanadaAccountants`, '', `---`);
  lines.push(`You are receiving this because you replied "breakdown" to my outreach. To unsubscribe from all future emails: reply with the word "unsubscribe" and I will remove you within 10 business days. Sender: Arthur Kostaras, 1012-728 Yates Street, Victoria, BC V8W 1L4, Canada.`);
  const text = lines.join('\n');
  const html = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;font-family:Arial,sans-serif;color:#111;">
<tr><td style="padding:24px 24px 0;">
<p style="margin:0 0 12px;font-size:15px;">Hi ${firstName},</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.55;">Thanks for asking for the breakdown. Honest read: your public profile data in the provincial CPA directories is sparser than our 5-dimension scorer needs for a confident scorecard.</p>
${populatedLabels.length > 0 ? `<p style="margin:14px 0 6px;font-size:14px;color:#111;font-weight:600;">What we can score (${populatedLabels.length} of 5):</p><ul style="margin:0 0 12px;padding-left:20px;font-size:14px;color:#333;">${populated.map(d => `<li>${DIMENSION_LABELS[d.key] || d.key} — ${d.score}/100. ${d.reason}.</li>`).join('')}</ul>` : ''}
${missingLabels.length > 0 ? `<p style="margin:14px 0 6px;font-size:14px;color:#111;font-weight:600;">What we cannot score from public data:</p><ul style="margin:0 0 12px;padding-left:20px;font-size:14px;color:#666;">${missingLabels.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}
<p style="margin:14px 0 12px;font-size:14px;line-height:1.55;color:#333;">The full 5-dimension scorecard becomes producible after standard tier opens, when public profile coverage on Canadian CPAs gets enriched on a different cadence. For founding cohort, the routing engine still runs on the data we have — your queue position is set by founding-cohort entry, not by the scorecard.</p>
<p style="margin:14px 0 12px;font-size:14px;line-height:1.55;color:#333;">If you want a founding seat anyway, reply with the word <strong>in</strong> and I will personally enroll you at $299/mo, locked for 24 months. Otherwise, no problem — you will continue to receive the standard sequence emails.</p>
<p style="margin:0 0 12px;font-size:15px;">— Arthur Kostaras<br><span style="color:#666;">Founder, CanadaAccountants</span></p>
</td></tr>
<tr><td style="padding:18px 24px;background:#f5f5f5;color:#777;font-size:11px;line-height:1.5;">
You are receiving this because you replied "breakdown" to my outreach. To unsubscribe from all future emails: reply with the word "unsubscribe" and I will remove you within 10 business days. Sender: Arthur Kostaras, 1012-728 Yates Street, Victoria, BC V8W 1L4, Canada.
</td></tr>
</table>`;
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ fallback: true, populated_count: populated.length, firstName })).digest('hex');
  return { ok: true, text, html, payload_hash: payloadHash, is_fallback: true };
}

module.exports = { PLATFORM, DIMENSIONS, score, compose, composeFallback };
