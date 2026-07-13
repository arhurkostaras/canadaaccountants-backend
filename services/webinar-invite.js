// "AI for CPAs" webinar invite — message class webinar_invite_ai_for_cpas_v1.
// Spec: ~/phronisi-ops/docs/webinar-invite-ai-for-cpas-2026-07-13.md
//
// DARK BY DESIGN. Two independent gates, both default OFF:
//   WEBINAR_INVITE_ENABLED           unset/false -> every call is a dry run, zero sends
//   WEBINAR_INVITE_ALLOW_THIRD_PARTY unset/false -> even with sends on, only self-test
//                                    (arthur@/arthur+/etc) addresses send; real
//                                    professionals skip loud. Flipping this flag
//                                    requires Arthur's written lift of the 2026-06-10
//                                    ACC professional-contact moratorium.
// One message class, no variants. No cron may ever call this module.

const crypto = require('crypto');
const { sendEmail, wrapInBrandTemplate } = require('./email');

const MESSAGE_CLASS = 'webinar_invite_ai_for_cpas_v1';
const ALLOWED_BASIS = ['express', 'ebr'];
// Same predicate as the friction-ack guard in services/email.js
const isSelfTest = e => /^arthur@|^arthur\+|negotiateandwin|akrosfinancial|@test\.|@testcpa|@example\./i.test(e || '');

function renderWebinarInvite({ firstName, dateLine, registrationUrl }) {
  if (!dateLine || !registrationUrl) {
    throw new Error(`renderWebinarInvite: unresolved placeholder — dateLine and registrationUrl are required (got dateLine=${JSON.stringify(dateLine)}, registrationUrl=${JSON.stringify(registrationUrl)}). The template is invalid to send while any placeholder is unresolved.`);
  }
  const first = (firstName || '').trim() || 'there';
  const subject = 'A free 45-minute session: AI for CPAs, without the hype';
  const text = `Hi ${first},

I run CanadaAccountants, and I also spend most of my working week using AI inside real finance workflows — working papers, client correspondence, documentation that has to survive review.

I'm hosting a free 45-minute session for CPAs on what actually works: which tasks AI handles well today, which ones it fails quietly, and how to document AI-assisted work so it holds up.

${dateLine}

No product pitch. One link at the end if you want to go deeper; nothing else.

Register here: ${registrationUrl}

Arthur Kostaras, CPA, CMA
CanadaAccountants.app

If you'd rather not hear about sessions like this, reply "unsubscribe" and I won't send another.`;

  const html = wrapInBrandTemplate(`
  <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;">Hi ${first},</p>
  <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;">I run CanadaAccountants, and I also spend most of my working week using AI inside real finance workflows &mdash; working papers, client correspondence, documentation that has to survive review.</p>
  <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;">I'm hosting a free 45-minute session for CPAs on what actually works: which tasks AI handles well today, which ones it fails quietly, and how to document AI-assisted work so it holds up.</p>
  <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;"><strong>${dateLine}</strong></p>
  <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;">No product pitch. One link at the end if you want to go deeper; nothing else.</p>
  <p style="margin:0 0 24px;"><a href="${registrationUrl}" style="display:inline-block;padding:12px 24px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600;">Register &rarr;</a></p>
  <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.6;">Arthur Kostaras, CPA, CMA<br>CanadaAccountants.app</p>
  <p style="margin:0;color:#999999;font-size:12px;line-height:1.6;">If you'd rather not hear about sessions like this, reply "unsubscribe" and I won't send another.</p>`);

  const templateHash = crypto.createHash('sha256').update(subject + '\n' + text).digest('hex').slice(0, 12);
  return { subject, html, text, templateHash };
}

// cohort: [{ email, first_name, casl_basis ('express'|'ebr'), evidence_ref }]
// Every recipient needs a CASL basis and an evidence pointer or it skips loud.
async function sendWebinarInvites(pool, { cohort, dateLine, registrationUrl }) {
  if (!Array.isArray(cohort) || cohort.length === 0) {
    throw new Error('sendWebinarInvites: cohort must be a non-empty array of {email, first_name, casl_basis, evidence_ref}');
  }
  const sendsEnabled = process.env.WEBINAR_INVITE_ENABLED === 'true';
  const thirdPartyAllowed = process.env.WEBINAR_INVITE_ALLOW_THIRD_PARTY === 'true';
  const results = { messageClass: MESSAGE_CLASS, dryRun: !sendsEnabled, sent: 0, skipped: [], failed: [], wouldSend: 0 };

  for (const r of cohort) {
    const email = (r.email || '').trim().toLowerCase();
    if (!email || !ALLOWED_BASIS.includes(r.casl_basis) || !r.evidence_ref) {
      console.error(`[WebinarInvite] SKIP invalid recipient ${email || '(no email)'}: casl_basis must be one of ${ALLOWED_BASIS.join('/')} and evidence_ref is required`);
      results.skipped.push({ email, reason: 'invalid_basis_or_evidence' });
      continue;
    }
    const suppressed = await pool.query('SELECT 1 FROM outreach_unsubscribes WHERE LOWER(email) = $1 LIMIT 1', [email]);
    if (suppressed.rows.length > 0) {
      console.warn(`[WebinarInvite] SKIP suppressed address ${email} (outreach_unsubscribes)`);
      results.skipped.push({ email, reason: 'suppressed' });
      continue;
    }
    const rendered = renderWebinarInvite({ firstName: r.first_name, dateLine, registrationUrl });
    if (!sendsEnabled) {
      console.log(`[WebinarInvite][DRY-RUN] would send to ${email} (basis=${r.casl_basis}, evidence=${r.evidence_ref}, template=${rendered.templateHash}) — WEBINAR_INVITE_ENABLED off`);
      results.wouldSend++;
      continue;
    }
    if (!thirdPartyAllowed && !isSelfTest(email)) {
      console.warn(`[WebinarInvite] SKIP third-party address ${email} — WEBINAR_INVITE_ALLOW_THIRD_PARTY off (ACC moratorium: flipping it requires Arthur's written lift)`);
      results.skipped.push({ email, reason: 'third_party_blocked' });
      continue;
    }
    const sendResult = await sendEmail({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: 'Arthur Kostaras <arthur@canadaaccountants.app>',
      replyTo: 'arthur@canadaaccountants.app',
    });
    if (!sendResult.success) {
      console.error(`[WebinarInvite] SEND FAILED to ${email}: ${sendResult.reason}`);
      results.failed.push({ email, reason: sendResult.reason });
      continue;
    }
    await pool.query(
      `INSERT INTO webinar_invite_log (email, message_class, casl_basis, evidence_ref, template_hash, resend_email_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [email, MESSAGE_CLASS, r.casl_basis, r.evidence_ref, rendered.templateHash, sendResult.id]
    );
    console.log(`[WebinarInvite] SENT to ${email} (basis=${r.casl_basis}, resend_id=${sendResult.id})`);
    results.sent++;
  }
  return results;
}

module.exports = { MESSAGE_CLASS, renderWebinarInvite, sendWebinarInvites, isSelfTest };
