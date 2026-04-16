const { Resend } = require('resend');

// Initialize Resend - graceful fallback when API key missing
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@canadaaccountants.app';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';

/**
 * Wraps HTML content in the shared branded email layout.
 * Table-based, mobile-responsive, matches outreach template style.
 */
function wrapInBrandTemplate(content, platformName = 'CanadaAccountants') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; }
      .email-body { padding: 24px 20px !important; }
      .email-header { padding: 20px 20px !important; }
      .email-footer { padding: 16px 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">

<!-- Header -->
<tr><td class="email-header" style="background:linear-gradient(135deg,#2563eb 0%,#1e3a8a 100%);padding:28px 40px;text-align:center;">
  <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${platformName}</h1>
  <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Canada's AI-Powered CPA Matching Platform</p>
</td></tr>

<!-- Body -->
<tr><td class="email-body" style="padding:36px 40px;">
  ${content}
</td></tr>

<!-- Footer -->
<tr><td class="email-footer" style="padding:20px 40px;border-top:1px solid #eeeeee;background-color:#fafafa;">
  <p style="margin:0 0 4px;color:#999999;font-size:11px;text-align:center;">
    ${platformName} | Toronto, ON, Canada
  </p>
  <p style="margin:0;color:#999999;font-size:11px;text-align:center;">
    <a href="https://canadaaccountants.app/privacy-policy" style="color:#999999;text-decoration:underline;">Privacy Policy</a>
    &nbsp;&middot;&nbsp;
    &copy; 2026 ${platformName}
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Shared email sender with graceful fallback
 */
async function sendEmail({ to, subject, html, text, headers, from, replyTo }) {
  if (!resend) {
    console.log(`[Email] RESEND_API_KEY not set. Would send to ${to}: "${subject}"`);
    return { success: false, reason: 'api_key_missing' };
  }

  try {
    // Auto-generate plain-text fallback if not provided
    const plainText = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const payload = {
      from: from || FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: plainText,
    };
    if (headers) payload.headers = headers;
    if (replyTo) payload.reply_to = replyTo;
    const { data, error } = await resend.emails.send(payload);

    if (error) {
      console.error('[Email] Resend API error:', error);
      return { success: false, reason: 'api_error', error };
    }

    console.log(`[Email] Sent to ${to}: "${subject}" (id: ${data.id})`);
    return { success: true, id: data.id };
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return { success: false, reason: 'exception', error: err.message };
  }
}

/**
 * Notify admin + SME after friction match results are generated
 */
async function sendFrictionMatchNotification(requestId, request, matches) {
  const contactInfo = request.contactInfo || {};
  const matchList = matches
    .map((m, i) => `<li><strong>${m.name}</strong> — ${m.specializations.join(', ')} (${m.matchScore.toFixed(0)}% match)</li>`)
    .join('');

  // Email to admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `New SME Match Request: ${contactInfo.name || requestId}`,
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">New Friction Elimination Match Request</h2>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Request ID:</strong> ${requestId}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Contact:</strong> ${contactInfo.name || 'N/A'} (${contactInfo.email || 'N/A'})</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Pain Point:</strong> ${request.painPoint || request.pain_point || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Business Type:</strong> ${request.businessType || request.business_type || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Urgency:</strong> ${request.urgencyLevel || request.urgency_level || 'N/A'}</p>
      <h3 style="margin:18px 0 12px;color:#1a1a1a;font-size:17px;font-weight:600;">Matches Generated (${matches.length})</h3>
      <ul style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">${matchList}</ul>
    `),
  });

  // Confirmation to SME (if we have their email)
  if (contactInfo.email) {
    await sendEmail({
      to: contactInfo.email,
      subject: 'Your CPA Matches Are Ready — CanadaAccountants',
      html: wrapInBrandTemplate(`
        <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">Great news, ${contactInfo.name || 'there'}!</h2>
        <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Our AI has finished analyzing your needs and found <strong>${matches.length} CPA matches</strong> for you.</p>
        <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">You can view your matches anytime at:<br>
        <a href="https://canadaaccountants.app/cpa-matches?request=${requestId}" style="color:#2563eb;text-decoration:none;">View My CPA Matches</a></p>
        <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">A member of our team will also follow up within 24 hours.</p>
        <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
      `),
    });
  }
}

/**
 * Welcome email after CPA friction registration
 */
async function sendCPAOnboardingEmail(registrationId, request, potentialClients) {
  const contactInfo = request.contactInfo || {};
  if (!contactInfo.email) return;

  await sendEmail({
    to: contactInfo.email,
    subject: 'Welcome to CanadaAccountants — Onboarding Next Steps',
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">Welcome to CanadaAccountants!</h2>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Hi ${contactInfo.name || 'there'},</p>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Your friction elimination registration is complete. Here's what happens next:</p>
      <ol style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">
        <li><strong>Onboarding call</strong> — within 24 hours</li>
        <li><strong>First client match</strong> — within 72 hours</li>
        <li><strong>Full integration</strong> — within 1 week</li>
      </ol>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">We've already identified <strong>${potentialClients.length} potential client matches</strong> for your profile.</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;">Our projected improvements for you:</p>
      <ul style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">
        <li>Sales cycle: <strong>months &rarr; 24 hours</strong></li>
        <li>Win rate: <strong>significantly improved</strong></li>
        <li>Marketing waste savings: <strong>$${parseInt(request.marketingWasteAmount || 30000).toLocaleString()}</strong></li>
      </ul>
      <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `),
  });

  // Notify admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `New CPA Registration: ${contactInfo.name || registrationId}`,
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">New CPA Friction Registration</h2>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Registration ID:</strong> ${registrationId}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Name:</strong> ${contactInfo.name || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Email:</strong> ${contactInfo.email || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Biggest Challenge:</strong> ${request.biggestChallenge || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Target Client Size:</strong> ${request.targetClientSize || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Potential Matches:</strong> ${potentialClients.length}</p>
    `),
  });
}

/**
 * Confirmation email after standard CPA registration (POST /api/cpa-registration)
 */
async function sendCPARegistrationConfirmation(registrationData) {
  const email = registrationData.email;
  if (!email) return;

  await sendEmail({
    to: email,
    subject: 'CPA Registration Received — CanadaAccountants',
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">Registration Received!</h2>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Hi ${registrationData.firstName || 'there'},</p>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Thank you for registering on CanadaAccountants. We've received your CPA profile and it's now under review.</p>
      <p style="margin:0 0 12px;color:#1a1a1a;font-size:15px;font-weight:600;">What happens next:</p>
      <ol style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">
        <li>Our team reviews your credentials (1-2 business days)</li>
        <li>Your profile goes live on the marketplace</li>
        <li>You start receiving AI-matched client leads</li>
      </ol>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">If you have questions, reply to this email or call us at <strong>1.647.956.7290</strong>.</p>
      <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `),
  });

  // Notify admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `New CPA Registration: ${registrationData.firstName || ''} ${registrationData.lastName || ''}`,
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">New Standard CPA Registration</h2>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Name:</strong> ${registrationData.firstName || ''} ${registrationData.lastName || ''}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Email:</strong> ${email}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Firm:</strong> ${registrationData.firmName || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Province:</strong> ${registrationData.province || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Experience:</strong> ${registrationData.experience || 'N/A'} years</p>
    `),
  });
}

/**
 * Contact form: email to admin + auto-reply to user
 */
async function sendContactFormEmail({ name, email, phone, company, subject, message }) {
  // Email to admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `Contact Form: ${subject || 'New Inquiry'} — from ${name}`,
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">New Contact Form Submission</h2>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Name:</strong> ${name}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Email:</strong> ${email}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Phone:</strong> ${phone || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Company:</strong> ${company || 'N/A'}</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;"><strong>Subject:</strong> ${subject || 'N/A'}</p>
      <hr style="border:none;border-top:1px solid #eeeeee;margin:18px 0;">
      <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">${message}</p>
    `),
  });

  // Auto-reply to user
  await sendEmail({
    to: email,
    subject: 'We received your message — CanadaAccountants',
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">Thanks for reaching out, ${name}!</h2>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">We've received your message and will get back to you within 1 business day.</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;">In the meantime, you can:</p>
      <ul style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">
        <li><a href="https://canadaaccountants.app/why-we-win" style="color:#2563eb;text-decoration:none;">See why CPAs choose us</a></li>
        <li>Call us directly at <strong>1.647.956.7290</strong></li>
      </ul>
      <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `),
    from: 'Arthur Kostaras <connect@canadaaccountants.app>',
  });
}

/**
 * Congratulations email when a CPA is verified by admin
 */
async function sendCPAVerificationEmail(cpaProfile) {
  const email = cpaProfile.email;
  if (!email) return;

  await sendEmail({
    to: email,
    subject: 'Your CPA Profile is Verified — CanadaAccountants',
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">Congratulations, ${cpaProfile.first_name || 'there'}!</h2>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Your CPA profile on CanadaAccountants has been <strong>verified</strong>.</p>
      <p style="margin:0 0 12px;color:#333333;font-size:15px;line-height:1.7;">This means:</p>
      <ul style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">
        <li>Your profile now has a verified badge</li>
        <li>You'll rank higher in AI-powered client matches</li>
        <li>Clients will see your verified status, increasing trust</li>
      </ul>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Log in to your dashboard to see your latest leads and update your profile:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td style="background:linear-gradient(135deg,#2563eb 0%,#1e3a8a 100%);border-radius:6px;padding:14px 36px;">
          <a href="https://canadaaccountants.app/cpa-dashboard" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Go to My Dashboard</a>
        </td></tr>
      </table>
      <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `),
  });
}

