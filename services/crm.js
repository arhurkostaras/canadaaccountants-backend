// CRM Pipeline Service — Phase 1: Pipeline Foundation
// Manages the 7-stage professional lifecycle: discovery → enrichment → validation → outreach → engagement → claimed → subscriber
// Also tracks: enrichment_failed, invalid, churned as terminal/retry states

const VALID_STATUSES = [
  'raw_import',         // 1. Discovery — entered DB via scraping
  'enriched',           // 2. Enrichment — Apollo found an email
  'enrichment_failed',  // 2b. Apollo failed — retry queue
  'validated',          // 3. Validation — ZeroBounce confirmed valid
  'invalid',            // 3b. ZeroBounce returned invalid/risky
  'contacted',          // 4. Outreach — first email sent
  'engaged',            // 5. Engagement — opened or clicked
  'claimed',            // 6. Claimed — registered on platform
  'subscriber',         // 7. Converted — paying Stripe subscriber
  'churned'             // 7b. Subscription canceled
];

// Legal state transitions — key: from_status, value: allowed to_statuses
const TRANSITIONS = {
  raw_import:        ['enriched', 'enrichment_failed', 'invalid'],
  enriched:          ['validated', 'invalid', 'engaged', 'contacted'],
  enrichment_failed: ['enriched', 'invalid', 'raw_import'],  // retry or give up
  validated:         ['contacted', 'invalid', 'engaged'],
  invalid:           ['raw_import'],                           // admin override to retry
  contacted:         ['engaged', 'contacted'],                 // re-contact allowed
  engaged:           ['claimed', 'engaged'],                   // multiple engagements ok
  claimed:           ['subscriber'],
  subscriber:        ['churned'],
  churned:           ['subscriber']                            // win-back
};

class CRMService {
  /**
   * @param {object} opts
   * @param {object} opts.db - pg Pool or Client
   * @param {string} opts.professionalsTable - e.g. 'scraped_advisors', 'scraped_lawyers', 'scraped_cpas'
   * @param {string} opts.platform - e.g. 'investing', 'lawyers', 'accountants'
   */
  constructor({ db, professionalsTable, platform }) {
    this.db = db;
    this.table = professionalsTable;
    this.platform = platform;
  }

  // ── Schema Migration ──────────────────────────────────────────────────

