/**
 * Shared email template builder for professional claim campaigns.
 * Produces table-based, mobile-responsive HTML compatible with
 * Outlook, Gmail, Apple Mail, and Yahoo Mail.
 *
 * Usage:
 *   const { buildClaimEmail } = require('../utils/email-template');
 *   const template = buildClaimEmail({ platformName, tagline, ... });
 *   // template.subject — email subject line
 *   // template.body   — full HTML body with {{variable}} placeholders
 */

function buildClaimEmail(config) {
  const {
    platformName,
    tagline,
    primaryColor = '#2563eb',
    gradientEnd = '#1e3a8a',
    subject,
    greeting,
    bodyParagraphs,
    features,
    ctaText = 'Claim Your Profile',
    ctaUrl,
    closingLine = "Claiming takes under 2 minutes. You'll verify your identity and can immediately update what clients see when they find you.",
    disclaimer = "If you don't wish to claim your profile, no action is needed — your basic listing will remain as-is.",
    footerNote = 'You are receiving this because your profile appears in a Canadian professional directory.',
    privacyUrl,
    copyrightName,
  } = config;

  const featureRows = features
    .map(
      (f) =>
        `<tr><td style="padding:4px 0;color:#333333;font-size:14px;line-height:1.6;">&#10003;&nbsp; <strong>${f.bold}</strong> — ${f.text}</td></tr>`
    )
    .join('\n            ');

  const paragraphs = bodyParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 18px;color:#333333;font-size:15px;line-height:1.7;">${p}</p>`
    )
    .join('\n\n          ');

  const body = `<!DOCTYPE html>
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
<tr><td class="email-header" style="background:linear-gradient(135deg,${primaryColor} 0%,${gradientEnd} 100%);padding:28px 40px;text-align:center;">
  <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${platformName}</h1>
  <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">${tagline}</p>
</td></tr>

<!-- Body -->
<tr><td class="email-body" style="padding:36px 40px;">
  <p style="margin:0 0 18px;color:#1a1a1a;font-size:15px;line-height:1.7;">${greeting}</p>

  ${paragraphs}

  <p style="margin:0 0 12px;color:#1a1a1a;font-size:15px;font-weight:600;">When you claim your profile, you can:</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
    ${featureRows}
  </table>

  <p style="margin:0 0 24px;color:#333333;font-size:15px;line-height:1.7;">
    ${closingLine}
  </p>

  <!-- CTA -->
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
    <tr><td style="background:linear-gradient(135deg,${primaryColor} 0%,${gradientEnd} 100%);border-radius:6px;padding:14px 36px;">
      <a href="${ctaUrl}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">${ctaText}</a>
    </td></tr>
  </table>

  <p style="margin:0;color:#888888;font-size:13px;line-height:1.6;">${disclaimer}</p>
</td></tr>

<!-- Footer -->
<tr><td class="email-footer" style="padding:20px 40px;border-top:1px solid #eeeeee;background-color:#fafafa;">
  <p style="margin:0 0 4px;color:#999999;font-size:11px;text-align:center;">
    ${footerNote}
  </p>
  <p style="margin:0;color:#999999;font-size:11px;text-align:center;">
    <a href="{{unsubscribe_url}}" style="color:#999999;text-decoration:underline;">Unsubscribe</a>
    &nbsp;&middot;&nbsp;
    <a href="${privacyUrl}" style="color:#999999;text-decoration:underline;">Privacy Policy</a>
    &nbsp;&middot;&nbsp;
    &copy; {{current_year}} ${copyrightName}
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, body };
}

module.exports = { buildClaimEmail };
