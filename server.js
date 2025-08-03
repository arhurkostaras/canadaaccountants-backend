const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
// Machine Learning imports
const { CanadianCPAMLEngine, MLScheduler } = require('./services/ml-engine');
const { RealtimeMLRecommendationEngine, RealtimeMLMiddleware } = require('./services/realtime-ml');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
// Initialize ML engines
const mlEngine = new CanadianCPAMLEngine(pool);
const realtimeMLEngine = new RealtimeMLRecommendationEngine(pool);
const mlScheduler = new MLScheduler(pool);
const mlMiddleware = new RealtimeMLMiddleware(realtimeMLEngine);

// Start ML learning scheduler
mlScheduler.startScheduler().catch(console.error);

// Middleware
app.use(cors({
    origin: [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:3001'],
    credentials: true
}));
app.use(express.json());

// =====================================================
// MACHINE LEARNING API ENDPOINTS
// =====================================================

// ML Route 1: Record match outcome
app.post('/api/ml/match-outcome', async (req, res) => {
  try {
    const {
      match_id,
      cpa_id,
      client_id,
      partnership_formed,
      partnership_start_date,
      client_satisfaction_score,
      cpa_satisfaction_score,
      revenue_generated,
      project_value,
      ongoing_monthly_value,
      initial_contact_made,
      proposal_submitted,
      contract_signed
    } = req.body;

    if (!match_id || !cpa_id || !client_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: match_id, cpa_id, client_id'
      });
    }

    const query = `
      INSERT INTO match_outcomes (
        match_id, cpa_id, client_id, partnership_formed,
        partnership_start_date, client_satisfaction_score, cpa_satisfaction_score,
        revenue_generated, project_value, ongoing_monthly_value,
        initial_contact_made, proposal_submitted, contract_signed,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (match_id) 
      DO UPDATE SET
        partnership_formed = EXCLUDED.partnership_formed,
        partnership_start_date = EXCLUDED.partnership_start_date,
        client_satisfaction_score = EXCLUDED.client_satisfaction_score,
        cpa_satisfaction_score = EXCLUDED.cpa_satisfaction_score,
        revenue_generated = EXCLUDED.revenue_generated,
        project_value = EXCLUDED.project_value,
        ongoing_monthly_value = EXCLUDED.ongoing_monthly_value,
        initial_contact_made = EXCLUDED.initial_contact_made,
        proposal_submitted = EXCLUDED.proposal_submitted,
        contract_signed = EXCLUDED.contract_signed,
        updated_at = NOW()
      RETURNING *;
    `;

    const result = await pool.query(query, [
      match_id, cpa_id, client_id, partnership_formed,
      partnership_start_date, client_satisfaction_score, cpa_satisfaction_score,
      revenue_generated, project_value, ongoing_monthly_value,
      initial_contact_made, proposal_submitted, contract_signed
    ]);

    // Trigger ML learning if significant outcome
    if (partnership_formed !== null) {
      realtimeMLEngine.emit('match_outcome_recorded', {
        match_id,
        cpa_id,
        client_id,
        partnership_formed,
        client_satisfaction_score,
        cpa_satisfaction_score
      });
    }

    res.json({
      success: true,
      message: 'Match outcome recorded successfully',
      data: result.rows[0],
      ml_triggered: partnership_formed !== null
    });

  } catch (error) {
    console.error('Error recording match outcome:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to record match outcome'
    });
  }
});