  async migrate() {
    console.log(`[CRM] Running migration for ${this.platform}...`);

    // 1. Add crm_status column to professionals table
    await this.db.query(`
      ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS crm_status VARCHAR(30) DEFAULT 'raw_import'
    `);

    // 2. Add crm_status_updated_at for tracking last transition
    await this.db.query(`
      ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS crm_status_updated_at TIMESTAMP WITH TIME ZONE
    `);

    // 3. Create pipeline events table (immutable log)
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS crm_pipeline_events (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        platform VARCHAR(30) NOT NULL,
        from_status VARCHAR(30),
        to_status VARCHAR(30) NOT NULL,
        triggered_by VARCHAR(30) NOT NULL DEFAULT 'system',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // 4. Create sequences table (for Phase 2)
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS crm_sequences (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(30) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        trigger_status VARCHAR(30),
        steps JSONB NOT NULL DEFAULT '[]',
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // 5. Create sequence enrollments table (for Phase 2)
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS crm_sequence_enrollments (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        sequence_id INTEGER NOT NULL REFERENCES crm_sequences(id),
        platform VARCHAR(30) NOT NULL,
        current_step INTEGER DEFAULT 0,
        next_send_at TIMESTAMP WITH TIME ZONE,
        enrolled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE,
        exit_reason VARCHAR(100),
        UNIQUE(professional_id, sequence_id, platform)
      )
    `);

    // 6. Create tags table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS crm_tags (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        platform VARCHAR(30) NOT NULL,
        tag VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(professional_id, platform, tag)
      )
    `);

    // 7. Create notes table
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS crm_notes (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        platform VARCHAR(30) NOT NULL,
        note TEXT NOT NULL,
        author VARCHAR(100) DEFAULT 'system',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // 8. Indexes
    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_crm_status ON ${this.table}(crm_status)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_crm_events_professional ON crm_pipeline_events(professional_id, created_at DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_crm_events_platform ON crm_pipeline_events(platform, created_at DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_crm_enrollments_next ON crm_sequence_enrollments(next_send_at) WHERE completed_at IS NULL`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_crm_tags_lookup ON crm_tags(professional_id, platform)`);

    console.log(`[CRM] Migration complete for ${this.platform}.`);
  }

  // ── Backfill ──────────────────────────────────────────────────────────

  async backfill() {
    console.log(`[CRM] Backfilling crm_status for ${this.platform}...`);

    // Determine column names based on platform
    const emailCol = 'enriched_email';
    const rawEmailCol = 'email';

    // 1. Professionals with a subscription → subscriber
    // Check if subscription table exists first
    const subTable = this.platform === 'investing' ? 'advisor_subscriptions'
      : this.platform === 'lawyers' ? 'lawyer_subscriptions'
      : 'cpa_subscriptions';

    try {
      const subCheck = await this.db.query(`
        SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)
      `, [subTable]);

      if (subCheck.rows[0].exists) {
        // Match by email — subscribers
        await this.db.query(`
          UPDATE ${this.table} p SET crm_status = 'subscriber', crm_status_updated_at = NOW()
          WHERE EXISTS (
            SELECT 1 FROM ${subTable} s
            WHERE s.email = COALESCE(p.enriched_email, p.email)
            AND s.status = 'active'
          ) AND (p.crm_status IS NULL OR p.crm_status = 'raw_import')
        `);
      }
    } catch (e) {
      console.log(`[CRM] Subscription table ${subTable} not found, skipping subscriber backfill`);
    }

    // 2. Professionals who have been sent outreach → contacted (at minimum)
    try {
      await this.db.query(`
        UPDATE ${this.table} p SET crm_status = 'contacted', crm_status_updated_at = NOW()
        WHERE EXISTS (
          SELECT 1 FROM outreach_emails oe
          WHERE oe.recipient_email = COALESCE(p.enriched_email, p.email)
          AND oe.status IN ('sent', 'delivered')
        ) AND (p.crm_status IS NULL OR p.crm_status = 'raw_import')
      `);
    } catch (e) {
      console.log(`[CRM] outreach_emails table not found, trying outreach_recipients`);
    }
    // Also check outreach_recipients (used by investing)
    try {
      await this.db.query(`
        UPDATE ${this.table} p SET crm_status = 'contacted', crm_status_updated_at = NOW()
        WHERE EXISTS (
          SELECT 1 FROM outreach_recipients r
          WHERE r.email = COALESCE(p.enriched_email, p.email)
          AND r.status IN ('sent', 'delivered')
        ) AND (p.crm_status IS NULL OR p.crm_status = 'raw_import')
      `);
    } catch (e) { /* outreach_recipients may not exist on all platforms */ }

    // 3. Professionals who opened/clicked → engaged
    try {
      await this.db.query(`
        UPDATE ${this.table} p SET crm_status = 'engaged', crm_status_updated_at = NOW()
        WHERE EXISTS (
          SELECT 1 FROM outreach_emails oe
          WHERE oe.recipient_email = COALESCE(p.enriched_email, p.email)
          AND oe.status IN ('opened', 'clicked')
        ) AND p.crm_status IN ('raw_import', 'enriched', 'validated', 'contacted')
      `);
    } catch (e) {
      console.log(`[CRM] Skipping outreach_emails engaged backfill`);
    }
    // Also check outreach_recipients for engaged (used by investing)
    try {
      await this.db.query(`
        UPDATE ${this.table} p SET crm_status = 'engaged', crm_status_updated_at = NOW()
        WHERE EXISTS (
          SELECT 1 FROM outreach_recipients r
          WHERE r.email = COALESCE(p.enriched_email, p.email)
          AND r.status IN ('opened', 'clicked')
        ) AND p.crm_status IN ('raw_import', 'enriched', 'validated', 'contacted')
      `);
    } catch (e) { /* outreach_recipients may not exist on all platforms */ }

    // 4. Professionals with enriched email but no outreach → enriched
    await this.db.query(`
      UPDATE ${this.table} SET crm_status = 'enriched', crm_status_updated_at = NOW()
      WHERE ${emailCol} IS NOT NULL AND ${emailCol} != ''
      AND (crm_status IS NULL OR crm_status = 'raw_import')
    `);

    // 5. Professionals marked invalid in existing status → invalid
    await this.db.query(`
      UPDATE ${this.table} SET crm_status = 'invalid', crm_status_updated_at = NOW()
      WHERE status = 'invalid'
      AND (crm_status IS NULL OR crm_status = 'raw_import')
    `);

    // 6. Everything else stays raw_import
    await this.db.query(`
      UPDATE ${this.table} SET crm_status = 'raw_import', crm_status_updated_at = NOW()
      WHERE crm_status IS NULL
    `);

    // Count results
    const counts = await this.db.query(`
      SELECT crm_status, COUNT(*) as cnt FROM ${this.table} GROUP BY crm_status ORDER BY cnt DESC
    `);
    console.log(`[CRM] Backfill complete for ${this.platform}:`);
    counts.rows.forEach(r => console.log(`  ${r.crm_status}: ${parseInt(r.cnt).toLocaleString()}`));

    return counts.rows;
  }

  // ── Pipeline Transitions ──────────────────────────────────────────────

  async transition(professionalId, toStatus, { triggeredBy = 'system', metadata = {} } = {}) {
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new Error(`Invalid CRM status: ${toStatus}`);
    }

    // Get current status
    const current = await this.db.query(
      `SELECT id, crm_status FROM ${this.table} WHERE id = $1`,
      [professionalId]
    );

    if (current.rows.length === 0) {
      throw new Error(`Professional ${professionalId} not found`);
    }

    const fromStatus = current.rows[0].crm_status || 'raw_import';

    // Validate transition
    const allowed = TRANSITIONS[fromStatus];
    if (!allowed || !allowed.includes(toStatus)) {
      throw new Error(`Invalid transition: ${fromStatus} → ${toStatus}. Allowed: ${(allowed || []).join(', ')}`);
    }

    // Update status
    await this.db.query(
      `UPDATE ${this.table} SET crm_status = $1, crm_status_updated_at = NOW() WHERE id = $2`,
      [toStatus, professionalId]
    );

    // Log event
    await this.db.query(
      `INSERT INTO crm_pipeline_events (professional_id, platform, from_status, to_status, triggered_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [professionalId, this.platform, fromStatus, toStatus, triggeredBy, JSON.stringify(metadata)]
    );

    return { id: professionalId, from: fromStatus, to: toStatus };
  }

  // Admin override — skip transition validation
  async forceTransition(professionalId, toStatus, { triggeredBy = 'admin', metadata = {} } = {}) {
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new Error(`Invalid CRM status: ${toStatus}`);
    }

    const current = await this.db.query(
      `SELECT id, crm_status FROM ${this.table} WHERE id = $1`,
      [professionalId]
    );
    if (current.rows.length === 0) throw new Error(`Professional ${professionalId} not found`);

    const fromStatus = current.rows[0].crm_status || 'raw_import';

    await this.db.query(
      `UPDATE ${this.table} SET crm_status = $1, crm_status_updated_at = NOW() WHERE id = $2`,
      [toStatus, professionalId]
    );

    await this.db.query(
      `INSERT INTO crm_pipeline_events (professional_id, platform, from_status, to_status, triggered_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [professionalId, this.platform, fromStatus, toStatus, triggeredBy, JSON.stringify({ ...metadata, forced: true })]
    );

    return { id: professionalId, from: fromStatus, to: toStatus, forced: true };
  }

  // ── Queries ───────────────────────────────────────────────────────────

  async getHistory(professionalId) {
    const result = await this.db.query(
      `SELECT * FROM crm_pipeline_events
       WHERE professional_id = $1 AND platform = $2
       ORDER BY created_at DESC`,
      [professionalId, this.platform]
    );
    return result.rows;
  }

  async getFunnel() {
    const result = await this.db.query(`
      SELECT crm_status, COUNT(*) as count
      FROM ${this.table}
      GROUP BY crm_status
      ORDER BY CASE crm_status
        WHEN 'raw_import' THEN 1
        WHEN 'enriched' THEN 2
        WHEN 'enrichment_failed' THEN 3
        WHEN 'validated' THEN 4
        WHEN 'invalid' THEN 5
        WHEN 'contacted' THEN 6
        WHEN 'engaged' THEN 7
        WHEN 'claimed' THEN 8
        WHEN 'subscriber' THEN 9
        WHEN 'churned' THEN 10
        ELSE 99
      END
    `);
    return result.rows;
  }

  async getFunnelWithConversions() {
    const funnel = await this.getFunnel();
    const total = funnel.reduce((sum, r) => sum + parseInt(r.count), 0);

    // Calculate conversion rates between stages
    const stageOrder = ['raw_import', 'enriched', 'validated', 'contacted', 'engaged', 'claimed', 'subscriber'];
    const counts = {};
    funnel.forEach(r => { counts[r.crm_status] = parseInt(r.count); });

    const conversions = [];
    for (let i = 0; i < stageOrder.length; i++) {
      const stage = stageOrder[i];
      const count = counts[stage] || 0;
      // Cumulative: count of this stage + all later stages
      const cumulative = stageOrder.slice(i).reduce((s, st) => s + (counts[st] || 0), 0);
      conversions.push({
        stage,
        count,
        cumulative,
        pct_of_total: total > 0 ? ((cumulative / total) * 100).toFixed(1) : '0.0',
        conversion_from_prev: i === 0 ? null
          : stageOrder.slice(i - 1).reduce((s, st) => s + (counts[st] || 0), 0) > 0
            ? ((cumulative / stageOrder.slice(i - 1).reduce((s, st) => s + (counts[st] || 0), 0)) * 100).toFixed(1)
            : '0.0'
      });
    }

    return {
      total,
      stages: funnel,
      conversions,
      terminal: {
        enrichment_failed: counts['enrichment_failed'] || 0,
        invalid: counts['invalid'] || 0,
        churned: counts['churned'] || 0
      }
    };
  }

  async getProfessional(professionalId) {
    const prof = await this.db.query(
      `SELECT * FROM ${this.table} WHERE id = $1`,
      [professionalId]
    );
    if (prof.rows.length === 0) return null;

    const history = await this.getHistory(professionalId);

    const tags = await this.db.query(
      `SELECT tag FROM crm_tags WHERE professional_id = $1 AND platform = $2 ORDER BY tag`,
      [professionalId, this.platform]
    );

    const notes = await this.db.query(
      `SELECT * FROM crm_notes WHERE professional_id = $1 AND platform = $2 ORDER BY created_at DESC LIMIT 20`,
      [professionalId, this.platform]
    );

    // Get outreach history
    let emails = [];
    try {
      const emailResult = await this.db.query(
        `SELECT id, campaign_id, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at
         FROM outreach_emails
         WHERE recipient_id = $1 AND recipient_type = $2
         ORDER BY sent_at DESC LIMIT 20`,
        [professionalId, this._recipientType()]
      );
      emails = emailResult.rows;
    } catch (e) { /* outreach_emails may not exist */ }

    return {
      ...prof.rows[0],
      pipeline_history: history,
      tags: tags.rows.map(r => r.tag),
      notes: notes.rows,
      outreach_emails: emails
    };
  }

  // ── Segment Queries ───────────────────────────────────────────────────

  async segment({ crm_status, province, designation, hasEmail, tag, limit = 100, offset = 0 } = {}) {
    const conditions = [`1=1`];
    const params = [];
    let paramIdx = 1;

    if (crm_status) {
      if (Array.isArray(crm_status)) {
        conditions.push(`crm_status = ANY($${paramIdx})`);
        params.push(crm_status);
      } else {
        conditions.push(`crm_status = $${paramIdx}`);
        params.push(crm_status);
      }
      paramIdx++;
    }

    if (province) {
      conditions.push(`province ILIKE $${paramIdx}`);
      params.push(province);
      paramIdx++;
    }

    if (designation) {
      conditions.push(`designation ILIKE $${paramIdx}`);
      params.push(`%${designation}%`);
      paramIdx++;
    }

    if (hasEmail === true) {
      conditions.push(`(enriched_email IS NOT NULL AND enriched_email != '')`);
    } else if (hasEmail === false) {
      conditions.push(`(enriched_email IS NULL OR enriched_email = '')`);
    }

    if (tag) {
      conditions.push(`EXISTS (SELECT 1 FROM crm_tags t WHERE t.professional_id = ${this.table}.id AND t.platform = '${this.platform}' AND t.tag = $${paramIdx})`);
      params.push(tag);
      paramIdx++;
    }

    // Count
    const countResult = await this.db.query(
      `SELECT COUNT(*) as total FROM ${this.table} WHERE ${conditions.join(' AND ')}`,
      params
    );

    // Results
    params.push(limit);
    params.push(offset);
    const result = await this.db.query(
      `SELECT id, first_name, last_name, full_name, province, city, designation, firm_name,
              email, enriched_email, crm_status, crm_status_updated_at
       FROM ${this.table}
       WHERE ${conditions.join(' AND ')}
       ORDER BY crm_status_updated_at DESC NULLS LAST
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    );

    return {
      total: parseInt(countResult.rows[0].total),
      professionals: result.rows,
      limit,
      offset
    };
  }

  // ── Tags ──────────────────────────────────────────────────────────────

  async addTag(professionalId, tag) {
    await this.db.query(
      `INSERT INTO crm_tags (professional_id, platform, tag) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [professionalId, this.platform, tag]
    );
  }

  async removeTag(professionalId, tag) {
    await this.db.query(
      `DELETE FROM crm_tags WHERE professional_id = $1 AND platform = $2 AND tag = $3`,
      [professionalId, this.platform, tag]
    );
  }

  // ── Notes ─────────────────────────────────────────────────────────────

  async addNote(professionalId, note, author = 'admin') {
    const result = await this.db.query(
      `INSERT INTO crm_notes (professional_id, platform, note, author) VALUES ($1, $2, $3, $4) RETURNING *`,
      [professionalId, this.platform, note, author]
    );
    return result.rows[0];
  }

  // ── Bulk Operations ───────────────────────────────────────────────────

  async bulkTransition(ids, toStatus, { triggeredBy = 'admin', metadata = {} } = {}) {
    const results = { success: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        await this.transition(id, toStatus, { triggeredBy, metadata });
        results.success++;
      } catch (e) {
        results.failed++;
        results.errors.push({ id, error: e.message });
      }
    }
    return results;
  }

  async bulkTag(ids, tag) {
    for (const id of ids) {
      await this.addTag(id, tag);
    }
    return { tagged: ids.length, tag };
  }

  // ── Dashboard Stats ───────────────────────────────────────────────────

  async getDashboardStats() {
    const funnel = await this.getFunnelWithConversions();

    // Recent activity (last 24h)
    const recentEvents = await this.db.query(`
      SELECT to_status, COUNT(*) as cnt
      FROM crm_pipeline_events
      WHERE platform = $1 AND created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY to_status ORDER BY cnt DESC
    `, [this.platform]);

    // Velocity: avg days between stages (last 30 days)
    const velocity = await this.db.query(`
      SELECT
        from_status, to_status,
        AVG(EXTRACT(EPOCH FROM (e2.created_at - e1.created_at)) / 86400)::NUMERIC(10,1) as avg_days
      FROM crm_pipeline_events e1
      JOIN crm_pipeline_events e2 ON e1.professional_id = e2.professional_id
        AND e2.created_at > e1.created_at
        AND e2.platform = e1.platform
      WHERE e1.platform = $1
        AND e1.created_at >= NOW() - INTERVAL '30 days'
        AND e1.from_status IS NOT NULL
      GROUP BY e1.from_status, e2.to_status
      HAVING COUNT(*) >= 5
      ORDER BY e1.from_status
    `, [this.platform]);

    return {
      funnel,
      recent_activity_24h: recentEvents.rows,
      stage_velocity_30d: velocity.rows
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  _recipientType() {
    return this.platform === 'investing' ? 'scraped_advisor'
      : this.platform === 'lawyers' ? 'scraped_lawyer'
      : 'scraped_cpa';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Sequence Engine
// ═══════════════════════════════════════════════════════════════════════

class SequenceEngine {
  /**
   * @param {object} opts
   * @param {object} opts.db - pg Pool or Client
   * @param {string} opts.professionalsTable
   * @param {string} opts.platform
   * @param {function} opts.sendEmail - async function({ to, subject, html, text })
   * @param {function} opts.renderTemplate - function(template, variables) => string
   */
  constructor({ db, professionalsTable, platform, sendEmail, renderTemplate }) {
    this.db = db;
    this.table = professionalsTable;
    this.platform = platform;
    this.sendEmail = sendEmail;
    this.renderTemplate = renderTemplate || ((t, v) => {
      let s = t;
      for (const [k, val] of Object.entries(v)) {
        s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), val || '');
      }
      return s;
    });
    this.processing = false;
  }

  // ── Sequence CRUD ─────────────────────────────────────────────────────

  async createSequence({ name, description, triggerStatus, steps, active = true }) {
    const result = await this.db.query(
      `INSERT INTO crm_sequences (platform, name, description, trigger_status, steps, active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [this.platform, name, description, triggerStatus, JSON.stringify(steps), active]
    );
    return result.rows[0];
  }

  async updateSequence(id, { name, description, triggerStatus, steps, active }) {
    const fields = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); params.push(description); }
    if (triggerStatus !== undefined) { fields.push(`trigger_status = $${idx++}`); params.push(triggerStatus); }
    if (steps !== undefined) { fields.push(`steps = $${idx++}`); params.push(JSON.stringify(steps)); }
    if (active !== undefined) { fields.push(`active = $${idx++}`); params.push(active); }
    fields.push(`updated_at = NOW()`);

    params.push(id);
    params.push(this.platform);

    const result = await this.db.query(
      `UPDATE crm_sequences SET ${fields.join(', ')} WHERE id = $${idx++} AND platform = $${idx} RETURNING *`,
      params
    );
    return result.rows[0];
  }

  async getSequences() {
    const result = await this.db.query(
      `SELECT s.*,
        (SELECT COUNT(*) FROM crm_sequence_enrollments e WHERE e.sequence_id = s.id AND e.completed_at IS NULL) as active_enrollments,
        (SELECT COUNT(*) FROM crm_sequence_enrollments e WHERE e.sequence_id = s.id AND e.completed_at IS NOT NULL) as completed_enrollments
       FROM crm_sequences s WHERE s.platform = $1 ORDER BY s.created_at DESC`,
      [this.platform]
    );
    return result.rows;
  }

  async getSequence(id) {
    const result = await this.db.query(
      `SELECT * FROM crm_sequences WHERE id = $1 AND platform = $2`,
      [id, this.platform]
    );
    return result.rows[0];
  }

  // ── Enrollment ────────────────────────────────────────────────────────

  async enroll(professionalId, sequenceId) {
    const seq = await this.getSequence(sequenceId);
    if (!seq) throw new Error(`Sequence ${sequenceId} not found`);
    if (!seq.active) throw new Error(`Sequence ${sequenceId} is inactive`);

    const steps = typeof seq.steps === 'string' ? JSON.parse(seq.steps) : seq.steps;
    if (!steps || steps.length === 0) throw new Error('Sequence has no steps');

    // Check unsubscribe
    const unsub = await this.db.query(
      `SELECT 1 FROM outreach_unsubscribes WHERE email = (
        SELECT COALESCE(enriched_email, email) FROM ${this.table} WHERE id = $1
      )`, [professionalId]
    );
    if (unsub.rows.length > 0) throw new Error('Professional is unsubscribed');

    // Calculate first send time
    const firstStep = steps[0];
    const delayDays = firstStep.delay_days || 0;
    const nextSend = new Date();
    nextSend.setDate(nextSend.getDate() + delayDays);

    const result = await this.db.query(
      `INSERT INTO crm_sequence_enrollments (professional_id, sequence_id, platform, current_step, next_send_at)
       VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT (professional_id, sequence_id, platform)
       DO UPDATE SET current_step = 0, next_send_at = $4, completed_at = NULL, exit_reason = NULL, enrolled_at = NOW()
       RETURNING *`,
      [professionalId, sequenceId, this.platform, nextSend]
    );

    return result.rows[0];
  }

  async bulkEnroll(professionalIds, sequenceId) {
    const results = { enrolled: 0, skipped: 0, errors: [] };
    for (const id of professionalIds) {
      try {
        await this.enroll(id, sequenceId);
        results.enrolled++;
      } catch (e) {
        results.skipped++;
        results.errors.push({ id, error: e.message });
      }
    }
    return results;
  }

  async unenroll(professionalId, sequenceId, reason = 'manual') {
    await this.db.query(
      `UPDATE crm_sequence_enrollments SET completed_at = NOW(), exit_reason = $1
       WHERE professional_id = $2 AND sequence_id = $3 AND platform = $4 AND completed_at IS NULL`,
      [reason, professionalId, sequenceId, this.platform]
    );
  }

  // ── Sequence Scheduler (runs every 15 min via cron) ───────────────────

  async processScheduledSends() {
    if (this.processing) {
      console.log(`[Sequences:${this.platform}] Already processing, skipping`);
      return;
    }
    this.processing = true;

    try {
      // Find all due enrollments
      const due = await this.db.query(`
        SELECT e.*, s.steps, s.name as sequence_name
        FROM crm_sequence_enrollments e
        JOIN crm_sequences s ON e.sequence_id = s.id
        WHERE e.platform = $1
          AND e.completed_at IS NULL
          AND e.next_send_at <= NOW()
          AND s.active = true
        ORDER BY e.next_send_at ASC
        LIMIT 100
      `, [this.platform]);

      if (due.rows.length === 0) {
        this.processing = false;
        return;
      }

      console.log(`[Sequences:${this.platform}] Processing ${due.rows.length} due sends...`);
      let sent = 0, skipped = 0, completed = 0;

      for (const enrollment of due.rows) {
        try {
          const steps = typeof enrollment.steps === 'string' ? JSON.parse(enrollment.steps) : enrollment.steps;
          const stepIndex = enrollment.current_step;

          if (stepIndex >= steps.length) {
            // Sequence complete
            await this.db.query(
              `UPDATE crm_sequence_enrollments SET completed_at = NOW(), exit_reason = 'completed' WHERE id = $1`,
              [enrollment.id]
            );
            completed++;
            continue;
          }

          const step = steps[stepIndex];

          // Get professional
          const prof = await this.db.query(
            `SELECT * FROM ${this.table} WHERE id = $1`,
            [enrollment.professional_id]
          );
          if (prof.rows.length === 0) {
            await this._exitEnrollment(enrollment.id, 'professional_not_found');
            skipped++;
            continue;
          }
          const professional = prof.rows[0];
          const email = professional.enriched_email || professional.email;
          if (!email) {
            await this._exitEnrollment(enrollment.id, 'no_email');
            skipped++;
            continue;
          }

          // Check unsubscribe
          const unsub = await this.db.query(
            `SELECT 1 FROM outreach_unsubscribes WHERE email = $1`,
            [email]
          );
          if (unsub.rows.length > 0) {
            await this._exitEnrollment(enrollment.id, 'unsubscribed');
            skipped++;
            continue;
          }

          // Check send condition
          if (step.send_condition) {
            const shouldSend = await this._evaluateCondition(step.send_condition, professional, enrollment);
            if (!shouldSend) {
              // Skip to next step or complete
              await this._advanceStep(enrollment, steps);
              skipped++;
              continue;
            }
          }

          // Generate unsubscribe token for claim/unsub URLs
          const unsubToken = require('crypto').randomBytes(24).toString('hex');

          // Render and send
          const variables = await this._buildVariables(professional, unsubToken);

          // A/B variant selection
          let subjectLine = step.subject_line;
          let variantIndex = 0;
          if (step.subject_line_variants && step.subject_line_variants.length > 0) {
            variantIndex = Math.floor(Math.random() * step.subject_line_variants.length);
            subjectLine = step.subject_line_variants[variantIndex];
          }

          const subject = this.renderTemplate(subjectLine, variables);
          const html = this.renderTemplate(step.body_template, variables);

          // Build unsubscribe URL for RFC 8058 one-click unsubscribe headers
          const unsubscribeUrl = variables.unsubscribe_url;

          const result = await this.sendEmail({
            to: email,
            subject,
            html,
            text: html.replace(/<[^>]+>/g, '').trim(),
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            },
          });

          if (result && result.success !== false) {
            // Log to outreach_emails if table exists
            try {
              // Ensure campaign_id allows NULL for CRM sequence sends
              await this.db.query(`ALTER TABLE outreach_emails ALTER COLUMN campaign_id DROP NOT NULL`).catch(() => {});
              await this.db.query(
                `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, subject, body, status, sent_at, resend_email_id, unsubscribe_token)
                 VALUES (0, $1, $2, $3, $4, $5, $6, 'sent', NOW(), $7, $8)`,
                [this._recipientType(), professional.id, email,
                 `${professional.first_name || ''} ${professional.last_name || ''}`.trim(),
                 subject, html, result.id || null, unsubToken]
              );
            } catch (e) { console.error(`[CRM:${this.platform}] outreach_emails insert failed:`, e.message); }

            // Log pipeline event
            await this.db.query(
              `INSERT INTO crm_pipeline_events (professional_id, platform, from_status, to_status, triggered_by, metadata)
               VALUES ($1, $2, $3, $3, 'sequence', $4)`,
              [professional.id, this.platform, professional.crm_status,
               JSON.stringify({
                 sequence_id: enrollment.sequence_id,
                 sequence_name: enrollment.sequence_name,
                 step: stepIndex,
                 variant_index: variantIndex,
                 subject
               })]
            );

            sent++;
          } else {
            skipped++;
          }

          // Advance to next step
          await this._advanceStep(enrollment, steps);

          // Delay between sends
          await new Promise(r => setTimeout(r, 2000));

        } catch (err) {
          console.error(`[Sequences:${this.platform}] Error processing enrollment ${enrollment.id}:`, err.message);
          skipped++;
        }
      }

      console.log(`[Sequences:${this.platform}] Done: ${sent} sent, ${skipped} skipped, ${completed} completed`);
    } finally {
      this.processing = false;
    }
  }

  // ── Auto-Enrollment ───────────────────────────────────────────────────
  // Call this when a professional's crm_status changes to auto-enroll in triggered sequences

  async checkAutoEnrollment(professionalId, newStatus) {
    const sequences = await this.db.query(
      `SELECT id, name FROM crm_sequences WHERE platform = $1 AND trigger_status = $2 AND active = true`,
      [this.platform, newStatus]
    );

    // For "Engaged No-Claim" sequence: require an actual click event, not just an open.
    // Open-only enrollments dilute the warmest cohort and waste sends on bot scanners.
    let hasClick = null; // lazy-checked

    for (const seq of sequences.rows) {
      try {
        if (seq.name === 'Engaged No-Claim') {
          if (hasClick === null) {
            // Check both outreach_emails (LAW/ACC) and outreach_recipients (INV) for a clicked event
            const recipientType = this._recipientType();
            const r1 = await this.db.query(
              `SELECT 1 FROM outreach_emails WHERE recipient_id = $1 AND recipient_type = $2 AND status = 'clicked' LIMIT 1`,
              [professionalId, recipientType]
            ).catch(() => ({ rows: [] }));
            if (r1.rows.length > 0) {
              hasClick = true;
            } else {
              // Fall back to outreach_recipients (INV uses email-based join, not id)
              const profEmail = await this.db.query(
                `SELECT COALESCE(enriched_email, email) as email FROM ${this.table} WHERE id = $1`,
                [professionalId]
              ).catch(() => ({ rows: [] }));
              if (profEmail.rows[0]?.email) {
                const r2 = await this.db.query(
                  `SELECT 1 FROM outreach_recipients WHERE email = $1 AND status = 'clicked' LIMIT 1`,
                  [profEmail.rows[0].email]
                ).catch(() => ({ rows: [] }));
                hasClick = r2.rows.length > 0;
              } else {
                hasClick = false;
              }
            }
          }
          if (!hasClick) {
            console.log(`[Sequences:${this.platform}] Skipping #${professionalId} for Engaged No-Claim — opened but no click`);
            continue;
          }
        }

        await this.enroll(professionalId, seq.id);
        console.log(`[Sequences:${this.platform}] Auto-enrolled #${professionalId} in sequence ${seq.id} (trigger: ${newStatus})`);
      } catch (e) {
        // Already enrolled or unsubscribed — fine
      }
    }
  }

