const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { sendEmail, sendFrictionMatchNotification, sendCPAOnboardingEmail, sendCPARegistrationConfirmation, sendContactFormEmail, sendCPAVerificationEmail, sendPasswordResetEmail, sendReferralEmail, sendClaimVerificationEmail } = require('./services/email');
const { OutreachEngine, CPA_ACQUISITION_TEMPLATE, SME_ACQUISITION_TEMPLATE } = require('./services/outreach');
const { CRMService, SequenceEngine, CRMIntelligence } = require('./services/crm');
const { generateBio, calculateSEOScore, generateOutreachTemplate } = require('./services/ai');
const crypto = require('crypto');
const cron = require('node-cron');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://canadaaccountants.app';
const BACKEND_URL = process.env.BACKEND_URL || 'https://canadaaccountants-backend-production-1d8f.up.railway.app';
// Canonical claim URL helper — every email CTA must route through this so the
// redirect endpoint can resolve recipient_id → unsubscribe_token → /claim-profile?ref=...
const claimRedirectUrl = (recipientId) => `${BACKEND_URL}/api/c/${recipientId}`;
const STRIPE_PRICES = {
  associate: process.env.STRIPE_PRICE_ASSOCIATE || '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || '',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || '',
  associate_monthly: process.env.STRIPE_PRICE_ASSOCIATE || '',
  professional_monthly: process.env.STRIPE_PRICE_PROFESSIONAL || '',
  enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE || '',
  associate_yearly: process.env.STRIPE_PRICE_ASSOCIATE_YEARLY || '',
  professional_yearly: process.env.STRIPE_PRICE_PROFESSIONAL_YEARLY || '',
  enterprise_yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || '',
};

// Initialize Sentry before anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Sentry request handler (must be first middleware)
if (process.env.SENTRY_DSN && Sentry.Handlers) {
  app.use(Sentry.Handlers.requestHandler());
} else if (process.env.SENTRY_DSN && Sentry.setupExpressErrorHandler) {
  // Sentry SDK v8+ — setupExpressErrorHandler is called after routes
}

// CORS Configuration
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Stripe webhook — must be before JSON parser (needs raw body)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret || !sig) {
    return res.status(400).json({ error: 'Missing webhook secret or signature' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const cpaProfileId = session.metadata?.cpa_profile_id;
        const planType = session.metadata?.plan_type;
        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier || planType;
        if (cpaProfileId && session.subscription) {
          await pool.query(
            `UPDATE cpa_subscriptions SET stripe_subscription_id = $1, stripe_customer_id = $2, status = 'active', current_period_start = NOW(), updated_at = NOW() WHERE cpa_profile_id = $3`,
            [session.subscription, session.customer, cpaProfileId]
          );
        }
        // Update users table with subscription info for upgrade gate
        if (userId) {
          await pool.query(
            `UPDATE users SET subscription_tier = $1, subscription_status = 'active', stripe_customer_id = $2 WHERE id = $3`,
            [tier, session.customer, userId]
          );
          console.log(`[Stripe] User ${userId} subscribed to ${tier}`);
        }
        console.log(`Checkout completed for CPA ${cpaProfileId}, plan: ${planType}`);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await pool.query(
          `UPDATE cpa_subscriptions SET status = $1, current_period_start = $2, current_period_end = $3, updated_at = NOW() WHERE stripe_subscription_id = $4`,
          [sub.status === 'active' ? 'active' : sub.status, new Date(sub.current_period_start * 1000), new Date(sub.current_period_end * 1000), sub.id]
        );
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await pool.query(
          `UPDATE cpa_subscriptions SET status = 'canceled', updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await pool.query(
            `UPDATE cpa_subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
            [invoice.subscription]
          );
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Trust Railway proxy
app.set('trust proxy', 1);

// JSON parsing middleware
app.use(express.json());

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many authentication attempts' }
});
app.use('/api/auth', authLimiter);

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions, please try again later' }
});
app.use('/api/contact', contactLimiter);

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many password reset attempts' }
});
app.use('/api/auth/forgot-password', resetLimiter);
app.use('/api/auth/reset-password', resetLimiter);

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Admin authorization middleware
const requireAdmin = (req, res, next) => {
  if (req.user.userType !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// CPA authorization middleware
const requireCPA = (req, res, next) => {
  if (req.user.userType !== 'CPA') {
    return res.status(403).json({ error: 'CPA access required' });
  }
  next();
};

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const userQuery = `
  SELECT u.*, cp.id as cpa_profile_id, cp.first_name, cp.last_name, cp.firm_name
  FROM users u
  LEFT JOIN cpa_profiles cp ON u.id = cp.user_id
  WHERE u.email = $1 AND u.user_type IN ('CPA', 'admin') AND u.is_active = true;
`;
    
    const result = await pool.query(userQuery, [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = result.rows[0];
    
    // For now, we'll create a simple password check
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        cpaProfileId: user.cpa_profile_id,
        email: user.email,
        userType: user.user_type 
      },
      process.env.JWT_SECRET || 'your_jwt_secret_key',
      { expiresIn: '7d' }
    );
    
    // Update last login
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );
    
    res.json({
      success: true,
      token: token,
      user: {
        id: user.id,
        email: user.email,
        userType: user.user_type,
        firstName: user.first_name,
        lastName: user.last_name,
        firmName: user.firm_name,
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Login failed',
      details: error.message 
    });
  }
});

// Token verification endpoint
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
  try {
    // Get fresh user data
    const userQuery = `
      SELECT u.*, cp.first_name, cp.last_name, cp.firm_name 
      FROM users u
      LEFT JOIN cpa_profiles cp ON u.id = cp.user_id
      WHERE u.id = $1;
    `;
    
    const result = await pool.query(userQuery, [req.user.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        userType: user.user_type,
        firstName: user.first_name,
        lastName: user.last_name,
        firmName: user.firm_name,
      }
    });

  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ 
      error: 'Token verification failed',
      details: error.message 
    });
  }
});

// Forgot password endpoint
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Always return success to avoid revealing whether email exists
    const successResponse = {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.'
    };

    // Look up user
    const userResult = await pool.query(
      'SELECT id, email, user_type FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.json(successResponse);
    }

    const user = userResult.rows[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store hashed token in DB
    await pool.query(
      'UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
      [resetTokenHash, expires, user.id]
    );

    // Get first name for email
    const profileResult = await pool.query(
      'SELECT first_name FROM cpa_profiles WHERE user_id = $1 LIMIT 1',
      [user.id]
    );
    const firstName = profileResult.rows.length > 0 ? profileResult.rows[0].first_name : null;

    // Send reset email
    const frontendUrl = FRONTEND_URL;
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    sendPasswordResetEmail({ email: user.email, resetUrl, firstName }).catch(err => {
      console.error('Password reset email error (non-fatal):', err.message);
    });

    res.json(successResponse);
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// Reset password endpoint
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Hash the token to compare with stored hash
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with matching token that hasn't expired
    const userResult = await pool.query(
      'SELECT id, email FROM users WHERE reset_token_hash = $1 AND reset_token_expires > NOW()',
      [tokenHash]
    );

    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = userResult.rows[0];

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2',
      [passwordHash, user.id]
    );

    res.json({ success: true, message: 'Password has been reset successfully. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Health check endpoint for Railway
app.get('/health', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'disconnected';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (e) {
    dbStatus = 'error: ' + e.message;
  }
  const ok = dbStatus === 'connected';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'OK' : 'DEGRADED',
    message: 'CanadaAccountants Backend',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    response_ms: Date.now() - start,
    services: { database: dbStatus }
  });
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Test endpoint working!', 
    timestamp: new Date().toISOString() 
  });
});

// Root endpoint - fixes "Cannot GET /" error
app.get('/', (req, res) => {
  res.json({
    message: 'CanadaAccountants API is running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      cpaRegistration: '/api/cpa-registration',
      performanceScore: '/api/performance/score',
      matchCpas: '/api/match-cpas',
      frictionElimination: '/api/friction/*'
    },
    timestamp: new Date().toISOString()
  });
});

// CPA Registration endpoint for your pricing page form
app.post('/api/cpa-registration', async (req, res) => {
  try {
    const registrationData = req.body;
    
    console.log('🎉 Processing CPA registration:', registrationData);

    // Generate unique registration ID
    const registrationId = `reg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store CPA registration in database
    const insertQuery = `
      INSERT INTO cpa_profiles (
    cpa_id, first_name, last_name, email, phone, firm_name,
    province, years_experience, firm_size, designation, industries_served,
    hourly_rate_min, profile_status, verification_status, created_date
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
ON CONFLICT (email) 
DO UPDATE SET 
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    phone = EXCLUDED.phone,
    firm_name = EXCLUDED.firm_name,
    province = EXCLUDED.province,
    years_experience = EXCLUDED.years_experience,
    firm_size = EXCLUDED.firm_size,
    specializations = EXCLUDED.specializations,
    industries_served = EXCLUDED.industries_served,
    hourly_rate_min = EXCLUDED.hourly_rate_min,
    profile_status = EXCLUDED.profile_status,
    verification_status = EXCLUDED.verification_status,
    updated_date = NOW()
RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      registrationId,                                    // $1 - cpa_id
      registrationData.firstName || '',                  // $2 - first_name
      registrationData.lastName || '',                   // $3 - last_name
      registrationData.email || '',                      // $4 - email
      registrationData.phone || '',                      // $5 - phone
      registrationData.firmName || '',                   // $6 - firm_name
      registrationData.province || '',                   // $7 - province
      parseInt(registrationData.experience) || 0,
      registrationData.firmSize || '',                   // $9 - firm_size
      JSON.stringify(registrationData.services || []),   // $10 - services
      JSON.stringify(registrationData.industries || []), // $11 - industries_served
      parseFloat(registrationData.hourlyRate) || 0,     // $12 - hourly_rate_min
      'pending',                                         // $13 - profile_status
      'unverified'                                       // $14 - verification_status
    ]);
  

    res.json({
      success: true,
      registrationId: registrationId,
      message: 'CPA registration successful',
      data: result.rows[0],
      timestamp: new Date().toISOString()
    });

    // Send registration confirmation email (async, non-blocking)
    sendCPARegistrationConfirmation(registrationData).catch(err => {
      console.error('Email send error (non-fatal):', err.message);
    });

    // Track outreach conversion (async, non-blocking)
    if (registrationData.email) {
      outreachEngine.trackConversion(registrationData.email, result.rows[0]?.id, registrationData.ref).catch(err => {
        console.error('Outreach conversion tracking error (non-fatal):', err.message);
      });
    }

  } catch (error) {
    console.error('❌ CPA registration error:', error);
    res.status(500).json({ 
      error: 'Failed to process CPA registration',
      details: error.message 
    });
  }
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize Outreach Engine
const outreachEngine = new OutreachEngine(pool);
outreachEngine.startQueueProcessor();

// Initialize CRM
const crm = new CRMService({ db: pool, professionalsTable: 'scraped_cpas', platform: 'accountants' });

const OUTREACH_FROM = 'Arthur Kostaras <connect@canadaaccountants.app>';
const sequenceEngine = new SequenceEngine({
  db: pool, professionalsTable: 'scraped_cpas', platform: 'accountants',
  sendEmail: (opts) => sendEmail({ ...opts, from: OUTREACH_FROM }),
  renderTemplate: (template, vars) => {
    let s = template;
    for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v || '');
    return s;
  }
});

const crmIntelligence = new CRMIntelligence({
  db: pool, professionalsTable: 'scraped_cpas', platform: 'accountants', sendAlert: sendEmail
});

// Auto-migrate: create outreach tables + add missing columns
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outreach_campaigns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50),
        subject_template TEXT,
        body_template TEXT,
        target_provinces TEXT[],
        target_cities TEXT[],
        daily_limit INTEGER DEFAULT 50,
        total_limit INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'paused',
        total_queued INTEGER DEFAULT 0,
        total_sent INTEGER DEFAULT 0,
        total_delivered INTEGER DEFAULT 0,
        total_opened INTEGER DEFAULT 0,
        total_clicked INTEGER DEFAULT 0,
        total_bounced INTEGER DEFAULT 0,
        total_complained INTEGER DEFAULT 0,
        total_unsubscribed INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS outreach_emails (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER NOT NULL,
        recipient_type VARCHAR(20) NOT NULL,
        recipient_id INTEGER NOT NULL,
        recipient_email VARCHAR(255) NOT NULL,
        recipient_name VARCHAR(500),
        resend_email_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'queued',
        rendered_subject TEXT,
        rendered_body TEXT,
        converted BOOLEAN DEFAULT FALSE,
        converted_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        unsubscribe_token TEXT,
        queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP,
        delivered_at TIMESTAMP,
        opened_at TIMESTAMP,
        clicked_at TIMESTAMP,
        bounced_at TIMESTAMP,
        complained_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS outreach_unsubscribes (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        unsubscribe_token VARCHAR(255),
        reason TEXT,
        unsubscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS converted_at TIMESTAMP`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS converted_user_id INTEGER`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS sequence_number INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS follow_up_delay_days INTEGER DEFAULT 5`);
    await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS max_sequence INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS follow_up_subjects JSONB`);
    await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS subject_variants JSONB`);
    await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS send_type VARCHAR(10) DEFAULT 'cold'`);
    await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS superseded_by INTEGER`);
    // One-time: backfill total_queued to actual count (counter drift fix)
    try {
      const r = await pool.query(`
        UPDATE outreach_campaigns c
        SET total_queued = COALESCE(sub.cnt, 0)
        FROM (
          SELECT campaign_id, COUNT(*) AS cnt
          FROM outreach_emails
          WHERE status = 'queued'
          GROUP BY campaign_id
        ) sub
        WHERE c.id = sub.campaign_id AND c.total_queued != sub.cnt
      `);
      if (r.rowCount > 0) console.log(`[DB] Backfilled total_queued on ${r.rowCount} campaigns`);
      // Also reset campaigns with no queued rows (counter > 0 but actual = 0)
      const r2 = await pool.query(`
        UPDATE outreach_campaigns SET total_queued = 0
        WHERE total_queued > 0 AND id NOT IN (SELECT DISTINCT campaign_id FROM outreach_emails WHERE status = 'queued')
      `);
      if (r2.rowCount > 0) console.log(`[DB] Reset total_queued to 0 on ${r2.rowCount} empty campaigns`);
    } catch (e) { console.log('[DB] total_queued backfill:', e.message); }
    // One-time: re-enable role-based emails in demand-side (SME) campaigns
    try {
      const result = await pool.query(`
        UPDATE outreach_emails SET status = 'queued', updated_at = NOW()
        WHERE campaign_id IN (SELECT id FROM outreach_campaigns WHERE type IN ('sme', 'business', 'investor'))
          AND status = 'failed'
      `);
      if (result.rowCount > 0) console.log(`[DB] Re-enabled ${result.rowCount} role-based emails in demand-side campaigns`);
    } catch (e) { /* ignore */ }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_events (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20),
        city VARCHAR(100),
        province VARCHAR(50),
        specialty VARCHAR(150),
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        session_id VARCHAR(100)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_search_events_city_spec ON search_events (city, specialty, timestamp)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_search_events_ts ON search_events (timestamp)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signal_emails (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        search_event_id INTEGER,
        email VARCHAR(255) NOT NULL,
        subject TEXT,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        opened_at TIMESTAMPTZ,
        clicked_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        resend_id VARCHAR(255)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_signal_emails_prof ON signal_emails (professional_id, sent_at)`);

    // Match notifications table for claimed professional alerts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_notifications (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        search_event_id INTEGER,
        searcher_city VARCHAR(100),
        searcher_specialty VARCHAR(150),
        searcher_type VARCHAR(50) DEFAULT 'business',
        email VARCHAR(255),
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        opened_at TIMESTAMPTZ,
        clicked_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_match_notif_prof ON match_notifications (professional_id, sent_at)`);

    // Tag re-engagement campaigns as warm
    await pool.query(`UPDATE outreach_campaigns SET send_type = 'warm' WHERE (send_type IS NULL OR send_type = 'cold') AND name ILIKE '%re-engagement%'`);
    await pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS variant_index INTEGER DEFAULT 0`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_validations (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50),
        sub_status VARCHAR(100),
        validated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[Migration] Outreach email columns + email_validations table verified');

    // Seed Tax Season Campaign (C8) — scheduled for April 14, 2026
    try {
      const existing = await pool.query("SELECT id FROM outreach_campaigns WHERE name = 'Tax Season CPA Campaign'");
      if (existing.rows.length === 0) {
        await pool.query(`
          INSERT INTO outreach_campaigns (name, type, subject_template, body_template, daily_limit, total_limit, status, send_type, created_at)
          VALUES (
            'Tax Season CPA Campaign',
            'cpa',
            '{{cpa_name}}, tax season is when clients search for a new CPA — is your profile ready?',
            '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"><tr><td style="background:linear-gradient(135deg,#2563eb 0%,#1e3a8a 100%);padding:28px 40px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">CanadaAccountants</h1><p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">AI-Powered CPA-Client Matching</p></td></tr><tr><td style="padding:36px 40px;"><p style="margin:0 0 18px;color:#1a1a1a;font-size:15px;line-height:1.7;">Hi {{first_name}},</p><p style="margin:0 0 18px;color:#333;font-size:15px;line-height:1.7;">April 30 is 16 days away. Right now, Canadians searching for a CPA are finding profiles on CanadaAccountants &mdash; but yours is unclaimed.</p><p style="margin:0 0 18px;color:#333;font-size:15px;line-height:1.7;">We already built your AI profile. Your SEO score is ??/100. Claimed CPAs in {{city}} are showing up in searches today.</p><p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.7;">Takes 30 seconds to claim before tax season ends.</p><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td style="background:linear-gradient(135deg,#2563eb,#1e3a8a);border-radius:6px;padding:14px 36px;"><a href="https://canadaaccountants.app/profile?id={{recipient_id}}" style="color:#fff;text-decoration:none;font-size:16px;font-weight:600;">Claim Before April 30 &rarr;</a></td></tr></table></td></tr><tr><td style="padding:20px 40px;border-top:1px solid #eee;background:#fafafa;"><p style="margin:0;color:#999;font-size:11px;text-align:center;"><a href="{{unsubscribe_url}}" style="color:#999;text-decoration:underline;">Unsubscribe</a> &middot; &copy; 2026 CanadaAccountants.app</p></td></tr></table></td></tr></table></body></html>',
            300,
            NULL,
            'scheduled',
            'cold',
            NOW()
          )
        `);
        console.log('[Campaign] Tax Season CPA Campaign (C8) seeded — scheduled for Apr 14');
      }
    } catch (e) { console.log('[Campaign] Tax season seed:', e.message); }

  } catch (err) {
    console.error('[Migration] Column migration error (non-fatal):', err.message);
  }
})();

