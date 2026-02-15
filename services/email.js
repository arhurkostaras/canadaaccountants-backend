const { Resend } = require('resend');

// Initialize Resend - graceful fallback when API key missing
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@canadaaccountants.app';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';

/**
 * Shared email sender with graceful fallback
 */
async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log(`[Email] RESEND_API_KEY not set. Would send to ${to}: "${subject}"`);
    return { success: false, reason: 'api_key_missing' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

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
    html: `
      <h2>New Friction Elimination Match Request</h2>
      <p><strong>Request ID:</strong> ${requestId}</p>
      <p><strong>Contact:</strong> ${contactInfo.name || 'N/A'} (${contactInfo.email || 'N/A'})</p>
      <p><strong>Pain Point:</strong> ${request.painPoint || request.pain_point || 'N/A'}</p>
      <p><strong>Business Type:</strong> ${request.businessType || request.business_type || 'N/A'}</p>
      <p><strong>Urgency:</strong> ${request.urgencyLevel || request.urgency_level || 'N/A'}</p>
      <h3>Matches Generated (${matches.length})</h3>
      <ul>${matchList}</ul>
    `,
  });

  // Confirmation to SME (if we have their email)
  if (contactInfo.email) {
    await sendEmail({
      to: contactInfo.email,
      subject: 'Your CPA Matches Are Ready — CanadaAccountants',
      html: `
        <h2>Great news, ${contactInfo.name || 'there'}!</h2>
        <p>Our AI has finished analyzing your needs and found <strong>${matches.length} CPA matches</strong> for you.</p>
        <p>You can view your matches anytime at:<br>
        <a href="https://canadaaccountants.app/cpa-matches.html?request=${requestId}">View My CPA Matches</a></p>
        <p>A member of our team will also follow up within 24 hours.</p>
        <br>
        <p>Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
      `,
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
    html: `
      <h2>Welcome to CanadaAccountants!</h2>
      <p>Hi ${contactInfo.name || 'there'},</p>
      <p>Your friction elimination registration is complete. Here's what happens next:</p>
      <ol>
        <li><strong>Onboarding call</strong> — within 24 hours</li>
        <li><strong>First client match</strong> — within 72 hours</li>
        <li><strong>Full integration</strong> — within 1 week</li>
      </ol>
      <p>We've already identified <strong>${potentialClients.length} potential client matches</strong> for your profile.</p>
      <p>Our projected improvements for you:</p>
      <ul>
        <li>Sales cycle: <strong>585 days → 24 hours</strong></li>
        <li>Win rate: <strong>25% → 70%+</strong></li>
        <li>Marketing waste savings: <strong>$${parseInt(request.marketingWasteAmount || 30000).toLocaleString()}</strong></li>
      </ul>
      <br>
      <p>Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `,
  });

  // Notify admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `New CPA Registration: ${contactInfo.name || registrationId}`,
    html: `
      <h2>New CPA Friction Registration</h2>
      <p><strong>Registration ID:</strong> ${registrationId}</p>
      <p><strong>Name:</strong> ${contactInfo.name || 'N/A'}</p>
      <p><strong>Email:</strong> ${contactInfo.email || 'N/A'}</p>
      <p><strong>Biggest Challenge:</strong> ${request.biggestChallenge || 'N/A'}</p>
      <p><strong>Target Client Size:</strong> ${request.targetClientSize || 'N/A'}</p>
      <p><strong>Potential Matches:</strong> ${potentialClients.length}</p>
    `,
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
    html: `
      <h2>Registration Received!</h2>
      <p>Hi ${registrationData.firstName || 'there'},</p>
      <p>Thank you for registering on CanadaAccountants. We've received your CPA profile and it's now under review.</p>
      <p><strong>What happens next:</strong></p>
      <ol>
        <li>Our team reviews your credentials (1-2 business days)</li>
        <li>Your profile goes live on the marketplace</li>
        <li>You start receiving AI-matched client leads</li>
      </ol>
      <p>If you have questions, reply to this email or call us at <strong>1.647.956.7290</strong>.</p>
      <br>
      <p>Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `,
  });

  // Notify admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `New CPA Registration: ${registrationData.firstName || ''} ${registrationData.lastName || ''}`,
    html: `
      <h2>New Standard CPA Registration</h2>
      <p><strong>Name:</strong> ${registrationData.firstName || ''} ${registrationData.lastName || ''}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Firm:</strong> ${registrationData.firmName || 'N/A'}</p>
      <p><strong>Province:</strong> ${registrationData.province || 'N/A'}</p>
      <p><strong>Experience:</strong> ${registrationData.experience || 'N/A'} years</p>
    `,
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
    html: `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
      <p><strong>Company:</strong> ${company || 'N/A'}</p>
      <p><strong>Subject:</strong> ${subject || 'N/A'}</p>
      <hr>
      <p>${message}</p>
    `,
  });

  // Auto-reply to user
  await sendEmail({
    to: email,
    subject: 'We received your message — CanadaAccountants',
    html: `
      <h2>Thanks for reaching out, ${name}!</h2>
      <p>We've received your message and will get back to you within 1 business day.</p>
      <p>In the meantime, you can:</p>
      <ul>
        <li><a href="https://canadaaccountants.app/find-cpa.html">Find a CPA now</a></li>
        <li>Call us directly at <strong>1.647.956.7290</strong></li>
      </ul>
      <br>
      <p>Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `,
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
    html: `
      <h2>Congratulations, ${cpaProfile.first_name || 'there'}!</h2>
      <p>Your CPA profile on CanadaAccountants has been <strong>verified</strong>.</p>
      <p>This means:</p>
      <ul>
        <li>Your profile now has a verified badge</li>
        <li>You'll rank higher in AI-powered client matches</li>
        <li>Clients will see your verified status, increasing trust</li>
      </ul>
      <p>Log in to your dashboard to see your latest leads and update your profile:</p>
      <p><a href="https://canadaaccountants.app/cpa-dashboard.html">Go to My Dashboard</a></p>
      <br>
      <p>Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `,
  });
}

/**
 * Password reset email with token link
 */
async function sendPasswordResetEmail({ email, resetUrl, firstName }) {
  await sendEmail({
    to: email,
    subject: 'Reset Your Password — CanadaAccountants',
    html: `
      <h2>Password Reset Request</h2>
      <p>Hi ${firstName || 'there'},</p>
      <p>We received a request to reset your password. Click the link below to set a new password:</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Reset My Password</a></p>
      <p>This link will expire in <strong>1 hour</strong>.</p>
      <p>If you didn't request this, you can safely ignore this email. Your password will remain unchanged.</p>
      <br>
      <p>Best regards,<br>Arthur Kostaras, CPA, CF<br>CanadaAccountants</p>
    `,
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
};
