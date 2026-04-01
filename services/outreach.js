const crypto = require('crypto');
const cron = require('node-cron');
const { Resend } = require('resend');
const { sendEmail } = require('./email');
const { buildClaimEmail } = require('../utils/email-template');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://canadaaccountants.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://canadaaccountants-backend-production-1d8f.up.railway.app';
const OUTREACH_FROM = 'Arthur Kostaras <connect@canadaaccountants.app>';

// Role-based email prefixes that ZeroBounce always returns as do_not_mail
const ROLE_BASED_PREFIXES = new Set([
  'info', 'admin', 'office', 'support', 'sales', 'contact', 'hello', 'help',
  'billing', 'accounts', 'enquiries', 'enquiry', 'hr', 'jobs', 'careers',
  'marketing', 'press', 'media', 'webmaster', 'postmaster', 'noreply',
  'no-reply', 'reception', 'general', 'team', 'staff'
]);

function isRoleBasedEmail(email) {
  if (!email) return false;
  const localPart = email.split('@')[0].toLowerCase();
  return ROLE_BASED_PREFIXES.has(localPart);
}

// Province-to-timezone mapping for time-zone-aware sending (~10 AM local)
const PROVINCE_TIMEZONE_UTC_HOUR = {
  // Atlantic (UTC-4): 10 AM AT = 14:00 UTC
  NL: 14, NS: 14, NB: 14, PE: 14,
  // Eastern (UTC-5): 10 AM ET = 15:00 UTC
  ON: 15, QC: 15,
  // Central (UTC-6): 10 AM CT = 16:00 UTC
  MB: 16, SK: 16,
  // Mountain (UTC-7): 10 AM MT = 17:00 UTC
  AB: 17,
  // Pacific (UTC-8): 10 AM PT = 18:00 UTC
  BC: 18,
};

function _isInSendWindow(province) {
  if (!province) return true; // unknown province — send anyway
  const targetHour = PROVINCE_TIMEZONE_UTC_HOUR[province.toUpperCase()];
  if (targetHour === undefined) return true; // unrecognized province — send anyway
  const nowUTC = new Date().getUTCHours();
  // Allow ±30 min window: if target is 15, accept hours 14 and 15
  return nowUTC === targetHour || nowUTC === targetHour - 1;
}