/**
 * Password reset email with token link
 */
async function sendPasswordResetEmail({ email, resetUrl, firstName }) {
  await sendEmail({
    to: email,
    subject: 'Reset Your Password — CanadaAccountants',
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">Password Reset Request</h2>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Hi ${firstName || 'there'},</p>
      <p style="margin:0 0 24px;color:#333333;font-size:15px;line-height:1.7;">We received a request to reset your password. Click the button below to set a new password:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td style="background:#dc2626;border-radius:6px;padding:14px 36px;">
          <a href="${resetUrl}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Reset My Password</a>
        </td></tr>
      </table>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">This link will expire in <strong>1 hour</strong>.</p>
      <p style="margin:0 0 16px;color:#888888;font-size:13px;line-height:1.6;">If you didn't request this, you can safely ignore this email. Your password will remain unchanged.</p>
      <p style="margin:0;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `),
  });
}

async function sendReferralEmail({ referrerName, refereeName, refereeEmail, referralCode, message }) {
  const registerUrl = `https://canadaaccountants.app/join-as-cpa?ref=${referralCode}`;
  await sendEmail({
    to: refereeEmail,
    subject: `${referrerName} thinks you'd benefit from CanadaAccountants`,
    html: wrapInBrandTemplate(`
      <h2 style="margin:0 0 18px;color:#1a1a1a;font-size:20px;font-weight:600;">You've been referred by a colleague</h2>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Hi${refereeName ? ` ${refereeName}` : ''},</p>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Your colleague <strong>${referrerName}</strong> thinks you'd benefit from CanadaAccountants — Canada's AI-powered CPA-to-client matching platform.</p>
      ${message ? `<p style="margin:0 0 16px;color:#555555;font-size:15px;line-height:1.7;font-style:italic;">"${message}"</p>` : ''}
      <p style="margin:0 0 24px;color:#333333;font-size:15px;line-height:1.7;">As a referred professional, you'll get priority onboarding and access to AI-matched client leads from day one.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td style="background:linear-gradient(135deg,#2563eb 0%,#1e3a8a 100%);border-radius:6px;padding:14px 36px;">
          <a href="${registerUrl}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Apply to Join CanadaAccountants</a>
        </td></tr>
      </table>
      <p style="margin:0 0 16px;color:#333333;font-size:15px;line-height:1.7;">Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
      <p style="margin:0;color:#888888;font-size:12px;line-height:1.6;">This is a one-time referral invitation. You will not receive further emails unless you register.</p>
    `),
  });
}

module.exports = {
  sendEmail,
  sendFrictionMatchNotification,
  sendCPAOnboardingEmail,
  sendCPARegistrationConfirmation,
  sendContactFormEmail,
  sendCPAVerificationEmail,
  sendPasswordResetEmail,
  sendReferralEmail,
};