  // ── Monitoring ────────────────────────────────────────────────────────

  async getActiveEnrollments({ sequenceId, limit = 50, offset = 0 } = {}) {
    const conditions = [`e.platform = $1`, `e.completed_at IS NULL`];
    const params = [this.platform];
    let idx = 2;

    if (sequenceId) {
      conditions.push(`e.sequence_id = $${idx++}`);
      params.push(sequenceId);
    }

    params.push(limit);
    params.push(offset);

    const result = await this.db.query(`
      SELECT e.*, s.name as sequence_name,
        p.first_name, p.last_name, p.enriched_email, p.email, p.province, p.crm_status
      FROM crm_sequence_enrollments e
      JOIN crm_sequences s ON e.sequence_id = s.id
      JOIN ${this.table} p ON e.professional_id = p.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.next_send_at ASC
      LIMIT $${idx++} OFFSET $${idx}
    `, params);

    return result.rows;
  }

  async getSequenceStats(sequenceId) {
    const result = await this.db.query(`
      SELECT
        COUNT(*) FILTER (WHERE completed_at IS NULL) as active,
        COUNT(*) FILTER (WHERE exit_reason = 'completed') as completed,
        COUNT(*) FILTER (WHERE exit_reason = 'unsubscribed') as unsubscribed,
        COUNT(*) FILTER (WHERE exit_reason NOT IN ('completed', 'unsubscribed') AND completed_at IS NOT NULL) as other_exits,
        COUNT(*) as total
      FROM crm_sequence_enrollments
      WHERE sequence_id = $1 AND platform = $2
    `, [sequenceId, this.platform]);

    return result.rows[0];
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  async _advanceStep(enrollment, steps) {
    const nextStep = enrollment.current_step + 1;
    if (nextStep >= steps.length) {
      await this.db.query(
        `UPDATE crm_sequence_enrollments SET current_step = $1, completed_at = NOW(), exit_reason = 'completed' WHERE id = $2`,
        [nextStep, enrollment.id]
      );
    } else {
      const nextStepDef = steps[nextStep];
      const delayDays = nextStepDef.delay_days || 1;
      const nextSend = new Date();
      nextSend.setDate(nextSend.getDate() + delayDays);
      await this.db.query(
        `UPDATE crm_sequence_enrollments SET current_step = $1, next_send_at = $2 WHERE id = $3`,
        [nextStep, nextSend, enrollment.id]
      );
    }
  }

  async _exitEnrollment(enrollmentId, reason) {
    await this.db.query(
      `UPDATE crm_sequence_enrollments SET completed_at = NOW(), exit_reason = $1 WHERE id = $2`,
      [reason, enrollmentId]
    );
  }

  async _evaluateCondition(condition, professional, enrollment) {
    switch (condition) {
      case 'only_if_not_engaged':
        return professional.crm_status !== 'engaged' && professional.crm_status !== 'claimed' && professional.crm_status !== 'subscriber';
      case 'only_if_not_claimed':
        return professional.crm_status !== 'claimed' && professional.crm_status !== 'subscriber';
      case 'only_if_not_opened': {
        const opened = await this.db.query(
          `SELECT 1 FROM outreach_emails WHERE recipient_id = $1 AND status IN ('opened', 'clicked') LIMIT 1`,
          [professional.id]
        );
        return opened.rows.length === 0;
      }
      default:
        return true; // Unknown condition — send anyway
    }
  }

  async _buildVariables(professional, unsubToken) {
    const platformUrls = {
      investing: 'https://canadainvesting.app',
      lawyers: 'https://canadalawyers.app',
      accountants: 'https://canadaaccountants.app'
    };
    const platformNames = {
      investing: 'CanadaInvesting',
      lawyers: 'CanadaLawyers',
      accountants: 'CanadaAccountants'
    };
    const baseUrl = platformUrls[this.platform] || '';
    const backendUrls = {
      investing: 'https://canadainvesting-backend-production.up.railway.app',
      lawyers: 'https://canadalawyers-backend-production.up.railway.app',
      accountants: 'https://canadaaccountants-backend-production-1d8f.up.railway.app'
    };
    const backendUrl = backendUrls[this.platform] || '';

    // Tiered social proof: returns a complete sentence fragment based on actual data.
    //   0-2 city claims  → fall back to province count
    //   3-9 city claims  → "a handful of professionals in {city}"
    //   10+ city claims  → "{N} professionals in {city}"
    //   Province fallback: "{N} professionals across {province}" if 10+, else generic
    const profType = this.platform === 'investing' ? 'advisors'
      : this.platform === 'lawyers' ? 'lawyers'
      : 'accountants';
    let socialProofLine = `professionals across Canada`;
    let socialProofShort = `peers`;
    try {
      let cityCount = 0;
      if (professional.city) {
        const r = await this.db.query(
          `SELECT COUNT(*) as count FROM ${this.table} WHERE LOWER(city) = LOWER($1) AND claim_status = 'claimed'`,
          [professional.city]
        );
        cityCount = parseInt(r.rows[0].count, 10);
      }
      if (cityCount >= 10) {
        socialProofLine = `${cityCount} ${profType} in ${professional.city}`;
        socialProofShort = `${cityCount} ${profType} in ${professional.city}`;
      } else if (cityCount >= 3) {
        socialProofLine = `a handful of ${profType} in ${professional.city}`;
        socialProofShort = `a handful of ${profType} in ${professional.city}`;
      } else if (professional.province) {
        // Province fallback when city count is too low
        const pr = await this.db.query(
          `SELECT COUNT(*) as count FROM ${this.table} WHERE UPPER(province) = UPPER($1) AND claim_status = 'claimed'`,
          [professional.province]
        );
        const provCount = parseInt(pr.rows[0].count, 10);
        if (provCount >= 10) {
          socialProofLine = `${provCount} ${profType} across ${professional.province}`;
          socialProofShort = `${provCount} ${profType} in your province`;
        } else {
          socialProofLine = `professionals across Canada`;
          socialProofShort = `peers across Canada`;
        }
      }
    } catch (e) { /* fall back to default */ }

    // Pre-baked checkout URLs for upgrade emails. Use the redirect endpoint that
    // creates a fresh Stripe session on click — links never expire.
    const recipientEmail = professional.enriched_email || professional.email || '';
    const fullName = professional.full_name || `${professional.first_name || ''} ${professional.last_name || ''}`.trim();
    const checkoutBase = recipientEmail
      ? `${backendUrl}/api/checkout`
      : `${baseUrl}/pricing`;
    const checkoutQuery = recipientEmail
      ? `?email=${encodeURIComponent(recipientEmail)}&name=${encodeURIComponent(fullName)}`
      : '';

    return {
      first_name: professional.first_name || '',
      last_name: professional.last_name || '',
      full_name: fullName,
      firm_name: professional.firm_name || '',
      city: professional.city || '',
      province: professional.province || '',
      designation: professional.designation || '',
      email: recipientEmail,
      platform_name: platformNames[this.platform] || this.platform,
      platform_url: baseUrl,
      social_proof_line: socialProofLine,
      social_proof_short: socialProofShort,
      claim_url: unsubToken ? `${baseUrl}/claim-profile?ref=${unsubToken}` : `${baseUrl}/claim-profile`,
      unsubscribe_url: unsubToken ? `${backendUrl}/api/unsubscribe/${unsubToken}` : `${baseUrl}/unsubscribe/${professional.id}`,
      checkout_associate_url: recipientEmail ? `${checkoutBase}/associate${checkoutQuery}` : `${baseUrl}/pricing`,
      checkout_professional_url: recipientEmail ? `${checkoutBase}/professional${checkoutQuery}` : `${baseUrl}/pricing`,
      checkout_enterprise_url: recipientEmail ? `${checkoutBase}/enterprise${checkoutQuery}` : `${baseUrl}/pricing`,
      pricing_url: `${baseUrl}/pricing`,
    };
  }

  _recipientType() {
    return this.platform === 'investing' ? 'scraped_advisor'
      : this.platform === 'lawyers' ? 'scraped_lawyer'
      : 'scraped_cpa';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Intelligence & Automation Layer
// ═══════════════════════════════════════════════════════════════════════

class CRMIntelligence {
  /**
   * @param {object} opts
   * @param {object} opts.db - pg Pool or Client
   * @param {string} opts.professionalsTable
   * @param {string} opts.platform
   * @param {function} [opts.sendAlert] - async function({ to, subject, html }) for anomaly alerts
   */
  constructor({ db, professionalsTable, platform, sendAlert }) {
    this.db = db;
    this.table = professionalsTable;
    this.platform = platform;
    this.sendAlert = sendAlert;
  }

  // ── Schema Migration ──────────────────────────────────────────────────

  async migrate() {
    console.log(`[CRM:Intelligence] Running migration for ${this.platform}...`);

    await this.db.query(`
      ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS engagement_score INTEGER DEFAULT 0
    `);
    await this.db.query(`
      ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS engagement_tier VARCHAR(20) DEFAULT 'cold'
    `);
    await this.db.query(`
      ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS churn_risk INTEGER
    `);
    await this.db.query(`
      ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMP WITH TIME ZONE
    `);

    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_engagement ON ${this.table}(engagement_score DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS idx_${this.table}_eng_tier ON ${this.table}(engagement_tier)`);

    console.log(`[CRM:Intelligence] Migration complete for ${this.platform}.`);
  }

  // ── Engagement Scoring ────────────────────────────────────────────────
  // Score: 0-100 composite. Run nightly.

  async computeAllScores() {
    console.log(`[CRM:Intelligence:${this.platform}] Computing engagement scores...`);

    const batchSize = 500;
    let offset = 0;
    let totalScored = 0;
    const tierCounts = { cold: 0, warm: 0, hot: 0, active: 0 };

    while (true) {
      const batch = await this.db.query(
        `SELECT id, crm_status, enriched_email, email, firm_name, designation, crm_status_updated_at
         FROM ${this.table}
         WHERE crm_status NOT IN ('invalid')
         ORDER BY id
         LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );

      if (batch.rows.length === 0) break;

      for (const prof of batch.rows) {
        const score = await this._computeScore(prof);
        const tier = score >= 80 ? 'hot' : score >= 60 ? 'warm' : score >= 30 ? 'active' : 'cold';
        tierCounts[tier]++;

        await this.db.query(
          `UPDATE ${this.table} SET engagement_score = $1, engagement_tier = $2, score_updated_at = NOW() WHERE id = $3`,
          [score, tier, prof.id]
        );
        totalScored++;
      }

      offset += batchSize;
    }

    console.log(`[CRM:Intelligence:${this.platform}] Scored ${totalScored} professionals:`, tierCounts);
    return { totalScored, tiers: tierCounts };
  }

  async _computeScore(professional) {
    let score = 0;
    const email = professional.enriched_email || professional.email;

    // 1. Pipeline stage score (0-30)
    const stageScores = {
      raw_import: 0, enrichment_failed: 0,
      enriched: 5, validated: 10,
      contacted: 15, engaged: 25,
      claimed: 28, subscriber: 30, churned: 10
    };
    score += stageScores[professional.crm_status] || 0;

    // 2. Email engagement recency (0-30)
    if (email) {
      try {
        const emailActivity = await this.db.query(`
          SELECT
            MAX(CASE WHEN status IN ('opened', 'clicked') THEN sent_at END) as last_engaged,
            MAX(CASE WHEN status = 'clicked' THEN sent_at END) as last_clicked,
            COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as total_engagements,
            COUNT(*) FILTER (WHERE status = 'clicked') as total_clicks
          FROM outreach_emails
          WHERE recipient_email = $1
        `, [email]);

        const activity = emailActivity.rows[0];
        if (activity && activity.last_engaged) {
          const daysSinceEngagement = (Date.now() - new Date(activity.last_engaged).getTime()) / 86400000;
          if (daysSinceEngagement <= 7) score += 20;
          else if (daysSinceEngagement <= 14) score += 15;
          else if (daysSinceEngagement <= 30) score += 10;
          else if (daysSinceEngagement <= 60) score += 5;

          // Click bonus
          if (activity.last_clicked) score += 5;
          // Multiple engagements bonus
          if (parseInt(activity.total_engagements) >= 3) score += 5;
        }
      } catch (e) { /* outreach_emails may not exist */ }
    }

    // 3. Profile completeness signals (0-15)
    if (professional.firm_name) score += 5;
    if (professional.designation) score += 5;
    if (email) score += 5;

    // 4. CRM activity recency (0-15)
    try {
      const recentEvents = await this.db.query(`
        SELECT COUNT(*) as cnt FROM crm_pipeline_events
        WHERE professional_id = $1 AND platform = $2 AND created_at >= NOW() - INTERVAL '30 days'
      `, [professional.id, this.platform]);

      const eventCount = parseInt(recentEvents.rows[0].cnt);
      if (eventCount >= 5) score += 15;
      else if (eventCount >= 3) score += 10;
      else if (eventCount >= 1) score += 5;
    } catch (e) {}

    // 5. Subscription tier bonus (0-10)
    if (professional.crm_status === 'subscriber') score += 10;

    return Math.min(100, Math.max(0, score));
  }

  // ── Churn Prediction ──────────────────────────────────────────────────
  // For subscribers: predict churn risk (0-100). Run nightly.

  async computeChurnScores() {
    console.log(`[CRM:Intelligence:${this.platform}] Computing churn risk scores...`);

    const subTable = this.platform === 'investing' ? 'advisor_subscriptions'
      : this.platform === 'lawyers' ? 'lawyer_subscriptions'
      : 'cpa_subscriptions';

    let scored = 0;
    const riskBuckets = { low: 0, medium: 0, high: 0, critical: 0 };

    try {
      // Get all active subscribers matched to professionals
      const subscribers = await this.db.query(`
        SELECT p.id, p.crm_status, p.enriched_email, p.email, p.engagement_score,
               s.current_period_end, s.created_at as sub_created_at, s.status as sub_status
        FROM ${this.table} p
        JOIN ${subTable} s ON s.email = COALESCE(p.enriched_email, p.email)
        WHERE p.crm_status = 'subscriber' AND s.status = 'active'
      `);

      for (const sub of subscribers.rows) {
        let risk = 0;

        // 1. Days until renewal (0-30 risk points)
        if (sub.current_period_end) {
          const daysToRenewal = (new Date(sub.current_period_end).getTime() - Date.now()) / 86400000;
          if (daysToRenewal <= 7) risk += 30;
          else if (daysToRenewal <= 14) risk += 20;
          else if (daysToRenewal <= 30) risk += 10;
        }

        // 2. Low engagement score (0-25 risk points)
        const engScore = sub.engagement_score || 0;
        if (engScore < 20) risk += 25;
        else if (engScore < 40) risk += 15;
        else if (engScore < 60) risk += 5;

        // 3. Email engagement drop-off (0-25 risk points)
        const email = sub.enriched_email || sub.email;
        if (email) {
          try {
            const recentOpens = await this.db.query(`
              SELECT COUNT(*) as cnt FROM outreach_emails
              WHERE recipient_email = $1 AND status IN ('opened', 'clicked')
              AND sent_at >= NOW() - INTERVAL '30 days'
            `, [email]);
            const opens = parseInt(recentOpens.rows[0].cnt);
            if (opens === 0) risk += 25;
            else if (opens === 1) risk += 10;
          } catch (e) {}
        }

        // 4. Short tenure (0-20 risk points) — newer subscribers churn more
        if (sub.sub_created_at) {
          const tenureMonths = (Date.now() - new Date(sub.sub_created_at).getTime()) / (86400000 * 30);
          if (tenureMonths < 2) risk += 20;
          else if (tenureMonths < 6) risk += 10;
        }

        risk = Math.min(100, Math.max(0, risk));
        const bucket = risk >= 80 ? 'critical' : risk >= 60 ? 'high' : risk >= 40 ? 'medium' : 'low';
        riskBuckets[bucket]++;

        await this.db.query(
          `UPDATE ${this.table} SET churn_risk = $1 WHERE id = $2`,
          [risk, sub.id]
        );
        scored++;
      }
    } catch (e) {
      console.log(`[CRM:Intelligence:${this.platform}] Churn scoring skipped (${e.message})`);
    }

    console.log(`[CRM:Intelligence:${this.platform}] Churn scored ${scored} subscribers:`, riskBuckets);
    return { scored, riskBuckets };
  }

  // ── Bounce Cluster Detection ──────────────────────────────────────────
  // Alert if bounce rate exceeds threshold in a rolling window.

  async checkBounceCluster({ windowHours = 48, thresholdPct = 5 } = {}) {
    console.log(`[CRM:Intelligence:${this.platform}] Checking bounce clusters...`);

    try {
      const stats = await this.db.query(`
        SELECT
          COUNT(*) as total_sent,
          COUNT(*) FILTER (WHERE status = 'bounced') as total_bounced,
          COUNT(*) FILTER (WHERE status = 'bounced') * 100.0 / NULLIF(COUNT(*), 0) as bounce_pct
        FROM outreach_emails
        WHERE sent_at >= NOW() - INTERVAL '${windowHours} hours'
      `);

      const { total_sent, total_bounced, bounce_pct } = stats.rows[0];
      const pct = parseFloat(bounce_pct) || 0;

      if (pct > thresholdPct && parseInt(total_sent) >= 10) {
        // Get affected domains
        const domains = await this.db.query(`
          SELECT
            SPLIT_PART(recipient_email, '@', 2) as domain,
            COUNT(*) as bounce_count
          FROM outreach_emails
          WHERE status = 'bounced' AND sent_at >= NOW() - INTERVAL '${windowHours} hours'
          GROUP BY domain
          ORDER BY bounce_count DESC
          LIMIT 10
        `);

        const alert = {
          platform: this.platform,
          bounce_pct: pct.toFixed(1),
          total_sent: parseInt(total_sent),
          total_bounced: parseInt(total_bounced),
          window_hours: windowHours,
          top_domains: domains.rows
        };

        console.warn(`[CRM:Intelligence:${this.platform}] BOUNCE ALERT: ${pct.toFixed(1)}% bounce rate (${total_bounced}/${total_sent}) in last ${windowHours}h`);

        // Send alert email
        if (this.sendAlert) {
          const domainList = domains.rows.map(d => `${d.domain}: ${d.bounce_count} bounces`).join('\n');
          await this.sendAlert({
            to: process.env.ADMIN_EMAIL || 'arthur@negotiateandwin.com',
            subject: `[${this.platform.toUpperCase()}] Bounce Alert: ${pct.toFixed(1)}% in ${windowHours}h`,
            html: `<h2>Bounce Cluster Detected</h2>
              <p><strong>Platform:</strong> ${this.platform}</p>
              <p><strong>Bounce rate:</strong> ${pct.toFixed(1)}% (${total_bounced} of ${total_sent})</p>
              <p><strong>Window:</strong> Last ${windowHours} hours</p>
              <h3>Top Bouncing Domains</h3>
              <pre>${domainList}</pre>
              <p>Review at: /api/admin/crm/intelligence/bounce-report</p>`
          });
        }

        return { alert: true, ...alert };
      }

      return { alert: false, bounce_pct: pct.toFixed(1), total_sent: parseInt(total_sent) };
    } catch (e) {
      console.log(`[CRM:Intelligence:${this.platform}] Bounce check skipped (${e.message})`);
      return { alert: false, error: e.message };
    }
  }

  // ── Nightly Intelligence Run ──────────────────────────────────────────
  // Call this from a single cron job.

  async runNightly() {
    console.log(`[CRM:Intelligence:${this.platform}] Starting nightly intelligence run...`);
    const results = {};

    results.engagement = await this.computeAllScores();
    results.churn = await this.computeChurnScores();
    results.bounces = await this.checkBounceCluster();

    console.log(`[CRM:Intelligence:${this.platform}] Nightly run complete.`);
    return results;
  }

  // ── Query Helpers ─────────────────────────────────────────────────────

  async getTopEngaged(limit = 50) {
    const result = await this.db.query(
      `SELECT id, first_name, last_name, full_name, province, city, designation, firm_name,
              enriched_email, email, crm_status, engagement_score, engagement_tier, churn_risk
       FROM ${this.table}
       WHERE engagement_score > 0
       ORDER BY engagement_score DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  async getChurnRisk(minRisk = 60, limit = 50) {
    const result = await this.db.query(
      `SELECT id, first_name, last_name, full_name, province, designation, firm_name,
              enriched_email, email, crm_status, engagement_score, churn_risk
       FROM ${this.table}
       WHERE churn_risk >= $1
       ORDER BY churn_risk DESC
       LIMIT $2`,
      [minRisk, limit]
    );
    return result.rows;
  }

  async getEngagementDistribution() {
    const result = await this.db.query(`
      SELECT engagement_tier, COUNT(*) as count,
             AVG(engagement_score)::INTEGER as avg_score
      FROM ${this.table}
      WHERE crm_status NOT IN ('invalid')
      GROUP BY engagement_tier
      ORDER BY CASE engagement_tier
        WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'active' THEN 3 WHEN 'cold' THEN 4
      END
    `);
    return result.rows;
  }

  async getBounceReport(windowHours = 48) {
    try {
      const result = await this.db.query(`
        SELECT
          SPLIT_PART(recipient_email, '@', 2) as domain,
          COUNT(*) FILTER (WHERE status = 'bounced') as bounces,
          COUNT(*) as total,
          (COUNT(*) FILTER (WHERE status = 'bounced') * 100.0 / NULLIF(COUNT(*), 0))::NUMERIC(5,1) as bounce_pct
        FROM outreach_emails
        WHERE sent_at >= NOW() - INTERVAL '${windowHours} hours'
        GROUP BY domain
        HAVING COUNT(*) FILTER (WHERE status = 'bounced') > 0
        ORDER BY bounces DESC
        LIMIT 20
      `);
      return result.rows;
    } catch (e) {
      return [];
    }
  }
}

module.exports = { CRMService, SequenceEngine, CRMIntelligence, VALID_STATUSES, TRANSITIONS };