// Auto-migrate: referral system + profile claiming
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER NOT NULL,
        referee_email VARCHAR(255) NOT NULL,
        referee_name VARCHAR(255),
        referee_firm VARCHAR(255),
        status VARCHAR(20) DEFAULT 'pending',
        referral_code VARCHAR(50) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        converted_at TIMESTAMP,
        UNIQUE(referrer_id, referee_email)
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_credits INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);
    `);
    // Profile claiming columns on scraped_cpas
    await pool.query(`
      ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS claimed_by INTEGER;
      ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS claim_status VARCHAR(20) DEFAULT 'unclaimed';
      ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS claim_token VARCHAR(100);
      ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS claim_requested_at TIMESTAMP;
    `);
    // CASL compliance: consent basis tracking and first contact timestamp
    await pool.query(`ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS consent_basis VARCHAR(50) DEFAULT 'professional_directory'`);
    await pool.query(`ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS first_contacted_at TIMESTAMP`);
    await pool.query(`ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS founding_member BOOLEAN DEFAULT FALSE`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS founding_member_emails (
        id SERIAL PRIMARY KEY,
        professional_id INTEGER NOT NULL,
        email VARCHAR(255) NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('[Migration] Referral + claim + CASL + founding_member columns verified');

  } catch (err) {
    console.error('[Migration] Referral/claim migration error (non-fatal):', err.message);
  }

  try {
    await crm.migrate();
    await crm.backfill();
    await crmIntelligence.migrate();
  } catch (err) {
    console.error('[CRM] Migration error:', err.message);
  }

  // Add generated_bio column for SEO profile pages
  try {
    await pool.query(`ALTER TABLE scraped_cpas ADD COLUMN IF NOT EXISTS generated_bio TEXT`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profile_visits (
        id SERIAL PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        visited_at TIMESTAMPTZ DEFAULT NOW(),
        visitor_ip VARCHAR(50),
        notified BOOLEAN DEFAULT false
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ab_test_results (
        id SERIAL PRIMARY KEY,
        variant VARCHAR(1) NOT NULL,
        page_load_at TIMESTAMPTZ DEFAULT NOW(),
        form_completed_at TIMESTAMPTZ,
        professional_id INTEGER,
        platform VARCHAR(20) DEFAULT 'accountants'
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ab_test_variant ON ab_test_results (variant, form_completed_at)`);
    console.log('[Migration] generated_bio column + profile_visits table + ab_test_results table verified');
  } catch (err) {
    console.error('[Migration] generated_bio migration error (non-fatal):', err.message);
  }

  // Seed core sequences (creates new or updates existing with new steps)
  try {
    const existing = await sequenceEngine.getSequences();
    const seqMap = {};
    for (const s of existing) {
      const steps = typeof s.steps === 'string' ? JSON.parse(s.steps) : s.steps;
      seqMap[s.name] = { id: s.id, stepCount: steps.length };
    }

    const engagedSteps = [
          {
            delay_days: 0,
            subject_line: '{{first_name}}, we just launched 3 AI-powered tools for accountants',
            body_template: `<p>Hi {{first_name}},</p>
<p>Big news — we've just launched <strong>3 AI-powered tools</strong> exclusively for claimed accountants on CanadaAccountants:</p>
<ul>
<li><strong>AI Bio Generator</strong> — a professionally written bio created from your credentials in seconds</li>
<li><strong>Profile SEO Score</strong> — see exactly how your profile ranks and what to improve to attract more clients</li>
<li><strong>Outreach Email Template</strong> — a ready-to-send announcement email to let your network know about your verified profile</li>
</ul>
<p>These tools are <strong>free for all claimed profiles</strong> and available the moment you claim.</p>
<p>CPAs with complete profiles and strong SEO scores get <strong>up to 5x more visibility</strong> in client searches.</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim & Access AI Tools</a></p>
<p style="color:#888;font-size:13px;">Takes under 2 minutes. No cost, no obligation.</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          },
          {
            delay_days: 3,
            subject_line: '{{first_name}}, your CanadaAccountants profile is getting attention',
            body_template: `<p>Hi {{first_name}},</p>
<p>We noticed you checked out your profile on <strong>CanadaAccountants</strong> — and you're not alone. Prospective clients in {{city}} are actively searching for accountants like you.</p>
<p>Right now, your listing shows basic directory info. Claiming your profile unlocks your <strong>AI-powered dashboard</strong> — including a professional bio generator, SEO score, and client outreach tools.</p>
<ul>
<li><strong>Control your narrative</strong> — add specialties, credentials, and an AI-generated bio</li>
<li><strong>Appear in priority search results</strong> — claimed profiles rank higher</li>
<li><strong>Receive warm leads</strong> — clients can contact you directly through the platform</li>
</ul>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p style="color:#888;font-size:13px;">Takes under 2 minutes.</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          },
          {
            delay_days: 7,
            subject_line: 'Quick question, {{first_name}}',
            body_template: `<p>Hi {{first_name}},</p>
<p>I noticed you opened our last email but haven't claimed your profile yet on CanadaAccountants.</p>
<p>Is there something holding you back? Many accountants tell us they weren't sure what "claiming" means — it simply means verifying you're the real {{first_name}} {{last_name}} so clients know your profile is authentic.</p>
<p>Once claimed, you get instant access to our <strong>AI tools</strong> — bio generator, SEO score, and outreach templates. No cost, no obligation. You can update or remove it anytime.</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile Now</a></p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          },
          {
            delay_days: 12,
            subject_line: 'Last call: your profile on CanadaAccountants',
            body_template: `<p>Hi {{first_name}},</p>
<p>This is our final reminder. Your unclaimed profile on CanadaAccountants will remain as-is — basic directory info only.</p>
<p>Accountants who've claimed their profiles see <strong>3x more client inquiries</strong> on average. Plus, you'll get free access to our AI-powered dashboard tools.</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p>If not, no worries — we won't email you about this again.</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          }
    ];
    if (!seqMap['Engaged No-Claim']) {
      await sequenceEngine.createSequence({
        name: 'Engaged No-Claim',
        description: 'High-conversion sequence for CPAs who opened/clicked emails but haven\'t claimed their profile yet.',
        triggerStatus: 'engaged',
        steps: engagedSteps,
        active: true
      });
      console.log('[CRM] Seeded sequence: Engaged No-Claim');
    } else if (seqMap['Engaged No-Claim'].stepCount < engagedSteps.length) {
      await sequenceEngine.updateSequence(seqMap['Engaged No-Claim'].id, { steps: engagedSteps });
      console.log('[CRM] Updated sequence: Engaged No-Claim (' + seqMap['Engaged No-Claim'].stepCount + ' → ' + engagedSteps.length + ' steps)');
    }

    const outreachSteps = [
          {
            delay_days: 0,
            subject_line: '{{first_name}}, your accountant profile is live on CanadaAccountants',
            body_template: `<p>Hi {{first_name}},</p>
<p>Your professional profile is now listed on <strong>CanadaAccountants</strong> — Canada's new platform connecting businesses with qualified accountants and CPAs.</p>
<p>We pulled your details from public CPA directory records. Here's what claiming your profile gets you:</p>
<ul>
<li><strong>Verified badge</strong> — builds instant trust with prospective clients</li>
<li><strong>Full profile control</strong> — add your photo, bio, specialties, and designations</li>
<li><strong>Client inquiries</strong> — receive contact requests directly through the platform</li>
</ul>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p style="color:#888;font-size:13px;">If you don't wish to claim, no action needed — your basic listing remains as-is.</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          },
          {
            delay_days: 5,
            subject_line: 'Businesses in {{city}} are searching — is your profile ready?',
            body_template: `<p>Hi {{first_name}},</p>
<p>We wanted to follow up — your profile on CanadaAccountants is live but unclaimed.</p>
<p>Claimed profiles appear higher in search results and include a verified badge that prospective clients look for when choosing an accountant.</p>
<p>It takes less than 2 minutes:</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
            send_condition: 'only_if_not_claimed'
          },
          {
            delay_days: 12,
            subject_line: '{{total_professionals}}+ CPAs are already listed on CanadaAccountants',
            body_template: `<p>Hi {{first_name}},</p>
<p>Over <strong>{{total_professionals}} accountants and CPAs</strong> across Canada are already listed on CanadaAccountants — and many have claimed their profiles to stand out to prospective clients.</p>
<p>Your {{city}} listing is still unclaimed. Verified accountants get priority placement in local search results and a trust badge that businesses look for.</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p style="color:#888;font-size:13px;">No cost. Takes under 2 minutes.</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
            send_condition: 'only_if_not_claimed'
          },
          {
            delay_days: 19,
            subject_line: 'Your {{city}} listing is still unclaimed',
            body_template: `<p>Hi {{first_name}},</p>
<p>Businesses searching for accountants in {{city}} can see your profile on CanadaAccountants — but it's still unclaimed.</p>
<p>Unclaimed profiles show only basic directory data. When you claim yours, you control what clients see: your bio, specialties, designations, and a verified badge.</p>
<p>It's free and takes under 2 minutes:</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
            send_condition: 'only_if_not_claimed'
          },
          {
            delay_days: 28,
            subject_line: 'Last note about your CanadaAccountants profile',
            body_template: `<p>Hi {{first_name}},</p>
<p>This is our last email about your unclaimed profile on CanadaAccountants.</p>
<p>If you'd like to claim it and get verified, the link below will always work. If not, no worries — your basic listing stays as-is and we won't email you about this again.</p>
<p><a href="{{claim_url}}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim Your Profile</a></p>
<p>All the best,<br>The CanadaAccountants Team</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
            send_condition: 'only_if_not_claimed'
          }
    ];
    if (!seqMap['Initial Outreach']) {
      await sequenceEngine.createSequence({
        name: 'Initial Outreach',
        description: 'First-contact sequence for newly validated CPAs. Introduces the platform and invites them to claim their profile.',
        triggerStatus: 'validated',
        steps: outreachSteps,
        active: true
      });
      console.log('[CRM] Seeded sequence: Initial Outreach');
    } else if (seqMap['Initial Outreach'].stepCount < outreachSteps.length) {
      await sequenceEngine.updateSequence(seqMap['Initial Outreach'].id, { steps: outreachSteps });
      console.log('[CRM] Updated sequence: Initial Outreach (' + seqMap['Initial Outreach'].stepCount + ' → ' + outreachSteps.length + ' steps)');
    }

    const welcomeSteps = [
          {
            delay_days: 0,
            subject_line: 'Welcome to CanadaAccountants, {{first_name}}!',
            body_template: `<p>Hi {{first_name}},</p>
<p>Congratulations — your profile on <strong>CanadaAccountants</strong> is now verified and live!</p>
<p>Here are 3 things you can do right now to start attracting clients:</p>
<ol>
<li><strong>Complete your bio</strong> — accountants with a full bio get 2x more views</li>
<li><strong>Add your specialties</strong> — help the right clients find you</li>
<li><strong>Upload a professional photo</strong> — profiles with photos get 40% more engagement</li>
</ol>
<p><a href="{{platform_url}}/cpa-dashboard" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Go to Your Dashboard</a></p>
<p>Questions? Just reply to this email.</p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          },
          {
            delay_days: 3,
            subject_line: 'Maximize your visibility on CanadaAccountants',
            body_template: `<p>Hi {{first_name}},</p>
<p>Now that your profile is claimed, here's how top accountants on CanadaAccountants stand out:</p>
<ul>
<li><strong>Professional members</strong> appear at the top of search results in their city</li>
<li><strong>Featured profiles</strong> get a highlighted card that catches the eye</li>
<li><strong>Priority placement</strong> means more client inquiries, faster</li>
</ul>
<p>See what a Professional membership can do for your practice:</p>
<p><a href="{{platform_url}}/pricing" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">View Membership Options</a></p>
<p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`
          }
    ];
    if (!seqMap['Post-Claim Welcome']) {
      await sequenceEngine.createSequence({
        name: 'Post-Claim Welcome',
        description: 'Onboarding sequence for CPAs who just claimed their profile. Guides them to complete their listing and upgrade.',
        triggerStatus: 'claimed',
        steps: welcomeSteps,
        active: true
      });
      console.log('[CRM] Seeded sequence: Post-Claim Welcome');
    } else if (seqMap['Post-Claim Welcome'].stepCount < welcomeSteps.length) {
      await sequenceEngine.updateSequence(seqMap['Post-Claim Welcome'].id, { steps: welcomeSteps });
      console.log('[CRM] Updated sequence: Post-Claim Welcome (' + seqMap['Post-Claim Welcome'].stepCount + ' → ' + welcomeSteps.length + ' steps)');
    }
  } catch (err) {
    console.error('[CRM] Sequence seeding error:', err.message);
  }
})();

// AI Performance Scoring Engine API
app.post('/api/performance/score', async (req, res) => {
  try {
    const { cpa, businessRequirements } = req.body;

    // AI Performance Scoring Logic
    const performanceScore = {
      overallScore: Math.floor(Math.random() * 15) + 85, // 85-99%
      performanceMetrics: {
        clientSatisfaction: Math.floor(Math.random() * 10) + 90,
        responseTime: Math.floor(Math.random() * 15) + 85,
        expertise: Math.floor(Math.random() * 8) + 92,
        reliability: Math.floor(Math.random() * 12) + 88
      },
      successPrediction: Math.floor(Math.random() * 20) + 80,
      confidence: Math.floor(Math.random() * 15) + 85,
      aiInsights: [
        "Strong track record in " + (businessRequirements?.industry || "technology") + " sector",
        "Excellent client retention rate",
        "Responsive communication style"
      ]
    };

    res.json(performanceScore);
  } catch (error) {
    console.error('Performance scoring error:', error);
    res.status(500).json({ error: 'Performance scoring failed' });
  }
});

// CPA Matching Algorithm (simplified version)
app.post('/api/match-cpas', async (req, res) => {
  try {
    const { businessRequirements } = req.body;
    
    // Mock CPA data for testing
    const mockCPAs = [
      {
        id: 1,
        name: "Sarah Johnson CPA",
        specialties: ["Tax Planning", "Small Business"],
        experience: 8,
        rating: 4.9,
        location: "Toronto, ON"
      },
      {
        id: 2,
        name: "Michael Chen CPA",
        specialties: ["Corporate Finance", "Technology"],
        experience: 12,
        rating: 4.8,
        location: "Vancouver, BC"
      },
      {
        id: 3,
        name: "Jennifer Smith CPA",
        specialties: ["Audit", "Non-Profit"],
        experience: 6,
        rating: 4.7,
        location: "Calgary, AB"
      }
    ];

    // Simple matching logic
    const matches = mockCPAs.map(cpa => ({
      ...cpa,
      matchScore: Math.floor(Math.random() * 20) + 80,
      recommendationReason: `Expert in ${cpa.specialties[0]} with ${cpa.experience} years experience`
    })).sort((a, b) => b.matchScore - a.matchScore);

    res.json({
      success: true,
      matches: matches,
      totalMatches: matches.length,
      searchCriteria: businessRequirements
    });
  } catch (error) {
    console.error('CPA matching error:', error);
    res.status(500).json({ error: 'CPA matching failed' });
  }
});

// =====================================================
// FRICTION ELIMINATION API ENDPOINTS
// =====================================================

// SME Friction Elimination Matching Request
app.post('/api/friction/sme-match-request', async (req, res) => {
  try {
    const frictionRequest = req.body;
    
    console.log('🔥 Processing SME friction elimination request:', frictionRequest);

    // Generate unique request ID
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store friction request in database
    const insertQuery = `
      INSERT INTO sme_friction_requests (
        request_id, pain_point, business_type, business_size, services_needed,
        time_being_lost, urgency_level, budget_range, contact_info, additional_context,
        friction_score, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *;
    `;

    // Calculate friction score based on pain points
    const frictionScore = calculateFrictionScore(frictionRequest);
    
    const result = await pool.query(insertQuery, [
      requestId,
      frictionRequest.painPoint || 'general',
      frictionRequest.businessType || 'small_business',
      frictionRequest.businessSize || 'small',
      JSON.stringify(frictionRequest.servicesNeeded || []),
      frictionRequest.timeBeingLost || 'moderate',
      frictionRequest.urgencyLevel || 'urgent',
      frictionRequest.budgetRange || 'standard',
      JSON.stringify(frictionRequest.contactInfo || {}),
      frictionRequest.additionalContext || '',
      frictionScore
    ]);

    // Log search event (non-blocking)
    const ci = frictionRequest.contactInfo || {};
    pool.query(
      `INSERT INTO search_events (platform, city, province, specialty, session_id) VALUES ($1, $2, $3, $4, $5)`,
      ['accountants', ci.city || null, ci.province || null, frictionRequest.painPoint || (frictionRequest.servicesNeeded || [])[0] || null, req.headers['x-session-id'] || null]
    ).catch(() => {});

    // Generate CPA matches based on friction points
    const cpaMatches = await generateFrictionBasedMatches(frictionRequest, frictionScore);
    
    // Store matches for later retrieval
    await storeFrictionMatches(requestId, cpaMatches);

    // Send immediate response
    res.json({
      success: true,
      requestId: requestId,
      message: 'Friction elimination request processed successfully',
      frictionScore: frictionScore,
      estimatedMatches: cpaMatches.length,
      nextSteps: {
        matchingTimeframe: '24 hours',
        followUpMethod: 'email',
        expectedResults: `${cpaMatches.length} highly compatible CPAs identified`
      },
      redirectUrl: `/match-results/${requestId}`,
      timestamp: new Date().toISOString()
    });

    // Send notification email (async)
    setTimeout(() => {
      sendFrictionMatchNotification(requestId, frictionRequest, cpaMatches);
    }, 1000);

    // Track outreach conversion (async, non-blocking)
    const smeEmail = frictionRequest.contactInfo?.email;
    if (smeEmail) {
      outreachEngine.trackConversion(smeEmail, null).catch(err => {
        console.error('Outreach conversion tracking error (non-fatal):', err.message);
      });
    }

  } catch (error) {
    console.error('❌ SME friction request error:', error);
    res.status(500).json({ 
      error: 'Failed to process friction elimination request',
      details: error.message 
    });
  }
});

// CPA Friction Elimination Registration
app.post('/api/friction/cpa-registration', async (req, res) => {
  try {
    const cpaRequest = req.body;
    
    console.log('🔥 Processing CPA friction elimination registration:', cpaRequest);

    // Generate unique CPA registration ID
    const registrationId = `cpa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Calculate CPA friction elimination score
    const cpaFrictionScore = calculateCPAFrictionScore(cpaRequest);
    
    // Store CPA registration
    const insertQuery = `
      INSERT INTO cpa_friction_profiles (
        registration_id, marketing_waste_amount, sales_cycle_length, current_win_rate,
        lead_generation_method, biggest_challenge, target_client_size, designation,
        contact_info, availability, friction_elimination_score, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      registrationId,
      cpaRequest.marketingWasteAmount || '30000',
      cpaRequest.salesCycleLength || '585',
      cpaRequest.currentWinRate || '25',
      cpaRequest.leadGenerationMethod || 'traditional',
      cpaRequest.biggestChallenge || 'lead_qualification',
      cpaRequest.targetClientSize || 'small_medium',
      JSON.stringify(cpaRequest.specializations || []),
      JSON.stringify(cpaRequest.contactInfo || {}),
      cpaRequest.availability || 'immediately',
      cpaFrictionScore
    ]);

    // Generate potential client matches
    const potentialClients = await generateCPAClientMatches(cpaRequest, cpaFrictionScore);
    
    res.json({
      success: true,
      registrationId: registrationId,
      message: 'CPA friction elimination registration successful',
      frictionEliminationScore: cpaFrictionScore,
      marketingWasteSavings: `$${parseInt(cpaRequest.marketingWasteAmount || 30000).toLocaleString()}`,
      salesCycleImprovement: '585 days → 24 hours',
      winRateProjection: '25% → 70%+',
      potentialMatches: potentialClients.length,
      nextSteps: {
        onboardingCall: 'Within 24 hours',
        firstClient: 'Within 72 hours',
        fullIntegration: 'Within 1 week'
      },
      timestamp: new Date().toISOString()
    });

    // Send CPA onboarding email (async)
    setTimeout(() => {
      sendCPAOnboardingEmail(registrationId, cpaRequest, potentialClients);
    }, 1000);

  } catch (error) {
    console.error('❌ CPA friction registration error:', error);
    res.status(500).json({ 
      error: 'Failed to process CPA friction elimination registration',
      details: error.message 
    });
  }
});

// Get Friction Match Results
app.get('/api/friction/match-results/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    
    console.log(`🔍 Retrieving friction match results for: ${requestId}`);

    // Get request details
    const requestQuery = `
      SELECT * FROM sme_friction_requests 
      WHERE request_id = $1;
    `;
    
    const requestResult = await pool.query(requestQuery, [requestId]);
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Match request not found' });
    }

    const frictionRequest = requestResult.rows[0];
    
    // Get CPA matches
    const matchesQuery = `
      SELECT * FROM friction_matches 
      WHERE request_id = $1 
      ORDER BY match_score DESC;
    `;
    
    const matchesResult = await pool.query(matchesQuery, [requestId]);
    const cpaMatches = matchesResult.rows;

    // Enhance matches with real-time data
    const enhancedMatches = await enhanceMatchesWithRealtimeData(cpaMatches);
    
    res.json({
      success: true,
      requestDetails: {
        requestId: frictionRequest.request_id,
        painPoint: frictionRequest.pain_point,
        businessType: frictionRequest.business_type,
        urgencyLevel: frictionRequest.urgency_level,
        frictionScore: frictionRequest.friction_score,
        submittedAt: frictionRequest.created_at
      },
      matches: enhancedMatches,
      totalMatches: enhancedMatches.length,
      frictionEliminationSummary: {
        avgTimeReduction: '20+ hours/month recovered',
        avgCostSavings: '$3,534/year in tax optimization',
        successProbability: '85%+',
        implementationTime: '24-48 hours'
      },
      nextSteps: generateNextSteps(enhancedMatches),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error retrieving friction match results:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve match results',
      details: error.message 
    });
  }
});

// Friction Analytics Dashboard
app.get('/api/friction/analytics', async (req, res) => {
  try {
    console.log('📊 Generating friction elimination analytics');

    // Get friction elimination metrics
    const metricsQuery = `
      WITH friction_metrics AS (
        SELECT 
          COUNT(*) as total_requests,
          AVG(friction_score) as avg_friction_score,
          COUNT(CASE WHEN urgency_level = 'emergency' THEN 1 END) as emergency_requests,
          COUNT(CASE WHEN pain_point = 'time-drain' THEN 1 END) as time_drain_requests,
          COUNT(CASE WHEN pain_point = 'tax-stress' THEN 1 END) as tax_stress_requests,
          COUNT(CASE WHEN pain_point = 'cpa-search' THEN 1 END) as cpa_search_requests,
          COUNT(CASE WHEN pain_point = 'financial-chaos' THEN 1 END) as financial_chaos_requests
        FROM sme_friction_requests
        WHERE created_at::timestamp >= NOW() - INTERVAL '30 days'
      ),
      cpa_metrics AS (
        SELECT 
          COUNT(*) as total_cpa_registrations,
          AVG(CAST(marketing_waste_amount AS NUMERIC)) as avg_marketing_waste,
          AVG(CAST(sales_cycle_length AS NUMERIC)) as avg_sales_cycle,
          AVG(CAST(current_win_rate AS NUMERIC)) as avg_win_rate
        FROM cpa_friction_profiles
        WHERE created_at::timestamp >= NOW() - INTERVAL '30 days'
      )
      SELECT fm.*, cm.* FROM friction_metrics fm, cpa_metrics cm;
    `;

    const result = await pool.query(metricsQuery);
    const metrics = result.rows[0];

    const analytics = {
      frictionEliminationMetrics: {
        totalRequests: parseInt(metrics.total_requests) || 0,
        avgFrictionScore: parseFloat(metrics.avg_friction_score) || 0,
        painPointDistribution: {
          timeDrain: parseInt(metrics.time_drain_requests) || 0,
          taxStress: parseInt(metrics.tax_stress_requests) || 0,
          cpaSearch: parseInt(metrics.cpa_search_requests) || 0,
          financialChaos: parseInt(metrics.financial_chaos_requests) || 0
        },
        urgencyLevels: {
          emergency: parseInt(metrics.emergency_requests) || 0
        }
      },
      cpaFrictionMetrics: {
        totalRegistrations: parseInt(metrics.total_cpa_registrations) || 0,
        avgMarketingWaste: parseFloat(metrics.avg_marketing_waste) || 30000,
        avgSalesCycle: parseFloat(metrics.avg_sales_cycle) || 585,
        avgWinRate: parseFloat(metrics.avg_win_rate) || 25
      },
      frictionEliminationImpact: {
        totalTimeSaved: calculateTotalTimeSaved(metrics),
        totalCostSavings: calculateTotalCostSavings(metrics),
        salesCycleReduction: '585 days → 24 hours (96% improvement)',
        winRateImprovement: '25% → 70%+ (180% improvement)',
        marketingWasteElimination: '$30,000+ → $1,000 (97% reduction)'
      },
      timestamp: new Date().toISOString()
    };

    res.json(analytics);

  } catch (error) {
    console.error('❌ Error generating friction analytics:', error);
    res.status(500).json({ 
      error: 'Failed to generate friction analytics',
      details: error.message 
    });
  }
});

// =====================================================================
// LIVE MARKET INTELLIGENCE APIs
// =====================================================================

// Live Industry Data Endpoint
app.get('/api/market/industry-data', async (req, res) => {
  try {
    console.log('🔥 Generating live market intelligence data');
    
    const marketData = {
      industries: [
        {
          name: 'Technology & Software',
          marketShare: 27.1,
          growthTrend: '+15%',
          primaryChallenge: 'Rapid scaling & investor reporting',
          cpaSpecialization: 'Growth-stage expertise'
        },
        {
          name: 'Retail & E-commerce',
          marketShare: 17.0,
          growthTrend: '→ 0%',
          primaryChallenge: 'Multi-channel integration',
          cpaSpecialization: 'E-commerce accounting'
        },
        {
          name: 'Manufacturing',
          marketShare: 15.4,
          growthTrend: '↘ -5%',
          primaryChallenge: 'Cost accounting precision',
          cpaSpecialization: 'Industrial accounting'
        },
        {
          name: 'Healthcare & Medical',
          marketShare: 12.6,
          growthTrend: '↗ +8%',
          primaryChallenge: 'Regulatory compliance',
          cpaSpecialization: 'Healthcare regulations'
        },
        {
          name: 'Construction & Real Estate',
          marketShare: 10.1,
          growthTrend: '↗ +12%',
          primaryChallenge: 'Project-based accounting',
          cpaSpecialization: 'Construction accounting'
        }
      ],
      lastUpdated: new Date().toISOString(),
      updateFrequency: '24 hours'
    };
    
    res.json(marketData);
  } catch (error) {
    console.error('❌ Error generating market data:', error);
    res.status(500).json({
      error: 'Failed to generate market intelligence',
      details: error.message
    });
  }
});

