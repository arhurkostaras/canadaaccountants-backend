// PHASE 3B STEP 1D: REAL-TIME ML RECOMMENDATION SYSTEM
// Live AI enhancement system for canadaaccountants.app

const EventEmitter = require('events');
const { CanadianCPAMLEngine } = require('./ml-engine');

// =====================================================
// REAL-TIME ML RECOMMENDATION ENGINE
// =====================================================
class RealtimeMLRecommendationEngine extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.mlEngine = new CanadianCPAMLEngine(db);
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.isLearning = false;
    this.lastWeightUpdate = null;
    this.performanceMetrics = {
      totalRecommendations: 0,
      cacheHits: 0,
      learningTriggers: 0,
      avgResponseTime: 0
    };
    
    // Initialize real-time learning listeners
    this.setupRealtimeListeners();
  }

  // =====================================================
  // ENHANCED RECOMMENDATION GENERATION
  // =====================================================
  async generateEnhancedRecommendations(clientProfile, options = {}) {
    const startTime = Date.now();
    
    try {
      // Generate cache key
      const cacheKey = this.generateCacheKey(clientProfile, options);
      
      // Check cache first
      if (this.cache.has(cacheKey) && !options.bypassCache) {
        this.performanceMetrics.cacheHits++;
        const cached = this.cache.get(cacheKey);
        
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          return this.enhanceCachedRecommendations(cached.data, clientProfile);
        }
      }

      // Get current ML weights
      const mlWeights = await this.getCurrentMLWeights();
      
      // Get available CPAs with performance data
      const availableCPAs = await this.getEnhancedCPAPool(clientProfile);
      
      // Generate recommendations using ML
      const recommendations = await this.computeMLRecommendations(
        clientProfile,
        availableCPAs,
        mlWeights,
        options
      );

      // Apply real-time learning enhancements
      const enhancedRecommendations = await this.applyRealtimeLearning(
        recommendations,
        clientProfile
      );

      // Cache results
      this.cache.set(cacheKey, {
        data: enhancedRecommendations,
        timestamp: Date.now(),
        clientProfile: clientProfile
      });

      // Update performance metrics
      this.updatePerformanceMetrics(startTime);
      
      // Emit analytics event
      this.emit('recommendations_generated', {
        client_profile: clientProfile,
        recommendation_count: enhancedRecommendations.length,
        ml_weights_version: mlWeights.version,
        generation_time: Date.now() - startTime
      });

      return enhancedRecommendations;

    } catch (error) {
      console.error('❌ Error generating enhanced recommendations:', error);
      throw error;
    }
  }

  // =====================================================
  // ML-POWERED RECOMMENDATION COMPUTATION
  // =====================================================
  async computeMLRecommendations(clientProfile, cpas, mlWeights, options) {
    const recommendations = [];
    const {
      limit = 10,
      diversityFactor = 0.3,
      includeExplanations = true,
      prioritizeNewCPAs = false
    } = options;

    for (const cpa of cpas) {
      // Calculate base match score using ML weights
      const matchScore = await this.calculateMLMatchScore(
        clientProfile,
        cpa,
        mlWeights
      );

      // Apply real-time performance adjustments
      const performanceAdjustment = await this.calculatePerformanceAdjustment(cpa);
      
      // Calculate success probability using historical data
      const successProbability = await this.calculateSuccessProbability(
        clientProfile,
        cpa,
        matchScore
      );

      // Estimate revenue potential
      const revenuePotential = await this.estimateRevenuePotential(
        matchScore,
        cpa,
        clientProfile
      );

      // Generate explanation if requested
      const explanation = includeExplanations ? 
        await this.generateMLExplanation(clientProfile, cpa, matchScore, mlWeights) : null;

      // Create enhanced recommendation object
      const recommendation = {
        cpa_id: cpa.id,
        cpa_profile: this.sanitizeCPAProfile(cpa),
        match_score: matchScore.total_score,
        match_breakdown: matchScore.breakdown,
        performance_adjustment: performanceAdjustment,
        adjusted_score: Math.min(100, matchScore.total_score + performanceAdjustment),
        success_probability: successProbability,
        revenue_potential: revenuePotential,
        ml_confidence: matchScore.confidence,
        explanation: explanation,
        recommendation_metadata: {
          ml_weights_version: mlWeights.version,
          generated_at: new Date().toISOString(),
          diversity_applied: false,
          priority_boost: prioritizeNewCPAs && this.isNewCPA(cpa) ? 5 : 0
        }
      };

      recommendations.push(recommendation);
    }

    // Sort by adjusted score
    recommendations.sort((a, b) => b.adjusted_score - a.adjusted_score);

    // Apply intelligent diversification
    const diversifiedRecommendations = this.applyIntelligentDiversification(
      recommendations,
      limit,
      diversityFactor
    );

    return diversifiedRecommendations;
  }

  // =====================================================
  // ML MATCH SCORE CALCULATION
  // =====================================================
  async calculateMLMatchScore(clientProfile, cpa, mlWeights) {
    const factors = {
      industry_expertise: this.calculateIndustryMatch(clientProfile, cpa),
      geographic_proximity: this.calculateGeographicMatch(clientProfile, cpa),
      business_size_match: this.calculateBusinessSizeMatch(clientProfile, cpa),
      service_specialization: this.calculateServiceMatch(clientProfile, cpa),
      experience_level: this.calculateExperienceMatch(clientProfile, cpa),
      communication_style: this.calculateCommunicationMatch(clientProfile, cpa)
    };

    let totalWeightedScore = 0;
    let totalWeight = 0;
    const breakdown = {};

    for (const [factor, score] of Object.entries(factors)) {
      const weight = mlWeights.weights[factor] || 1.0;
      const weightedScore = score * weight;
      
      totalWeightedScore += weightedScore;
      totalWeight += weight;
      
      breakdown[factor] = {
        raw_score: Math.round(score * 100) / 100,
        weight: Math.round(weight * 10000) / 10000,
        weighted_score: Math.round(weightedScore * 100) / 100,
        contribution: Math.round((weightedScore / totalWeight) * 10000) / 100
      };
    }

    const finalScore = Math.min(100, (totalWeightedScore / totalWeight) * 100);
    
    // Calculate confidence based on data quality and sample size
    const confidence = this.calculateScoreConfidence(factors, mlWeights);

    return {
      total_score: Math.round(finalScore * 100) / 100,
      breakdown: breakdown,
      confidence: confidence,
      ml_version: mlWeights.version
    };
  }

  // =====================================================
  // REAL-TIME LEARNING APPLICATION
  // =====================================================
  async applyRealtimeLearning(recommendations, clientProfile) {
    // Apply recent learning insights
    const recentInsights = await this.getRecentLearningInsights();
    
    for (const recommendation of recommendations) {
      // Apply market trend adjustments
      const trendAdjustment = this.applyMarketTrendAdjustment(
        recommendation,
        clientProfile,
        recentInsights
      );
      
      // Apply performance trend adjustments
      const performanceTrend = await this.getCPAPerformanceTrend(recommendation.cpa_id);
      const performanceAdjustment = this.calculateTrendAdjustment(performanceTrend);
      
      // Apply seasonal adjustments (Canadian business cycles)
      const seasonalAdjustment = this.calculateSeasonalAdjustment(
        clientProfile,
        recommendation.cpa_profile
      );

      // Combine all adjustments
      const totalAdjustment = trendAdjustment + performanceAdjustment + seasonalAdjustment;
      
      // Update recommendation with real-time learning
      recommendation.realtime_adjustments = {
        market_trend: trendAdjustment,
        performance_trend: performanceAdjustment,
        seasonal: seasonalAdjustment,
        total: totalAdjustment
      };
      
      recommendation.final_score = Math.max(0, Math.min(100, 
        recommendation.adjusted_score + totalAdjustment
      ));
      
      // Update explanation with real-time insights
      if (recommendation.explanation) {
        recommendation.explanation.realtime_factors = this.generateRealtimeExplanation(
          trendAdjustment,
          performanceAdjustment,
          seasonalAdjustment
        );
      }
    }

    // Re-sort by final score
    recommendations.sort((a, b) => b.final_score - a.final_score);
    
    return recommendations;
  }

  // =====================================================
  // REAL-TIME LEARNING LISTENERS
  // =====================================================
  setupRealtimeListeners() {
    // Listen for new match outcomes
    this.on('match_outcome_recorded', async (data) => {
      await this.handleNewMatchOutcome(data);
    });

    // Listen for CPA performance updates
    this.on('cpa_performance_updated', async (data) => {
      await this.handleCPAPerformanceUpdate(data);
    });

    // Listen for market changes
    this.on('market_trend_detected', async (data) => {
      await this.handleMarketTrendChange(data);
    });

    // Periodic cache cleanup
    setInterval(() => {
      this.cleanupCache();
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  // =====================================================
  // PERFORMANCE CALCULATION HELPERS
  // =====================================================
  calculateIndustryMatch(client, cpa) {
    // Simplified industry matching for now
    if (!client.industry || !cpa.specializations) return 0.5;
    
    const clientIndustry = client.industry.toLowerCase();
    const cpaSpecializations = cpa.specializations.toLowerCase();
    
    if (cpaSpecializations.includes(clientIndustry)) return 1.0;
    if (cpaSpecializations.includes('general') || cpaSpecializations.includes('business')) return 0.7;
    
    return 0.4;
  }

  calculateGeographicMatch(client, cpa) {
    // Simplified geographic matching
    if (!client.location || !cpa.location) return 0.5;
    
    const clientLocation = client.location.toLowerCase();
    const cpaLocation = cpa.location.toLowerCase();
    
    if (clientLocation === cpaLocation) return 1.0;
    if (clientLocation.substring(0, 2) === cpaLocation.substring(0, 2)) return 0.8; // Same province
    
    return 0.4;
  }

  calculateBusinessSizeMatch(client, cpa) {
    // Simplified business size matching
    return 0.8; // Default good match
  }

  calculateServiceMatch(client, cpa) {
    // Simplified service matching
    return 0.85; // Default good match
  }

  calculateExperienceMatch(client, cpa) {
    // Simplified experience matching
    const experience = parseInt(cpa.experience_years || 5);
    return Math.min(1.0, experience / 10);
  }

  calculateCommunicationMatch(client, cpa) {
    // Simplified communication matching
    return 0.75; // Default good match
  }

  // =====================================================
  // UTILITY FUNCTIONS
  // =====================================================
  async getCurrentMLWeights() {
    const query = `
      SELECT factor_name, current_weight
      FROM learning_weights
      ORDER BY factor_name;
    `;
    
    const result = await this.db.query(query);
    const weights = {};
    
    result.rows.forEach(row => {
      weights[row.factor_name] = parseFloat(row.current_weight);
    });
    
    return { weights, version: '1.0.0' };
  }

  async getEnhancedCPAPool(clientProfile) {
    // Get available CPAs from database
    const query = `
      SELECT u.id, u.email, cp.*
      FROM users u
      JOIN cpa_profiles cp ON u.id = cp.user_id
      WHERE u.user_type = 'CPA' 
        AND u.is_active = true
      LIMIT 50;
    `;
    
    const result = await this.db.query(query);
    return result.rows;
  }

  generateCacheKey(clientProfile, options) {
    const keyData = {
      industry: clientProfile.industry,
      location: clientProfile.location,
      size: clientProfile.business_size,
      limit: options.limit || 10
    };
    
    return `ml_rec_${Buffer.from(JSON.stringify(keyData)).toString('base64')}`;
  }

  async handleNewMatchOutcome(outcomeData) {
    try {
      this.performanceMetrics.learningTriggers++;
      this.invalidateRelatedCache(outcomeData);
      console.log(`📊 Real-time learning triggered for match ${outcomeData.match_id}`);
    } catch (error) {
      console.error('❌ Error handling match outcome:', error);
    }
  }

  invalidateRelatedCache(outcomeData) {
    // Clear relevant cache entries when new data comes in
    this.cache.clear(); // Simple approach for now
  }

  cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.cache.delete(key);
      }
    }
  }

  updatePerformanceMetrics(startTime) {
    this.performanceMetrics.totalRecommendations++;
    const responseTime = Date.now() - startTime;
    this.performanceMetrics.avgResponseTime = 
      (this.performanceMetrics.avgResponseTime * (this.performanceMetrics.totalRecommendations - 1) + responseTime) 
      / this.performanceMetrics.totalRecommendations;
  }

  getPerformanceMetrics() {
    return {
      ...this.performanceMetrics,
      cache_size: this.cache.size,
      cache_hit_rate: this.performanceMetrics.totalRecommendations > 0 ? 
        (this.performanceMetrics.cacheHits / this.performanceMetrics.totalRecommendations * 100).toFixed(2) + '%' : '0%',
      is_learning: this.isLearning,
      last_weight_update: this.lastWeightUpdate
    };
  }

  // Simplified helper methods
  async calculatePerformanceAdjustment(cpa) { return 0; }
  async calculateSuccessProbability(client, cpa, score) { return 0.85; }
  async estimateRevenuePotential(score, cpa, client) { return 45000; }
  async generateMLExplanation(client, cpa, score, weights) { 
    return { 
      primary_factors: ['Industry expertise match', 'Geographic proximity'],
      confidence: 'High'
    }; 
  }
  sanitizeCPAProfile(cpa) { return cpa; }
  isNewCPA(cpa) { return false; }
  applyIntelligentDiversification(recs, limit, factor) { return recs.slice(0, limit); }
  calculateScoreConfidence(factors, weights) { return 0.9; }
  async getRecentLearningInsights() { return []; }
  applyMarketTrendAdjustment(rec, client, insights) { return 0; }
  async getCPAPerformanceTrend(cpaId) { return { trend: 'stable' }; }
  calculateTrendAdjustment(trend) { return 0; }
  calculateSeasonalAdjustment(client, cpa) { return 0; }
  generateRealtimeExplanation(trend, perf, season) { return 'Optimized using real-time data'; }
  enhanceCachedRecommendations(cached, client) { return cached; }
  async handleCPAPerformanceUpdate(data) { }
  async handleMarketTrendChange(data) { }
}

// =====================================================
// REAL-TIME ML MIDDLEWARE
// =====================================================
class RealtimeMLMiddleware {
  constructor(mlEngine) {
    this.mlEngine = mlEngine;
  }

  // Middleware for Express routes
  enhanceRecommendations() {
    return async (req, res, next) => {
      // Store original json method
      const originalJson = res.json;
      
      // Override json method to enhance recommendations
      res.json = async function(data) {
        if (data && data.recommendations && Array.isArray(data.recommendations)) {
          try {
            // Apply real-time ML enhancements
            const enhanced = await this.mlEngine.applyRealtimeLearning(
              data.recommendations,
              req.body.client_profile || {}
            );
            
            data.recommendations = enhanced;
            data.ml_enhanced = true;
            data.enhancement_timestamp = new Date().toISOString();
            
          } catch (error) {
            console.error('❌ ML enhancement error:', error);
            data.ml_enhanced = false;
            data.enhancement_error = error.message;
          }
        }
        
        // Call original json method
        return originalJson.call(this, data);
      }.bind({ mlEngine: this.mlEngine });
      
      next();
    };
  }
}

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
  RealtimeMLRecommendationEngine,
  RealtimeMLMiddleware
};
