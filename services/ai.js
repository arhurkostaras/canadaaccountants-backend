const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate a professional bio using Claude Haiku
 */
async function generateBio(profile, platform = 'investing') {
  const professionMap = {
    investing: { title: 'financial advisor', field: 'financial services', body: 'CIRO' },
    lawyers: { title: 'lawyer', field: 'legal services', body: 'Law Society' },
    accountants: { title: 'CPA', field: 'accounting', body: 'CPA body' }
  };
  const p = professionMap[platform] || professionMap.investing;

  const prompt = `Write a professional 2-paragraph bio for a Canadian ${p.title}. Use the following details. Do NOT fabricate information not provided. Write in third person. Keep it under 150 words. Professional but warm tone.

Name: ${profile.first_name} ${profile.last_name}
Firm: ${profile.firm_name || 'Independent practice'}
City: ${profile.city || 'N/A'}
Province: ${profile.province || 'N/A'}
Designation: ${profile.designation || 'N/A'}
Specializations: ${profile.specializations || 'General practice'}
Years of Experience: ${profile.years_experience || 'N/A'}

Write the bio now:`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text.trim();
}

/**
 * Calculate SEO/profile completeness score (algorithmic, no AI needed)
 */
function calculateSEOScore(profile) {
  const checks = [
    { field: 'bio', label: 'Add a professional bio', weight: 20, has: !!profile.bio },
    { field: 'phone', label: 'Add your phone number', weight: 10, has: !!profile.phone },
    { field: 'specializations', label: 'List your specializations', weight: 15, has: !!(profile.specializations && profile.specializations.length > 0) },
    { field: 'firm_name', label: 'Add your firm name', weight: 10, has: !!profile.firm_name },
    { field: 'designation', label: 'Add your designation/credentials', weight: 10, has: !!profile.designation },
    { field: 'city', label: 'Add your city', weight: 5, has: !!profile.city },
    { field: 'province', label: 'Add your province', weight: 5, has: !!profile.province },
    { field: 'years_experience', label: 'Add years of experience', weight: 10, has: !!profile.years_experience },
    { field: 'claimed', label: 'Claim your profile', weight: 10, has: profile.claim_status === 'claimed' },
    { field: 'subscription', label: 'Subscribe to a plan for priority ranking', weight: 5, has: !!profile.subscription_tier }
  ];

  let score = 0;
  const recommendations = [];

  for (const check of checks) {
    if (check.has) {
      score += check.weight;
    } else {
      recommendations.push({
        field: check.field,
        action: check.label,
        impact: check.weight >= 15 ? 'high' : check.weight >= 10 ? 'medium' : 'low',
        points: check.weight
      });
    }
  }

  // Sort recommendations by impact (highest points first)
  recommendations.sort((a, b) => b.points - a.points);

  let grade;
  if (score >= 90) grade = 'A+';
  else if (score >= 80) grade = 'A';
  else if (score >= 70) grade = 'B+';
  else if (score >= 60) grade = 'B';
  else if (score >= 50) grade = 'C';
  else grade = 'D';

  return { score, grade, recommendations, maxScore: 100 };
}

/**
 * Generate a personalized outreach/announcement email template using Claude Haiku
 */
async function generateOutreachTemplate(profile, platform = 'investing') {
  const platformMap = {
    investing: { name: 'CanadaInvesting.app', title: 'financial advisor', audience: 'clients and prospects' },
    lawyers: { name: 'CanadaLawyers.app', title: 'lawyer', audience: 'clients and referral partners' },
    accountants: { name: 'CanadaAccountants.app', title: 'CPA', audience: 'clients and business contacts' }
  };
  const p = platformMap[platform] || platformMap.investing;

  const prompt = `Write a short, professional email that a Canadian ${p.title} can send to their ${p.audience} announcing that their verified profile is now live on ${p.name}.

Details:
Name: ${profile.first_name} ${profile.last_name}
Firm: ${profile.firm_name || 'Independent practice'}
City: ${profile.city || ''}
Province: ${profile.province || ''}
Specializations: ${profile.specializations || 'General practice'}

Requirements:
- Subject line first (on its own line, prefixed with "Subject: ")
- Keep body under 120 words
- Professional but personal tone
- Mention the verified profile and what it means for them
- Include a subtle CTA to view the profile
- Do NOT include placeholder URLs — just say "my profile on ${p.name}"
- Sign off with just the first name

Write the email now:`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0].text.trim();

  // Parse subject from body
  const lines = text.split('\n');
  let subject = '';
  let body = text;
  if (lines[0].toLowerCase().startsWith('subject:')) {
    subject = lines[0].replace(/^subject:\s*/i, '').trim();
    body = lines.slice(1).join('\n').trim();
  }

  return { subject, body };
}

module.exports = { generateBio, calculateSEOScore, generateOutreachTemplate };