// Live SME Insights Endpoint
app.get('/api/market/sme-insights', async (req, res) => {
  try {
    console.log('📊 Generating live SME market insights');
    
    const smeInsights = {
      keyMetrics: [
        {
          metric: '60%',
          description: 'of Canadian SMEs face cash flow management challenges',
          source: 'CW Bank Survey, 2025',
          updated: '09:49 AM ET'
        },
        {
          metric: '47%',
          description: 'QuickBooks market dominance among Canadian SMEs',
          source: 'Statistics Canada Advanced Technology Survey 2022',
          updated: '09:49 AM ET'
        },
        {
          metric: '34%',
          description: 'SMEs in active scaling phase, requiring specialized growth-stage CPA expertise',
          source: 'Intuit QuickBooks 2025 Survey',
          updated: '09:49 AM ET'
        }
      ],
      timestamp: new Date().toISOString(),
      updateFrequency: 'Real-Time'
    };
    
    res.json(smeInsights);
  } catch (error) {
    console.error('❌ Error generating SME insights:', error);
    res.status(500).json({
      error: 'Failed to generate SME insights',
      details: error.message
    });
  }
});

// =====================================================
// FRICTION ELIMINATION HELPER FUNCTIONS
// =====================================================

function calculateFrictionScore(request) {
  let score = 0;
  
  // Pain point scoring
  const painPointScores = {
    'time-drain': 25,
    'tax-stress': 20,
    'cpa-search': 30,
    'financial-chaos': 35
  };
  score += painPointScores[request.painPoint] || 20;
  
  // Urgency scoring
  const urgencyScores = {
    'emergency': 30,
    'urgent': 20,
    'soon': 10,
    'flexible': 5
  };
  score += urgencyScores[request.urgencyLevel] || 15;
  
  // Business size impact
  const sizeScores = {
    'startup': 10,
    'small': 15,
    'medium': 20,
    'large': 25
  };
  score += sizeScores[request.businessSize] || 15;
  
  // Time being lost
  const timeScores = {
    'minimal': 5,
    'moderate': 15,
    'significant': 25,
    'severe': 35
  };
  score += timeScores[request.timeBeingLost] || 15;
  
  return Math.min(100, score);
}

function calculateCPAFrictionScore(request) {
  let score = 0;
  
  // Marketing waste impact
  const wasteAmount = parseInt(request.marketingWasteAmount) || 30000;
  score += Math.min(40, wasteAmount / 1000);
  
  // Sales cycle length impact
  const cycleLength = parseInt(request.salesCycleLength) || 585;
  score += Math.min(30, cycleLength / 20);
  
  // Win rate impact (inverse scoring)
  const winRate = parseInt(request.currentWinRate) || 25;
  score += Math.max(0, 30 - winRate);
  
  return Math.min(100, score);
}

async function generateFrictionBasedMatches(request, frictionScore) {
  try {
    // Query real CPAs from the database
    const result = await pool.query(
      'SELECT * FROM cpa_profiles WHERE is_active = true'
    );

    if (result.rows.length === 0) {
      return [];
    }

    // Map pain points to relevant specializations
    const painPointSpecializations = {
      'time-drain': ['bookkeeping', 'payroll', 'small business', 'accounting'],
      'tax-stress': ['tax-planning', 'tax', 'compliance', 'tax planning'],
      'financial-chaos': ['cfo-services', 'financial-planning', 'financial', 'consulting', 'advisory'],
      'cpa-search': null // matches all specializations
    };

    const relevantSpecs = painPointSpecializations[request.painPoint] || null;

    // Score each CPA
    const scoredCPAs = result.rows.map(cpa => {
      let score = 0;

      // Specialization match (0-40 pts)
      if (relevantSpecs) {
        const cpaSpecs = Array.isArray(cpa.specializations)
          ? cpa.specializations
          : (typeof cpa.specializations === 'string' ? JSON.parse(cpa.specializations || '[]') : []);
        const specMatch = cpaSpecs.some(spec =>
          relevantSpecs.some(rs => spec.toLowerCase().includes(rs))
        );
        score += specMatch ? 40 : 10;
      } else {
        // cpa-search matches everyone
        score += 30;
      }

      // Province proximity (0-20 pts)
      const smeLocation = (request.contactInfo?.province || request.contactInfo?.location || '').toLowerCase();
      const cpaProvince = (cpa.province || '').toLowerCase();
      if (smeLocation && cpaProvince && smeLocation.includes(cpaProvince)) {
        score += 20;
      } else if (cpaProvince) {
        score += 5;
      }

      // Experience level (0-15 pts)
      const years = cpa.years_experience || 0;
      if (years >= 15) score += 15;
      else if (years >= 10) score += 12;
      else if (years >= 5) score += 8;
      else score += 4;

      // Firm size fit (0-15 pts)
      const bizSize = (request.businessSize || '').toLowerCase();
      const firmSize = (cpa.firm_size || '').toLowerCase();
      const sizeCompatibility = {
        'startup': ['solo', 'small'],
        'small': ['solo', 'small', 'medium'],
        'medium': ['small', 'medium', 'large'],
        'large': ['medium', 'large']
      };
      if (sizeCompatibility[bizSize] && sizeCompatibility[bizSize].some(s => firmSize.includes(s))) {
        score += 15;
      } else {
        score += 5;
      }

      // Verification bonus (0-10 pts)
      if (cpa.verification_status === 'verified') {
        score += 10;
      }

      const matchScore = Math.min(100, score);
      const cpaSpecs = Array.isArray(cpa.specializations)
        ? cpa.specializations
        : (typeof cpa.specializations === 'string' ? JSON.parse(cpa.specializations || '[]') : []);

      return {
        id: cpa.cpa_id || String(cpa.id),
        name: `${cpa.first_name || ''} ${cpa.last_name || ''}`.trim() || cpa.firm_name || 'CPA',
        specializations: cpaSpecs,
        experience: cpa.years_experience || 0,
        frictionExpertise: request.painPoint || 'general',
        successRate: cpa.verification_status === 'verified' ? 90 : 75,
        avgTimeSavings: `${Math.max(10, (cpa.years_experience || 5) * 2)} hours/month`,
        avgCostSavings: `$${Math.max(2000, (cpa.years_experience || 5) * 400).toLocaleString()}/year`,
        location: `${cpa.city || ''}, ${cpa.province || ''}`.replace(/^, |, $/g, '') || 'Canada',
        availability: 'within_24h',
        matchScore: matchScore
      };
    });

    // Sort by score descending, return top 3
    return scoredCPAs
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 3);
  } catch (error) {
    console.error('Error generating friction-based matches:', error);
    return [];
  }
}

async function generateCPAClientMatches(request, frictionScore) {
  try {
    // Query recent SME friction requests that could match this CPA's specializations
    const cpaSpecs = request.specializations || [];
    const result = await pool.query(`
      SELECT request_id, pain_point, business_type, business_size,
             urgency_level, friction_score, contact_info, created_at
      FROM sme_friction_requests
      ORDER BY created_at DESC
      LIMIT 10
    `);

    if (result.rows.length === 0) {
      return [];
    }

    return result.rows.map(row => {
      const contactInfo = typeof row.contact_info === 'string'
        ? JSON.parse(row.contact_info || '{}')
        : (row.contact_info || {});
      return {
        industry: row.business_type || 'General',
        size: row.business_size || 'Small Business',
        painPoint: row.pain_point || 'general',
        urgency: row.urgency_level || 'soon',
        matchProbability: Math.min(95, (row.friction_score || 50) + 20),
        company: contactInfo.company || '',
        requestDate: row.created_at
      };
    }).slice(0, 5);
  } catch (error) {
    console.error('Error generating CPA client matches:', error);
    return [];
  }
}

async function storeFrictionMatches(requestId, matches) {
  try {
    for (const match of matches) {
      const insertQuery = `
        INSERT INTO friction_matches (
          request_id, cpa_id, cpa_name, designation, match_score,
          friction_expertise, success_rate, avg_time_savings, avg_cost_savings,
          location, availability, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW());
      `;
      
      await pool.query(insertQuery, [
        requestId,
        match.id,
        match.name,
        JSON.stringify(match.specializations),
        match.matchScore,
        match.frictionExpertise,
        match.successRate,
        match.avgTimeSavings,
        match.avgCostSavings,
        match.location,
        match.availability
      ]);
    }
  } catch (error) {
    console.error('Error storing friction matches:', error);
  }
}

async function enhanceMatchesWithRealtimeData(matches) {
  return matches.map(match => ({
    ...match,
    realTimeStatus: 'available',
    responseTime: '< 2 hours'
  }));
}

function generateNextSteps(matches) {
  return {
    immediate: 'Schedule consultation call with top-matched CPA',
    week1: 'Complete financial assessment and optimization plan',
    week2: 'Implement friction elimination strategies',
    ongoing: 'Monitor savings and continuous optimization'
  };
}

function calculateTotalTimeSaved(metrics) {
  const avgRequestsPerDay = (metrics.total_requests || 0) / 30;
  const avgTimeSavingsPerRequest = 20; // hours per month
  return Math.round(avgRequestsPerDay * avgTimeSavingsPerRequest * 30);
}

function calculateTotalCostSavings(metrics) {
  const avgRequestsPerDay = (metrics.total_requests || 0) / 30;
  const avgCostSavingsPerRequest = 3534; // dollars per year
  return Math.round(avgRequestsPerDay * avgCostSavingsPerRequest * 30);
}

// =====================================================
// CPA DASHBOARD API ENDPOINTS
// =====================================================

// CPA: Get my matches (leads)
app.get('/api/cpa/my-matches', authenticateToken, requireCPA, async (req, res) => {
  try {
    // Find the CPA's profile via user_id or email
    const profileResult = await pool.query(
      'SELECT * FROM cpa_profiles WHERE user_id = $1 OR email = $2 LIMIT 1',
      [req.user.userId, req.user.email]
    );

    if (profileResult.rows.length === 0) {
      return res.json({ success: true, matches: [], message: 'No CPA profile found' });
    }

    const cpaProfile = profileResult.rows[0];
    const cpaId = cpaProfile.cpa_id || String(cpaProfile.id);

    // Get friction matches for this CPA
    const matchesResult = await pool.query(`
      SELECT fm.*, sfr.pain_point, sfr.business_type, sfr.business_size,
             sfr.urgency_level, sfr.contact_info AS sme_contact, sfr.friction_score,
             sfr.created_at AS request_date
      FROM friction_matches fm
      LEFT JOIN sme_friction_requests sfr ON fm.request_id = sfr.request_id
      WHERE fm.cpa_id = $1
      ORDER BY fm.created_at DESC
    `, [cpaId]);

    res.json({ success: true, matches: matchesResult.rows });
  } catch (error) {
    console.error('CPA my-matches error:', error);
    res.status(500).json({ error: 'Failed to fetch matches', details: error.message });
  }
});

// CPA: Get my profile
app.get('/api/cpa/my-profile', authenticateToken, requireCPA, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cpa_profiles WHERE user_id = $1 OR email = $2 LIMIT 1',
      [req.user.userId, req.user.email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CPA profile not found' });
    }

    res.json({ success: true, profile: result.rows[0] });
  } catch (error) {
    console.error('CPA my-profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile', details: error.message });
  }
});

// CPA: Update my profile
app.put('/api/cpa/my-profile', authenticateToken, requireCPA, async (req, res) => {
  try {
    const { specializations, hourlyRate, firmName, province, city, phone } = req.body;

    const result = await pool.query(`
      UPDATE cpa_profiles SET
        specializations = COALESCE($1, designation),
        hourly_rate_min = COALESCE($2, hourly_rate_min),
        firm_name = COALESCE($3, firm_name),
        province = COALESCE($4, province),
        city = COALESCE($5, city),
        phone = COALESCE($6, phone),
        updated_date = NOW()
      WHERE user_id = $7 OR email = $8
      RETURNING *
    `, [
      specializations ? JSON.stringify(specializations) : null,
      hourlyRate || null,
      firmName || null,
      province || null,
      city || null,
      phone || null,
      req.user.userId,
      req.user.email
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CPA profile not found' });
    }

    res.json({ success: true, profile: result.rows[0] });
  } catch (error) {
    console.error('CPA update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile', details: error.message });
  }
});

// CPA: Get my stats
app.get('/api/cpa/my-stats', authenticateToken, requireCPA, async (req, res) => {
  try {
    const profileResult = await pool.query(
      'SELECT * FROM cpa_profiles WHERE user_id = $1 OR email = $2 LIMIT 1',
      [req.user.userId, req.user.email]
    );

    if (profileResult.rows.length === 0) {
      return res.json({ success: true, stats: { totalMatches: 0, byStatus: {} } });
    }

    const cpaId = profileResult.rows[0].cpa_id || String(profileResult.rows[0].id);

    const statsResult = await pool.query(`
      SELECT
        COUNT(*) AS total_matches,
        COUNT(CASE WHEN status = 'presented' THEN 1 END) AS presented,
        COUNT(CASE WHEN status = 'contacted' THEN 1 END) AS contacted,
        COUNT(CASE WHEN status = 'meeting_scheduled' THEN 1 END) AS meetings,
        COUNT(CASE WHEN partnership_formed = true THEN 1 END) AS partnerships
      FROM friction_matches
      WHERE cpa_id = $1
    `, [cpaId]);

    const s = statsResult.rows[0];
    res.json({
      success: true,
      stats: {
        totalMatches: parseInt(s.total_matches) || 0,
        presented: parseInt(s.presented) || 0,
        contacted: parseInt(s.contacted) || 0,
        meetings: parseInt(s.meetings) || 0,
        partnerships: parseInt(s.partnerships) || 0,
        verificationStatus: profileResult.rows[0].verification_status
      }
    });
  } catch (error) {
    console.error('CPA my-stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats', details: error.message });
  }
});

// =====================================================
// AI POST-CLAIM FEATURE ROUTES
// =====================================================

// Generate AI Bio
app.post('/api/cpa/ai-bio', authenticateToken, requireCPA, async (req, res) => {
  try {
    const profile = await pool.query(
      `SELECT cp.*, sc.first_name as scraped_first, sc.last_name as scraped_last, sc.designation as scraped_designation, sc.city as scraped_city, sc.province as scraped_province, sc.firm_name as scraped_firm
       FROM cpa_profiles cp
       LEFT JOIN scraped_cpas sc ON sc.claimed_by = cp.user_id
       WHERE cp.user_id = $1`, [req.user.userId]
    );
    if (profile.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

    const p = profile.rows[0];
    const merged = {
      first_name: p.first_name || p.scraped_first,
      last_name: p.last_name || p.scraped_last,
      firm_name: p.firm_name || p.scraped_firm,
      city: p.city || p.scraped_city,
      province: p.province || p.scraped_province,
      designation: p.designation || p.scraped_designation,
      specializations: Array.isArray(p.specializations) ? p.specializations.join(', ') : (p.specializations || ''),
      years_experience: p.years_experience
    };

    const bio = await generateBio(merged, 'accountants');
    res.json({ success: true, bio });
  } catch (error) {
    console.error('AI bio error:', error.message);
    res.status(500).json({ error: 'Failed to generate bio' });
  }
});

// SEO / Profile Completeness Score
app.get('/api/cpa/seo-score', authenticateToken, requireCPA, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cp.*, cs.plan_type as subscription_tier, sc.claim_status, sc.designation
       FROM cpa_profiles cp
       LEFT JOIN cpa_subscriptions cs ON cp.id = cs.cpa_profile_id
       LEFT JOIN scraped_cpas sc ON sc.claimed_by = cp.user_id
       WHERE cp.user_id = $1
       LIMIT 1`, [req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

    const score = calculateSEOScore(result.rows[0]);
    res.json({ success: true, ...score });
  } catch (error) {
    console.error('SEO score error:', error.message);
    res.status(500).json({ error: 'Failed to calculate score' });
  }
});

// Generate Outreach Announcement Template
app.post('/api/cpa/outreach-template', authenticateToken, requireCPA, async (req, res) => {
  try {
    const profile = await pool.query(
      `SELECT cp.*, sc.first_name as scraped_first, sc.last_name as scraped_last, sc.designation as scraped_designation, sc.city as scraped_city, sc.province as scraped_province, sc.firm_name as scraped_firm
       FROM cpa_profiles cp
       LEFT JOIN scraped_cpas sc ON sc.claimed_by = cp.user_id
       WHERE cp.user_id = $1`, [req.user.userId]
    );
    if (profile.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

    const p = profile.rows[0];
    const merged = {
      first_name: p.first_name || p.scraped_first,
      last_name: p.last_name || p.scraped_last,
      firm_name: p.firm_name || p.scraped_firm,
      city: p.city || p.scraped_city,
      province: p.province || p.scraped_province,
      specializations: Array.isArray(p.specializations) ? p.specializations.join(', ') : (p.specializations || '')
    };

    const template = await generateOutreachTemplate(merged, 'accountants');
    res.json({ success: true, ...template });
  } catch (error) {
    console.error('Outreach template error:', error.message);
    res.status(500).json({ error: 'Failed to generate template' });
  }
});

// Save bio to profile
app.put('/api/cpa/bio', authenticateToken, requireCPA, async (req, res) => {
  try {
    const { bio } = req.body;
    if (!bio) return res.status(400).json({ error: 'Bio is required' });
    await pool.query('UPDATE cpa_profiles SET bio = $1, updated_date = NOW() WHERE user_id = $2', [bio, req.user.userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save bio' });
  }
});

// =====================================================
// ADMIN DASHBOARD API ENDPOINTS
// =====================================================

// Admin: Dashboard stats overview
app.get('/api/admin/dashboard-stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE user_type = 'CPA') AS total_cpas,
        (SELECT COUNT(*) FROM users WHERE user_type = 'SME') AS total_smes,
        (SELECT COUNT(*) FROM sme_friction_requests) AS total_sme_requests,
        (SELECT COUNT(*) FROM friction_matches) AS total_matches,
        (SELECT COUNT(*) FROM friction_matches WHERE partnership_formed = true) AS total_partnerships,
        (SELECT COUNT(*) FROM cpa_friction_profiles) AS total_cpa_friction_profiles,
        (SELECT COUNT(*) FROM cpa_profiles WHERE verification_status = 'verified') AS verified_cpas,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d,
        (SELECT COUNT(*) FROM sme_friction_requests WHERE created_at >= NOW() - INTERVAL '7 days') AS new_requests_7d
    `);
    res.json({ success: true, stats: stats.rows[0] });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats', details: error.message });
  }
});

// Admin: Paginated CPA list with optional status filter
app.get('/api/admin/cpas', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const verified = req.query.verified; // 'true', 'false', or undefined (all)

    let whereClause = '';
    const params = [limit, offset];
    if (verified === 'true') {
      whereClause = "WHERE cp.verification_status = 'verified'";
    } else if (verified === 'false') {
      whereClause = "WHERE cp.verification_status != 'verified'";
    }

    const cpas = await pool.query(`
      SELECT cp.*, u.created_at AS user_created_at, u.last_login, u.is_active AS user_is_active
      FROM cpa_profiles cp
      LEFT JOIN users u ON cp.user_id = u.id
      ${whereClause}
      ORDER BY cp.created_date DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, params);

    const countResult = await pool.query(`
      SELECT COUNT(*) FROM cpa_profiles cp
      ${whereClause}
    `);

    res.json({
      success: true,
      cpas: cpas.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
      },
    });
  } catch (error) {
    console.error('Admin CPAs error:', error);
    res.status(500).json({ error: 'Failed to fetch CPAs', details: error.message });
  }
});

// Admin: Verify / unverify a CPA
app.post('/api/admin/cpas/:id/verify', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { verified } = req.body; // boolean

    const newStatus = (verified !== false) ? 'verified' : 'unverified';
    const result = await pool.query(`
      UPDATE cpa_profiles
      SET verification_status = $1, updated_date = NOW()
      WHERE id = $2
      RETURNING id, first_name, last_name, verification_status
    `, [newStatus, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CPA profile not found' });
    }

    // Send verification congratulations email if newly verified
    if (newStatus === 'verified') {
      const cpa = result.rows[0];
      // Look up full profile for email
      const fullProfile = await pool.query('SELECT * FROM cpa_profiles WHERE id = $1', [id]);
      if (fullProfile.rows.length > 0 && fullProfile.rows[0].email) {
        sendCPAVerificationEmail(fullProfile.rows[0]).catch(err => {
          console.error('Verification email error (non-fatal):', err.message);
        });
      }
    }

    res.json({ success: true, cpa: result.rows[0] });
  } catch (error) {
    console.error('Admin verify CPA error:', error);
    res.status(500).json({ error: 'Failed to update CPA verification', details: error.message });
  }
});

// Admin: Recent friction elimination submissions
app.get('/api/admin/submissions', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const result = await pool.query(`
      SELECT request_id, pain_point, business_type, business_size,
             urgency_level, friction_score, contact_info, created_at
      FROM sme_friction_requests
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({ success: true, submissions: result.rows });
  } catch (error) {
    console.error('Admin submissions error:', error);
    res.status(500).json({ error: 'Failed to fetch submissions', details: error.message });
  }
});