function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class OutreachEngine {
  constructor(pool) {
    this.pool = pool;
    this.processing = false;
    this.interval = null;
    this.resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    this.canPollStatus = null; // null = unknown, true/false after first check
    this.zbConsecutiveErrors = 0;
    this.zbCreditsRemaining = null; // cached ZeroBounce credit count
    this.zbCreditsCheckedAt = null; // when credits were last checked
  }

  // =====================================================
  // CAMPAIGN CRUD
  // =====================================================

  async createCampaign({ name, type, subjectTemplate, bodyTemplate, targetProvinces, targetCities, targetNaicsCodes, dailyLimit, totalLimit }) {
    const result = await this.pool.query(
      `INSERT INTO outreach_campaigns (name, type, subject_template, body_template, target_provinces, target_cities, target_naics_codes, daily_limit, total_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name, type, subjectTemplate, bodyTemplate, targetProvinces || null, targetCities || null, targetNaicsCodes || null, dailyLimit || 50, totalLimit || null]
    );
    return result.rows[0];
  }

  async getCampaign(id) {
    const result = await this.pool.query('SELECT * FROM outreach_campaigns WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async listCampaigns() {
    const result = await this.pool.query('SELECT * FROM outreach_campaigns ORDER BY created_at DESC');
    return result.rows;
  }

  async updateCampaign(id, updates) {
    const allowed = ['name', 'subject_template', 'body_template', 'target_provinces', 'target_cities', 'target_naics_codes', 'daily_limit', 'total_limit', 'subject_variants', 'follow_up_delay_days', 'max_sequence', 'follow_up_subjects', 'send_type'];
    const sets = [];
    const values = [];
    let idx = 1;

    for (const [key, val] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowed.includes(dbKey)) {
        sets.push(`${dbKey} = $${idx}`);
        values.push(val);
        idx++;
      }
    }

    if (sets.length === 0) return this.getCampaign(id);

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.pool.query(
      `UPDATE outreach_campaigns SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0];
  }

  // =====================================================
  // CAMPAIGN LIFECYCLE
  // =====================================================

  async launchCampaign(campaignId) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.status === 'active') throw new Error('Campaign is already active');

    // Queue emails for this campaign
    const queued = await this._queueEmailsForCampaign(campaign);

    await this.pool.query(
      `UPDATE outreach_campaigns SET status = 'active', launched_at = NOW(), total_queued = $2, updated_at = NOW() WHERE id = $1`,
      [campaignId, queued]
    );

    return { campaignId, queued };
  }

  async pauseCampaign(campaignId) {
    await this.pool.query(
      `UPDATE outreach_campaigns SET status = 'paused', paused_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );
  }

  async _queueEmailsForCampaign(campaign) {
    let queued = 0;
    let skippedByValidation = 0;
    const variantCount = (campaign.subject_variants && Array.isArray(campaign.subject_variants)) ? campaign.subject_variants.length + 1 : 1;

    if (campaign.type === 'cpa') {
      // Find scraped CPAs with email (direct or enriched) not already contacted
      // Use DISTINCT ON + cross-campaign email dedup to prevent duplicate sends
      let query = `
        SELECT DISTINCT ON (COALESCE(sc.enriched_email, sc.email))
               sc.id, sc.first_name, sc.last_name, sc.full_name, sc.city, sc.province, sc.firm_name,
               COALESCE(sc.enriched_email, sc.email) AS email
        FROM scraped_cpas sc
        WHERE COALESCE(sc.enriched_email, sc.email) IS NOT NULL
          AND sc.status != 'invalid'
          AND COALESCE(sc.enriched_email, sc.email) NOT IN (SELECT email FROM outreach_unsubscribes)
          AND sc.id NOT IN (SELECT recipient_id FROM outreach_emails WHERE recipient_type = 'cpa')
          AND COALESCE(sc.enriched_email, sc.email) NOT IN (SELECT DISTINCT recipient_email FROM outreach_emails)
          AND COALESCE(sc.enriched_email, sc.email) NOT IN (
            SELECT DISTINCT recipient_email FROM outreach_emails
            WHERE sent_at > NOW() - INTERVAL '30 days' AND status IN ('sent','delivered','opened','clicked')
          )
      `;
      const params = [];
      let paramIdx = 1;

      if (campaign.target_provinces && campaign.target_provinces.length > 0) {
        query += ` AND sc.province = ANY($${paramIdx})`;
        params.push(campaign.target_provinces);
        paramIdx++;
      }
      if (campaign.target_cities && campaign.target_cities.length > 0) {
        query += ` AND sc.city = ANY($${paramIdx})`;
        params.push(campaign.target_cities);
        paramIdx++;
      }
      if (campaign.total_limit) {
        query += ` LIMIT $${paramIdx}`;
        params.push(campaign.total_limit);
      }

      const cpas = await this.pool.query(query, params);

      for (const cpa of cpas.rows) {
        // ZeroBounce pre-validation before queuing
        const validation = await this._validateEmailForQueue(cpa.email);
        if (!validation.valid) {
          console.log(`[Outreach] Pre-queue rejected: ${cpa.email} (${validation.status}/${validation.sub_status})`);
          skippedByValidation++;
          continue;
        }

        const name = cpa.full_name || `${cpa.first_name || ''} ${cpa.last_name || ''}`.trim();
        const unsubToken = crypto.randomBytes(24).toString('hex');
        const variantIndex = variantCount > 1 ? Math.floor(Math.random() * variantCount) : 0;
        await this.pool.query(
          `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, status, unsubscribe_token, variant_index)
           VALUES ($1, 'cpa', $2, $3, $4, 'queued', $5, $6)`,
          [campaign.id, cpa.id, cpa.email, name, unsubToken, variantIndex]
        );
        queued++;
      }
    } else if (campaign.type === 'sme') {
      let query = `
        SELECT DISTINCT ON (ss.contact_email)
               ss.id, ss.business_name, ss.province, ss.city, ss.industry,
               COALESCE(ss.contact_email) AS email, ss.contact_name
        FROM scraped_smes ss
        WHERE ss.contact_email IS NOT NULL
          AND ss.status != 'invalid'
          AND ss.contact_email NOT IN (SELECT email FROM outreach_unsubscribes)
          AND ss.id NOT IN (SELECT recipient_id FROM outreach_emails WHERE recipient_type = 'sme')
          AND ss.contact_email NOT IN (SELECT DISTINCT recipient_email FROM outreach_emails)
          AND ss.contact_email NOT IN (
            SELECT DISTINCT recipient_email FROM outreach_emails
            WHERE sent_at > NOW() - INTERVAL '30 days' AND status IN ('sent','delivered','opened','clicked')
          )
      `;
      const params = [];
      let paramIdx = 1;

      if (campaign.target_provinces && campaign.target_provinces.length > 0) {
        query += ` AND ss.province = ANY($${paramIdx})`;
        params.push(campaign.target_provinces);
        paramIdx++;
      }
      if (campaign.target_naics_codes && campaign.target_naics_codes.length > 0) {
        query += ` AND ss.naics_code = ANY($${paramIdx})`;
        params.push(campaign.target_naics_codes);
        paramIdx++;
      }
      if (campaign.total_limit) {
        query += ` LIMIT $${paramIdx}`;
        params.push(campaign.total_limit);
      }

      const smes = await this.pool.query(query, params);

      for (const sme of smes.rows) {
        // ZeroBounce pre-validation before queuing — skip role-based filter for SME campaigns
        const validation = await this._validateEmailForQueue(sme.email, { skipRoleBased: true });
        if (!validation.valid) {
          console.log(`[Outreach] Pre-queue rejected: ${sme.email} (${validation.status}/${validation.sub_status})`);
          skippedByValidation++;
          continue;
        }

        const unsubToken = crypto.randomBytes(24).toString('hex');
        const variantIndex = variantCount > 1 ? Math.floor(Math.random() * variantCount) : 0;
        await this.pool.query(
          `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, status, unsubscribe_token, variant_index)
           VALUES ($1, 'sme', $2, $3, $4, 'queued', $5, $6)`,
          [campaign.id, sme.id, sme.email, sme.contact_name || sme.business_name, unsubToken, variantIndex]
        );
        queued++;
      }
    }

    if (skippedByValidation > 0) {
      console.log(`[Outreach] Queue build complete: ${queued} queued, ${skippedByValidation} rejected by ZeroBounce pre-validation`);
    }

    return queued;
  }

  // =====================================================
  // QUEUE PROCESSOR — 9 AM & 2 PM ET daily
  // =====================================================

  startQueueProcessor() {
    // 9 AM ET and 2 PM ET daily
    this.morningJob = cron.schedule('0 9 * * *', () => this.processQueue(), { timezone: 'America/Toronto' });
    this.afternoonJob = cron.schedule('0 14 * * *', () => this.processQueue(), { timezone: 'America/Toronto' });
    // Backup: hourly during business hours in case deployment killed the main crons
    this.backupJob = cron.schedule('0 10,11,12,13,15,16 * * *', () => this.processQueue(), { timezone: 'America/Toronto' });
    // Keep delivery status polling every 30 min
    this.deliveryPoll = setInterval(() => this._pollEmailStatuses(), 30 * 60 * 1000);
    console.log('[Outreach] Scheduled: 9 AM & 2 PM ET daily + hourly backup 10-16 ET');

    // Startup catch-up: if we booted during business hours, process queue immediately
    setTimeout(async () => {
      const now = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });
      const hour = new Date(now).getHours();
      if (hour >= 9 && hour < 17) {
        console.log('[Outreach] Startup catch-up: business hours detected, processing queue...');
        await this.processQueue();
      }
    }, 30000);
  }

  stopQueueProcessor() {
    if (this.morningJob) { this.morningJob.stop(); this.morningJob = null; }
    if (this.afternoonJob) { this.afternoonJob.stop(); this.afternoonJob = null; }
    if (this.backupJob) { this.backupJob.stop(); this.backupJob = null; }
    if (this.deliveryPoll) { clearInterval(this.deliveryPoll); this.deliveryPoll = null; }
  }

  async processQueue() {
    if (this.processing) return;

    // Ensure send_type column exists (may race with DB migration on startup)
    if (!this._sendTypeMigrated) {
      try {
        await this.pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS send_type VARCHAR(10) DEFAULT 'cold'`);
        await this.pool.query(`UPDATE outreach_campaigns SET send_type = 'warm' WHERE (send_type IS NULL OR send_type = 'cold') AND name ILIKE '%re-engagement%'`);
        this._sendTypeMigrated = true;
      } catch (e) { /* ignore */ }
    }

    // Cold/warm send day split schedule
    // Tue-Thu: cold sends, Fri: warm sends, Mon/Sat/Sun: off
    // Holidays override: skip all sends
    const now = new Date();
    const day = now.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat

    // No sends on Sat, Sun, Mon
    if (day === 0 || day === 1 || day === 6) {
      console.log('[Outreach] No-send day (Mon/Sat/Sun). Skipping.');
      return;
    }

    // Holiday check (YYYY-MM-DD in ET)
    const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    const holidays = ['2026-04-03', '2026-04-04', '2026-04-06']; // Good Friday, Easter Saturday, Easter Monday
    if (holidays.includes(etDate)) {
      console.log(`[Outreach] Holiday (${etDate}). Skipping all sends.`);
      return;
    }

    // Determine which send types run today
    const coldDay = day >= 2 && day <= 4; // Tue, Wed, Thu
    let warmDay = day === 5; // Friday normally

    // If Friday is a holiday, move warm sends to Thursday
    if (day === 4) {
      const friday = new Date(now);
      friday.setDate(friday.getDate() + 1);
      const fridayStr = friday.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
      if (holidays.includes(fridayStr)) {
        warmDay = true;
        console.log('[Outreach] Friday is a holiday — warm sends moved to today (Thursday)');
      }
    }

    const sendTypes = [];
    if (coldDay) sendTypes.push('cold');
    if (warmDay) sendTypes.push('warm');
    console.log(`[Outreach] Day ${day} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]}) — processing: ${sendTypes.join(', ')}`);

    this.processing = true;

    try {
      // Bounce rate circuit breaker
      const bounceCheck = await this._checkBounceRate();
      if (bounceCheck.paused) {
        console.log('[Outreach] Bounce rate circuit breaker triggered — all campaigns paused');
        return;
      }

      // Auto-relaunch: reactivate campaigns matching today's send types
      const stalled = await this.pool.query(
        `SELECT id, name, status FROM outreach_campaigns WHERE status IN ('paused', 'completed') AND COALESCE(send_type, 'cold') = ANY($1)`,
        [sendTypes]
      );
      for (const camp of stalled.rows) {
        await this.pool.query(
          `UPDATE outreach_campaigns SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [camp.id]
        );
        console.log(`[Outreach] Auto-relaunched campaign ${camp.id} "${camp.name}" (was ${camp.status})`);
      }

      // Get active campaigns filtered by today's send types
      const campaigns = await this.pool.query(
        `SELECT * FROM outreach_campaigns WHERE status = 'active' AND COALESCE(send_type, 'cold') = ANY($1)`,
        [sendTypes]
      );

      for (const campaign of campaigns.rows) {
        // Count emails sent today for this campaign
        const todayCount = await this.pool.query(
          `SELECT COUNT(*) FROM outreach_emails WHERE campaign_id = $1 AND sent_at >= CURRENT_DATE`,
          [campaign.id]
        );
        const sentToday = parseInt(todayCount.rows[0].count);

        if (sentToday >= campaign.daily_limit) continue;

        const remaining = campaign.daily_limit - sentToday;

        // Get queued emails for this campaign (skip emails that have failed too many times)
        const emails = await this.pool.query(
          `SELECT * FROM outreach_emails WHERE campaign_id = $1 AND status = 'queued' AND COALESCE(retry_count, 0) < 5 ORDER BY queued_at ASC LIMIT $2`,
          [campaign.id, remaining]
        );

        for (const email of emails.rows) {
          await this._sendOutreachEmail(campaign, email);
          // 2-second delay between sends to avoid Resend rate limiting
          await new Promise(r => setTimeout(r, 2000));
        }

        // Check if campaign is complete (no more queued)
        const queuedRemaining = await this.pool.query(
          `SELECT COUNT(*) FROM outreach_emails WHERE campaign_id = $1 AND status = 'queued'`,
          [campaign.id]
        );
        if (parseInt(queuedRemaining.rows[0].count) === 0) {
          await this.pool.query(
            `UPDATE outreach_campaigns SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [campaign.id]
          );
        }
      }
      // Auto-relaunch: check completed AND active campaigns for newly enriched CPAs
      // Active campaigns may have hit the daily limit but still need new recipients queued
      const relaunchCampaigns = await this.pool.query(
        `SELECT * FROM outreach_campaigns WHERE status IN ('completed', 'active')`
      );

      for (const campaign of relaunchCampaigns.rows) {
        const newEmails = await this._countNewRecipientsForCampaign(campaign);
        if (newEmails > 0) {
          const queued = await this._queueEmailsForCampaign(campaign);
          if (queued > 0) {
            await this.pool.query(
              `UPDATE outreach_campaigns SET status = 'active', total_queued = total_queued + $2, completed_at = NULL, updated_at = NOW() WHERE id = $1`,
              [campaign.id, queued]
            );
            console.log(`[Outreach] Auto-queued ${queued} new emails for campaign ${campaign.id} "${campaign.name}"`);
          }
        }
      }
      // Queue follow-up emails for drip sequences
      await this._queueFollowUps();
      // Poll Resend for delivery status of recently sent emails
      await this._pollEmailStatuses();
    } catch (error) {
      console.error('[Outreach] Queue processing error:', error.message);
    } finally {
      this.processing = false;
    }
  }

  // =====================================================
  // FOLLOW-UP DRIP SEQUENCE
  // =====================================================

  async _queueFollowUps() {
    try {
      const campaigns = await this.pool.query(
        `SELECT * FROM outreach_campaigns WHERE status IN ('active', 'completed') AND max_sequence > 1`
      );

      let totalQueued = 0;
      for (const campaign of campaigns.rows) {
        const delayDays = campaign.follow_up_delay_days || 5;

        const eligibleEmails = await this.pool.query(
          `SELECT oe.* FROM outreach_emails oe
           WHERE oe.campaign_id = $1
             AND oe.status IN ('sent', 'delivered')
             AND oe.sent_at < NOW() - INTERVAL '1 day' * $2
             AND oe.sequence_number < $3
             AND NOT EXISTS (
               SELECT 1 FROM outreach_emails oe2
               WHERE oe2.campaign_id = oe.campaign_id
                 AND oe2.recipient_email = oe.recipient_email
                 AND oe2.sequence_number = oe.sequence_number + 1
             )
             AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)`,
          [campaign.id, delayDays, campaign.max_sequence]
        );

        for (const email of eligibleEmails.rows) {
          const newToken = crypto.randomBytes(24).toString('hex');
          await this.pool.query(
            `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, status, unsubscribe_token, sequence_number)
             VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)`,
            [campaign.id, email.recipient_type, email.recipient_id, email.recipient_email, email.recipient_name, newToken, email.sequence_number + 1]
          );
          totalQueued++;
        }

        // Re-activate completed campaigns that now have follow-ups queued
        if (totalQueued > 0 && campaign.status === 'completed') {
          await this.pool.query(
            `UPDATE outreach_campaigns SET status = 'active', total_queued = total_queued + $2, completed_at = NULL, updated_at = NOW() WHERE id = $1`,
            [campaign.id, totalQueued]
          );
        }
      }

      if (totalQueued > 0) {
        console.log(`[Outreach] Queued ${totalQueued} follow-up emails`);
      }
    } catch (err) {
      console.error('[Outreach] Follow-up queue error:', err.message);
    }
  }

  async _pollEmailStatuses() {
    if (!this.resend) return;

    // On first run, test if the API key has read permissions
    if (this.canPollStatus === null) {
      try {
        // Try to fetch any email - if key is send-only, this will throw
        await this.resend.emails.get('test-id');
        this.canPollStatus = true;
      } catch (err) {
        if (err.message && err.message.includes('restricted')) {
          this.canPollStatus = false;
          console.log('[Outreach] Resend API key is send-only — email status polling disabled. Create a full-access key to enable delivery/open/click tracking.');
        } else {
          // 404 or other error means the key CAN read, just the ID was invalid
          this.canPollStatus = true;
        }
      }
    }

    if (!this.canPollStatus) return;

    try {
      // Get sent emails that haven't been confirmed delivered yet (max 50 per cycle)
      const emails = await this.pool.query(
        `SELECT id, resend_email_id, status, campaign_id, recipient_email
         FROM outreach_emails
         WHERE resend_email_id IS NOT NULL
           AND status IN ('sent', 'delivered')
           AND sent_at >= NOW() - INTERVAL '7 days'
         ORDER BY sent_at DESC
         LIMIT 50`
      );

      let updated = 0;
      for (const email of emails.rows) {
        try {
          const { data } = await this.resend.emails.get(email.resend_email_id);
          if (!data) continue;

          // Map Resend last_event to our status
          const event = data.last_event;
          if (!event) continue;

          const eventToStatus = {
            'delivered': 'delivered',
            'opened': 'opened',
            'clicked': 'clicked',
            'bounced': 'bounced',
            'complained': 'complained',
          };

          const newStatus = eventToStatus[event];
          if (!newStatus) continue;

          const statusOrder = ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'];
          const currentIdx = statusOrder.indexOf(email.status);
          const newIdx = statusOrder.indexOf(newStatus);

          if (newStatus === 'bounced' || newStatus === 'complained' || newIdx > currentIdx) {
            await this.pool.query(
              `UPDATE outreach_emails SET status = $2, updated_at = NOW() WHERE id = $1`,
              [email.id, newStatus]
            );

            const counterMap = { delivered: 'total_delivered', opened: 'total_opened', clicked: 'total_clicked', bounced: 'total_bounced', complained: 'total_complained' };
            if (counterMap[newStatus]) {
              await this.pool.query(
                `UPDATE outreach_campaigns SET ${counterMap[newStatus]} = ${counterMap[newStatus]} + 1, updated_at = NOW() WHERE id = $1`,
                [email.campaign_id]
              );
            }

            if (newStatus === 'bounced' || newStatus === 'complained') {
              await this.pool.query(
                `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at) VALUES ($1, $2, NOW()) ON CONFLICT (email) DO NOTHING`,
                [email.recipient_email, newStatus]
              );
            }
            updated++;
          }

          await new Promise(r => setTimeout(r, 500)); // Rate limit polling
        } catch (err) {
          // Skip individual email errors
        }
      }

      if (updated > 0) {
        console.log(`[Outreach] Status poll: updated ${updated} email statuses`);
      }
    } catch (err) {
      console.error('[Outreach] Status polling error:', err.message);
    }
  }

  async _countNewRecipientsForCampaign(campaign) {
    if (campaign.type === 'cpa') {
      let query = `
        SELECT COUNT(*) FROM scraped_cpas sc
        WHERE COALESCE(sc.enriched_email, sc.email) IS NOT NULL
          AND sc.status != 'invalid'
          AND COALESCE(sc.enriched_email, sc.email) NOT IN (SELECT email FROM outreach_unsubscribes)
          AND sc.id NOT IN (SELECT recipient_id FROM outreach_emails WHERE campaign_id = $1 AND recipient_type = 'cpa')
      `;
      const params = [campaign.id];
      let idx = 2;
      if (campaign.target_provinces && campaign.target_provinces.length > 0) {
        query += ` AND sc.province = ANY($${idx})`;
        params.push(campaign.target_provinces);
        idx++;
      }
      const result = await this.pool.query(query, params);
      return parseInt(result.rows[0].count);
    } else if (campaign.type === 'sme') {
      let query = `
        SELECT COUNT(*) FROM scraped_smes ss
        WHERE ss.contact_email IS NOT NULL
          AND ss.status != 'invalid'
          AND ss.contact_email NOT IN (SELECT email FROM outreach_unsubscribes)
          AND ss.id NOT IN (SELECT recipient_id FROM outreach_emails WHERE campaign_id = $1 AND recipient_type = 'sme')
      `;
      const params = [campaign.id];
      let idx = 2;
      if (campaign.target_provinces && campaign.target_provinces.length > 0) {
        query += ` AND ss.province = ANY($${idx})`;
        params.push(campaign.target_provinces);
        idx++;
      }
      if (campaign.target_naics_codes && campaign.target_naics_codes.length > 0) {
        query += ` AND ss.naics_code = ANY($${idx})`;
        params.push(campaign.target_naics_codes);
        idx++;
      }
      const result = await this.pool.query(query, params);
      return parseInt(result.rows[0].count);
    }
    return 0;
  }

  async _sendOutreachEmail(campaign, emailRecord) {
    try {
      // Skip obviously invalid emails (safety net)
      const email = emailRecord.recipient_email;
      const isDemandSide = ['sme', 'business', 'investor'].includes(campaign.type);
      if (!email ||
          email.match(/\.(png|jpg|jpeg|gif|svg|css|js|webp|ico|woff|woff2)$/i) ||
          email.match(/\d+x\d*\./) ||
          email.match(/@(mysite|yoursite|yourdomain|domain|example|test|placeholder|sentry|wixpress|mailchimp|domainmarket)\./i) ||
          email.match(/^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|fraud|spam|bounce|info@info|support@support)@/i) ||
          email.match(/^(w4bsupport|accessibility|webmaster|hostmaster|admin@admin)@/i) ||
          // Role-based filter — only for supply-side (professional) campaigns
          (!isDemandSide && email.match(/^(info|contact|hello|office|admin|support|sales|marketing|hr|careers|jobs|reception|general|enquiries|inquiries|billing|privacy|legal|compliance|media|press|communications|feedback|team|service|accounting|remittance|corporatemarketing|webenquiry|centrecontact|crm|community|newsletter|events?|customerservice|mail|signs|donations?|frontdesk|connect|kontakt|foi\.?privacy)@/i)) ||
          // Template placeholder emails
          email.match(/@email\.com$/i) ||
          email.match(/^(your|youre?mail|your\.?address|your\.?email|your\.?name|name|email|someone|sampleemail|test|user|username|example)@/i) ||
          // Generic non-professional prefixes — only for supply-side
          (!isDemandSide && email.match(/^(shop|news|relais|ventas|pomoc|talent|web|people|appsupport|salesfire|newbusiness|notification|partnerships|right\.info|secretariat|secretary|vancouver|northyork|toronto|montreal|calgary|ottawa|staplestax|taxman|teamparmelee|order|leisure|lending|investors|corp|contactus|contact_us|recruitment|reservations|shipping|warehouse|dispatch|returns|booking|socam|rotterdam)@/i)) ||
          // Obvious junk: xxx@, single/double char locals, ROT13-like gibberish
          email.match(/^x{2,}@/i) ||
          email.split('@')[0].length < 3 ||
          email.match(/^u003e/i) ||
          // Non-vowel-heavy local parts (ROT13/gibberish detection: >8 chars with <15% vowels)
          (email.split('@')[0].length > 8 && (email.split('@')[0].match(/[aeiou]/gi) || []).length / email.split('@')[0].length < 0.15) ||
          email.length > 80 ||
          email.includes('..') ||
          !email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        console.warn(`[Outreach] Skipping invalid email: ${email}`);
        await this.pool.query(`UPDATE outreach_emails SET status = 'failed', updated_at = NOW() WHERE id = $1`, [emailRecord.id]);
        return;
      }

      // Time-zone-aware sending: look up recipient province and check send window
      if (emailRecord.recipient_type === 'cpa' && emailRecord.recipient_id) {
        try {
          const provResult = await this.pool.query('SELECT province FROM scraped_cpas WHERE id = $1', [emailRecord.recipient_id]);
          const recipientProvince = provResult.rows[0]?.province;
          if (!_isInSendWindow(recipientProvince)) {
            // Not in this province's send window — skip, will retry next cycle
            return;
          }
        } catch (e) { /* proceed if lookup fails */ }
      }

      // ZeroBounce email validation (if API key configured)
      const isDemandSideCampaign = ['sme', 'business', 'investor'].includes(campaign.type);
      const validation = await this._validateEmail(email, { skipRoleBased: isDemandSideCampaign });
      if (!validation.valid) {
        console.warn(`[Outreach] ZeroBounce blocked: ${email} (${validation.status}/${validation.sub_status})`);
        await this.pool.query(
          `UPDATE outreach_emails SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [emailRecord.id]
        );
        return;
      }

      // Use existing unsubscribe token from queue time, or generate one for backward compatibility
      const unsubToken = emailRecord.unsubscribe_token || crypto.randomBytes(24).toString('hex');

      // Render template (unsubscribe_url is injected as a template variable)
      const { subject, body } = await this._renderTemplate(campaign, emailRecord, unsubToken);

      // Build unsubscribe URL for RFC 8058 headers
      const unsubscribeUrl = `${BACKEND_URL}/api/unsubscribe/${unsubToken}`;

      // Send via Resend
      const result = await sendEmail({
        to: emailRecord.recipient_email,
        subject,
        html: body,
        text: htmlToPlainText(body),
        from: OUTREACH_FROM,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
      });

      if (result.success) {
        await this.pool.query(
          `UPDATE outreach_emails SET status = 'sent', sent_at = NOW(), resend_email_id = $2, rendered_subject = $3, rendered_body = $4 WHERE id = $1`,
          [emailRecord.id, result.id, subject, body]
        );
        await this.pool.query(
          `UPDATE outreach_campaigns SET total_sent = total_sent + 1, updated_at = NOW() WHERE id = $1`,
          [campaign.id]
        );

        // Store unsubscribe token on the email record for lookup when they click
        await this.pool.query(
          `UPDATE outreach_emails SET unsubscribe_token = $2 WHERE id = $1`,
          [emailRecord.id, unsubToken]
        ).catch(() => {});

        // CASL compliance: track first contact timestamp for 2-year expiry
        if (emailRecord.recipient_type === 'cpa' && emailRecord.recipient_id) {
          await this.pool.query(
            `UPDATE scraped_cpas SET first_contacted_at = NOW() WHERE id = $1 AND first_contacted_at IS NULL`,
            [emailRecord.recipient_id]
          ).catch(() => {});
        }
      } else {
        // Increment retry count; mark as 'failed' after 5 attempts
        const retries = (emailRecord.retry_count || 0) + 1;
        if (retries >= 5) {
          await this.pool.query(
            `UPDATE outreach_emails SET status = 'failed', retry_count = $2, updated_at = NOW() WHERE id = $1`,
            [emailRecord.id, retries]
          );
          console.error(`[Outreach] Permanently failed after ${retries} attempts: ${emailRecord.recipient_email} (${result.reason})`);
        } else {
          await this.pool.query(
            `UPDATE outreach_emails SET retry_count = $2, updated_at = NOW() WHERE id = $1`,
            [emailRecord.id, retries]
          );
          console.warn(`[Outreach] Retry ${retries}/5 for ${emailRecord.recipient_email}: ${result.reason}`);
        }
      }
    } catch (error) {
      console.error(`[Outreach] Send error for email ${emailRecord.id}:`, error.message);
    }
  }

  // =====================================================
  // ZEROBOUNCE EMAIL VALIDATION
  // =====================================================

  async _validateEmail(email, options = {}) {
    const apiKey = process.env.ZEROBOUNCE_API_KEY;
    if (!apiKey) return { valid: true, status: 'skipped', sub_status: '' };

    // Pre-filter role-based emails — saves ZeroBounce credits
    // Skip for demand-side campaigns where role-based is valid
    if (!options.skipRoleBased && isRoleBasedEmail(email)) {
      console.log(`[Outreach] Role-based email skipped (no ZB credit used): ${email}`);
      // Cache as do_not_mail so downstream code treats it consistently
      try {
        await this.pool.query(
          `INSERT INTO email_validations (email, status, sub_status) VALUES ($1, 'do_not_mail', 'role_based_pre_filter')
           ON CONFLICT (email) DO UPDATE SET status = 'do_not_mail', sub_status = 'role_based_pre_filter', validated_at = NOW()`,
          [email]
        );
      } catch (e) { /* cache save non-critical */ }
      return { valid: false, status: 'do_not_mail', sub_status: 'role_based_pre_filter' };
    }

    try {
      // Check cache first (valid for 30 days)
      const cached = await this.pool.query(
        `SELECT status, sub_status FROM email_validations WHERE email = $1 AND validated_at > NOW() - INTERVAL '30 days'`,
        [email]
      );
      if (cached.rows.length > 0) {
        const row = cached.rows[0];
        const valid = ['valid', 'catch-all', 'unknown'].includes(row.status);
        if (row.status === 'catch-all') {
          console.log(`[Outreach] Warning: catch-all email ${email} - monitoring bounce rate`);
        }
        console.log(`[Outreach] ZeroBounce (cached): ${email} → ${row.status}`);
        return { valid, status: row.status, sub_status: row.sub_status || '', catchAll: row.status === 'catch-all' };
      }

      // Call ZeroBounce API
      const https = require('https');
      const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&ip_address=`;

      const data = await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid ZeroBounce response')); }
          });
        }).on('error', reject);
      });

      const status = (data.status || 'unknown').toLowerCase();
      const sub_status = (data.sub_status || '').toLowerCase();

      // Cache result
      await this.pool.query(
        `INSERT INTO email_validations (email, status, sub_status) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET status = $2, sub_status = $3, validated_at = NOW()`,
        [email, status, sub_status]
      );

      const valid = ['valid', 'catch-all', 'unknown'].includes(status);
      if (status === 'catch-all') {
        console.log(`[Outreach] Warning: catch-all email ${email} - monitoring bounce rate`);
      }
      this.zbConsecutiveErrors = 0;
      console.log(`[Outreach] ZeroBounce: ${email} → ${status}${sub_status ? '/' + sub_status : ''}`);
      return { valid, status, sub_status, catchAll: status === 'catch-all' };
    } catch (err) {
      this.zbConsecutiveErrors++;
      console.error(`[Outreach] ZeroBounce error for ${email}: ${err.message} (consecutive: ${this.zbConsecutiveErrors})`);
      if (this.zbConsecutiveErrors >= 3) {
        console.warn(`[Outreach] ZeroBounce circuit breaker: ${this.zbConsecutiveErrors} consecutive errors — blocking email`);
        return { valid: false, status: 'validation_unavailable', sub_status: err.message };
      }
      return { valid: true, status: 'error', sub_status: err.message };
    }
  }

  // =====================================================
  // ZEROBOUNCE CREDIT CHECK
  // =====================================================

  async _checkZeroBounceCredits() {
    const apiKey = process.env.ZEROBOUNCE_API_KEY;
    if (!apiKey) return { available: true, credits: null };

    // Cache credits for 1 hour
    if (this.zbCreditsRemaining !== null && this.zbCreditsCheckedAt &&
        (Date.now() - this.zbCreditsCheckedAt) < 3600000) {
      return { available: this.zbCreditsRemaining >= 100, credits: this.zbCreditsRemaining };
    }

    try {
      const https = require('https');
      const url = `https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(apiKey)}`;

      const data = await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid ZeroBounce credits response')); }
          });
        }).on('error', reject);
      });

      const credits = parseInt(data.Credits, 10) || 0;
      this.zbCreditsRemaining = credits;
      this.zbCreditsCheckedAt = Date.now();
      console.log(`[Outreach] ZeroBounce credits remaining: ${credits}`);

      if (credits < 100) {
        console.warn(`[Outreach] ZeroBounce credits low (${credits}) — falling back to sending without pre-validation`);
        return { available: false, credits };
      }

      return { available: true, credits };
    } catch (err) {
      console.error(`[Outreach] ZeroBounce credit check failed: ${err.message}`);
      return { available: false, credits: null };
    }
  }

  async _validateEmailForQueue(email, options = {}) {
    const apiKey = process.env.ZEROBOUNCE_API_KEY;
    if (!apiKey) return { valid: true, status: 'skipped', sub_status: '' };

    // Check credits first
    const creditCheck = await this._checkZeroBounceCredits();
    if (!creditCheck.available) {
      console.log(`[Outreach] Skipping pre-validation for ${email} — insufficient ZeroBounce credits`);
      return { valid: true, status: 'credits_low', sub_status: '' };
    }

    // Use the existing _validateEmail method (which has caching built in)
    const result = await this._validateEmail(email, options);

    // Decrement cached credits if we made an actual API call (not cached)
    if (result.status !== 'skipped' && result.status !== 'error' &&
        result.status !== 'validation_unavailable' && this.zbCreditsRemaining !== null) {
      // Only decrement if this was a fresh API call (check if it was cached)
      const cached = await this.pool.query(
        `SELECT validated_at FROM email_validations WHERE email = $1`,
        [email]
      );
      // If validated in last 2 seconds, it was likely a fresh call
      if (cached.rows.length > 0) {
        const validatedAt = new Date(cached.rows[0].validated_at);
        if ((Date.now() - validatedAt.getTime()) < 2000) {
          this.zbCreditsRemaining = Math.max(0, this.zbCreditsRemaining - 1);
        }
      }
    }

    return result;
  }

  // =====================================================
  // TEMPLATE RENDERER
  // =====================================================

  async _renderTemplate(campaign, emailRecord, unsubToken) {
    let subject = campaign.subject_template;
    // A/B subject line testing: use variant subject if assigned
    if (emailRecord.variant_index > 0 && campaign.subject_variants && campaign.subject_variants[emailRecord.variant_index - 1]) {
      subject = campaign.subject_variants[emailRecord.variant_index - 1];
    }
    // Follow-up subject override — unique angles per step (avoids spam-signal "Following up:" prefix)
    if (emailRecord.sequence_number > 1 && campaign.follow_up_subjects && Array.isArray(campaign.follow_up_subjects)) {
      const fuSubject = campaign.follow_up_subjects[emailRecord.sequence_number - 2];
      if (fuSubject) subject = fuSubject;
      // else fall through to generic per-step subjects below
    }
    if (emailRecord.sequence_number > 1 && !campaign.follow_up_subjects?.[emailRecord.sequence_number - 2]) {
      const stepFallbacks = [
        'Quick question about your practice in {{city}}',
        'Your {{province}} profile — last reminder',
        '{{first_name}}, businesses in {{city}} are searching now',
        'Last note about your CanadaAccountants profile'
      ];
      subject = stepFallbacks[emailRecord.sequence_number - 2] || subject;
    }
    let body = campaign.body_template;

    const vars = {};

    // Build unsubscribe URL from token (template footer has {{unsubscribe_url}})
    if (unsubToken) {
      vars.unsubscribe_url = `${BACKEND_URL}/api/unsubscribe/${unsubToken}`;
    } else {
      vars.unsubscribe_url = `${FRONTEND_URL}/unsubscribe`;
    }

    if (campaign.type === 'cpa' && emailRecord.recipient_type === 'cpa') {
      // Get CPA data
      const cpa = await this.pool.query('SELECT * FROM scraped_cpas WHERE id = $1', [emailRecord.recipient_id]);
      if (cpa.rows[0]) {
        const c = cpa.rows[0];
        vars.cpa_name = emailRecord.recipient_name || c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
        vars.city = c.city || '';
        vars.province = c.province || '';
        vars.firm_name = c.firm_name || '';
        vars.firm_name_line = c.firm_name ? ` (listed under ${c.firm_name})` : '';

        // Get real SME count in their area
        const smeCount = await this.pool.query(
          `SELECT COUNT(*) FROM scraped_smes WHERE province = $1 AND status != 'invalid'`,
          [c.province]
        );
        vars.sme_count = smeCount.rows[0].count || '0';

        // Get total CPAs count for social proof
        const totalCpas = await this.pool.query('SELECT COUNT(*) FROM scraped_cpas');
        vars.total_cpas = parseInt(totalCpas.rows[0].count).toLocaleString('en-CA');

        // Get active friction requests count
        const activeRequests = await this.pool.query(
          `SELECT COUNT(*) FROM sme_friction_requests WHERE created_at >= NOW() - INTERVAL '90 days'`
        );
        vars.active_requests = activeRequests.rows[0].count || '0';
      }
    } else if (campaign.type === 'sme' && emailRecord.recipient_type === 'sme') {
      // Get SME data
      const sme = await this.pool.query('SELECT * FROM scraped_smes WHERE id = $1', [emailRecord.recipient_id]);
      if (sme.rows[0]) {
        const s = sme.rows[0];
        vars.business_name = s.business_name || '';
        vars.industry = s.industry || '';
        vars.province = s.province || '';

        // Get CPA count in their province
        const cpaCount = await this.pool.query(
          `SELECT COUNT(*) FROM scraped_cpas WHERE province = $1 AND status != 'invalid'`,
          [s.province]
        );
        vars.cpa_count = cpaCount.rows[0].count || '0';
      }
    }

    // Replace variables
    for (const [key, val] of Object.entries(vars)) {
      const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      subject = subject.replace(re, val);
      body = body.replace(re, val);
    }

    // Replace platform URL and year
    body = body.replace(/\{\{platform_url\}\}/g, FRONTEND_URL);
    subject = subject.replace(/\{\{platform_url\}\}/g, FRONTEND_URL);
    body = body.replace(/\{\{current_year\}\}/g, new Date().getFullYear().toString());

    // Append ref tracking token to CTA links for conversion attribution
    if (unsubToken) {
      body = body.replace(
        /href="https:\/\/canadaaccountants\.app\/(join-as-cpa|claim-profile)"/g,
        `href="https://canadaaccountants.app/profile?id=${emailRecord.recipient_id}&ref=${unsubToken}"`
      );
    }

    // Safety net: strip any unreplaced {{variables}} so raw code never shows in emails
    subject = subject.replace(/\{\{[a-z_]+\}\}/g, '');
    body = body.replace(/\{\{[a-z_]+\}\}/g, '');

    return { subject, body };
  }

  async previewTemplate(campaignId) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    // Use sample data for preview
    // Get real total CPA count for social proof
    let totalCpasCount = '94,517';
    try {
      const totalCpas = await this.pool.query('SELECT COUNT(*) FROM scraped_cpas');
      totalCpasCount = parseInt(totalCpas.rows[0].count).toLocaleString('en-CA');
    } catch (e) { /* fallback */ }

    const sampleVars = campaign.type === 'cpa'
      ? { cpa_name: 'Jane Smith', city: 'Vancouver', province: 'BC', firm_name: 'Smith & Associates', firm_name_line: ' (listed under Smith & Associates)', sme_count: '1,247', total_cpas: totalCpasCount, active_requests: '38' }
      : { business_name: 'Maple Tech Solutions Inc.', industry: 'Technology', province: 'ON', cpa_count: '3,845' };

    let subject = campaign.subject_template;
    let body = campaign.body_template;

    for (const [key, val] of Object.entries(sampleVars)) {
      const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      subject = subject.replace(re, val);
      body = body.replace(re, val);
    }
    body = body.replace(/\{\{platform_url\}\}/g, FRONTEND_URL);

    return { subject, body };
  }

  async testSend(campaignId, testEmail) {
    const { subject, body } = await this.previewTemplate(campaignId);
    const result = await sendEmail({
      to: testEmail,
      subject: `[TEST] ${subject}`,
      html: body,
      from: OUTREACH_FROM,
    });
    return result;
  }

  // =====================================================
  // RESEND WEBHOOK HANDLER
  // =====================================================

  async handleResendWebhook(event) {
    const { type, data } = event;
    const emailId = data?.email_id;

    if (!emailId) return;

    console.log(`[Outreach] Webhook: ${type} for ${emailId}`);

    // Find the outreach email by resend_email_id
    const emailResult = await this.pool.query(
      `SELECT * FROM outreach_emails WHERE resend_email_id = $1`,
      [emailId]
    );

    if (emailResult.rows.length === 0) return;

    const outreachEmail = emailResult.rows[0];
    const campaignId = outreachEmail.campaign_id;

    const statusMap = {
      'email.delivered': 'delivered',
      'email.opened': 'opened',
      'email.clicked': 'clicked',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
    };

    const newStatus = statusMap[type];
    if (!newStatus) return;

    const timestampCol = `${newStatus}_at`;

    // Bot click detection: clicks within 60s of delivery are almost certainly email security scanners
    let isBotClick = false;
    if (newStatus === 'clicked' && outreachEmail.delivered_at) {
      const deliveredAt = new Date(outreachEmail.delivered_at).getTime();
      const now = Date.now();
      const secondsSinceDelivery = (now - deliveredAt) / 1000;
      if (secondsSinceDelivery < 60) {
        isBotClick = true;
        console.log(`[Outreach] Bot click detected: ${outreachEmail.recipient_email} clicked ${secondsSinceDelivery.toFixed(0)}s after delivery — flagging`);
      }
    }

    // Only update if the new status is "later" in the lifecycle
    const statusOrder = ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'];
    const currentIdx = statusOrder.indexOf(outreachEmail.status);
    const newIdx = statusOrder.indexOf(newStatus);

    // Allow update for bounced/complained from any state, or for "forward" progression
    if (newStatus === 'bounced' || newStatus === 'complained' || newIdx > currentIdx) {
      await this.pool.query(
        `UPDATE outreach_emails SET status = $2, ${timestampCol} = NOW()${isBotClick ? ', is_bot_click = true' : ''} WHERE id = $1`,
        [outreachEmail.id, newStatus]
      );
    } else if (newStatus === 'opened' || newStatus === 'clicked') {
      // For opens/clicks, update the timestamp even if already in that status
      await this.pool.query(
        `UPDATE outreach_emails SET ${timestampCol} = NOW()${isBotClick ? ', is_bot_click = true' : ''} WHERE id = $1`,
        [outreachEmail.id]
      );
    }

    // Update campaign counters
    const counterMap = {
      'delivered': 'total_delivered',
      'opened': 'total_opened',
      'clicked': 'total_clicked',
      'bounced': 'total_bounced',
      'complained': 'total_complained',
    };
    const counterCol = counterMap[newStatus];
    // Don't increment click counter for bot clicks
    if (counterCol && newIdx > currentIdx && !(isBotClick && newStatus === 'clicked')) {
      await this.pool.query(
        `UPDATE outreach_campaigns SET ${counterCol} = ${counterCol} + 1, updated_at = NOW() WHERE id = $1`,
        [campaignId]
      );
    }

    // Auto-unsubscribe on bounce or complaint
    if (newStatus === 'bounced' || newStatus === 'complained') {
      await this.pool.query(
        `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at) VALUES ($1, $2, NOW()) ON CONFLICT (email) DO NOTHING`,
        [outreachEmail.recipient_email, newStatus]
      );
    }
  }

  // =====================================================
  // UNSUBSCRIBE
  // =====================================================

  async getUnsubscribeInfo(token) {
    // Look up by stored unsubscribe_token first (fast), fallback to body search
    let result = await this.pool.query(
      `SELECT recipient_email, recipient_name FROM outreach_emails WHERE unsubscribe_token = $1 LIMIT 1`,
      [token]
    );
    if (result.rows.length === 0) {
      // Fallback for emails sent before token column was added
      result = await this.pool.query(
        `SELECT recipient_email, recipient_name FROM outreach_emails WHERE rendered_body LIKE $1 LIMIT 1`,
        [`%${token}%`]
      );
    }
    if (result.rows.length > 0) {
      return { email: result.rows[0].recipient_email, name: result.rows[0].recipient_name };
    }
    return null;
  }

  async processUnsubscribe(token, reason) {
    const info = await this.getUnsubscribeInfo(token);
    if (!info) return false;

    await this.pool.query(
      `INSERT INTO outreach_unsubscribes (email, unsubscribe_token, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET reason = $3, unsubscribed_at = NOW()`,
      [info.email, token, reason || 'user_request']
    );
    return true;
  }

  // =====================================================
  // CONVERSION TRACKING
  // =====================================================

  async trackConversion(email, userId, refToken = null) {
    // First try: lookup by ref token (most precise — links to exact outreach email)
    if (refToken) {
      const refResult = await this.pool.query(
        `SELECT oe.id, oe.campaign_id FROM outreach_emails oe
         WHERE oe.unsubscribe_token = $1 AND oe.converted = false
         ORDER BY oe.sent_at DESC LIMIT 1`,
        [refToken]
      );

      if (refResult.rows.length > 0) {
        const outreachEmail = refResult.rows[0];
        await this.pool.query(
          `UPDATE outreach_emails SET converted = true, converted_at = NOW(), converted_user_id = $2 WHERE id = $1`,
          [outreachEmail.id, userId]
        );
        await this.pool.query(
          `UPDATE outreach_campaigns SET total_converted = total_converted + 1, updated_at = NOW() WHERE id = $1`,
          [outreachEmail.campaign_id]
        );
        console.log(`[Outreach] Conversion tracked via ref token: ${email} -> user ${userId} (campaign ${outreachEmail.campaign_id})`);
        return true;
      }
    }

    // Fallback: lookup by email address
    const result = await this.pool.query(
      `SELECT oe.id, oe.campaign_id FROM outreach_emails oe
       WHERE oe.recipient_email = $1 AND oe.converted = false
       ORDER BY oe.sent_at DESC LIMIT 1`,
      [email]
    );

    if (result.rows.length > 0) {
      const outreachEmail = result.rows[0];
      await this.pool.query(
        `UPDATE outreach_emails SET converted = true, converted_at = NOW(), converted_user_id = $2 WHERE id = $1`,
        [outreachEmail.id, userId]
      );
      await this.pool.query(
        `UPDATE outreach_campaigns SET total_converted = total_converted + 1, updated_at = NOW() WHERE id = $1`,
        [outreachEmail.campaign_id]
      );
      console.log(`[Outreach] Conversion tracked via email: ${email} -> user ${userId} (campaign ${outreachEmail.campaign_id})`);
      return true;
    }

    return false;
  }

  // =====================================================
  // RECONCILIATION — bulk status sync from Resend API
  // =====================================================

  async reconcileStatuses() {
    if (!this.resend) throw new Error('Resend API key not configured');

    const emails = await this.pool.query(
      `SELECT id, resend_email_id, status, campaign_id, recipient_email
       FROM outreach_emails
       WHERE resend_email_id IS NOT NULL
         AND status IN ('sent', 'delivered')
         AND sent_at >= NOW() - INTERVAL '30 days'
       ORDER BY sent_at DESC`
    );

    console.log(`[Outreach] Reconciling ${emails.rows.length} emails...`);
    let reconciled = 0;
    let updated = 0;
    const statuses = {};

    for (const email of emails.rows) {
      try {
        const { data } = await this.resend.emails.get(email.resend_email_id);
        reconciled++;
        if (!data || !data.last_event) continue;

        const event = data.last_event;
        const eventToStatus = { delivered: 'delivered', opened: 'opened', clicked: 'clicked', bounced: 'bounced', complained: 'complained' };
        const newStatus = eventToStatus[event];
        if (!newStatus) continue;

        statuses[newStatus] = (statuses[newStatus] || 0) + 1;

        const statusOrder = ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'];
        const currentIdx = statusOrder.indexOf(email.status);
        const newIdx = statusOrder.indexOf(newStatus);

        if (newStatus === 'bounced' || newStatus === 'complained' || newIdx > currentIdx) {
          await this.pool.query(
            `UPDATE outreach_emails SET status = $2, updated_at = NOW() WHERE id = $1`,
            [email.id, newStatus]
          );

          const counterMap = { delivered: 'total_delivered', opened: 'total_opened', clicked: 'total_clicked', bounced: 'total_bounced', complained: 'total_complained' };
          if (counterMap[newStatus]) {
            await this.pool.query(
              `UPDATE outreach_campaigns SET ${counterMap[newStatus]} = ${counterMap[newStatus]} + 1, updated_at = NOW() WHERE id = $1`,
              [email.campaign_id]
            );
          }

          if (newStatus === 'bounced' || newStatus === 'complained') {
            await this.pool.query(
              `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at) VALUES ($1, $2, NOW()) ON CONFLICT (email) DO NOTHING`,
              [email.recipient_email, newStatus]
            );
          }
          updated++;
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        // Skip individual errors
      }
    }

    console.log(`[Outreach] Reconciliation complete: ${reconciled} checked, ${updated} updated`);
    return { reconciled, updated, statuses };
  }

  // =====================================================
  // QUEUE VALIDATION
  // =====================================================

  async validateQueued() {
    const queued = await this.pool.query(
      `SELECT id, recipient_email FROM outreach_emails WHERE status = 'queued' ORDER BY queued_at ASC`
    );

    let valid = 0, invalid = 0, errors = 0;

    for (const row of queued.rows) {
      try {
        const result = await this._validateEmail(row.recipient_email);

        if (result.status === 'skipped') { valid++; }
        else if (result.status !== 'error' && result.status !== 'validation_unavailable') {
          if (result.valid) { valid++; }
          else {
            invalid++;
            await this.pool.query(
              `UPDATE outreach_emails SET status = 'failed', updated_at = NOW() WHERE id = $1`,
              [row.id]
            );
          }
        } else {
          errors++;
        }
      } catch (err) {
        errors++;
        console.error(`[Outreach] Validate error for ${row.recipient_email}:`, err.message);
      }

      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[Outreach] Queue validation complete: ${valid} valid, ${invalid} invalid, ${errors} errors out of ${queued.rows.length}`);
    return { total: queued.rows.length, valid, invalid, errors };
  }

  // =====================================================
  // BOUNCE RATE CIRCUIT BREAKER
  // =====================================================

  async _checkBounceRate() {
    try {
      const result = await this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
          COUNT(*) AS total
        FROM outreach_emails
        WHERE sent_at >= NOW() - INTERVAL '2 hours'
          AND status IN ('sent','delivered','opened','clicked','bounced','complained')
      `);

      const bounced = parseInt(result.rows[0].bounced, 10);
      const total = parseInt(result.rows[0].total, 10);

      if (total < 50) {
        return { bounceRate: total > 0 ? bounced / total : 0, paused: false, reason: 'insufficient_volume' };
      }

      const bounceRate = bounced / total;

      if (bounceRate > 0.10) {
        console.error(`[Outreach] BOUNCE RATE CIRCUIT BREAKER: ${(bounceRate * 100).toFixed(1)}% bounce rate (${bounced}/${total} in 24h) — pausing ALL active campaigns`);

        // Pause all active campaigns
        await this.pool.query(
          `UPDATE outreach_campaigns SET status = 'paused', paused_at = NOW(), updated_at = NOW() WHERE status = 'active'`
        );

        // Send admin alert
        const adminEmail = process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com';
        try {
          await sendEmail({
            to: adminEmail,
            subject: '[CanadaAccountants] ALERT: Bounce rate circuit breaker triggered',
            html: `<h2>Bounce Rate Circuit Breaker Triggered</h2>
              <p><strong>Bounce rate:</strong> ${(bounceRate * 100).toFixed(1)}% (${bounced} bounced out of ${total} sent in last 24h)</p>
              <p><strong>Threshold:</strong> 5%</p>
              <p><strong>Action taken:</strong> All active campaigns have been automatically paused.</p>
              <p>Please investigate the bounce reasons and resume campaigns manually once resolved.</p>
              <p style="color:#999;font-size:12px;">This is an automated alert from the CanadaAccountants outreach engine.</p>`,
          });
          console.log(`[Outreach] Bounce rate alert sent to ${adminEmail}`);
        } catch (emailErr) {
          console.error(`[Outreach] Failed to send bounce rate alert: ${emailErr.message}`);
        }

        return { bounceRate, paused: true };
      }

      return { bounceRate, paused: false };
    } catch (err) {
      console.error('[Outreach] Bounce rate check error:', err.message);
      return { bounceRate: 0, paused: false, error: err.message };
    }
  }

  // =====================================================
  // STATS
  // =====================================================

  async getOverallStats() {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*) FROM outreach_campaigns) AS total_campaigns,
        (SELECT COUNT(*) FROM outreach_campaigns WHERE status = 'active') AS active_campaigns,
        (SELECT COALESCE(SUM(total_sent), 0) FROM outreach_campaigns) AS total_sent,
        (SELECT COALESCE(SUM(total_delivered), 0) FROM outreach_campaigns) AS total_delivered,
        (SELECT COALESCE(SUM(total_opened), 0) FROM outreach_campaigns) AS total_opened,
        (SELECT COALESCE(SUM(total_clicked), 0) FROM outreach_campaigns) AS total_clicked,
        (SELECT COALESCE(SUM(total_bounced), 0) FROM outreach_campaigns) AS total_bounced,
        (SELECT COALESCE(SUM(total_converted), 0) FROM outreach_campaigns) AS total_converted,
        (SELECT COUNT(*) FROM outreach_unsubscribes WHERE reason = 'user_request') AS total_unsubscribes,
        (SELECT COUNT(*) FROM outreach_unsubscribes WHERE reason IN ('bounced', 'complained')) AS total_bounce_unsubs,
        (SELECT COUNT(*) FROM scraped_cpas) AS total_scraped_cpas,
        (SELECT COUNT(*) FROM scraped_cpas WHERE COALESCE(enriched_email, email) IS NOT NULL) AS cpas_with_email,
        (SELECT COUNT(*) FROM scraped_smes) AS total_scraped_smes,
        (SELECT COUNT(*) FROM scraped_smes WHERE contact_email IS NOT NULL) AS smes_with_email
    `);
    return result.rows[0];
  }

  // =====================================================
  // A/B VARIANT STATS
  // =====================================================

  async getVariantStats(campaignId) {
    const result = await this.pool.query(
      `SELECT
        COALESCE(variant_index, 0) AS variant_index,
        COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','bounced','complained')) AS sent,
        COUNT(*) FILTER (WHERE status IN ('delivered','opened','clicked')) AS delivered,
        COUNT(*) FILTER (WHERE status IN ('opened','clicked')) AS opened,
        COUNT(*) FILTER (WHERE status = 'clicked') AS clicked,
        COUNT(*) FILTER (WHERE status = 'bounced') AS bounced
      FROM outreach_emails
      WHERE campaign_id = $1
      GROUP BY COALESCE(variant_index, 0)
      ORDER BY COALESCE(variant_index, 0)`,
      [campaignId]
    );

    const campaign = await this.getCampaign(campaignId);
    const variants = result.rows.map(row => {
      const idx = parseInt(row.variant_index, 10);
      let subjectLabel = idx === 0 ? (campaign?.subject_template || 'Original') : 'Unknown';
      if (idx > 0 && campaign?.subject_variants && campaign.subject_variants[idx - 1]) {
        subjectLabel = campaign.subject_variants[idx - 1];
      }
      return {
        variant_index: idx,
        subject: subjectLabel,
        sent: parseInt(row.sent, 10),
        delivered: parseInt(row.delivered, 10),
        opened: parseInt(row.opened, 10),
        clicked: parseInt(row.clicked, 10),
        bounced: parseInt(row.bounced, 10),
        open_rate: parseInt(row.delivered, 10) > 0 ? (parseInt(row.opened, 10) / parseInt(row.delivered, 10) * 100).toFixed(1) + '%' : '0.0%',
        click_rate: parseInt(row.delivered, 10) > 0 ? (parseInt(row.clicked, 10) / parseInt(row.delivered, 10) * 100).toFixed(1) + '%' : '0.0%',
      };
    });

    return variants;
  }
}

// =====================================================
// DEFAULT EMAIL TEMPLATES
// =====================================================

const CPA_ACQUISITION_TEMPLATE = buildClaimEmail({
  platformName: 'CanadaAccountants',
  tagline: 'CPA-Client Matching Platform',
  subject: 'Your CPA profile is live — claim it now',
  greeting: 'Hi {{cpa_name}},',
  bodyParagraphs: [
    'Your professional profile is now listed on <strong>CanadaAccountants.app</strong> — a platform where Canadian businesses search for and get matched with CPAs.',
    'Right now, your listing shows basic information pulled from your provincial CPA directory{{firm_name_line}}. Business owners in {{province}} are already using the platform to find accountants, and your profile is visible to them.',
    "<strong>Here's why that matters:</strong> unclaimed profiles show limited information. When a business searches for a CPA in {{city}}, they see your name — but not your specializations, availability, or what makes your practice different.",
  ],
  features: [
    { bold: 'Control your listing', text: 'add your specializations, bio, and credentials' },
    { bold: 'Receive AI-matched leads', text: 'get introduced to businesses that fit your practice' },
    { bold: 'Appear in priority search results', text: 'claimed profiles rank higher than unclaimed ones' },
    { bold: 'Build your verified trust profile', text: 'stand out from the {{total_cpas}}+ other CPAs listed' },
  ],
  closingLine: "Claiming takes under 2 minutes. You'll verify your identity and can immediately update what business owners see when they find you.",
  ctaUrl: 'https://canadaaccountants.app/claim-profile',
  privacyUrl: 'https://canadaaccountants.app/privacy-policy',
  copyrightName: 'CanadaAccountants.app',
});

const SME_ACQUISITION_TEMPLATE = {
  subject: '{{business_name}} — meet your matched CPA',
  body: `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2 style="color:#1e293b;">Hi there,</h2>
      <p>Canadian businesses spend <strong>months</strong> searching for the right CPA. That's time and money you can't afford to lose.</p>
      <p>CanadaAccountants is an AI-powered platform that matches {{industry}} businesses like {{business_name}} with pre-verified CPAs in <strong>under 24 hours</strong>.</p>
      <p>We've already onboarded <strong>{{cpa_count}} qualified CPAs</strong> in {{province}} — covering tax planning, bookkeeping, advisory, and more.</p>
      <div style="background:#f8fafc;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:0 0 12px 0;font-weight:bold;">What makes us different:</p>
        <ul style="margin:0;padding-left:20px;">
          <li><strong>AI-powered matching</strong> — not a generic directory, a precision match to your industry and needs</li>
          <li><strong>Pre-verified CPAs only</strong> — every professional is credential-checked</li>
          <li><strong>24-hour turnaround</strong> — submit your needs, get matched tomorrow</li>
          <li><strong>Built by a CPA</strong> — we understand what businesses actually need</li>
        </ul>
      </div>
      <p style="font-size:14px;color:#555;">There's no cost to your business — CPAs invest in the platform to reach qualified clients like you. Submit your needs and we'll personally match you with the right CPA for your situation.</p>
      <p style="text-align:center;margin:30px 0;">
        <a href="{{platform_url}}/find-cpa" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
          Get Matched With a CPA
        </a>
      </p>
      <p style="color:#666;font-size:14px;">Best regards,<br>Arthur Kostaras, CPA, CF<br>Founder, CanadaAccountants</p>
    </div>
  `
};

module.exports = { OutreachEngine, CPA_ACQUISITION_TEMPLATE, SME_ACQUISITION_TEMPLATE };
