const crypto = require('crypto');
const { Resend } = require('resend');
const { sendEmail } = require('./email');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://canadaaccountants.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://canadaaccountants-backend-production-1d8f.up.railway.app';

class OutreachEngine {
  constructor(pool) {
    this.pool = pool;
    this.processing = false;
    this.interval = null;
    this.resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    this.canPollStatus = null; // null = unknown, true/false after first check
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
    const allowed = ['name', 'subject_template', 'body_template', 'target_provinces', 'target_cities', 'target_naics_codes', 'daily_limit', 'total_limit'];
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

    if (campaign.type === 'cpa') {
      // Find scraped CPAs with email (direct or enriched) not already in this campaign
      let query = `
        SELECT sc.id, sc.first_name, sc.last_name, sc.full_name, sc.city, sc.province, sc.firm_name,
               COALESCE(sc.enriched_email, sc.email) AS email
        FROM scraped_cpas sc
        WHERE COALESCE(sc.enriched_email, sc.email) IS NOT NULL
          AND sc.status != 'invalid'
          AND COALESCE(sc.enriched_email, sc.email) NOT IN (SELECT email FROM outreach_unsubscribes)
          AND sc.id NOT IN (SELECT recipient_id FROM outreach_emails WHERE campaign_id = $1 AND recipient_type = 'cpa')
      `;
      const params = [campaign.id];
      let paramIdx = 2;

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
        const name = cpa.full_name || `${cpa.first_name || ''} ${cpa.last_name || ''}`.trim();
        await this.pool.query(
          `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, status)
           VALUES ($1, 'cpa', $2, $3, $4, 'queued')`,
          [campaign.id, cpa.id, cpa.email, name]
        );
        queued++;
      }
    } else if (campaign.type === 'sme') {
      let query = `
        SELECT ss.id, ss.business_name, ss.province, ss.city, ss.industry,
               COALESCE(ss.contact_email) AS email, ss.contact_name
        FROM scraped_smes ss
        WHERE ss.contact_email IS NOT NULL
          AND ss.status != 'invalid'
          AND ss.contact_email NOT IN (SELECT email FROM outreach_unsubscribes)
          AND ss.id NOT IN (SELECT recipient_id FROM outreach_emails WHERE campaign_id = $1 AND recipient_type = 'sme')
      `;
      const params = [campaign.id];
      let paramIdx = 2;

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
        await this.pool.query(
          `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, status)
           VALUES ($1, 'sme', $2, $3, $4, 'queued')`,
          [campaign.id, sme.id, sme.email, sme.contact_name || sme.business_name]
        );
        queued++;
      }
    }

    return queued;
  }

  // =====================================================
  // QUEUE PROCESSOR — runs every 5 minutes
  // =====================================================

  startQueueProcessor() {
    this.interval = setInterval(() => this.processQueue(), 5 * 60 * 1000);
    console.log('[Outreach] Queue processor started (every 5 min)');
  }

  stopQueueProcessor() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      // Get active campaigns
      const campaigns = await this.pool.query(
        `SELECT * FROM outreach_campaigns WHERE status = 'active'`
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
      // Poll Resend for delivery status of recently sent emails
      await this._pollEmailStatuses();
    } catch (error) {
      console.error('[Outreach] Queue processing error:', error.message);
    } finally {
      this.processing = false;
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

            if (newStatus === 'complained') {
              await this.pool.query(
                `INSERT INTO outreach_unsubscribes (email, reason) VALUES ($1, 'complaint') ON CONFLICT (email) DO NOTHING`,
                [email.recipient_email]
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
    }
    return 0;
  }

  async _sendOutreachEmail(campaign, emailRecord) {
    try {
      // Render template
      const { subject, body } = await this._renderTemplate(campaign, emailRecord);

      // Add unsubscribe link
      const unsubToken = crypto.randomBytes(24).toString('hex');
      const unsubUrl = `${BACKEND_URL}/api/unsubscribe/${unsubToken}`;
      const bodyWithUnsub = body + `
        <hr style="margin-top:40px;border:none;border-top:1px solid #ddd;">
        <p style="font-size:12px;color:#999;margin-top:16px;">
          You're receiving this because your professional profile was found in a Canadian CPA or business directory.
          <br><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a> from future emails.
        </p>
      `;

      // Send via Resend
      const result = await sendEmail({
        to: emailRecord.recipient_email,
        subject,
        html: bodyWithUnsub,
      });

      if (result.success) {
        await this.pool.query(
          `UPDATE outreach_emails SET status = 'sent', sent_at = NOW(), resend_email_id = $2, rendered_subject = $3, rendered_body = $4 WHERE id = $1`,
          [emailRecord.id, result.id, subject, bodyWithUnsub]
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
  // TEMPLATE RENDERER
  // =====================================================

  async _renderTemplate(campaign, emailRecord) {
    let subject = campaign.subject_template;
    let body = campaign.body_template;

    const vars = {};

    if (campaign.type === 'cpa' && emailRecord.recipient_type === 'cpa') {
      // Get CPA data
      const cpa = await this.pool.query('SELECT * FROM scraped_cpas WHERE id = $1', [emailRecord.recipient_id]);
      if (cpa.rows[0]) {
        const c = cpa.rows[0];
        vars.cpa_name = emailRecord.recipient_name || c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
        vars.city = c.city || '';
        vars.province = c.province || '';
        vars.firm_name = c.firm_name || '';

        // Get real SME count in their area
        const smeCount = await this.pool.query(
          `SELECT COUNT(*) FROM scraped_smes WHERE province = $1 AND status != 'invalid'`,
          [c.province]
        );
        vars.sme_count = smeCount.rows[0].count || '0';

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

    // Replace platform URL
    body = body.replace(/\{\{platform_url\}\}/g, FRONTEND_URL);
    subject = subject.replace(/\{\{platform_url\}\}/g, FRONTEND_URL);

    return { subject, body };
  }

  async previewTemplate(campaignId) {
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    // Use sample data for preview
    const sampleVars = campaign.type === 'cpa'
      ? { cpa_name: 'Jane Smith', city: 'Vancouver', province: 'BC', firm_name: 'Smith & Associates', sme_count: '1,247', active_requests: '38' }
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

    // Only update if the new status is "later" in the lifecycle
    const statusOrder = ['queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'];
    const currentIdx = statusOrder.indexOf(outreachEmail.status);
    const newIdx = statusOrder.indexOf(newStatus);

    // Allow update for bounced/complained from any state, or for "forward" progression
    if (newStatus === 'bounced' || newStatus === 'complained' || newIdx > currentIdx) {
      await this.pool.query(
        `UPDATE outreach_emails SET status = $2, ${timestampCol} = NOW() WHERE id = $1`,
        [outreachEmail.id, newStatus]
      );
    } else if (newStatus === 'opened' || newStatus === 'clicked') {
      // For opens/clicks, update the timestamp even if already in that status
      await this.pool.query(
        `UPDATE outreach_emails SET ${timestampCol} = NOW() WHERE id = $1`,
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
    if (counterCol && newIdx > currentIdx) {
      await this.pool.query(
        `UPDATE outreach_campaigns SET ${counterCol} = ${counterCol} + 1, updated_at = NOW() WHERE id = $1`,
        [campaignId]
      );
    }

    // Auto-unsubscribe on complaint
    if (newStatus === 'complained') {
      await this.pool.query(
        `INSERT INTO outreach_unsubscribes (email, reason) VALUES ($1, 'complaint') ON CONFLICT (email) DO NOTHING`,
        [outreachEmail.recipient_email]
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

  async trackConversion(email, userId) {
    // Check if this email matches any outreach records
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

      console.log(`[Outreach] Conversion tracked: ${email} -> user ${userId} (campaign ${outreachEmail.campaign_id})`);
      return true;
    }

    return false;
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
        (SELECT COUNT(*) FROM outreach_unsubscribes WHERE reason != 'pending') AS total_unsubscribes,
        (SELECT COUNT(*) FROM scraped_cpas) AS total_scraped_cpas,
        (SELECT COUNT(*) FROM scraped_cpas WHERE COALESCE(enriched_email, email) IS NOT NULL) AS cpas_with_email,
        (SELECT COUNT(*) FROM scraped_smes) AS total_scraped_smes,
        (SELECT COUNT(*) FROM scraped_smes WHERE contact_email IS NOT NULL) AS smes_with_email
    `);
    return result.rows[0];
  }
}

// =====================================================
// DEFAULT EMAIL TEMPLATES
// =====================================================

const CPA_ACQUISITION_TEMPLATE = {
  subject: '{{sme_count}} businesses in {{province}} are looking for a CPA — are you available?',
  body: `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2 style="color:#1e293b;">Hi {{cpa_name}},</h2>
      <p>The average Canadian SME spends <strong>585 days</strong> searching for the right accountant. Meanwhile, qualified CPAs like you spend thousands on marketing that delivers inconsistent results.</p>
      <p>We built <strong>CanadaAccountants</strong> to solve both sides of that equation.</p>
      <p>Our AI-powered matching platform connects <strong>{{sme_count}} businesses</strong> in {{province}} directly with CPAs based on specialization, location, and client fit — eliminating the guesswork for both sides.</p>
      <div style="background:#f8fafc;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:0 0 12px 0;font-weight:bold;">What makes this different:</p>
        <ul style="margin:0;padding-left:20px;">
          <li><strong>AI-qualified leads</strong> — matched to your specialization, not random inquiries</li>
          <li><strong>Verified client demand</strong> — {{active_requests}} active requests from real business owners</li>
          <li><strong>Remote-friendly</strong> — serve clients in {{city}} or anywhere in Canada</li>
          <li><strong>Professional trust profile</strong> — verified credentials that set you apart</li>
        </ul>
      </div>
      <p>We're onboarding a limited number of CPAs per region to maintain match quality. If you'd like to be considered, you can apply below.</p>
      <p style="text-align:center;margin:30px 0;">
        <a href="{{platform_url}}/join-as-cpa.html" style="display:inline-block;background:#dc2626;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
          Apply to Join
        </a>
      </p>
      <p style="color:#666;font-size:14px;">Best regards,<br>Arthur Kostaras, CPA, CF<br>Founder, CanadaAccountants</p>
    </div>
  `
};

const SME_ACQUISITION_TEMPLATE = {
  subject: 'Stop wasting 585 days finding the right CPA',
  body: `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2 style="color:#1e293b;">Hi {{business_name}},</h2>
      <p>Finding the right CPA for your {{industry}} business shouldn't take <strong>585 days</strong> — but that's the Canadian average.</p>
      <p>CanadaAccountants uses AI to match your business with pre-verified CPAs in {{province}} in <strong>under 24 hours</strong>.</p>
      <p>There are <strong>{{cpa_count}} verified CPAs</strong> in {{province}} on our platform right now, specializing in everything from tax planning to advisory services.</p>
      <div style="background:#f8fafc;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:0 0 12px 0;font-weight:bold;">How it works:</p>
        <ol style="margin:0;padding-left:20px;">
          <li>Tell us about your business needs (2 minutes)</li>
          <li>Our AI matches you with the top 3 CPAs for your situation</li>
          <li>Connect directly — no middleman, no fees</li>
        </ol>
      </div>
      <p style="text-align:center;margin:30px 0;">
        <a href="{{platform_url}}/find-cpa.html" style="display:inline-block;background:#dc2626;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
          Find My CPA Match
        </a>
      </p>
      <p style="color:#666;font-size:14px;">Best regards,<br>Arthur Kostaras, CPA, CF<br>Founder, CanadaAccountants</p>
    </div>
  `
};

module.exports = { OutreachEngine, CPA_ACQUISITION_TEMPLATE, SME_ACQUISITION_TEMPLATE };