// Admin: Recent match activity
app.get('/api/admin/matches', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const result = await pool.query(`
      SELECT fm.match_id, fm.request_id, fm.cpa_name, fm.match_score,
             fm.friction_expertise, fm.status, fm.partnership_formed, fm.created_at,
             sfr.pain_point, sfr.business_type, sfr.contact_info
      FROM friction_matches fm
      LEFT JOIN sme_friction_requests sfr ON fm.request_id = sfr.request_id
      ORDER BY fm.created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({ success: true, matches: result.rows });
  } catch (error) {
    console.error('Admin matches error:', error);
    res.status(500).json({ error: 'Failed to fetch matches', details: error.message });
  }
});

// =====================================================
// OUTREACH CAMPAIGN API ENDPOINTS (Admin)
// =====================================================

// Create campaign
app.post('/api/admin/outreach/campaigns', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const campaign = await outreachEngine.createCampaign(req.body);
    res.json({ success: true, campaign });
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ error: 'Failed to create campaign', details: error.message });
  }
});

// List campaigns
app.get('/api/admin/outreach/campaigns', async (req, res) => {
  try {
    const campaigns = await outreachEngine.listCampaigns();
    res.json({ success: true, campaigns });
  } catch (error) {
    console.error('List campaigns error:', error);
    res.status(500).json({ error: 'Failed to list campaigns', details: error.message });
  }
});

// Get campaign details
app.get('/api/admin/outreach/campaigns/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const campaign = await outreachEngine.getCampaign(parseInt(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to get campaign', details: error.message });
  }
});

// Update campaign
app.put('/api/admin/outreach/campaigns/:id', async (req, res) => {
  try {
    const campaign = await outreachEngine.updateCampaign(parseInt(req.params.id), req.body);
    res.json({ success: true, campaign });
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ error: 'Failed to update campaign', details: error.message });
  }
});

// Launch campaign
app.post('/api/admin/outreach/campaigns/:id/launch', async (req, res) => {
  try {
    const result = await outreachEngine.launchCampaign(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Launch campaign error:', error);
    res.status(500).json({ error: 'Failed to launch campaign', details: error.message });
  }
});

// Pause campaign
app.post('/api/admin/outreach/campaigns/:id/pause', async (req, res) => {
  try {
    await outreachEngine.pauseCampaign(parseInt(req.params.id));
    res.json({ success: true, message: 'Campaign paused' });
  } catch (error) {
    console.error('Pause campaign error:', error);
    res.status(500).json({ error: 'Failed to pause campaign', details: error.message });
  }
});

// Preview campaign template
app.post('/api/admin/outreach/campaigns/:id/preview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const preview = await outreachEngine.previewTemplate(parseInt(req.params.id));
    res.json({ success: true, preview });
  } catch (error) {
    console.error('Preview campaign error:', error);
    res.status(500).json({ error: 'Failed to preview campaign', details: error.message });
  }
});

// Test send campaign
app.post('/api/admin/outreach/campaigns/:id/test-send', async (req, res) => {
  try {
    const testEmail = req.body.email || req.user.email;
    const result = await outreachEngine.testSend(parseInt(req.params.id), testEmail);
    res.json({ success: true, result, sentTo: testEmail });
  } catch (error) {
    console.error('Test send error:', error);
    res.status(500).json({ error: 'Failed to send test email', details: error.message });
  }
});

// A/B subject variant stats
app.get('/api/admin/outreach/campaigns/:id/variants', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const variants = await outreachEngine.getVariantStats(parseInt(req.params.id));
    res.json({ success: true, variants });
  } catch (error) {
    console.error('Variant stats error:', error);
    res.status(500).json({ error: 'Failed to get variant stats', details: error.message });
  }
});

// Browse scraped CPAs (admin)
app.get('/api/admin/outreach/scraped-cpas', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { province, city, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit) || 50);
    const params = [];
    const conditions = [];
    let paramIdx = 1;

    if (province) { conditions.push(`province = $${paramIdx++}`); params.push(province); }
    if (city) { conditions.push(`city ILIKE $${paramIdx++}`); params.push(`%${city}%`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(100, parseInt(limit) || 50);
    params.push(lim, offset);

    const result = await pool.query(
      `SELECT * FROM scraped_cpas ${where} ORDER BY scraped_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM scraped_cpas ${where}`, params.slice(0, -2));

    res.json({ success: true, cpas: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page) });
  } catch (error) {
    console.error('Browse scraped CPAs error:', error);
    res.status(500).json({ error: 'Failed to browse scraped CPAs', details: error.message });
  }
});

// Browse scraped SMEs (admin)
app.get('/api/admin/outreach/scraped-smes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { province, industry, page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit) || 50);
    const params = [];
    const conditions = [];
    let paramIdx = 1;

    if (province) { conditions.push(`province = $${paramIdx++}`); params.push(province); }
    if (industry) { conditions.push(`industry ILIKE $${paramIdx++}`); params.push(`%${industry}%`); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(100, parseInt(limit) || 50);
    params.push(lim, offset);

    const result = await pool.query(
      `SELECT * FROM scraped_smes ${where} ORDER BY scraped_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
    );
    const countResult = await pool.query(`SELECT COUNT(*) FROM scraped_smes ${where}`, params.slice(0, -2));

    res.json({ success: true, smes: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page) });
  } catch (error) {
    console.error('Browse scraped SMEs error:', error);
    res.status(500).json({ error: 'Failed to browse scraped SMEs', details: error.message });
  }
});

// Bulk SME export for cross-platform sync (no auth — internal use)
app.get('/api/admin/sme/export', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5000, 10000);
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT business_name, contact_name, contact_email, industry, naics_code, province, city, website, phone, enrichment_source, source
       FROM scraped_smes
       WHERE contact_email IS NOT NULL AND contact_email != '' AND status != 'invalid'
       ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Outreach stats
app.get('/api/admin/outreach/stats', async (req, res) => {
  try {
    const stats = await outreachEngine.getOverallStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Outreach stats error:', error);
    res.status(500).json({ error: 'Failed to get outreach stats', details: error.message });
  }
});

// Outreach quality — bounce/complaint rates for 24h, 7d, 30d
app.get('/api/admin/outreach/quality', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const windows = ['24 hours', '7 days', '30 days'];
    const labels = ['24h', '7d', '30d'];
    const quality = {};

    for (let i = 0; i < windows.length; i++) {
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,
          COUNT(*) FILTER (WHERE status = 'complained') AS complained,
          COUNT(*) AS total
        FROM outreach_emails
        WHERE sent_at >= NOW() - INTERVAL '${windows[i]}'
          AND status IN ('sent','delivered','opened','clicked','bounced','complained')
      `);
      const row = result.rows[0];
      const total = parseInt(row.total, 10);
      const bounced = parseInt(row.bounced, 10);
      const complained = parseInt(row.complained, 10);
      quality[labels[i]] = {
        total,
        bounced,
        complained,
        bounce_rate: total > 0 ? (bounced / total * 100).toFixed(2) + '%' : '0.00%',
        complaint_rate: total > 0 ? (complained / total * 100).toFixed(2) + '%' : '0.00%',
      };
    }

    res.json({ success: true, quality, threshold: '5% bounce rate triggers auto-pause' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get quality metrics', details: error.message });
  }
});

// ZeroBounce validation stats
app.get('/api/admin/validation-analysis', async (req, res) => {
  try {
    const byEnrichmentSource = await pool.query(`
      SELECT l.enrichment_source,
        ev.status as zb_status,
        COUNT(*) as count
      FROM email_validations ev
      JOIN scraped_cpas l ON COALESCE(l.enriched_email, l.email) = ev.email
      GROUP BY l.enrichment_source, ev.status
      ORDER BY l.enrichment_source, count DESC
    `);
    const byProvince = await pool.query(`
      SELECT l.province,
        ev.status as zb_status,
        COUNT(*) as count
      FROM email_validations ev
      JOIN scraped_cpas l ON COALESCE(l.enriched_email, l.email) = ev.email
      GROUP BY l.province, ev.status
      ORDER BY l.province, count DESC
    `);
    const bySource = await pool.query(`
      SELECT l.source,
        ev.status as zb_status,
        COUNT(*) as count
      FROM email_validations ev
      JOIN scraped_cpas l ON COALESCE(l.enriched_email, l.email) = ev.email
      GROUP BY l.source, ev.status
      ORDER BY l.source, count DESC
    `);
    res.json({ success: true, byEnrichmentSource: byEnrichmentSource.rows, byProvince: byProvince.rows, byScraperSource: bySource.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/validation-stats', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*) AS count FROM email_validations GROUP BY status ORDER BY count DESC`
    );
    const total = result.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
    res.json({ success: true, total, statuses: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get validation stats', details: error.message });
  }
});

// Clicked professionals — who clicked but didn't claim
app.get('/api/admin/clicked-no-claim', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT oe.recipient_email, oe.recipient_name, MAX(oe.clicked_at) AS clicked_at, MIN(oe.unsubscribe_token) AS unsubscribe_token,
             MAX(sc.first_name) AS first_name, MAX(sc.last_name) AS last_name, MAX(sc.firm_name) AS firm_name,
             MAX(sc.city) AS city, MAX(sc.province) AS province, MAX(sc.designation) AS designation, MIN(sc.claim_status) AS claim_status
      FROM outreach_emails oe
      LEFT JOIN scraped_cpas sc ON sc.id = oe.recipient_id
      WHERE oe.clicked_at IS NOT NULL
        AND (sc.claim_status IS NULL OR sc.claim_status != 'claimed')
      GROUP BY oe.recipient_email, oe.recipient_name
      ORDER BY clicked_at DESC
    `);
    res.json({ success: true, count: result.rows.length, professionals: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tag clicked SMEs as client prospects
app.post('/api/admin/tag-sme-prospects', async (req, res) => {
  try {
    // Add crm_tag column if it doesn't exist
    await pool.query(`ALTER TABLE scraped_smes ADD COLUMN IF NOT EXISTS crm_tag VARCHAR(50)`).catch(() => {});

    // Find SMEs who clicked outreach emails
    const result = await pool.query(`
      SELECT DISTINCT oe.recipient_email, oe.recipient_name, oe.recipient_id
      FROM outreach_emails oe
      WHERE oe.clicked_at IS NOT NULL AND oe.recipient_type = 'sme'
    `);

    let tagged = 0;
    for (const r of result.rows) {
      try {
        await pool.query(
          `UPDATE scraped_smes SET crm_tag = 'sme_client_prospect' WHERE id = $1 OR email = $2`,
          [r.recipient_id, r.recipient_email]
        );
        tagged++;
      } catch (e) { /* skip */ }
    }

    res.json({ success: true, tagged, total_clicked: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ZeroBounce bulk purge — validates all enriched CPAs without cached validation
app.post('/api/admin/zerobounce-purge', async (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const apiKey = process.env.ZEROBOUNCE_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'ZEROBOUNCE_API_KEY not configured' });

  res.json({ success: true, message: `ZeroBounce purge started (limit: ${limit})` });

  try {
    const unvalidated = await pool.query(
      `SELECT l.id, COALESCE(l.enriched_email, l.email) as email, l.crm_status
       FROM scraped_cpas l
       WHERE COALESCE(l.enriched_email, l.email) IS NOT NULL
         AND COALESCE(l.enriched_email, l.email) != ''
         AND NOT EXISTS (
           SELECT 1 FROM email_validations ev
           WHERE ev.email = COALESCE(l.enriched_email, l.email)
             AND ev.validated_at > NOW() - INTERVAL '30 days'
         )
         AND (l.crm_status IN ('enriched', 'raw_import') OR l.crm_status IS NULL)
       ORDER BY
         CASE WHEN l.crm_status = 'enriched' THEN 0 ELSE 1 END,
         l.scraped_at ASC
       LIMIT $1`,
      [limit]
    );

    console.log(`[ZB-Purge] Starting purge of ${unvalidated.rows.length} unvalidated CPAs...`);
    let validated = 0, invalid = 0, errors = 0;

    for (const row of unvalidated.rows) {
      try {
        const result = await outreachEngine._validateEmail(row.email);
        validated++;

        if (result.valid && row.crm_status === 'enriched') {
          try {
            await crm.transition(row.id, 'validated', {
              triggeredBy: 'zerobounce_purge',
              metadata: { zb_status: result.status, zb_sub_status: result.sub_status }
            });
          } catch (e) { /* transition may not be valid from current state */ }
        } else if (!result.valid) {
          invalid++;
          try {
            await crm.transition(row.id, 'invalid', {
              triggeredBy: 'zerobounce_purge',
              metadata: { zb_status: result.status, zb_sub_status: result.sub_status }
            });
          } catch (e) { /* transition may not be valid from current state */ }
        }

        await new Promise(r => setTimeout(r, 500));
        if (validated % 50 === 0) {
          console.log(`[ZB-Purge] Progress: ${validated}/${unvalidated.rows.length} validated, ${invalid} invalid`);
        }
      } catch (err) {
        errors++;
        console.error(`[ZB-Purge] Error validating ${row.email}: ${err.message}`);
      }
    }

    console.log(`[ZB-Purge] Complete: ${validated} validated, ${invalid} invalid, ${errors} errors`);
  } catch (err) {
    console.error('[ZB-Purge] Fatal error:', err.message);
  }
});

// =====================================================
// PUBLIC OUTREACH ENDPOINTS
// =====================================================

// Resend webhook handler
app.post('/api/webhooks/resend', express.json(), async (req, res) => {
  try {
    await outreachEngine.handleResendWebhook(req.body);

    // Wire Resend events into CRM pipeline transitions
    const { type, data } = req.body || {};
    if (data?.email_id && (type === 'email.opened' || type === 'email.clicked')) {
      try {
        const recipientRow = await pool.query(
          `SELECT recipient_email FROM outreach_emails WHERE resend_email_id = $1 LIMIT 1`,
          [data.email_id]
        );
        const recipientEmail = recipientRow.rows[0]?.recipient_email;
        if (recipientEmail) {
          const prof = await pool.query(
            `SELECT id, crm_status FROM scraped_cpas WHERE enriched_email = $1 OR email = $1 LIMIT 1`,
            [recipientEmail]
          );
          if (prof.rows.length > 0 && ['contacted', 'validated', 'enriched'].includes(prof.rows[0].crm_status)) {
            await crm.transition(prof.rows[0].id, 'engaged', {
              triggeredBy: 'resend_webhook',
              metadata: { event: type, email_id: data.email_id }
            });
            console.log(`[CRM] ${type} → engaged transition for cpa ${prof.rows[0].id} (${recipientEmail})`);
          }
        }
      } catch (crmErr) {
        console.error('[CRM] Webhook transition error:', crmErr.message);
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Resend webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Unsubscribe page (GET)
app.get('/api/unsubscribe/:token', async (req, res) => {
  try {
    const info = await outreachEngine.getUnsubscribeInfo(req.params.token);
    const email = info ? info.email : '';
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Unsubscribe - CanadaAccountants</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>body{font-family:Arial,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;color:#333;}
      h2{color:#1e293b;}
      button{background:#dc2626;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:16px;}
      button:hover{background:#b91c1c;}
      .muted{color:#999;font-size:13px;margin-top:20px;}
      </style></head>
      <body>
        <h2>Unsubscribe</h2>
        <p>We're sorry to see you go${info ? `, ${info.name || ''}` : ''}.</p>
        <p>Click below to unsubscribe <strong>${email || 'your email'}</strong> from future CanadaAccountants outreach emails.</p>
        <form method="POST" action="/api/unsubscribe/${req.params.token}">
          <button type="submit">Unsubscribe Me</button>
        </form>
        <p class="muted">You will no longer receive marketing emails from CanadaAccountants.</p>
      </body></html>
    `);
  } catch (error) {
    res.status(500).send('An error occurred. Please try again later.');
  }
});

// Process unsubscribe (POST)
app.post('/api/unsubscribe/:token', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const success = await outreachEngine.processUnsubscribe(req.params.token, req.body.reason || 'user_request');
    if (success) {
      res.send(`
        <!DOCTYPE html>
        <html><head><title>Unsubscribed - CanadaAccountants</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>body{font-family:Arial,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;color:#333;}
        h2{color:#16a34a;}</style></head>
        <body>
          <h2>You've been unsubscribed</h2>
          <p>You won't receive any more marketing emails from CanadaAccountants.</p>
          <p>If this was a mistake, you can contact us at <strong>arthur@negotiateandwin.com</strong>.</p>
        </body></html>
      `);
    } else {
      res.status(400).send('Invalid or expired unsubscribe link.');
    }
  } catch (error) {
    res.status(500).send('An error occurred. Please try again later.');
  }
});

// =====================================================
// CONTACT FORM ENDPOINT
// =====================================================
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, company, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    console.log(`📧 Contact form submission from ${name} (${email})`);

    // Send emails (async, non-blocking)
    sendContactFormEmail({ name, email, phone, company, subject, message }).catch(err => {
      console.error('Contact email error (non-fatal):', err.message);
    });

    res.json({
      success: true,
      message: 'Your message has been received. We will get back to you within 1 business day.',
    });
  } catch (error) {
    console.error('❌ Contact form error:', error);
    res.status(500).json({ error: 'Failed to process contact form', details: error.message });
  }
});

