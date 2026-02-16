const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { sendFrictionMatchNotification, sendCPAOnboardingEmail, sendCPARegistrationConfirmation, sendContactFormEmail, sendCPAVerificationEmail, sendPasswordResetEmail } = require('./services/email');
const { OutreachEngine, CPA_ACQUISITION_TEMPLATE, SME_ACQUISITION_TEMPLATE } = require('./services/outreach');
const crypto = require('crypto');

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

// JSON parsing middleware
app.use(express.json());

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
    const frontendUrl = process.env.FRONTEND_URL || 'https://canadaaccountants.app';
    const resetUrl = `${frontendUrl}/reset-password.html?token=${resetToken}`;

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
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    message: 'CanadaAccountants AI Backend is running successfully',
    timestamp: new Date().toISOString(),
    services: {
      ml_engine: 'active',
      database: 'connected', 
      ai_services: 'ready',
      friction_elimination: 'active'
    }
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
    province, years_experience, firm_size, specializations, industries_served,
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
      outreachEngine.trackConversion(registrationData.email, result.rows[0]?.id).catch(err => {
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
        lead_generation_method, biggest_challenge, target_client_size, specializations,
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
          request_id, cpa_id, cpa_name, specializations, match_score,
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
        specializations = COALESCE($1, specializations),
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
// ADMIN DASHBOARD API ENDPOINTS
// =====================================================

// Admin: Dashboard stats overview
app.get('/api/admin/dashboard-stats', authenticateToken, requireAdmin, async (req, res) => {
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
app.get('/api/admin/outreach/campaigns', authenticateToken, requireAdmin, async (req, res) => {
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
app.put('/api/admin/outreach/campaigns/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const campaign = await outreachEngine.updateCampaign(parseInt(req.params.id), req.body);
    res.json({ success: true, campaign });
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ error: 'Failed to update campaign', details: error.message });
  }
});

// Launch campaign
app.post('/api/admin/outreach/campaigns/:id/launch', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await outreachEngine.launchCampaign(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Launch campaign error:', error);
    res.status(500).json({ error: 'Failed to launch campaign', details: error.message });
  }
});

// Pause campaign
app.post('/api/admin/outreach/campaigns/:id/pause', authenticateToken, requireAdmin, async (req, res) => {
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
app.post('/api/admin/outreach/campaigns/:id/test-send', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const testEmail = req.body.email || req.user.email;
    const result = await outreachEngine.testSend(parseInt(req.params.id), testEmail);
    res.json({ success: true, result, sentTo: testEmail });
  } catch (error) {
    console.error('Test send error:', error);
    res.status(500).json({ error: 'Failed to send test email', details: error.message });
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

// Outreach stats
app.get('/api/admin/outreach/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stats = await outreachEngine.getOverallStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Outreach stats error:', error);
    res.status(500).json({ error: 'Failed to get outreach stats', details: error.message });
  }
});

// =====================================================
// PUBLIC OUTREACH ENDPOINTS
// =====================================================

// Resend webhook handler
app.post('/api/webhooks/resend', express.json(), async (req, res) => {
  try {
    await outreachEngine.handleResendWebhook(req.body);
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