// ML Route 2: Get learning insights
app.get('/api/ml/learning-insights', async (req, res) => {
  try {
    const { factor_category, confidence_threshold = 0.5 } = req.query;

    // Get current learning weights
    let weightsQuery = `
      SELECT 
        factor_name,
        factor_category,
        current_weight,
        baseline_weight,
        success_correlation,
        confidence_score,
        total_matches_analyzed,
        successful_matches,
        accuracy_improvement,
        ROUND((current_weight - baseline_weight) / baseline_weight * 100, 2) as weight_change_percent
      FROM learning_weights
      WHERE confidence_score >= $1
    `;
    
    const queryParams = [confidence_threshold];
    
    if (factor_category) {
      weightsQuery += ` AND factor_category = $2`;
      queryParams.push(factor_category);
    }
    
    weightsQuery += ` ORDER BY success_correlation DESC`;

    const weightsResult = await pool.query(weightsQuery, queryParams);

    // Get system performance
    const performanceQuery = `
      SELECT 
        COUNT(*) as total_matches,
        COUNT(CASE WHEN partnership_formed = true THEN 1 END) as successful_partnerships,
        ROUND(AVG(CASE WHEN partnership_formed = true THEN client_satisfaction_score END), 2) as avg_client_satisfaction,
        ROUND(AVG(CASE WHEN partnership_formed = true THEN cpa_satisfaction_score END), 2) as avg_cpa_satisfaction,
        ROUND(AVG(CASE WHEN partnership_formed = true THEN revenue_generated END), 2) as avg_revenue_per_success
      FROM match_outcomes
      WHERE created_at >= NOW() - INTERVAL '30 days';
    `;

    const performanceResult = await pool.query(performanceQuery);

    res.json({
      success: true,
      data: {
        learning_weights: weightsResult.rows,
        system_performance: performanceResult.rows[0],
        analysis_metadata: {
          confidence_threshold,
          factor_category_filter: factor_category,
          generated_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    console.error('Error retrieving learning insights:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve learning insights'
    });
  }
});

// ML Route 3: Trigger ML weight recalculation
app.post('/api/ml/recalculate-weights', async (req, res) => {
  try {
    const { force_recalculation = false, minimum_samples = 10 } = req.body;

    // Check if we have enough data
    const dataCheckQuery = `
      SELECT COUNT(*) as total_outcomes
      FROM match_outcomes
      WHERE partnership_formed IS NOT NULL;
    `;

    const dataCheck = await pool.query(dataCheckQuery);
    const totalOutcomes = parseInt(dataCheck.rows[0].total_outcomes);

    if (!force_recalculation && totalOutcomes < minimum_samples) {
      return res.json({
        success: true,
        message: `Insufficient data for recalculation. Need ${minimum_samples}, have ${totalOutcomes}`,
        recalculated: false,
        total_outcomes: totalOutcomes
      });
    }

    // Trigger ML learning cycle
    const learningResults = await mlEngine.performLearningCycle();

    res.json({
      success: true,
      message: 'ML weights recalculated successfully',
      recalculated: true,
      data: {
        total_outcomes: totalOutcomes,
        learning_results: learningResults,
        recalculation_timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error recalculating ML weights:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to recalculate ML weights'
    });
  }
});

// ML Route 4: Enhanced recommendations
app.post('/api/ml/enhanced-recommendations', async (req, res) => {
  try {
    const {
      client_profile,
      limit = 10,
      include_explanations = true,
      use_ml_weights = true
    } = req.body;

    if (!client_profile) {
      return res.status(400).json({
        success: false,
        error: 'Client profile is required'
      });
    }

    // Generate enhanced recommendations using ML
    const recommendations = await realtimeMLEngine.generateEnhancedRecommendations(
      client_profile,
      { limit, include_explanations, use_ml_weights }
    );

    res.json({
      success: true,
      data: {
        recommendations: recommendations,
        ml_enhanced: true,
        total_analyzed: recommendations.length,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error generating enhanced recommendations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate enhanced recommendations'
    });
  }
});

// ML Route 5: Get ML system status
app.get('/api/ml/status', async (req, res) => {
  try {
    const schedulerStatus = mlScheduler.getStatus();
    const performanceMetrics = realtimeMLEngine.getPerformanceMetrics();

    // Get latest model version
    const modelQuery = `
      SELECT version_number, accuracy_score, is_active, created_at
      FROM ml_model_versions
      WHERE is_active = true
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    
    const modelResult = await pool.query(modelQuery);

    res.json({
      success: true,
      data: {
        scheduler_status: schedulerStatus,
        performance_metrics: performanceMetrics,
        current_model: modelResult.rows[0] || null,
        system_health: 'operational',
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error getting ML status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get ML status'
    });
  }
});

// Test database connection on startup
pool.query('SELECT NOW()', (err, result) => {
    if (err) {
        console.error('❌ Database connection failed:', err);
    } else {
        console.log('✅ Database connected:', result.rows[0].now);
    }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Routes
app.get('/', (req, res) => {
    res.json({
        message: 'CanadaAccountants API',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: '/api/health',
            auth: {
                register: 'POST /api/auth/register',
                login: 'POST /api/auth/login'
            },
            matching: 'GET /api/matches',
            profiles: {
                cpa: 'GET /api/profiles/cpa',
                sme: 'GET /api/profiles/sme'
            }
        }
    });
});

app.get('/api/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT NOW() as time, COUNT(*) as user_count FROM users');
        const userCount = await pool.query('SELECT COUNT(*) as total FROM users');
        const cpaCount = await pool.query('SELECT COUNT(*) as cpas FROM cpa_profiles');
        const smeCount = await pool.query('SELECT COUNT(*) as smes FROM sme_profiles');
        
        res.json({
            status: 'healthy',
            database: 'connected',
            timestamp: dbResult.rows[0].time,
            stats: {
                total_users: parseInt(userCount.rows[0].total),
                cpas: parseInt(cpaCount.rows[0].cpas),
                smes: parseInt(smeCount.rows[0].smes)
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            database: 'disconnected',
            error: error.message
        });
    }
});

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, userType } = req.body;
        
        // Validation
        if (!email || !password || !userType) {
            return res.status(400).json({ error: 'Email, password, and user type are required' });
        }
        
        if (!['CPA', 'SME'].includes(userType)) {
            return res.status(400).json({ error: 'User type must be CPA or SME' });
        }
        
        // Check if user exists
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'User already exists' });
        }
        
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
        
        // Create user
        const result = await pool.query(
            'INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id, email, user_type, created_at',
            [email, passwordHash, userType]
        );
        
        const user = result.rows[0];
        
        // Generate JWT
        const token = jwt.sign(
            { userId: user.id, email: user.email, userType: user.user_type },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.status(201).json({
            message: 'User created successfully',
            token,
            user: {
                id: user.id,
                email: user.email,
                userType: user.user_type,
                createdAt: user.created_at
            }
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        // Get user
        const result = await pool.query(
            'SELECT id, email, password_hash, user_type, is_active FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        
        if (!user.is_active) {
            return res.status(401).json({ error: 'Account is deactivated' });
        }
        
        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Update last login
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
        
        // Generate JWT
        const token = jwt.sign(
            { userId: user.id, email: user.email, userType: user.user_type },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                email: user.email,
                userType: user.user_type
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all CPAs
app.get('/api/profiles/cpas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                cp.id, cp.first_name, cp.last_name, cp.license_number, cp.province,
                cp.city, cp.years_experience, cp.hourly_rate, cp.current_capacity,
                cp.accepting_clients, cp.platform_rating, cp.total_matches, cp.bio,
                u.email
            FROM cpa_profiles cp
            JOIN users u ON cp.user_id = u.id
            WHERE u.is_active = TRUE AND cp.accepting_clients = TRUE
            ORDER BY cp.platform_rating DESC, cp.years_experience DESC
        `);
        
        res.json({
            message: 'CPAs retrieved successfully',
            count: result.rows.length,
            cpas: result.rows
        });
    } catch (error) {
        console.error('Get CPAs error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all SMEs
app.get('/api/profiles/smes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                sp.id, sp.company_name, sp.industry, sp.contact_first_name, sp.contact_last_name,
                sp.employee_count, sp.annual_revenue_min, sp.annual_revenue_max,
                sp.city, sp.province, sp.budget_min, sp.budget_max, sp.urgency_level,
                sp.complexity_level, sp.platform_rating, sp.total_matches,
                u.email
            FROM sme_profiles sp
            JOIN users u ON sp.user_id = u.id
            WHERE u.is_active = TRUE
            ORDER BY sp.created_at DESC
        `);
        
        res.json({
            message: 'SMEs retrieved successfully',
            count: result.rows.length,
            smes: result.rows
        });
    } catch (error) {
        console.error('Get SMEs error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6-Factor Matching Algorithm
app.get('/api/matches/:smeId', async (req, res) => {
    try {
        const { smeId } = req.params;
        
        // Get SME profile
        const smeResult = await pool.query(`
            SELECT * FROM sme_profiles WHERE id = $1
        `, [smeId]);
        
        if (smeResult.rows.length === 0) {
            return res.status(404).json({ error: 'SME not found' });
        }
        
        const sme = smeResult.rows[0];
        
        // Get all available CPAs
        const cpaResult = await pool.query(`
            SELECT cp.*, u.email 
            FROM cpa_profiles cp
            JOIN users u ON cp.user_id = u.id
            WHERE u.is_active = TRUE AND cp.accepting_clients = TRUE
        `);
        
        // Calculate 6-factor match scores
        const matches = cpaResult.rows.map(cpa => {
            // Factor 1: Industry Experience (25%)
            const industryScore = calculateIndustryMatch(sme.industry, cpa.bio);
            
            // Factor 2: Business Size Compatibility (20%)
            const sizeScore = calculateSizeMatch(sme.employee_count, cpa.years_experience);
            
            // Factor 3: Service Requirements (20%)
            const servicesScore = calculateServicesMatch(sme.complexity_level, cpa.years_experience);
            
            // Factor 4: Geographic Proximity (15%)
            const locationScore = calculateLocationMatch(sme.province, sme.city, cpa.province, cpa.city);
            
            // Factor 5: Availability & Capacity (10%)
            const availabilityScore = calculateAvailabilityMatch(cpa.current_capacity, cpa.accepting_clients);
            
            // Factor 6: Past Success Rate (10%)
            const successScore = calculateSuccessMatch(cpa.platform_rating, cpa.total_matches);
            
            // Calculate weighted overall score
            const overallScore = (
                industryScore * 0.25 +
                sizeScore * 0.20 +
                servicesScore * 0.20 +
                locationScore * 0.15 +
                availabilityScore * 0.10 +
                successScore * 0.10
            );
            
            return {
                cpa,
                scores: {
                    overall: Math.round(overallScore * 100) / 100,
                    industry: Math.round(industryScore * 100) / 100,
                    size: Math.round(sizeScore * 100) / 100,
                    services: Math.round(servicesScore * 100) / 100,
                    location: Math.round(locationScore * 100) / 100,
                    availability: Math.round(availabilityScore * 100) / 100,
                    success: Math.round(successScore * 100) / 100
                }
            };
        });
        
        // Sort by overall score
        matches.sort((a, b) => b.scores.overall - a.scores.overall);
        
        res.json({
            message: 'Matches calculated successfully',
            sme: sme,
            matches: matches.slice(0, 10), // Top 10 matches
            algorithm: '6-factor weighted scoring'
        });
        
    } catch (error) {
        console.error('Matching error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Matching algorithm helper functions
function calculateIndustryMatch(smeIndustry, cpaBio) {
    if (!cpaBio) return 0.5;
    const bio = cpaBio.toLowerCase();
    const industry = smeIndustry.toLowerCase();
    
    if (bio.includes(industry)) return 1.0;
    if (bio.includes('technology') && industry.includes('tech')) return 0.9;
    if (bio.includes('startup') && industry.includes('tech')) return 0.8;
    return 0.6; // Base compatibility
}

function calculateSizeMatch(employeeCount, yearsExperience) {
    if (!employeeCount || !yearsExperience) return 0.7;
    
    if (employeeCount <= 10 && yearsExperience >= 3) return 1.0;
    if (employeeCount <= 50 && yearsExperience >= 5) return 0.9;
    if (employeeCount <= 100 && yearsExperience >= 7) return 0.8;
    if (employeeCount > 100 && yearsExperience >= 10) return 0.9;
    return 0.6;
}

function calculateServicesMatch(complexityLevel, yearsExperience) {
    if (!complexityLevel || !yearsExperience) return 0.7;
    
    if (complexityLevel === 'low' && yearsExperience >= 2) return 1.0;
    if (complexityLevel === 'medium' && yearsExperience >= 5) return 1.0;
    if (complexityLevel === 'high' && yearsExperience >= 8) return 1.0;
    if (complexityLevel === 'high' && yearsExperience >= 5) return 0.8;
    return 0.7;
}

function calculateLocationMatch(smeProvince, smeCity, cpaProvince, cpaCity) {
    if (!smeProvince || !cpaProvince) return 0.5;
    
    if (smeProvince === cpaProvince) {
        if (smeCity && cpaCity && smeCity.toLowerCase() === cpaCity.toLowerCase()) {
            return 1.0; // Same city
        }
        return 0.8; // Same province
    }
    return 0.4; // Different province
}

function calculateAvailabilityMatch(capacity, accepting) {
    if (!accepting) return 0.0;
    if (!capacity) return 0.7;
    
    if (capacity >= 5) return 1.0;
    if (capacity >= 3) return 0.8;
    if (capacity >= 1) return 0.6;
    return 0.3;
}

function calculateSuccessMatch(rating, totalMatches) {
    if (!rating) rating = 5.0;
    if (!totalMatches) totalMatches = 0;
    
    const ratingScore = rating / 5.0;
    const experienceBonus = Math.min(totalMatches / 20, 0.2);
    
    return Math.min(ratingScore + experienceBonus, 1.0);
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 CanadaAccountants API running on http://localhost:${PORT}`);
    console.log(`🌍 Frontend URL: ${process.env.FRONTEND_URL}`);
    console.log(`💡 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📊 API docs: http://localhost:${PORT}/`);
    console.log('🔥 6-Factor Matching Algorithm Ready!');
});