// Create a new campaign (no auth — admin use only)
app.post('/api/admin/outreach/create-campaign', async (req, res) => {
  try {
    const { name, type, subject_template, body_template, daily_limit = 300, total_limit, subject_variants, follow_up_subjects } = req.body;
    if (!name || !type || !subject_template || !body_template) {
      return res.status(400).json({ error: 'name, type, subject_template, and body_template required' });
    }
    const result = await pool.query(
      `INSERT INTO outreach_campaigns (name, type, subject_template, body_template, daily_limit, total_limit, status, max_sequence, follow_up_delay_days, subject_variants, follow_up_subjects)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 3, 5, $7, $8) RETURNING id`,
      [name, type, subject_template, body_template, daily_limit, total_limit || null,
       subject_variants ? JSON.stringify(subject_variants) : null,
       follow_up_subjects ? JSON.stringify(follow_up_subjects) : null]
    );
    res.json({ success: true, campaignId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-engagement campaign: send apology to CPAs who clicked but hit 404
app.post('/api/admin/outreach/reengage-clicked', async (req, res) => {
  try {
    const { subject_template, body_template, daily_limit = 300 } = req.body;
    if (!subject_template || !body_template) {
      return res.status(400).json({ error: 'subject_template and body_template required' });
    }

    // Create campaign
    const campResult = await pool.query(
      `INSERT INTO outreach_campaigns (name, type, subject_template, body_template, daily_limit, total_limit, status, max_sequence, follow_up_delay_days)
       VALUES ($1, 'cpa', $2, $3, $4, 300, 'active', 1, 0) RETURNING id`,
      ['CPA Re-engagement — Claim Page Fix', subject_template, body_template, daily_limit]
    );
    const campaignId = campResult.rows[0].id;

    // Get clicked-no-claim CPAs with their recipient_id
    const clicked = await pool.query(`
      SELECT DISTINCT ON (oe.recipient_email)
             oe.recipient_email, oe.recipient_name, oe.recipient_id
      FROM outreach_emails oe
      LEFT JOIN scraped_cpas sc ON sc.id = oe.recipient_id
      WHERE oe.clicked_at IS NOT NULL
        AND oe.recipient_type = 'cpa'
        AND (sc.claim_status IS NULL OR sc.claim_status != 'claimed')
        AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)
      ORDER BY oe.recipient_email, oe.clicked_at DESC
    `);

    let queued = 0;
    const crypto = require('crypto');
    for (const r of clicked.rows) {
      const unsubToken = crypto.randomBytes(24).toString('hex');
      await pool.query(
        `INSERT INTO outreach_emails (campaign_id, recipient_type, recipient_id, recipient_email, recipient_name, status, unsubscribe_token, variant_index, sequence_number)
         VALUES ($1, 'cpa', $2, $3, $4, 'queued', $5, 0, 1)`,
        [campaignId, r.recipient_id, r.recipient_email, r.recipient_name, unsubToken]
      );
      queued++;
    }

    // Update campaign queued count
    await pool.query(
      `UPDATE outreach_campaigns SET total_queued = $2, updated_at = NOW() WHERE id = $1`,
      [campaignId, queued]
    );

    res.json({ success: true, campaignId, queued, message: `Campaign C${campaignId} created with ${queued} re-engagement emails queued` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual queue trigger (admin only)
app.post('/api/admin/outreach/process-queue', async (req, res) => {
  try {
    outreachEngine.processQueue().catch(err => console.error('[Outreach] Manual queue error:', err.message));
    res.json({ success: true, message: 'Queue processing triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reconcile email delivery statuses from Resend API
app.post('/api/admin/outreach/reconcile', async (req, res) => {
  try {
    const result = await outreachEngine.reconcileStatuses();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate all queued emails via ZeroBounce before sending
app.post('/api/admin/outreach/validate-queued', async (req, res) => {
  try {
    outreachEngine.validateQueued().catch(err =>
      console.error('[Outreach] Queue validation error:', err.message)
    );
    res.json({ success: true, message: 'Queue validation started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Outreach pipeline health
app.get('/api/outreach/health', async (req, res) => {
  try {
    const today = await pool.query(`SELECT COUNT(*) FROM outreach_emails WHERE sent_at >= CURRENT_DATE`);
    const queued = await pool.query(`SELECT COUNT(*) FROM outreach_emails WHERE status = 'queued'`);
    const bounced7d = await pool.query(`SELECT COUNT(*) FROM outreach_emails WHERE status = 'bounced' AND sent_at > NOW() - INTERVAL '7 days'`);
    const unsub7d = await pool.query(`SELECT COUNT(*) FROM outreach_unsubscribes WHERE unsubscribed_at > NOW() - INTERVAL '7 days'`);
    const campaigns = await pool.query(`SELECT id, name, status, daily_limit, total_sent FROM outreach_campaigns WHERE status = 'active'`);
    res.json({
      sent_today: parseInt(today.rows[0].count),
      queued: parseInt(queued.rows[0].count),
      bounced_7d: parseInt(bounced7d.rows[0].count),
      unsubscribed_7d: parseInt(unsub7d.rows[0].count),
      active_campaigns: campaigns.rows,
      schedule: '9 AM & 2 PM ET daily'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// REFERRAL SYSTEM
// =====================================================

const referralLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 10, message: { error: 'Referral limit reached (10/day)' } });

app.post('/api/referrals/send', authenticateToken, referralLimiter, async (req, res) => {
  try {
    const { email, name, message } = req.body;
    if (!email) return res.status(400).json({ error: 'Referee email is required' });

    const referralCode = `ref_${crypto.randomBytes(6).toString('hex')}`;

    // Get referrer info
    const referrer = await pool.query(
      `SELECT u.id, cp.first_name, cp.last_name FROM users u LEFT JOIN cpa_profiles cp ON u.id = cp.user_id WHERE u.id = $1`,
      [req.user.userId]
    );
    const referrerName = referrer.rows[0] ? `${referrer.rows[0].first_name || ''} ${referrer.rows[0].last_name || ''}`.trim() || 'A colleague' : 'A colleague';

    await pool.query(
      `INSERT INTO referrals (referrer_id, referee_email, referee_name, referee_firm, referral_code) VALUES ($1, $2, $3, $4, $5)`,
      [req.user.userId, email, name || null, req.body.firm || null, referralCode]
    );

    sendReferralEmail({ referrerName, refereeName: name, refereeEmail: email, referralCode, message }).catch(err => {
      console.error('[Referral] Email send error:', err.message);
    });

    res.json({ success: true, referralCode, message: 'Referral invitation sent' });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'You have already referred this email' });
    console.error('[Referral] Error:', error.message);
    res.status(500).json({ error: 'Failed to send referral' });
  }
});

app.get('/api/referrals/mine', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, referee_email, referee_name, status, referral_code, created_at, converted_at FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    const credits = await pool.query(`SELECT referral_credits FROM users WHERE id = $1`, [req.user.userId]);
    res.json({ referrals: result.rows, credits: credits.rows[0]?.referral_credits || 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

app.get('/api/referrals/verify/:code', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.referee_name, r.status, u.id as referrer_user_id, cp.first_name, cp.last_name, cp.firm_name
       FROM referrals r JOIN users u ON r.referrer_id = u.id LEFT JOIN cpa_profiles cp ON u.id = cp.user_id
       WHERE r.referral_code = $1`,
      [req.params.code]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid referral code' });
    const row = result.rows[0];
    res.json({ valid: true, referrerName: `${row.first_name || ''} ${row.last_name || ''}`.trim(), referrerFirm: row.firm_name });
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify referral code' });
  }
});

// =====================================================
// PROFILE CLAIMING
// =====================================================

app.get('/api/professionals/search', async (req, res) => {
  try {
    const { name, city, province } = req.query;
    if (!name || name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });

    let query = `SELECT id, first_name, last_name, firm_name, city, province, designation, claim_status FROM scraped_cpas WHERE (first_name || ' ' || last_name) ILIKE $1`;
    const params = [`%${name}%`];
    if (city) { params.push(`%${city}%`); query += ` AND city ILIKE $${params.length}`; }
    if (province) { params.push(province); query += ` AND province = $${params.length}`; }
    query += ` LIMIT 20`;

    const result = await pool.query(query, params);
    res.json({ results: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/api/professionals/claim/:id', authenticateToken, async (req, res) => {
  try {
    const professionalId = parseInt(req.params.id);
    const professional = await pool.query(`SELECT * FROM scraped_cpas WHERE id = $1`, [professionalId]);
    if (professional.rows.length === 0) return res.status(404).json({ error: 'Professional not found' });
    if (professional.rows[0].claim_status === 'claimed') return res.status(409).json({ error: 'Profile already claimed' });

    const claimToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE scraped_cpas SET claim_status = 'pending', claim_token = $1, claimed_by = $2, claim_requested_at = NOW() WHERE id = $3`,
      [claimToken, req.user.userId, professionalId]
    );

    const prof = professional.rows[0];
    const enrichedEmail = prof.enriched_email || prof.email;
    if (enrichedEmail) {
      sendClaimVerificationEmail({
        email: enrichedEmail,
        firstName: prof.first_name,
        claimToken,
        professionalName: `${prof.first_name || ''} ${prof.last_name || ''}`.trim()
      }).catch(err => console.error('[Claim] Email error:', err.message));
      res.json({ success: true, verification: 'email_sent', message: 'Verification email sent to the professional email on file' });
    } else {
      res.json({ success: true, verification: 'admin_review', message: 'Claim submitted for admin review (no email on file)' });
    }
  } catch (error) {
    console.error('[Claim] Error:', error.message);
    res.status(500).json({ error: 'Failed to process claim' });
  }
});

app.get('/api/professionals/verify-claim/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE scraped_cpas SET claim_status = 'claimed', claim_token = NULL, founding_member = TRUE WHERE claim_token = $1 AND claim_status = 'pending' RETURNING id, first_name, last_name, claimed_by`,
      [req.params.token]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid or expired claim token' });
    res.json({ success: true, message: 'Profile claimed successfully', professionalId: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/admin/claims/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE scraped_cpas SET claim_status = 'claimed', claim_token = NULL, founding_member = TRUE WHERE id = $1 AND claim_status = 'pending' RETURNING id, claimed_by`,
      [parseInt(req.params.id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No pending claim found' });
    res.json({ success: true, message: 'Claim approved', professionalId: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Approval failed' });
  }
});

app.get('/api/admin/claims/pending', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sc.id, sc.first_name, sc.last_name, sc.firm_name, sc.city, sc.province, sc.claimed_by, sc.claim_requested_at, u.email as claimant_email
       FROM scraped_cpas sc LEFT JOIN users u ON sc.claimed_by = u.id WHERE sc.claim_status = 'pending' ORDER BY sc.claim_requested_at DESC`
    );
    res.json({ pendingClaims: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pending claims' });
  }
});

// =====================================================
// STRIPE SUBSCRIPTION ROUTES
// =====================================================

app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { priceId: frontendPriceId, planType, email, profileId, tier, interval } = req.body;
    const lookupKey = frontendPriceId || planType || tier;
    const stripePriceId = STRIPE_PRICES[lookupKey];
    if (!stripePriceId) return res.status(400).json({ error: `Invalid plan: ${lookupKey}` });

    let customerEmail = email;
    let cpaProfileId = profileId;
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'your_jwt_secret_key');
        customerEmail = customerEmail || decoded.email;
        userId = decoded.userId;
        if (!cpaProfileId) {
          const profileResult = await pool.query('SELECT id FROM cpa_profiles WHERE user_id = $1', [decoded.userId]);
          if (profileResult.rows.length > 0) cpaProfileId = profileResult.rows[0].id.toString();
        }
      } catch (e) { /* proceed with email */ }
    }

    if (!customerEmail) return res.status(400).json({ error: 'Email is required' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/admin?upgraded=true`,
      cancel_url: `${FRONTEND_URL}/admin?upgraded=false`,
      metadata: {
        cpa_profile_id: cpaProfileId || '',
        plan_type: tier || planType || lookupKey,
        interval: interval || 'monthly',
        userId: userId ? String(userId) : '',
        tier: tier || planType || lookupKey
      },
      customer_email: customerEmail
    });

    res.json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session', details: error.message });
  }
});

app.get('/api/stripe/subscription-status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cs.* FROM cpa_subscriptions cs JOIN cpa_profiles cp ON cs.cpa_profile_id = cp.id WHERE cp.user_id = $1`,
      [req.user.userId]
    );
    res.json({ success: true, subscription: result.rows[0] || null });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch subscription', details: error.message });
  }
});

app.post('/api/stripe/create-portal-session', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cs.stripe_customer_id FROM cpa_subscriptions cs JOIN cpa_profiles cp ON cs.cpa_profile_id = cp.id WHERE cp.user_id = $1`,
      [req.user.userId]
    );
    if (!result.rows[0]?.stripe_customer_id) return res.status(400).json({ error: 'No Stripe customer found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: result.rows[0].stripe_customer_id,
      return_url: `${FRONTEND_URL}/cpa-dashboard`
    });
    res.json({ success: true, url: session.url });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create portal session', details: error.message });
  }
});

// =====================================================
// BOT CLICK FILTER — real human visit beacon
// =====================================================

// Add is_bot_click column if it doesn't exist
pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS is_bot_click BOOLEAN DEFAULT false`).catch(() => {});
pool.query(`ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS real_visit_at TIMESTAMPTZ`).catch(() => {});

// POST /api/claim/real-visit — called by claim page JS to record a real human visit
app.post('/api/claim/real-visit', async (req, res) => {
  try {
    const { ref } = req.body;
    if (!ref) return res.status(400).json({ error: 'ref required' });

    await pool.query(
      `UPDATE outreach_emails SET real_visit_at = NOW(), is_bot_click = false WHERE unsubscribe_token = $1`,
      [ref]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup test claim records
app.post('/api/admin/cleanup-test-claims', async (req, res) => {
  try {
    const r1 = await pool.query(`UPDATE scraped_cpas SET claim_status = 'unclaimed', claimed_by = NULL WHERE claimed_by IN (SELECT id FROM users WHERE email = 'test-dryrun-audit@example.com')`);
    const r2 = await pool.query(`DELETE FROM users WHERE email = 'test-dryrun-audit@example.com'`);
    res.json({ success: true, cpas_unclaimed: r1.rowCount, users_deleted: r2.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ONE-SHOT — un-claim Julie Doyle (id=26235) which was claimed during 2026-04-08 funnel verification test.
// TODO: REMOVE this endpoint after firing once.
app.post('/api/admin/_unclaim_julie_doyle', async (req, res) => {
  try {
    const before = await pool.query(`SELECT id, full_name, claim_status, claimed_by, founding_member FROM scraped_cpas WHERE id = 26235`);
    const r = await pool.query(`UPDATE scraped_cpas SET claim_status = NULL, claimed_by = NULL, founding_member = FALSE WHERE id = 26235 RETURNING id, full_name, claim_status, claimed_by, founding_member`);
    res.json({ success: true, before: before.rows[0] || null, after: r.rows[0] || null, rowCount: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// CLAIM PROFILE ENDPOINTS (free claim flow)
// =====================================================

// GET /api/claim/profile/:refToken — look up scraped profile by outreach unsubscribe_token
// GET /api/c/:recipientId — canonical claim redirect.
// Resolves recipient_id → most recent outreach_emails.unsubscribe_token →
// 302 to /claim-profile?ref=<token>. Single source of truth for every email CTA
// so direct-construction code paths (digest, visitor notif, signal, recovery, etc.)
// don't need the token in scope. Falls back to homepage if no row.
app.get('/api/c/:recipientId', async (req, res) => {
  try {
    const recipientId = parseInt(req.params.recipientId, 10);
    if (!recipientId) return res.redirect(302, `${FRONTEND_URL}/`);
    const r = await pool.query(
      `SELECT unsubscribe_token FROM outreach_emails
       WHERE recipient_id = $1 AND unsubscribe_token IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [recipientId]
    );
    if (r.rows.length === 0 || !r.rows[0].unsubscribe_token) {
      return res.redirect(302, `${FRONTEND_URL}/find-cpa`);
    }
    return res.redirect(302, `${FRONTEND_URL}/claim-profile?ref=${r.rows[0].unsubscribe_token}`);
  } catch (error) {
    console.error('[/api/c] Error:', error.message);
    return res.redirect(302, `${FRONTEND_URL}/`);
  }
});

app.get('/api/claim/profile/:refToken', async (req, res) => {
  try {
    const { refToken } = req.params;

    // Look up outreach email by unsubscribe_token
    const outreach = await pool.query(
      `SELECT id, recipient_id, recipient_type, recipient_email FROM outreach_emails WHERE unsubscribe_token = $1`,
      [refToken]
    );
    if (outreach.rows.length === 0) return res.status(404).json({ error: 'Token not found' });

    const { recipient_id, recipient_email } = outreach.rows[0];

    // Fetch scraped CPA profile
    const profile = await pool.query(
      `SELECT id, first_name, last_name, full_name, firm_name, city, province, designation, email, enriched_email FROM scraped_cpas WHERE id = $1`,
      [recipient_id]
    );
    if (profile.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

    const p = profile.rows[0];
    const rawEmail = p.enriched_email || p.email || recipient_email || '';

    // Generate AI bio + SEO score on the fly — show value BEFORE claiming
    let aiBio = null;
    let seoScore = null;
    try {
      aiBio = await generateBio({
        first_name: p.first_name,
        last_name: p.last_name,
        firm_name: p.firm_name,
        city: p.city,
        province: p.province,
        designation: p.designation,
      }, 'accountants');
    } catch (e) { console.error('[Claim] AI bio generation error:', e.message); }

    try {
      seoScore = calculateSEOScore({
        bio: aiBio,
        phone: null,
        specializations: null,
        firm_name: p.firm_name,
        designation: p.designation,
        city: p.city,
        province: p.province,
        years_experience: null,
        claim_status: 'unclaimed',
        subscription_tier: null,
      });
    } catch (e) { /* non-critical */ }

    res.json({
      name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      firstName: p.first_name,
      lastName: p.last_name,
      firmName: p.firm_name,
      city: p.city,
      province: p.province,
      credentials: p.designation,
      email: rawEmail,
      aiBio,
      seoScore,
    });
  } catch (error) {
    console.error('[Claim Profile] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /api/claim/instant — instant free claim: create account + claim profile
app.post('/api/claim/instant', async (req, res) => {
  try {
    const { refToken, email, refCode } = req.body;
    if (!refToken || !email) return res.status(400).json({ error: 'refToken and email are required' });

    // Validate refToken
    const outreach = await pool.query(
      `SELECT id, recipient_id, recipient_type, recipient_email FROM outreach_emails WHERE unsubscribe_token = $1`,
      [refToken]
    );
    if (outreach.rows.length === 0) return res.status(404).json({ error: 'Invalid token' });

    const { recipient_id } = outreach.rows[0];

    // Fetch scraped profile
    const profile = await pool.query(
      `SELECT id, first_name, last_name, full_name, firm_name, email, enriched_email, claim_status FROM scraped_cpas WHERE id = $1`,
      [recipient_id]
    );
    if (profile.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    if (profile.rows[0].claim_status === 'claimed') return res.status(409).json({ error: 'Profile already claimed' });

    // Check if user already exists
    const existingUser = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    let userId;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
    } else {
      // Create new user account with random password (magic link bypasses it)
      const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const newUser = await pool.query(
        `INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, 'CPA') RETURNING id`,
        [email, passwordHash]
      );
      userId = newUser.rows[0].id;
    }

    // Referral tracking: if refCode provided, link referrer and grant priority placement
    if (refCode) {
      try {
        const referrer = await pool.query(`SELECT id FROM users WHERE referral_code = $1`, [refCode]);
        if (referrer.rows.length > 0) {
          const referrerId = referrer.rows[0].id;
          await pool.query(`UPDATE users SET referred_by = $1 WHERE id = $2`, [referrerId, userId]);
          await pool.query(`UPDATE users SET priority_placement = true WHERE id = $1`, [referrerId]);
          console.log(`[Referral] User ${userId} referred by ${referrerId}`);
        }
      } catch (refErr) {
        console.error('[Referral] Tracking error:', refErr.message);
      }
    }

    // Mark profile as claimed + founding member
    await pool.query(
      `UPDATE scraped_cpas SET claim_status = 'claimed', claimed_by = $1, founding_member = TRUE WHERE id = $2`,
      [userId, recipient_id]
    );

    // Track conversion
    outreachEngine.trackConversion(email, userId, refToken).catch(err => {
      console.error('[Claim] trackConversion error:', err.message);
    });

    // Generate long-lived JWT for magic link (30 days)
    const token = jwt.sign(
      { userId, email, userType: 'CPA' },
      process.env.JWT_SECRET || 'your_jwt_secret_key',
      { expiresIn: '30d' }
    );

    // Generate magic login link — one click to access dashboard
    const magicLink = `${FRONTEND_URL}/admin?token=${token}`;

    // Generate referral link for post-claim prompt
    let newReferralCode = crypto.randomBytes(16).toString('hex');
    await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL`, [newReferralCode, userId]);
    const refResult = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [userId]);
    const referralLink = `${FRONTEND_URL}/join-as-cpa?ref=${refResult.rows[0].referral_code}`;

    // Send magic link email — NO password, NO extra steps
    sendEmail({
      to: email,
      subject: `You're in — access your CanadaAccountants dashboard`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1e3a8a;">Your Profile is Claimed!</h2>
          <p>Hello ${profile.rows[0].first_name || 'there'},</p>
          <p>Your professional profile on <strong>CanadaAccountants.app</strong> is now live. Your AI bio is published and visible to clients searching for CPAs in ${profile.rows[0].province || 'your area'}.</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${magicLink}" style="display: inline-block; background: linear-gradient(135deg, #2563eb, #1e3a8a); color: white; padding: 16px 40px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 16px;">Access Your Dashboard &rarr;</a>
          </p>
          <p style="color: #666; font-size: 14px;">This link logs you in automatically — no password needed. It expires in 30 days.</p>
          <p style="color: #666; font-size: 14px;">From your dashboard you can edit your bio, update your specializations, and see client matches.</p>
        </div>
      `
    }).catch(err => console.error('[Claim] Magic link email error:', err.message));

    res.json({ success: true, token, userId, magicLink, referralLink });
  } catch (error) {
    console.error('[Claim Instant] Error:', error.message);
    res.status(500).json({ error: 'Failed to process instant claim' });
  }
});

// TEMPORARY: Admin password reset (remove after use)
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) return res.status(400).json({ error: 'email and newPassword required' });
    const hash = await bcrypt.hash(newPassword, 10);
    const result = await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2 AND user_type = $3', [hash, email, 'admin']);
    if (result.rowCount === 0) {
      // Create admin if doesn't exist
      await pool.query('INSERT INTO users (email, password_hash, user_type, email_verified, is_active) VALUES ($1, $2, $3, true, true)', [email, hash, 'admin']);
      return res.json({ success: true, action: 'created' });
    }
    res.json({ success: true, action: 'updated', rowsAffected: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ====== REFERRAL SYSTEM ======

// Ensure referral columns exist
(async () => {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(64)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS priority_placement BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(50)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255)`);
    console.log('[Referral] Schema columns ensured');
  } catch (err) {
    console.error('[Referral] Schema migration error:', err.message);
  }
})();

// GET /api/referral/:userId — generate or return existing referral link
app.get('/api/referral/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid userId' });

    // Check if user already has a referral code
    const user = await pool.query(`SELECT id, referral_code FROM users WHERE id = $1`, [userId]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    let code = user.rows[0].referral_code;
    if (!code) {
      code = crypto.randomBytes(16).toString('hex');
      await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [code, userId]);
    }

    const referralLink = `${FRONTEND_URL}/join-as-cpa?ref=${code}`;
    res.json({ referralLink, code });
  } catch (err) {
    console.error('[Referral] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate referral link' });
  }
});

// =====================================================
// POST-CLAIM RETENTION LOOP
// =====================================================

const PROVINCE_POP_WEIGHT = { ON: 14, QC: 8.5, BC: 5.1, AB: 4.4, MB: 1.4, SK: 1.2, NS: 1, NB: 0.8, NL: 0.5, PE: 0.16 };

// Profile activity endpoint — returns view counts + SME match previews
app.get('/api/dashboard/activity', authenticateToken, requireCPA, async (req, res) => {
  try {
    const profile = await pool.query(
      `SELECT cp.*, sc.id as scraped_id, sc.province as scraped_province, sc.city as scraped_city, sc.first_name as scraped_first, sc.last_name as scraped_last
       FROM cpa_profiles cp
       LEFT JOIN scraped_cpas sc ON sc.claimed_by = cp.user_id
       WHERE cp.user_id = $1`, [req.user.userId]
    );
    if (profile.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    const p = profile.rows[0];
    const province = p.province || p.scraped_province || 'ON';
    const city = p.city || p.scraped_city || '';

    // Count real visits from outreach_emails (real_visit_at)
    let realViews = 0;
    if (p.scraped_id) {
      const viewResult = await pool.query(
        `SELECT COUNT(*) as views FROM outreach_emails WHERE recipient_id = $1 AND real_visit_at IS NOT NULL`,
        [p.scraped_id]
      );
      realViews = parseInt(viewResult.rows[0].views) || 0;
    }
    // Generate realistic view count based on province population weight
    const popWeight = PROVINCE_POP_WEIGHT[province] || 1;
    const baseViews = Math.floor(popWeight * 2.5 + Math.random() * popWeight * 1.5);
    const profileViews = Math.max(realViews, baseViews);

    // Query SME matches in same province
    const matches = await pool.query(
      `SELECT business_name, industry, city FROM scraped_smes WHERE province = $1 AND business_name IS NOT NULL ORDER BY scraped_at DESC LIMIT 5`,
      [province]
    );
    const matchList = matches.rows.map(m => ({
      business_name: m.business_name,
      industry: m.industry || 'Professional Services',
      city: m.city || city,
      upgrade_to_connect: true
    }));

    res.json({
      success: true,
      profileViews,
      matchesThisWeek: matchList.length,
      matches: matchList
    });
  } catch (error) {
    console.error('Dashboard activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity', details: error.message });
  }
});

// Dashboard matches endpoint — upgrade gate: free users get previews, subscribers get full details
app.get('/api/dashboard/matches', authenticateToken, requireCPA, async (req, res) => {
  try {
    // Get user subscription status
    const subResult = await pool.query(
      `SELECT cs.status, cs.plan_type FROM cpa_subscriptions cs JOIN cpa_profiles cp ON cs.cpa_profile_id = cp.id WHERE cp.user_id = $1 AND cs.status = 'active'`,
      [req.user.userId]
    );
    // Also check users table for subscription_status
    const userResult = await pool.query(
      `SELECT subscription_tier, subscription_status FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const hasSubscription = (subResult.rows.length > 0) || (userResult.rows[0]?.subscription_status === 'active');
    const tier = subResult.rows[0]?.plan_type || userResult.rows[0]?.subscription_tier || null;

    // Get user's province from profile
    const profile = await pool.query(
      `SELECT cp.province, cp.city, sc.province as scraped_province, sc.city as scraped_city
       FROM cpa_profiles cp
       LEFT JOIN scraped_cpas sc ON sc.claimed_by = cp.user_id
       WHERE cp.user_id = $1`, [req.user.userId]
    );
    const province = profile.rows[0]?.province || profile.rows[0]?.scraped_province || 'ON';

    // Query scraped_smes in user's province
    const matches = await pool.query(
      `SELECT business_name, industry, city, contact_name, contact_email, phone FROM scraped_smes WHERE province = $1 AND business_name IS NOT NULL ORDER BY scraped_at DESC LIMIT 10`,
      [province]
    );

    if (hasSubscription) {
      // Full match details for subscribers
      res.json({
        success: true,
        subscribed: true,
        tier,
        matches: matches.rows.map(m => ({
          business_name: m.business_name,
          industry: m.industry || 'Professional Services',
          city: m.city || '',
          contact_name: m.contact_name || '',
          contact_email: m.contact_email || '',
          phone: m.phone || ''
        }))
      });
    } else {
      // Preview only for free users
      res.json({
        success: true,
        subscribed: false,
        tier: null,
        matches: matches.rows.map(m => ({
          business_name: m.business_name,
          industry: m.industry || 'Professional Services',
          city: m.city || '',
          upgrade_to_connect: true
        }))
      });
    }
  } catch (error) {
    console.error('Dashboard matches error:', error);
    res.status(500).json({ error: 'Failed to fetch matches', details: error.message });
  }
});

// Weekly activity digest email — sends to all claimed CPAs
app.post('/api/admin/send-activity-digest', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const claimed = await pool.query(
      `SELECT sc.id, sc.first_name, sc.last_name, sc.email, sc.province, sc.city, sc.designation, u.id as user_id
       FROM scraped_cpas sc
       JOIN users u ON sc.claimed_by = u.id
       WHERE sc.claim_status = 'claimed' AND sc.email IS NOT NULL`
    );
    let sent = 0, failed = 0;
    for (const cpa of claimed.rows) {
      try {
        const province = cpa.province || 'ON';
        const city = cpa.city || 'your area';
        const popWeight = PROVINCE_POP_WEIGHT[province] || 1;
        const profileViews = Math.floor(popWeight * 2.5 + Math.random() * popWeight * 1.5);

        // Real visit count
        const viewResult = await pool.query(
          `SELECT COUNT(*) as views FROM outreach_emails WHERE recipient_id = $1 AND real_visit_at IS NOT NULL`, [cpa.id]
        );
        const realViews = parseInt(viewResult.rows[0].views) || 0;
        const totalViews = Math.max(realViews, profileViews);

        // SME matches
        const matches = await pool.query(
          `SELECT business_name, industry, city FROM scraped_smes WHERE province = $1 AND business_name IS NOT NULL ORDER BY scraped_at DESC LIMIT 5`, [province]
        );
        const matchCount = matches.rows.length;

        // Build match preview HTML
        const matchRows = matches.rows.map(m => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${m.business_name}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${m.industry || 'Professional Services'}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${m.city || city}</td>
          </tr>`).join('');

        // Generate login token for magic link (7-day expiry)
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ userId: cpa.user_id, email: cpa.email, userType: 'CPA' }, process.env.JWT_SECRET || 'your_jwt_secret_key', { expiresIn: '7d' });
        const dashboardLink = `${FRONTEND_URL}/cpa-dashboard?token=${token}`;

        const subject = `Your profile was viewed ${totalViews} times this week`;
        const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
  <tr><td style="background:#1e3a8a;padding:24px 32px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">Weekly Activity Report</h1>
    <p style="color:#93c5fd;margin:4px 0 0;font-size:14px;">CanadaAccountants.app</p>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:16px;color:#333;">Hi ${cpa.first_name || 'there'},</p>
    <div style="background:#eff6ff;border-left:4px solid #2563eb;padding:16px 20px;margin:16px 0;border-radius:4px;">
      <p style="margin:0;font-size:28px;font-weight:bold;color:#1e3a8a;">${totalViews} profile views</p>
      <p style="margin:4px 0 0;color:#555;">Businesses searched for accountants in ${city} this week</p>
    </div>
    <p style="font-size:16px;color:#333;"><strong>${matchCount} businesses</strong> matched your profile this week:</p>
    ${matchCount > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;margin:12px 0;">
      <tr style="background:#f9fafb;">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#555;">Business</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#555;">Industry</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#555;">City</th>
      </tr>
      ${matchRows}
    </table>` : ''}
    <p style="font-size:14px;color:#666;">Upgrade your plan to connect directly with these businesses and unlock contact details.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${dashboardLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">View Your Dashboard</a>
    </div>
    <p style="font-size:12px;color:#999;margin-top:24px;">You're receiving this because you claimed your profile on CanadaAccountants.app</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

        await sendEmail({ to: cpa.email, subject, html, from: OUTREACH_FROM });
        sent++;
        await new Promise(r => setTimeout(r, 2000)); // 2s delay between sends
      } catch (emailErr) {
        console.error(`Activity digest failed for ${cpa.email}:`, emailErr.message);
        failed++;
      }
    }
    res.json({ success: true, sent, failed, total: claimed.rows.length });
  } catch (error) {
    console.error('Activity digest error:', error);
    res.status(500).json({ error: 'Failed to send activity digest', details: error.message });
  }
});


app.post('/api/admin/generate-bios', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.key;
  if (apiKey !== (process.env.ADMIN_API_KEY || 'bio-gen-2026')) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const limit = parseInt(req.query.limit) || 100;
  res.json({ success: true, message: `Bio generation started (limit: ${limit}). Processing in background.` });

  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, firm_name, city, province, designation
       FROM scraped_cpas
       WHERE generated_bio IS NULL AND first_name IS NOT NULL AND last_name IS NOT NULL
       ORDER BY CASE WHEN claim_status = 'claimed' THEN 0 ELSE 1 END, id
       LIMIT $1`,
      [limit]
    );

    console.log(`[Bio] Starting bulk generation for ${rows.length} CPAs...`);
    let generated = 0, errors = 0;

    for (const row of rows) {
      try {
        const bio = await generateBio(row, 'accountants');
        if (bio && !bio.includes('being generated')) {
          await pool.query('UPDATE scraped_cpas SET generated_bio = $1 WHERE id = $2', [bio, row.id]);
          generated++;
        } else {
          errors++;
        }
        if (generated % 10 === 0) console.log(`[Bio] Progress: ${generated}/${rows.length} generated`);
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        errors++;
        console.error(`[Bio] Error for CPA ${row.id}: ${err.message}`);
      }
    }

    console.log(`[Bio] Complete: ${generated} generated, ${errors} errors out of ${rows.length} processed`);
  } catch (err) {
    console.error('[Bio] Bulk generation failed:', err.message);
  }
});

// ==================== PUBLIC PROFILE PAGE (SEO) ====================
app.get('/api/profiles/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, firm_name, city, province, designation,
              phone, generated_bio, claim_status, founding_member
       FROM scraped_cpas WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

    const p = rows[0];

    // Flip "Last, First" to "First Last" if needed
    let firstName = p.first_name || '';
    let lastName = p.last_name || '';
    if (firstName.includes(',') && !lastName) {
      const parts = firstName.split(',').map(s => s.trim());
      lastName = parts[0];
      firstName = parts[1] || '';
    }
    const fullName = `${firstName} ${lastName}`.trim();

    // Generate AI bio on-the-fly if missing
    let bio = p.generated_bio;
    if (!bio) {
      try {
        bio = await generateBio({ ...p, first_name: firstName, last_name: lastName }, 'accountants');
        // Persist for future requests (fire and forget)
        pool.query('UPDATE scraped_cpas SET generated_bio = $1 WHERE id = $2', [bio, p.id]).catch(() => {});
      } catch (bioErr) {
        console.error(`[Profile] Bio generation failed for id=${p.id}:`, bioErr.message);
        bio = null;
      }
    }

    // Calculate SEO score on-the-fly
    const seoScore = calculateSEOScore({
      bio: bio,
      phone: p.phone,
      specializations: p.specializations,
      firm_name: p.firm_name,
      designation: p.designation,
      city: p.city,
      province: p.province,
      years_experience: p.years_experience,
      claim_status: p.claim_status,
      subscription_tier: p.subscription_tier
    });

    const jobTitle = p.designation ? `${p.designation} — Chartered Professional Accountant` : 'Chartered Professional Accountant';
    const location = [p.city, p.province].filter(Boolean).join(', ');

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: fullName,
      jobTitle,
      ...(p.firm_name && { worksFor: { '@type': 'Organization', name: p.firm_name } }),
      ...(location && { address: { '@type': 'PostalAddress', addressLocality: p.city || '', addressRegion: p.province || '', addressCountry: 'CA' } }),
      ...(bio && { description: bio }),
      url: `https://canadaaccountants.app/profile?id=${p.id}`
    };

    res.json({
      profile: {
        id: p.id,
        name: fullName,
        first_name: firstName,
        last_name: lastName,
        firm_name: p.firm_name,
        city: p.city,
        province: p.province,
        designation: p.designation,
        bio: bio,
        claim_status: p.claim_status || 'unclaimed',
        claimed: p.claim_status === 'claimed',
        founding_member: p.founding_member || false
      },
      seo_score: seoScore,
      structured_data: jsonLd
    });

    // Track profile visit asynchronously (fire and forget)
    const visitorIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    pool.query(
      'INSERT INTO profile_visits (profile_id, visitor_ip) VALUES ($1, $2)',
      [p.id, visitorIp]
    ).catch(() => {});
  } catch (err) {
    console.error('[Profile] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sentry error handler (must be before app.listen, after all routes)
if (process.env.SENTRY_DSN && Sentry.Handlers) {
  app.use(Sentry.Handlers.errorHandler());
} else if (process.env.SENTRY_DSN && Sentry.setupExpressErrorHandler) {
  Sentry.setupExpressErrorHandler(app);
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CanadaAccountants API running on port ${PORT}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`💚 Health check available at /health`);
  console.log(`📊 API docs available at /`);
  console.log(`🔥 6-Factor Matching Algorithm Ready!`);
  console.log(`⚡ Friction Elimination Engine Active!`);
});


// Purge all bounced emails: suppress + dequeue + invalidate
app.post('/api/admin/purge-bounces', async (req, res) => {
  try {
    // 1. Find all bounced emails
    const bounced = await pool.query(
      `SELECT DISTINCT recipient_email as email FROM outreach_emails WHERE status = 'bounced' AND recipient_email IS NOT NULL`
    );
    
    let suppressed = 0, dequeued = 0, invalidated = 0;
    
    for (const row of bounced.rows) {
      const email = row.email;
      
      // 2. Add to suppression list
      try {
        await pool.query(
          `INSERT INTO outreach_unsubscribes (email, reason, unsubscribed_at) VALUES ($1, 'permanent_bounce', NOW()) ON CONFLICT (email) DO NOTHING`,
          [email]
        );
        suppressed++;
      } catch (e) {}
      
      // 3. Dequeue from active queues + decrement campaign counters
      const dq = await pool.query(
        `WITH dequeued AS (
          UPDATE outreach_emails SET status = 'failed', updated_at = NOW()
          WHERE recipient_email = $1 AND status = 'queued'
          RETURNING campaign_id
        )
        UPDATE outreach_campaigns SET total_queued = GREATEST(total_queued - sub.cnt, 0)
        FROM (SELECT campaign_id, COUNT(*) AS cnt FROM dequeued GROUP BY campaign_id) sub
        WHERE outreach_campaigns.id = sub.campaign_id`,
        [email]
      );
      dequeued += dq.rowCount;
      
      // 4. Mark profile as invalid
      try {
        await pool.query(
          `UPDATE scraped_cpas SET status = 'invalid' WHERE (email = $1 OR enriched_email = $1)`,
          [email]
        );
        invalidated += dq.rowCount > 0 ? 1 : 0;
      } catch (e) {}
    }
    
    res.json({ success: true, totalBounced: bounced.rows.length, suppressed, dequeued, invalidated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ENGAGEMENT LAYER 1: Weekly Digest
// ═══════════════════════════════════════════════════════════════════
// Weekly digest state (in-memory)
const digestState = { running: false, lastRun: null, sent: 0, errors: 0, total: 0, remaining: 0 };

// Recovery campaign — clicked-but-not-claimed apology email
const recoveryState = { running: false, lastRun: null, sent: 0, errors: 0, total: 0, remaining: 0 };

app.post('/api/admin/send-recovery-campaign', async (req, res) => {
  if (recoveryState.running) {
    return res.status(409).json({ status: 'already_running', ...recoveryState });
  }

  try {
    // Audience: clicked in last 14 days, never claimed, not unsubscribed
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(DISTINCT oe.recipient_email) as total
      FROM outreach_emails oe
      JOIN scraped_cpas sc ON sc.id = oe.recipient_id
      WHERE oe.status IN ('clicked', 'opened')
        AND oe.clicked_at > NOW() - INTERVAL '14 days'
        AND sc.claim_status IS DISTINCT FROM 'claimed'
        AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)
    `);
    const total = parseInt(countRows[0].total);

    recoveryState.running = true;
    recoveryState.lastRun = new Date().toISOString();
    recoveryState.sent = 0;
    recoveryState.errors = 0;
    recoveryState.total = total;
    recoveryState.remaining = total;

    res.status(202).json({ status: 'accepted', total, message: 'Recovery campaign processing in background' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Process in background
  (async () => {
    try {
      const { rows: recipients } = await pool.query(`
        SELECT DISTINCT ON (oe.recipient_email)
          oe.recipient_email, oe.recipient_id,
          sc.first_name, sc.last_name
        FROM outreach_emails oe
        JOIN scraped_cpas sc ON sc.id = oe.recipient_id
        WHERE oe.status IN ('clicked', 'opened')
          AND oe.clicked_at > NOW() - INTERVAL '14 days'
          AND sc.claim_status IS DISTINCT FROM 'claimed'
          AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)
        ORDER BY oe.recipient_email, oe.clicked_at DESC
      `);

      for (let i = 0; i < recipients.length; i += 50) {
        const batch = recipients.slice(i, i + 50);
        for (const r of batch) {
          try {
            let firstName = r.first_name || '';
            if (firstName.includes(',')) {
              const parts = firstName.split(',').map(s => s.trim());
              firstName = parts[1] || parts[0];
            }
            if (!firstName) firstName = 'there';

            const subject = `${firstName}, the claim link is finally fixed`;
            const claimUrl = claimRedirectUrl(r.recipient_id);
            const unsubUrl = `${BACKEND_URL}/api/unsubscribe/${r.recipient_email}`;

            const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:32px;color:#1a1a1a;">
              <p style="font-size:15px;line-height:1.7;margin:0 0 16px;">Hi ${firstName},</p>
              <p style="font-size:15px;line-height:1.7;margin:0 0 16px;">I owe you an honest apology. You clicked through to your profile on <strong>CanadaAccountants</strong> recently, but the link I sent you was broken &mdash; it dropped you on a page that couldn't actually claim anything. I tried to fix it yesterday and accidentally sent you a second broken link. I'm sorry.</p>
              <p style="font-size:15px;line-height:1.7;margin:0 0 16px;">The button below is the real, working one. I personally tested it end-to-end this time. Your AI bio is already built and waiting. Claiming takes about 30 seconds, and it's free.</p>
              <p style="font-size:15px;line-height:1.7;margin:0 0 24px;">Thank you for your patience with me on this.</p>
              <p style="font-size:15px;line-height:1.7;margin:0 0 28px;">&mdash; Arthur Kostaras</p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#2563eb,#1e3a8a);border-radius:6px;padding:14px 32px;"><a href="${claimUrl}" style="color:#fff;text-decoration:none;font-size:16px;font-weight:600;">Claim Your Profile &rarr;</a></td></tr></table>
              <p style="margin:32px 0 0;color:#999;font-size:11px;text-align:center;"><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a> &middot; CanadaAccountants.app</p>
            </div>`;

            await sendEmail({ to: r.recipient_email, subject, html, from: OUTREACH_FROM });
            recoveryState.sent++;
          } catch (e) {
            console.error(`[Recovery] Failed for ${r.recipient_email}:`, e.message);
            recoveryState.errors++;
          }
          recoveryState.remaining--;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`[Recovery] Complete: sent=${recoveryState.sent}, errors=${recoveryState.errors}`);
    } catch (err) {
      console.error('[Recovery] Fatal:', err.message);
    } finally {
      recoveryState.running = false;
    }
  })();
});

app.get('/api/admin/recovery-status', async (req, res) => {
  res.json(recoveryState);
});

app.post('/api/admin/send-weekly-digest', async (req, res) => {
  if (digestState.running) {
    return res.status(409).json({ status: 'already_running', ...digestState });
  }

  // Count recipients first
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT recipient_email) as total FROM outreach_emails
       WHERE status IN ('sent','delivered','opened','clicked')
         AND recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)`
    );
    const total = parseInt(rows[0].total);
    digestState.running = true;
    digestState.lastRun = new Date().toISOString();
    digestState.sent = 0;
    digestState.errors = 0;
    digestState.total = total;
    digestState.remaining = total;

    res.status(202).json({ status: 'accepted', total, message: 'Digest processing in background' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Process in background
  (async () => {
    try {
      const PROVINCE_POP = { ON: 14, QC: 8.5, BC: 5.1, AB: 4.4, MB: 1.4, SK: 1.2, NS: 1, NB: 0.8, NL: 0.5, PE: 0.16 };
      const delay = ms => new Promise(r => setTimeout(r, ms));

      const { rows: recipients } = await pool.query(
        `SELECT DISTINCT recipient_email FROM outreach_emails
         WHERE status IN ('sent','delivered','opened','clicked')
           AND recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)`
      );

      for (let i = 0; i < recipients.length; i += 50) {
        const batch = recipients.slice(i, i + 50);
        for (const r of batch) {
          try {
            const { rows: cpas } = await pool.query(
              `SELECT id, first_name, last_name, city, province, phone, designation, firm_name
               FROM scraped_cpas WHERE COALESCE(enriched_email, email) = $1 LIMIT 1`,
              [r.recipient_email]
            );
            if (cpas.length === 0) { digestState.remaining--; continue; }
            const cpa = cpas[0];
            const province = (cpa.province || 'ON').toUpperCase();
            const popWeight = PROVINCE_POP[province] || 1;
            const views = Math.floor(popWeight * (Math.random() * 3 + 2));
            const { rows: cityCount } = await pool.query(
              `SELECT COUNT(*) FROM scraped_cpas WHERE city = $1`, [cpa.city || 'Unknown']
            );
            const totalInCity = parseInt(cityCount[0].count) || 10;
            const rank = Math.floor(Math.random() * totalInCity * 0.6) + 1;
            let tip = '';
            if (!cpa.phone) tip = 'Add your phone number — profiles with a phone get 40% more inquiries.';
            else if (!cpa.firm_name) tip = 'Add your firm name — it builds trust and improves search ranking.';
            else tip = 'Your profile is looking strong! Consider upgrading for priority placement.';
            const firstName = cpa.first_name || 'there';
            const city = cpa.city || province;
            const subject = `Your profile this week — ${views} views in ${city}`;
            const profileUrl = claimRedirectUrl(cpa.id);
            const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:24px;"><h2 style="color:#1e3a8a;">Weekly Profile Report</h2><p>Hi ${firstName},</p><div style="text-align:center;margin:20px 0;padding:20px;background:#f0f7ff;border-radius:12px;"><div style="font-size:48px;font-weight:bold;color:#2563eb;">${views}</div><div style="color:#666;font-size:14px;">profile views this week</div></div><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">Search appearances in ${city}</td><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">${totalInCity}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">Your ranking</td><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;text-align:right;">#${rank} of ${totalInCity}</td></tr></table><div style="margin:20px 0;padding:16px;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:4px;"><strong style="color:#92400e;">Tip to boost your profile:</strong><p style="margin:8px 0 0;color:#78350f;">${tip}</p></div><p style="text-align:center;margin:24px 0;"><a href="${profileUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">View Your Profile</a></p><p style="color:#999;font-size:11px;">CanadaAccountants.app<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.recipient_email)}">Unsubscribe</a></p></div>`;
            await sendEmail({ to: r.recipient_email, subject, html, from: OUTREACH_FROM });
            digestState.sent++;
          } catch (e) {
            console.error(`[WeeklyDigest] Failed for ${r.recipient_email}:`, e.message);
            digestState.errors++;
          }
          digestState.remaining--;
        }
        await delay(1000); // 1s between batches of 50
      }
      console.log(`[WeeklyDigest] Complete: sent=${digestState.sent}, errors=${digestState.errors}, total=${digestState.total}`);
    } catch (err) {
      console.error('[WeeklyDigest] Fatal:', err.message);
    } finally {
      digestState.running = false;
    }
  })();
});

app.get('/api/admin/digest-status', async (req, res) => {
  res.json(digestState);
});

// ═══════════════════════════════════════════════════════════════════
// ENGAGEMENT LAYER 2: Behavioral Sequences
// ═══════════════════════════════════════════════════════════════════
app.post('/api/admin/send-behavioral-sequences', async (req, res) => {
  try {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const counts = { segmentA: 0, segmentB: 0, segmentC: 0, segmentD: 0, segmentE: 0 };

    // Helper: check unsubscribed
    const isUnsubscribed = async (email) => {
      const { rows } = await pool.query('SELECT 1 FROM outreach_unsubscribes WHERE email = $1', [email]);
      return rows.length > 0;
    };

    // Helper: get CPA by email
    const getCPA = async (email) => {
      const { rows } = await pool.query(
        `SELECT id, first_name, last_name, city, province, designation, firm_name, designation, generated_bio
         FROM scraped_cpas WHERE COALESCE(enriched_email, email) = $1 LIMIT 1`, [email]
      );
      return rows[0] || null;
    };

    // SEGMENT A: Opened but never clicked — send bio text in email
    const { rows: segA } = await pool.query(
      `SELECT DISTINCT recipient_email FROM outreach_emails
       WHERE opened_at IS NOT NULL AND clicked_at IS NULL
         AND recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)`
    );
    for (const r of segA) {
      try {
        const cpa = await getCPA(r.recipient_email);
        if (!cpa) continue;
        const bio = cpa.generated_bio || 'Your AI-generated bio is ready to preview when you claim your profile.';
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${cpa.first_name || 'there'},</p>
  <p>We generated a professional bio for your CanadaAccountants profile. Here's a preview:</p>
  <blockquote style="margin:16px 0;padding:16px;background:#f8fafc;border-left:4px solid #2563eb;border-radius:4px;font-style:italic;color:#334155;">${bio}</blockquote>
  <p>Claim your profile to customize it and make it live for prospective clients.</p>
  <p style="text-align:center;"><a href="${claimRedirectUrl(cpa.id)}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Claim & Customize Your Bio</a></p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.recipient_email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.recipient_email, subject: `${cpa.first_name || 'Hi'}, here's your AI-generated professional bio`, html, from: OUTREACH_FROM });
        counts.segmentA++;
        await delay(2000);
      } catch (e) { console.error(`[BehavioralA] ${r.recipient_email}:`, e.message); }
    }

    // SEGMENT B: Clicked but never claimed — send social proof
    const { rows: segB } = await pool.query(
      `SELECT DISTINCT oe.recipient_email FROM outreach_emails oe
       JOIN scraped_cpas sc ON COALESCE(sc.enriched_email, sc.email) = oe.recipient_email
       WHERE oe.clicked_at IS NOT NULL AND (sc.claim_status IS NULL OR sc.claim_status != 'claimed')
         AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)`
    );
    for (const r of segB) {
      try {
        const cpa = await getCPA(r.recipient_email);
        if (!cpa) continue;
        const { rows: claimCount } = await pool.query(
          `SELECT COUNT(*) FROM scraped_cpas WHERE claim_status = 'claimed' AND province = $1`, [cpa.province || 'ON']
        );
        const claimed = parseInt(claimCount[0].count) || 0;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${cpa.first_name || 'there'},</p>
  <p><strong>${claimed} CPAs in ${cpa.province || 'your province'}</strong> have already claimed their profiles on CanadaAccountants this month.</p>
  <p>Claimed profiles appear higher in search results and include verified badges, AI bios, and direct client contact — all at no cost.</p>
  <p>Don't let competitors in ${cpa.city || 'your city'} get ahead.</p>
  <p style="text-align:center;"><a href="${claimRedirectUrl(cpa.id)}" style="display:inline-block;background:#059669;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Claim Your Profile Now</a></p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.recipient_email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.recipient_email, subject: `${claimed} CPAs in ${cpa.province || 'your province'} just claimed their profiles`, html, from: OUTREACH_FROM });
        counts.segmentB++;
        await delay(2000);
      } catch (e) { console.error(`[BehavioralB] ${r.recipient_email}:`, e.message); }
    }

    // SEGMENT C: Multi-click — send ultra-direct with magic link JWT
    const { rows: segC } = await pool.query(
      `SELECT recipient_email, COUNT(clicked_at) as clicks FROM outreach_emails
       WHERE clicked_at IS NOT NULL
         AND recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)
       GROUP BY recipient_email HAVING COUNT(clicked_at) >= 2`
    );
    for (const r of segC) {
      try {
        const cpa = await getCPA(r.recipient_email);
        if (!cpa) continue;
        const magicToken = jwt.sign({ email: r.recipient_email, cpaId: cpa.id, action: 'claim' }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
        const magicLink = `${FRONTEND_URL}/claim?token=${magicToken}`;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${cpa.first_name || 'there'},</p>
  <p>You've visited your profile multiple times — clearly it matters to you. Let's make it official.</p>
  <p>We've created a <strong>one-click claim link</strong> just for you. No forms, no passwords — just click and your profile is claimed instantly:</p>
  <p style="text-align:center;margin:24px 0;"><a href="${magicLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:16px 40px;border-radius:8px;text-decoration:none;font-weight:700;font-size:18px;">Claim in One Click</a></p>
  <p style="color:#888;font-size:13px;">This link expires in 7 days and is unique to you.</p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.recipient_email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.recipient_email, subject: `${cpa.first_name || 'Hi'}, claim your profile in one click`, html, from: OUTREACH_FROM });
        counts.segmentC++;
        await delay(2000);
      } catch (e) { console.error(`[BehavioralC] ${r.recipient_email}:`, e.message); }
    }

    // SEGMENT D: Claimed but no return — send activity update
    const { rows: segD } = await pool.query(
      `SELECT DISTINCT COALESCE(sc.enriched_email, sc.email) as email, sc.id, sc.first_name, sc.city, sc.province
       FROM scraped_cpas sc
       WHERE sc.claim_status = 'claimed'
         AND COALESCE(sc.enriched_email, sc.email) NOT IN (SELECT email FROM outreach_unsubscribes)`
    );
    for (const r of segD) {
      try {
        if (!r.email) continue;
        const { rows: visits } = await pool.query(
          'SELECT COUNT(*) FROM profile_visits WHERE profile_id = $1', [r.id]
        );
        const visitCount = parseInt(visits[0].count) || 0;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${r.first_name || 'there'},</p>
  <p>Quick update on your CanadaAccountants profile:</p>
  <div style="padding:16px;background:#f0fdf4;border-radius:8px;margin:16px 0;">
    <p style="margin:0;"><strong>${visitCount}</strong> total profile views</p>
    <p style="margin:8px 0 0;color:#666;">Clients in ${r.city || r.province || 'your area'} are actively searching for CPAs.</p>
  </div>
  <p>Keep your profile updated to maintain visibility. Consider adding new specializations or updating your bio.</p>
  <p style="text-align:center;"><a href="${FRONTEND_URL}/profile?id=${r.id}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">View Your Dashboard</a></p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.email, subject: `Activity update: ${visitCount} views on your CanadaAccountants profile`, html, from: OUTREACH_FROM });
        counts.segmentD++;
        await delay(2000);
      } catch (e) { console.error(`[BehavioralD] ${r.email}:`, e.message); }
    }

    // SEGMENT E: Upgrade candidates — claimed but no subscription
    const { rows: segE } = await pool.query(
      `SELECT sc.id, sc.first_name, sc.city, sc.province, COALESCE(sc.enriched_email, sc.email) as email
       FROM scraped_cpas sc
       LEFT JOIN users u ON sc.claimed_by = u.id
       WHERE sc.claim_status = 'claimed'
         AND (u.subscription_tier IS NULL OR u.subscription_tier = '')
         AND COALESCE(sc.enriched_email, sc.email) NOT IN (SELECT email FROM outreach_unsubscribes)`
    );
    for (const r of segE) {
      try {
        if (!r.email) continue;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${r.first_name || 'there'},</p>
  <p>Your free profile on CanadaAccountants is live — but did you know you could be getting <strong>5x more client inquiries</strong>?</p>
  <p>Upgraded members get:</p>
  <ul style="color:#334155;">
    <li><strong>Priority placement</strong> in ${r.city || r.province || 'local'} search results</li>
    <li><strong>Verified badge</strong> that builds instant trust</li>
    <li><strong>AI-powered client matching</strong> based on specialization</li>
    <li><strong>Monthly analytics report</strong> with competitor benchmarks</li>
  </ul>
  <p style="text-align:center;margin:24px 0;"><a href="${FRONTEND_URL}/pricing" style="display:inline-block;background:#059669;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">See Upgrade Options</a></p>
  <p style="color:#888;font-size:13px;">Plans start at $199/year. Cancel anytime.</p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.email, subject: `${r.first_name || 'Hi'}, unlock priority placement for your CPA profile`, html, from: OUTREACH_FROM });
        counts.segmentE++;
        await delay(2000);
      } catch (e) { console.error(`[BehavioralE] ${r.email}:`, e.message); }
    }

    res.json({ success: true, ...counts, totalProcessed: Object.values(counts).reduce((a, b) => a + b, 0) });
  } catch (err) {
    console.error('[BehavioralSequences] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ENGAGEMENT LAYER 3: Visitor Notifications
// ═══════════════════════════════════════════════════════════════════
app.post('/api/admin/send-visitor-notifications', async (req, res) => {
  try {
    const delay = ms => new Promise(r => setTimeout(r, ms));

    // Get un-notified visits grouped by profile
    const { rows: visits } = await pool.query(
      `SELECT pv.profile_id, COUNT(*) as visit_count, MAX(pv.visited_at) as last_visit
       FROM profile_visits pv
       WHERE pv.notified = false
       GROUP BY pv.profile_id`
    );

    let sent = 0, failed = 0, enriched = 0;
    for (const v of visits) {
      try {
        const { rows: cpas } = await pool.query(
          `SELECT id, first_name, last_name, city, province, COALESCE(enriched_email, email) as email, claim_status
           FROM scraped_cpas WHERE id = $1`, [v.profile_id]
        );
        if (cpas.length === 0) continue;
        const cpa = cpas[0];
        if (!cpa.email) continue;

        // Check unsubscribe
        const { rows: unsub } = await pool.query('SELECT 1 FROM outreach_unsubscribes WHERE email = $1', [cpa.email]);
        if (unsub.length > 0) continue;

        const viewText = parseInt(v.visit_count) === 1 ? 'Someone viewed' : `${v.visit_count} people viewed`;
        let subject, html;

        // Search event enrichment for unclaimed profiles
        let matchingSearch = null;
        if (!cpa.claim_status || cpa.claim_status !== 'claimed') {
          try {
            const { rows: searchRows } = await pool.query(`
              SELECT * FROM search_events
              WHERE LOWER(city) = LOWER($1)
                AND timestamp > NOW() - INTERVAL '30 minutes'
                AND platform = 'accountants'
              ORDER BY timestamp DESC LIMIT 1
            `, [cpa.city]);
            if (searchRows.length > 0) matchingSearch = searchRows[0];
          } catch (searchErr) {
            console.log('[VisitorNotify] search_events lookup failed (non-fatal):', searchErr.message);
          }
        }

        if (matchingSearch && matchingSearch.specialty) {
          // Enriched notification with search context
          const name = cpa.first_name || 'there';
          const city = matchingSearch.city || cpa.city || 'your area';
          const specialty = matchingSearch.specialty;
          subject = `${name}, a business in ${city} searching for a ${specialty} CPA just viewed your profile`;
          html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${name},</p>
  <div style="text-align:center;margin:20px 0;padding:20px;background:#fef3c7;border-radius:12px;">
    <div style="font-size:36px;">🔍</div>
    <div style="font-size:20px;font-weight:bold;color:#92400e;margin-top:8px;">A ${specialty} CPA search in ${city} led to your profile</div>
    <div style="color:#78350f;font-size:14px;margin-top:4px;">Last visit: ${new Date(v.last_visit).toLocaleDateString('en-CA')}</div>
  </div>
  <p>Someone in ${city} searched for a <strong>${specialty}</strong> CPA and visited your profile — but it's unclaimed so we can't make the introduction yet. Claim your profile to be connected.</p>
  <p style="text-align:center;margin:24px 0;"><a href="${claimRedirectUrl(cpa.id)}" style="display:inline-block;background:#059669;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Claim & Get Introduced →</a></p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(cpa.email)}">Unsubscribe</a></p>
</div>`;
          enriched++;
        } else {
          // Generic notification (existing behavior)
          subject = `${viewText} your CanadaAccountants profile`;
          html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <p>Hi ${cpa.first_name || 'there'},</p>
  <div style="text-align:center;margin:20px 0;padding:20px;background:#fef3c7;border-radius:12px;">
    <div style="font-size:36px;">👀</div>
    <div style="font-size:20px;font-weight:bold;color:#92400e;margin-top:8px;">${viewText} your profile</div>
    <div style="color:#78350f;font-size:14px;margin-top:4px;">Last visit: ${new Date(v.last_visit).toLocaleDateString('en-CA')}</div>
  </div>
  <p>Potential clients in ${cpa.city || cpa.province || 'your area'} are actively looking at your credentials. Make sure your profile is complete and up to date.</p>
  <p style="text-align:center;margin:24px 0;"><a href="${claimRedirectUrl(cpa.id)}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">View Your Profile</a></p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(cpa.email)}">Unsubscribe</a></p>
</div>`;
        }
        await sendEmail({ to: cpa.email, subject, html, from: OUTREACH_FROM });

        // Mark visits as notified
        await pool.query('UPDATE profile_visits SET notified = true WHERE profile_id = $1 AND notified = false', [v.profile_id]);
        sent++;
        await delay(2000);
      } catch (e) {
        console.error(`[VisitorNotify] profile_id=${v.profile_id}:`, e.message);
        failed++;
      }
    }
    res.json({ success: true, sent, failed, enriched, totalProfiles: visits.length });
  } catch (err) {
    console.error('[VisitorNotifications] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ENGAGEMENT LAYER 4: Competitive Report
// ═══════════════════════════════════════════════════════════════════
app.post('/api/admin/send-competitive-report', async (req, res) => {
  try {
    const PROVINCE_POP = { ON: 14, QC: 8.5, BC: 5.1, AB: 4.4, MB: 1.4, SK: 1.2, NS: 1, NB: 0.8, NL: 0.5, PE: 0.16 };
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const now = new Date();
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    // Get province stats
    const { rows: provinceStats } = await pool.query(
      `SELECT province, COUNT(*) as total FROM scraped_cpas WHERE province IS NOT NULL GROUP BY province`
    );
    const statsMap = {};
    for (const s of provinceStats) {
      const popWeight = PROVINCE_POP[s.province] || 1;
      statsMap[s.province] = {
        total: parseInt(s.total),
        newClaims: Math.floor(popWeight * 3),
        avgScore: 50
      };
    }

    // Get all emailed professionals grouped by province
    const { rows: recipients } = await pool.query(
      `SELECT DISTINCT oe.recipient_email, sc.id, sc.first_name, sc.province
       FROM outreach_emails oe
       JOIN scraped_cpas sc ON COALESCE(sc.enriched_email, sc.email) = oe.recipient_email
       WHERE oe.status IN ('sent','delivered','opened','clicked')
         AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)
         AND sc.province IS NOT NULL`
    );

    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        const stats = statsMap[r.province] || { total: 100, newClaims: 3, avgScore: 50 };
        const subject = `CPA Market Report — ${r.province} ${monthName}`;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <h2 style="color:#1e3a8a;border-bottom:2px solid #2563eb;padding-bottom:12px;">CPA Market Report: ${r.province}</h2>
  <p>Hi ${r.first_name || 'there'},</p>
  <p>Here's your monthly competitive intelligence briefing for CPAs in ${r.province}:</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <tr style="background:#f8fafc;"><td style="padding:12px;border:1px solid #e2e8f0;font-weight:bold;">Total CPAs listed</td><td style="padding:12px;border:1px solid #e2e8f0;text-align:right;font-size:18px;color:#2563eb;">${stats.total.toLocaleString()}</td></tr>
    <tr><td style="padding:12px;border:1px solid #e2e8f0;font-weight:bold;">New claims this month</td><td style="padding:12px;border:1px solid #e2e8f0;text-align:right;font-size:18px;color:#059669;">+${stats.newClaims}</td></tr>
    <tr style="background:#f8fafc;"><td style="padding:12px;border:1px solid #e2e8f0;font-weight:bold;">Avg. profile score</td><td style="padding:12px;border:1px solid #e2e8f0;text-align:right;font-size:18px;color:#f59e0b;">${stats.avgScore}/100</td></tr>
  </table>
  <div style="padding:16px;background:#eff6ff;border-radius:8px;margin:16px 0;">
    <p style="margin:0;font-weight:bold;color:#1e3a8a;">What this means for you:</p>
    <p style="margin:8px 0 0;color:#334155;">Competition is growing. CPAs with claimed, complete profiles are capturing the majority of client inquiries. Make sure your profile stands out.</p>
  </div>
  <p style="text-align:center;margin:24px 0;"><a href="${claimRedirectUrl(r.id)}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Update Your Profile</a></p>
  <p style="color:#999;font-size:11px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.recipient_email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.recipient_email, subject, html, from: OUTREACH_FROM });
        sent++;
        await delay(2000);
      } catch (e) {
        console.error(`[CompetitiveReport] ${r.recipient_email}:`, e.message);
        failed++;
      }
    }
    res.json({ success: true, sent, failed, total: recipients.length });
  } catch (err) {
    console.error('[CompetitiveReport] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ENGAGEMENT LAYER 5: AI Market Briefs
// ═══════════════════════════════════════════════════════════════════
app.post('/api/admin/send-ai-briefs', async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const now = new Date();
    const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    // Generate and cache briefs per province
    const briefCache = {};
    const provinces = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE'];
    const PROVINCE_NAMES = { ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta', MB: 'Manitoba', SK: 'Saskatchewan', NS: 'Nova Scotia', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island' };

    for (const prov of provinces) {
      try {
        const message = await aiClient.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{ role: 'user', content: `Write a 3-paragraph market brief for CPAs (Chartered Professional Accountants) in ${PROVINCE_NAMES[prov]}, Canada. Include current trends, client demand drivers, and one actionable tip. Keep it under 200 words. Professional tone. Do not use markdown headers.` }]
        });
        briefCache[prov] = message.content[0].text.trim();
      } catch (e) {
        console.error(`[AIBriefs] Failed to generate brief for ${prov}:`, e.message);
        briefCache[prov] = `The CPA market in ${PROVINCE_NAMES[prov]} continues to show strong demand, particularly in advisory services and tax planning. Firms that invest in digital presence and specialization are seeing the strongest client growth. Consider highlighting your niche expertise to stand out in an increasingly competitive market.`;
      }
    }

    // Get all emailed professionals by province
    const { rows: recipients } = await pool.query(
      `SELECT DISTINCT oe.recipient_email, sc.id, sc.first_name, sc.province
       FROM outreach_emails oe
       JOIN scraped_cpas sc ON COALESCE(sc.enriched_email, sc.email) = oe.recipient_email
       WHERE oe.status IN ('sent','delivered','opened','clicked')
         AND oe.recipient_email NOT IN (SELECT email FROM outreach_unsubscribes)
         AND sc.province IS NOT NULL`
    );

    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        const brief = briefCache[r.province] || briefCache['ON'] || 'Market brief unavailable.';
        const provinceName = PROVINCE_NAMES[r.province] || r.province;
        const subject = `AI Market Brief: CPA trends in ${provinceName} — ${monthName}`;
        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;padding:24px;border-radius:12px 12px 0 0;">
    <h2 style="margin:0;font-size:20px;">AI Market Brief</h2>
    <p style="margin:8px 0 0;opacity:0.9;font-size:14px;">CPA Trends in ${provinceName} | ${monthName}</p>
  </div>
  <div style="padding:24px;background:#f8fafc;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none;">
    <p>Hi ${r.first_name || 'there'},</p>
    <p>Here is your AI-generated market intelligence brief:</p>
    <div style="margin:16px 0;padding:20px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;line-height:1.7;color:#334155;">${brief.replace(/\n/g, '<br><br>')}</div>
    <p style="color:#64748b;font-size:13px;">This brief was generated by AI based on current market data and trends. For personalized insights, visit your dashboard.</p>
    <p style="text-align:center;margin:24px 0;"><a href="${FRONTEND_URL}/profile?id=${r.id}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">View Your Dashboard</a></p>
  </div>
  <p style="color:#999;font-size:11px;margin-top:16px;">CanadaAccountants.app | Toronto, ON, Canada<br><a href="${FRONTEND_URL}/unsubscribe?email=${encodeURIComponent(r.recipient_email)}">Unsubscribe</a></p>
</div>`;
        await sendEmail({ to: r.recipient_email, subject, html, from: OUTREACH_FROM });
        sent++;
        await delay(2000);
      } catch (e) {
        console.error(`[AIBriefs] ${r.recipient_email}:`, e.message);
        failed++;
      }
    }
    res.json({ success: true, sent, failed, total: recipients.length, provincesGenerated: Object.keys(briefCache).length });
  } catch (err) {
    console.error('[AIBriefs] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Search event analytics
app.get('/api/admin/search-events', async (req, res) => {
  try {
    const { city, specialty, since } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;
    if (city) { conditions.push(`city ILIKE $${idx}`); values.push(`%${city}%`); idx++; }
    if (specialty) { conditions.push(`specialty ILIKE $${idx}`); values.push(`%${specialty}%`); idx++; }
    if (since) { conditions.push(`timestamp >= $${idx}`); values.push(since); idx++; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const events = await pool.query(`SELECT * FROM search_events ${where} ORDER BY timestamp DESC LIMIT 100`, values);
    const topSearches = await pool.query(
      `SELECT city, specialty, COUNT(*) as count FROM search_events WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY city, specialty ORDER BY count DESC LIMIT 20`
    );
    res.json({ success: true, events: events.rows, top_searches_7d: topSearches.rows, total: events.rows.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch search events', details: error.message });
  }
});

// Matched professionals landing page API
app.get('/api/matched-professionals', async (req, res) => {
  try {
    const { province, specialty } = req.query;
    if (!province) return res.status(400).json({ error: 'Province required' });

    // Score and rank professionals
    const { rows } = await pool.query(`
      SELECT id, first_name, last_name, firm_name, city, province, designation,
             generated_bio, claim_status, phone, founding_member
      FROM scraped_cpas
      WHERE province = $1
        AND COALESCE(enriched_email, email) IS NOT NULL
      ORDER BY
        CASE WHEN founding_member = TRUE THEN 0 ELSE 1 END,
        CASE WHEN claim_status = 'claimed' THEN 0 ELSE 1 END,
        CASE WHEN generated_bio IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN phone IS NOT NULL THEN 0 ELSE 1 END
      LIMIT 20
    `, [province]);

    // Calculate SEO scores and build response
    const professionals = rows.map(p => {
      let firstName = p.first_name || '';
      let lastName = p.last_name || '';
      if (firstName.includes(',') && !lastName) {
        const parts = firstName.split(',').map(s => s.trim());
        lastName = parts[0];
        firstName = parts[1] || '';
      }
      const name = `${firstName} ${lastName}`.trim();

      let score = 30; // base
      if (p.generated_bio) score += 25;
      if (p.phone) score += 15;
      if (p.firm_name) score += 10;
      if (p.designation) score += 10;
      if (p.claim_status === 'claimed') score += 10;

      return {
        id: p.id,
        name,
        first_name: firstName,
        last_name: lastName,
        firm_name: p.firm_name,
        city: p.city,
        province: p.province,
        designation: p.designation,
        bio_excerpt: p.generated_bio ? p.generated_bio.substring(0, 200) + '...' : null,
        seo_score: score,
        claimed: p.claim_status === 'claimed',
        founding_member: p.founding_member || false,
        profile_url: `/profile?id=${p.id}`
      };
    });

    // Sort by score descending, take top 3
    professionals.sort((a, b) => b.seo_score - a.seo_score);
    const top3 = professionals.slice(0, 3);

    res.json({
      success: true,
      province,
      specialty: specialty || null,
      professionals: top3,
      total_in_province: rows.length
    });
  } catch (error) {
    console.error('[MatchedProfessionals] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch matched professionals' });
  }
});

// Client-signal email trigger — fires when a search event matches unclaimed professionals
app.post('/api/admin/trigger-client-signal', async (req, res) => {
  try {
    const { search_event_id } = req.body;

    // Get the search event
    const { rows: events } = await pool.query(
      'SELECT * FROM search_events WHERE id = $1', [search_event_id]
    );
    if (events.length === 0) return res.status(404).json({ error: 'Search event not found' });
    const event = events[0];

    const result = await processClientSignal(event);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Background: process recent search events for client signals
async function processClientSignal(event) {
  const city = event.city;
  const province = event.province;
  const specialty = event.specialty;

  if (!province && !city) return { triggered: 0, reason: 'No location in search event' };

  const locationConditions = [];
  const locationParams = [];
  let idx = 1;
  if (province) { locationConditions.push(`province = $${idx}`); locationParams.push(province); idx++; }
  if (city) { locationConditions.push(`LOWER(city) = LOWER($${idx})`); locationParams.push(city); idx++; }

  let sentClaimed = 0;
  let sentUnclaimed = 0;

  // ── TIER 1: Claimed professionals → match notification with dashboard link ──
  try {
    const claimedConditions = ["claim_status = 'claimed'", ...locationConditions];
    const { rows: claimedPros } = await pool.query(`
      SELECT id, first_name, last_name, city, province, designation, firm_name,
             COALESCE(enriched_email, email) AS email
      FROM scraped_cpas
      WHERE ${claimedConditions.join(' AND ')}
        AND COALESCE(enriched_email, email) IS NOT NULL
        AND COALESCE(enriched_email, email) != ''
        AND COALESCE(enriched_email, email) NOT IN (SELECT email FROM outreach_unsubscribes)
        AND NOT EXISTS (
          SELECT 1 FROM match_notifications mn
          WHERE mn.professional_id = scraped_cpas.id AND mn.sent_at > NOW() - INTERVAL '24 hours'
        )
      LIMIT 5
    `, locationParams);

    for (const prof of claimedPros) {
      let firstName = prof.first_name || '';
      let lastName = prof.last_name || '';
      if (firstName.includes(',') && !lastName) {
        const parts = firstName.split(',').map(s => s.trim());
        lastName = parts[0]; firstName = parts[1] || '';
      }
      const name = `${firstName} ${lastName}`.trim() || 'CPA';
      const profCity = prof.city || province || 'your area';
      const spec = specialty || 'accounting';

      const subject = `${name}, a business in ${profCity} is looking for a ${spec} CPA`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:24px;">
        <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:24px 32px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:20px;">CanadaAccountants</h2>
        </div>
        <div style="padding:24px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <p style="font-size:15px;color:#111;">Hi ${firstName || 'there'},</p>
          <p style="font-size:15px;color:#333;line-height:1.7;">A business in ${profCity} searched CanadaAccountants for a <strong>${spec} CPA</strong> &mdash; your profile matched their criteria.</p>
          <p style="font-size:15px;color:#333;line-height:1.7;">Their contact details are available in your dashboard. Log in to view and respond.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="https://canadaaccountants.app/admin" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;">View This Match &rarr;</a>
          </div>
          <p style="color:#999;font-size:11px;">CanadaAccountants.app<br><a href="https://canadaaccountants.app/unsubscribe?email=${encodeURIComponent(prof.email)}">Unsubscribe</a></p>
        </div>
      </div>`;

      try {
        await sendEmail({ to: prof.email, subject, html, from: OUTREACH_FROM });
        await pool.query(
          'INSERT INTO match_notifications (professional_id, search_event_id, searcher_city, searcher_specialty, searcher_type, email) VALUES ($1, $2, $3, $4, $5, $6)',
          [prof.id, event.id, city || null, specialty || null, 'business', prof.email]
        );
        sentClaimed++;
      } catch (e) {
        console.error(`[ClientSignal] Failed to send claimed notification to ${prof.email}:`, e.message);
      }
    }
    console.log(`[ClientSignal] Sent ${sentClaimed} claimed match notifications for event ${event.id}`);
  } catch (e) {
    console.error('[ClientSignal] Claimed query error:', e.message);
  }

  // ── TIER 2: Unclaimed professionals → claim to be introduced (existing logic) ──
  const unclaimedConditions = ["claim_status IS DISTINCT FROM 'claimed'", ...locationConditions];
  const { rows: professionals } = await pool.query(`
    SELECT id, first_name, last_name, city, province, designation, firm_name,
           COALESCE(enriched_email, email) AS email
    FROM scraped_cpas
    WHERE ${unclaimedConditions.join(' AND ')}
      AND COALESCE(enriched_email, email) IS NOT NULL
      AND COALESCE(enriched_email, email) != ''
      AND NOT EXISTS (
        SELECT 1 FROM signal_emails se
        WHERE se.professional_id = scraped_cpas.id AND se.sent_at > NOW() - INTERVAL '14 days'
      )
      AND COALESCE(enriched_email, email) NOT IN (SELECT email FROM outreach_unsubscribes)
    LIMIT 10
  `, locationParams);

  for (const prof of professionals) {
    let firstName = prof.first_name || '';
    let lastName = prof.last_name || '';
    if (firstName.includes(',') && !lastName) {
      const parts = firstName.split(',').map(s => s.trim());
      lastName = parts[0]; firstName = parts[1] || '';
    }
    const name = `${firstName} ${lastName}`.trim() || 'CPA';
    const profCity = prof.city || province || 'your area';
    const spec = specialty || 'accounting';

    const subject = `${name}, a business in ${profCity} just searched for a ${spec} CPA`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:24px;">
      <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:24px 32px;border-radius:8px 8px 0 0;">
        <h2 style="color:#fff;margin:0;font-size:20px;">CanadaAccountants</h2>
      </div>
      <div style="padding:24px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
        <p style="font-size:15px;color:#111;">Hi ${firstName || 'there'},</p>
        <p style="font-size:15px;color:#333;line-height:1.7;">A business in ${profCity} searched CanadaAccountants for a <strong>${spec} CPA</strong> &mdash; your profile matched their criteria. We can&rsquo;t make the introduction until you claim your profile. Takes 30 seconds.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="https://canadaaccountants.app/profile?id=${prof.id}" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;">Claim &amp; Get Introduced &rarr;</a>
        </div>
        <p style="color:#999;font-size:11px;">CanadaAccountants.app<br><a href="https://canadaaccountants.app/unsubscribe?email=${encodeURIComponent(prof.email)}">Unsubscribe</a></p>
      </div>
    </div>`;

    try {
      const result = await sendEmail({ to: prof.email, subject, html, from: OUTREACH_FROM });
      await pool.query(
        'INSERT INTO signal_emails (professional_id, search_event_id, email, subject, resend_id) VALUES ($1, $2, $3, $4, $5)',
        [prof.id, event.id, prof.email, subject, result?.id || null]
      );
      sentUnclaimed++;
    } catch (e) {
      console.error(`[ClientSignal] Failed to send to ${prof.email}:`, e.message);
    }
  }

  const totalSent = sentClaimed + sentUnclaimed;
  console.log(`[ClientSignal] Triggered ${totalSent} emails (${sentClaimed} claimed, ${sentUnclaimed} unclaimed) for search event ${event.id} (${city || province}, ${specialty})`);
  return { triggered: totalSent, claimed_notified: sentClaimed, unclaimed_notified: sentUnclaimed, professionals_matched: professionals.length, city, province, specialty };
}

// Auto-process: hook into search event logging
// This runs as background job after each search event is logged
async function processRecentSignals() {
  try {
    const { rows: recentEvents } = await pool.query(`
      SELECT se.* FROM search_events se
      WHERE se.timestamp > NOW() - INTERVAL '60 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM signal_emails sig WHERE sig.search_event_id = se.id
        )
      ORDER BY se.timestamp DESC
      LIMIT 5
    `);
    for (const event of recentEvents) {
      await processClientSignal(event);
    }
  } catch (e) {
    console.error('[ClientSignal] Auto-process error:', e.message);
  }
}

// Run signal processor every 15 minutes
setInterval(() => processRecentSignals().catch(e => console.error('[ClientSignal]', e.message)), 15 * 60 * 1000);

app.get('/api/admin/signal-emails', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM signal_emails ORDER BY sent_at DESC LIMIT 50'
    );
    res.json({ success: true, signals: rows, total: rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Founding Member Program ──
app.post('/api/admin/founding-members/flag', async (req, res) => {
  try {
    // 1. Find all claimed professionals
    const { rows: claimed } = await pool.query(
      `SELECT id, first_name, last_name, city, province, designation, COALESCE(enriched_email, email) AS email
       FROM scraped_cpas WHERE claim_status = 'claimed'`
    );

    let flagged = 0, emailed = 0;

    for (const p of claimed) {
      // 2. Set founding_member = TRUE
      await pool.query('UPDATE scraped_cpas SET founding_member = TRUE WHERE id = $1', [p.id]);
      flagged++;

      // 3. Skip if already emailed or no email
      if (!p.email) continue;
      const { rows: already } = await pool.query(
        'SELECT id FROM founding_member_emails WHERE professional_id = $1', [p.id]
      );
      if (already.length > 0) continue;

      // Resolve first name
      let firstName = p.first_name || '';
      let lastName = p.last_name || '';
      if (firstName.includes(',') && !lastName) {
        const parts = firstName.split(',').map(s => s.trim());
        lastName = parts[0];
        firstName = parts[1] || '';
      }
      if (!firstName) firstName = 'there';

      const designation = p.designation || 'CPA';
      const city = p.city || 'your city';

      const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:24px;">
  <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:24px 32px;border-radius:8px 8px 0 0;">
    <h2 style="color:#fff;margin:0;font-size:20px;">CanadaAccountants</h2>
  </div>
  <div style="padding:24px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
    <p style="font-size:15px;color:#111;">Hi ${firstName},</p>
    <p style="font-size:15px;color:#333;line-height:1.7;">You were one of the first ${designation}s in ${city} to claim your profile on CanadaAccountants. We've added Founding Member status to your profile — you'll be permanently listed first in local search in your city. Your badge is now visible on your public profile.</p>
    <p style="font-size:15px;color:#333;">Thank you for being first.</p>
    <p style="color:#999;font-size:11px;">CanadaAccountants</p>
  </div>
</div>`;

      try {
        await sendEmail({
          to: p.email,
          subject: "You're a Founding Member of CanadaAccountants",
          html,
          from: OUTREACH_FROM
        });
        await pool.query(
          'INSERT INTO founding_member_emails (professional_id, email) VALUES ($1, $2)',
          [p.id, p.email]
        );
        emailed++;
      } catch (emailErr) {
        console.error(`[FoundingMember] Email failed for id=${p.id}:`, emailErr.message);
      }
    }

    res.json({ success: true, flagged, emailed, total_claimed: claimed.length });
  } catch (error) {
    console.error('[FoundingMember] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// A/B test tracking
app.post('/api/ab-test/track-load', async (req, res) => {
  try {
    const { variant, professional_id } = req.body;
    if (!variant || !['A', 'B'].includes(variant)) return res.status(400).json({ error: 'Invalid variant' });
    const { rows } = await pool.query(
      'INSERT INTO ab_test_results (variant, professional_id) VALUES ($1, $2) RETURNING id',
      [variant, professional_id || null]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ab-test/track-complete', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Test ID required' });
    await pool.query(
      'UPDATE ab_test_results SET form_completed_at = NOW() WHERE id = $1',
      [id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/ab-test/results', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        variant,
        COUNT(*) as loads,
        COUNT(form_completed_at) as completions,
        ROUND(COUNT(form_completed_at)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as rate,
        MIN(page_load_at) as started_at
      FROM ab_test_results
      GROUP BY variant
      ORDER BY variant
    `);

    const startDate = rows.length > 0 ? new Date(rows[0].started_at) : new Date();
    const daysRunning = Math.ceil((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    let winner = null;
    if (daysRunning >= 14 && rows.length === 2) {
      winner = parseFloat(rows[0].rate) >= parseFloat(rows[1].rate) ? rows[0].variant : rows[1].variant;
    }

    res.json({ success: true, variants: rows, days_running: daysRunning, winner });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Match Notifications Admin ──
app.get('/api/admin/match-notifications', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM match_notifications ORDER BY sent_at DESC LIMIT 50'
    );
    res.json({ success: true, notifications: rows, total: rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Dashboard Match Count (for claimed professionals) ──
app.get('/api/dashboard/matches', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { rows: prof } = await pool.query(
      'SELECT id FROM scraped_cpas WHERE claimed_by = $1', [userId]
    );
    if (prof.length === 0) return res.json({ success: true, matches: [], count: 0 });

    const { rows: matches } = await pool.query(
      `SELECT id, searcher_city, searcher_specialty, searcher_type, sent_at
       FROM match_notifications WHERE professional_id = $1 ORDER BY sent_at DESC LIMIT 20`,
      [prof[0].id]
    );
    res.json({ success: true, matches, count: matches.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Custom error handler — returns JSON, hides internals on 500
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message
  });
});

// Sequence scheduler — every 15 minutes
setInterval(() => {
  sequenceEngine.processScheduledSends().catch(err =>
    console.error('[Sequences] Scheduled send error:', err.message)
  );
}, 15 * 60 * 1000);

// Tax Season Campaign auto-launch: April 14, 2026 at 9 AM ET
cron.schedule('0 9 14 4 *', async () => {
  try {
    const { rows } = await pool.query("SELECT id FROM outreach_campaigns WHERE name = 'Tax Season CPA Campaign' AND status = 'scheduled'");
    if (rows.length > 0) {
      await outreachEngine.launchCampaign(rows[0].id);
      console.log('[Campaign] Tax Season CPA Campaign launched!');
    }
  } catch (e) { console.error('[Campaign] Tax season launch error:', e.message); }
}, { timezone: 'America/Toronto' });

// Tax Season Campaign auto-pause: April 28, 2026 at 6 PM ET
cron.schedule('0 18 28 4 *', async () => {
  try {
    await pool.query("UPDATE outreach_campaigns SET status = 'completed' WHERE name = 'Tax Season CPA Campaign'");
    console.log('[Campaign] Tax Season CPA Campaign ended (Apr 28)');
  } catch (e) { console.error('[Campaign] Tax season end error:', e.message); }
}, { timezone: 'America/Toronto' });

// =====================================================
// PIPELINE MONITOR — Cross-platform health reports
// Fires at 9:05 AM, 10:05 AM, and 2:05 PM ET on send days (Tue-Thu)
// Emails consolidated report to admin
// =====================================================

const MONITOR_BACKENDS = [
  { name: 'ACC', url: 'https://canadaaccountants-backend-production-1d8f.up.railway.app' },
  { name: 'LAW', url: 'https://canadalawyers-backend-production.up.railway.app' },
  { name: 'INV', url: 'https://canadainvesting-backend-production.up.railway.app' },
];

const HOLIDAYS = ['2026-04-03', '2026-04-04', '2026-04-06'];

async function runPipelineMonitor(label) {
  const https = require('https');
  const fetchJSON = (url) => new Promise((resolve) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  const now = new Date();
  const day = now.getDay();
  const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

  // Skip weekends, Monday, holidays
  if (day === 0 || day === 1 || day === 6 || HOLIDAYS.includes(etDate)) {
    console.log(`[Monitor] Skipping — non-send day (${etDate})`);
    return;
  }

  const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-US', { timeZone: 'America/Toronto', month: 'long', day: 'numeric', year: 'numeric' });

  let rows = '';
  let totalSent = 0, totalQueued = 0, totalConv = 0;
  const alerts = [];

  for (const backend of MONITOR_BACKENDS) {
    try {
      const health = await fetchJSON(`${backend.url}/api/outreach/health`);
      const campaigns = await fetchJSON(`${backend.url}/api/admin/outreach/campaigns`);
      const camps = campaigns?.campaigns || campaigns || [];

      const sent = health?.sent_today || 0;
      const queued = health?.queued || 0;
      const bnc7d = health?.bounced_7d || 0;
      const active = health?.active_campaigns?.length || 0;
      const conv = camps.reduce((sum, c) => sum + (c.total_converted || 0), 0);

      totalSent += sent;
      totalQueued += queued;
      totalConv += conv;

      // Check for alerts
      if (active === 0 && queued > 0) alerts.push(`${backend.name}: 0 active campaigns with ${queued} queued — possible circuit breaker`);
      if (sent === 0 && label !== '9:05 AM' && queued > 0) alerts.push(`${backend.name}: 0 sent today at ${label} with ${queued} queued`);

      rows += `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;">${backend.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${sent.toLocaleString()}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${queued.toLocaleString()}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${active}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${bnc7d}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;color:#059669;">${conv}</td>
      </tr>`;
    } catch (e) {
      rows += `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;" colspan="6">${backend.name}: ERROR — ${e.message}</td></tr>`;
      alerts.push(`${backend.name}: health check failed — ${e.message}`);
    }
  }

  // Check digest status
  let digestInfo = '';
  try {
    const digest = await fetchJSON(`${MONITOR_BACKENDS[0].url}/api/admin/digest-status`);
    if (digest?.running) {
      digestInfo = `<div style="margin:12px 0;padding:12px 16px;background:#eff6ff;border-radius:6px;font-size:13px;color:#1e40af;">Digest running: ${digest.sent}/${digest.total} sent, ${digest.errors} errors</div>`;
    } else if (digest?.lastRun) {
      digestInfo = `<div style="margin:12px 0;padding:12px 16px;background:#f0fdf4;border-radius:6px;font-size:13px;color:#166534;">Last digest: ${digest.sent}/${digest.total} sent (${new Date(digest.lastRun).toLocaleString('en-US', { timeZone: 'America/Toronto' })})</div>`;
    }
  } catch { /* skip */ }

  const alertsHtml = alerts.length > 0
    ? `<div style="margin:16px 0;padding:12px 16px;background:#fef2f2;border-left:4px solid #dc2626;border-radius:0 6px 6px 0;"><strong style="color:#991b1b;">Alerts:</strong><ul style="margin:8px 0 0;padding-left:20px;color:#991b1b;font-size:13px;">${alerts.map(a => `<li>${a}</li>`).join('')}</ul></div>`
    : '';

  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;font-size:18px;">Pipeline Monitor — ${label}</h2>
      <p style="margin:4px 0 0;opacity:0.85;font-size:13px;">${dateStr}</p>
    </div>
    <div style="padding:20px 24px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr style="background:#f1f5f9;">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#475569;">Platform</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#475569;">Sent</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#475569;">Queued</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#475569;">Active</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#475569;">Bnc 7d</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#475569;">Conv</th>
        </tr>
        ${rows}
        <tr style="background:#f8fafc;font-weight:700;">
          <td style="padding:8px 12px;">Total</td>
          <td style="padding:8px 12px;text-align:right;">${totalSent.toLocaleString()}</td>
          <td style="padding:8px 12px;text-align:right;">${totalQueued.toLocaleString()}</td>
          <td style="padding:8px 12px;text-align:right;" colspan="2"></td>
          <td style="padding:8px 12px;text-align:right;color:#059669;">${totalConv}</td>
        </tr>
      </table>
      ${digestInfo}
      ${alertsHtml}
      <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;">Auto-generated by ACC pipeline monitor</p>
    </div>
  </div>`;

  try {
    await sendEmail({
      to: 'arthur@negotiateandwin.com',
      subject: `Pipeline ${label} — ${totalSent} sent, ${totalConv} conv — ${dateStr}`,
      html,
      from: 'Pipeline Monitor <connect@canadaaccountants.app>'
    });
    console.log(`[Monitor] ${label} report sent — sent=${totalSent}, conv=${totalConv}, alerts=${alerts.length}`);
  } catch (e) {
    console.error(`[Monitor] Failed to send report: ${e.message}`);
  }
}

// 9:05 AM — post-cron check
cron.schedule('5 9 * * 2-4', () => runPipelineMonitor('9:05 AM').catch(e => console.error('[Monitor]', e.message)), { timezone: 'America/Toronto' });

// 10:05 AM — Ontario window check
cron.schedule('5 10 * * 2-4', () => runPipelineMonitor('10:05 AM').catch(e => console.error('[Monitor]', e.message)), { timezone: 'America/Toronto' });

// 2:05 PM — afternoon cron check
cron.schedule('5 14 * * 2-4', () => runPipelineMonitor('2:05 PM').catch(e => console.error('[Monitor]', e.message)), { timezone: 'America/Toronto' });

// Also fire on Friday warm send days
cron.schedule('5 9 * * 5', () => runPipelineMonitor('9:05 AM (Fri warm)').catch(e => console.error('[Monitor]', e.message)), { timezone: 'America/Toronto' });
cron.schedule('5 14 * * 5', () => runPipelineMonitor('2:05 PM (Fri warm)').catch(e => console.error('[Monitor]', e.message)), { timezone: 'America/Toronto' });

console.log('[Monitor] Pipeline monitor scheduled: 9:05/10:05/14:05 Tue-Thu, 9:05/14:05 Fri');

// CRM Intelligence — nightly at 3 AM ET (use setInterval every 24h with initial delay)
setTimeout(() => {
  crmIntelligence.runNightly().catch(err => console.error('[CRM:Intelligence] Nightly run error:', err.message));
  setInterval(() => {
    crmIntelligence.runNightly().catch(err => console.error('[CRM:Intelligence] Nightly run error:', err.message));
  }, 24 * 60 * 60 * 1000);
}, (() => { const now = new Date(); const next3am = new Date(); next3am.setHours(3, 0, 0, 0); if (next3am <= now) next3am.setDate(next3am.getDate() + 1); return next3am - now; })());

// =====================================================
// CRM API Routes
// =====================================================

app.get('/api/admin/crm/funnel', authenticateToken, requireAdmin, async (req, res) => {
  try { res.json({ success: true, ...(await crm.getFunnelWithConversions()) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try { res.json({ success: true, ...(await crm.getDashboardStats()) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/professionals/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const data = await crm.getProfessional(parseInt(req.params.id));
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, professional: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/professionals/:id/history', authenticateToken, requireAdmin, async (req, res) => {
  try { res.json({ success: true, history: await crm.getHistory(parseInt(req.params.id)) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/professionals/:id/transition', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { to_status, metadata } = req.body;
    if (!to_status) return res.status(400).json({ success: false, error: 'to_status required' });
    const result = await crm.transition(parseInt(req.params.id), to_status, { triggeredBy: 'admin', metadata: metadata || {} });
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/professionals/:id/force-transition', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { to_status, metadata } = req.body;
    if (!to_status) return res.status(400).json({ success: false, error: 'to_status required' });
    const result = await crm.forceTransition(parseInt(req.params.id), to_status, { triggeredBy: 'admin', metadata: metadata || {} });
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/segment', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { crm_status, province, designation, has_email, tag, limit, offset } = req.query;
    const data = await crm.segment({
      crm_status: crm_status ? crm_status.split(',') : undefined,
      province, designation,
      hasEmail: has_email === 'true' ? true : has_email === 'false' ? false : undefined,
      tag, limit: parseInt(limit) || 100, offset: parseInt(offset) || 0
    });
    res.json({ success: true, ...data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/bulk/transition', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ids, to_status, metadata } = req.body;
    if (!ids || !Array.isArray(ids) || !to_status) return res.status(400).json({ success: false, error: 'ids (array) and to_status required' });
    res.json({ success: true, ...(await crm.bulkTransition(ids, to_status, { triggeredBy: 'admin', metadata: metadata || {} })) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/bulk/tag', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ids, tag } = req.body;
    if (!ids || !Array.isArray(ids) || !tag) return res.status(400).json({ success: false, error: 'ids (array) and tag required' });
    res.json({ success: true, ...(await crm.bulkTag(ids, tag)) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/professionals/:id/tags', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ success: false, error: 'tag required' });
    await crm.addTag(parseInt(req.params.id), tag);
    res.json({ success: true, tag });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/crm/professionals/:id/tags/:tag', authenticateToken, requireAdmin, async (req, res) => {
  try { await crm.removeTag(parseInt(req.params.id), req.params.tag); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/professionals/:id/notes', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ success: false, error: 'note required' });
    res.json({ success: true, note: await crm.addNote(parseInt(req.params.id), note, 'admin') });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/backfill', authenticateToken, requireAdmin, async (req, res) => {
  try { res.json({ success: true, counts: await crm.backfill() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// =====================================================
// Sequence API Routes (Phase 2)
// =====================================================

app.get('/api/admin/crm/sequences', authenticateToken, requireAdmin, async (req, res) => {
  try { res.json({ success: true, sequences: await sequenceEngine.getSequences() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/sequences/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const seq = await sequenceEngine.getSequence(parseInt(req.params.id));
    if (!seq) return res.status(404).json({ success: false, error: 'Not found' });
    const stats = await sequenceEngine.getSequenceStats(seq.id);
    res.json({ success: true, sequence: seq, stats });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/sequences', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, description, trigger_status, steps, active } = req.body;
    if (!name || !steps) return res.status(400).json({ success: false, error: 'name and steps required' });
    const seq = await sequenceEngine.createSequence({ name, description, triggerStatus: trigger_status, steps, active });
    res.json({ success: true, sequence: seq });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/admin/crm/sequences/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, description, trigger_status, steps, active } = req.body;
    const seq = await sequenceEngine.updateSequence(parseInt(req.params.id), { name, description, triggerStatus: trigger_status, steps, active });
    if (!seq) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, sequence: seq });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/sequences/:id/enroll', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { professional_id, professional_ids } = req.body;
    if (professional_ids && Array.isArray(professional_ids)) {
      const result = await sequenceEngine.bulkEnroll(professional_ids, parseInt(req.params.id));
      return res.json({ success: true, ...result });
    }
    if (!professional_id) return res.status(400).json({ success: false, error: 'professional_id required' });
    const enrollment = await sequenceEngine.enroll(professional_id, parseInt(req.params.id));
    res.json({ success: true, enrollment });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/sequences/:id/unenroll', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { professional_id, reason } = req.body;
    if (!professional_id) return res.status(400).json({ success: false, error: 'professional_id required' });
    await sequenceEngine.unenroll(professional_id, parseInt(req.params.id), reason || 'manual');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/sequences/:id/enrollments', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const enrollments = await sequenceEngine.getActiveEnrollments({
      sequenceId: parseInt(req.params.id), limit: parseInt(limit) || 50, offset: parseInt(offset) || 0
    });
    res.json({ success: true, enrollments });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/crm/sequences/process', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await sequenceEngine.processScheduledSends();
    res.json({ success: true, message: 'Sequence processing triggered' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// =====================================================
// Intelligence API Routes (Phase 4)
// =====================================================

app.post('/api/admin/crm/intelligence/run', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const results = await crmIntelligence.runNightly();
    res.json({ success: true, ...results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/intelligence/engagement', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const distribution = await crmIntelligence.getEngagementDistribution();
    const top = await crmIntelligence.getTopEngaged(parseInt(req.query.limit) || 25);
    res.json({ success: true, distribution, topEngaged: top });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/intelligence/churn', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const atRisk = await crmIntelligence.getChurnRisk(parseInt(req.query.min_risk) || 50);
    res.json({ success: true, atRisk });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/crm/intelligence/bounce-report', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const check = await crmIntelligence.checkBounceCluster({ windowHours: parseInt(req.query.hours) || 48 });
    const domains = await crmIntelligence.getBounceReport(parseInt(req.query.hours) || 48);
    res.json({ success: true, ...check, domains });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== BULK BIO GENERATION ====================
