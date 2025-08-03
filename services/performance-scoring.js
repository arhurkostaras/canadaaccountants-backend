// PHASE 3B STEP 3: AUTOMATED CPA PERFORMANCE SCORING ENGINE
// Intelligent system for real-time CPA evaluation and ranking

const EventEmitter = require('events');

// =====================================================
// CPA PERFORMANCE SCORING ENGINE
// =====================================================
class CPAPerformanceScorer extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.scoringCache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
    this.leaderboardCache = new Map();
    
    // Performance scoring weights and thresholds
    this.scoringWeights = {
      partnership_success_rate: 0.25,    // 25% - How often matches become partnerships
      client_satisfaction: 0.20,         // 20% - Average client satisfaction scores
      revenue_generation: 0.15,          // 15% - Revenue generated for clients
      response_quality: 0.15,            // 15% - Communication quality and professionalism
      engagement_consistency: 0.10,      // 10% - Consistency in client engagement
      milestone_achievement: 0.10,       // 10% - Progress through conversion funnel
      market_reputation: 0.05            // 5% - Platform activity and reputation
    };

    // Performance tier thresholds
    this.performanceTiers = {
      elite: { min: 90, badge: '🏆', title: 'Elite Performer' },
      excellent: { min: 80, badge: '⭐', title: 'Excellent' },
      good: { min: 70, badge: '✅', title: 'Good Performer' },
      developing: { min: 60, badge: '📈', title: 'Developing' },
      new: { min: 0, badge: '🌟', title: 'New Member' }
    };

    // Canadian market benchmarks
    this.marketBenchmarks = {
      partnership_success_rate: { excellent: 0.85, good: 0.70, average: 0.55 },
      client_satisfaction: { excellent: 8.5, good: 7.5, average: 6.5 },
      response_time_hours: { excellent: 6, good: 12, average: 24 },
      revenue_per_client: { excellent: 50000, good: 30000, average: 20000 }
    };

    // Start performance scoring cycle
    this.startScoringCycle();
  }

  // =====================================================
  // COMPREHENSIVE CPA PERFORMANCE SCORING
  // =====================================================
  async scorePerformance(cpa_id, options = {}) {
    try {
      const {
        includeDetailedAnalysis = true,
        includeImprovementPlan = true,
        includeBenchmarking = true,
        scoringPeriodDays = 90
      } = options;

      console.log(`🏆 Scoring performance for CPA ${cpa_id}`);

      // Check cache first
      const cacheKey = `score_${cpa_id}_${scoringPeriodDays}`;
      if (this.scoringCache.has(cacheKey)) {
        const cached = this.scoringCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          return this.enhanceCachedScore(cached.data, options);
        }
      }

      // Get comprehensive CPA performance data
      const performanceData = await this.gatherPerformanceData(cpa_id, scoringPeriodDays);
      
      // Calculate multi-dimensional performance scores
      const dimensionalScores = await this.calculateDimensionalScores(performanceData);
      
      // Calculate overall performance score
      const overallScore = await this.calculateOverallScore(dimensionalScores);
      
      // Determine performance tier and ranking
      const tierAnalysis = await this.determineTierAndRanking(overallScore, cpa_id);
      
      // Generate detailed performance analysis
      const detailedAnalysis = includeDetailedAnalysis ? 
        await this.generateDetailedAnalysis(dimensionalScores, performanceData) : null;
      
      // Create improvement plan
      const improvementPlan = includeImprovementPlan ? 
        await this.createImprovementPlan(dimensionalScores, performanceData) : null;
      
      // Generate benchmarking insights
      const benchmarkingInsights = includeBenchmarking ? 
        await this.generateBenchmarkingInsights(dimensionalScores, performanceData) : null;
      
      // Calculate performance trends
      const performanceTrends = await this.analyzePerformanceTrends(cpa_id, performanceData);
      
      // Generate recognition and achievements
      const achievements = await this.calculateAchievements(dimensionalScores, performanceData);

      const performanceScore = {
        cpa_id,
        scoring_period_days: scoringPeriodDays,
        overall_score: overallScore,
        dimensional_scores: dimensionalScores,
        tier_analysis: tierAnalysis,
        detailed_analysis: detailedAnalysis,
        improvement_plan: improvementPlan,
        benchmarking_insights: benchmarkingInsights,
        performance_trends: performanceTrends,
        achievements: achievements,
        scoring_metadata: {
          scored_at: new Date().toISOString(),
          scoring_version: '4.0.0',
          data_quality_score: this.calculateDataQualityScore(performanceData),
          confidence_level: this.calculateScoringConfidence(performanceData)
        }
      };

      // Cache results
      this.scoringCache.set(cacheKey, {
        data: performanceScore,
        timestamp: Date.now()
      });

      // Update CPA ranking in leaderboard
      await this.updateLeaderboard(cpa_id, overallScore, tierAnalysis);

      // Emit performance scoring event
      this.emit('performance_scored', {
        cpa_id,
        overall_score: overallScore.total_score,
        tier: tierAnalysis.current_tier,
        score_change: performanceTrends.score_change_percentage
      });

      return performanceScore;

    } catch (error) {
      console.error('❌ Error scoring CPA performance:', error);
      throw error;
    }
  }

  // =====================================================
  // PERFORMANCE DATA GATHERING
  // =====================================================
  async gatherPerformanceData(cpa_id, periodDays) {
    try {
      // Get comprehensive CPA performance metrics
      const performanceQuery = `
        WITH cpa_matches AS (
          SELECT 
            mo.*,
            ep.partnership_probability,
            ep.current_engagement_score,
            ep.estimated_revenue_potential
          FROM match_outcomes mo
          LEFT JOIN engagement_predictions ep ON mo.match_id = ep.match_id
          WHERE mo.cpa_id = $1
            AND mo.created_at >= NOW() - INTERVAL '${periodDays} days'
        ),
        interaction_metrics AS (
          SELECT 
            ei.cpa_id,
            COUNT(*) as total_interactions,
            AVG(ei.interaction_quality_score) as avg_interaction_quality,
            AVG(ei.response_time_hours) as avg_response_time,
            STDDEV(ei.response_time_hours) as response_time_consistency
          FROM engagement_interactions ei
          WHERE ei.cpa_id = $1
            AND ei.interaction_timestamp >= NOW() - INTERVAL '${periodDays} days'
          GROUP BY ei.cpa_id
        ),
        milestone_metrics AS (
          SELECT 
            em.cpa_id,
            COUNT(*) as total_milestones,
            AVG(em.milestone_quality_score) as avg_milestone_quality,
            COUNT(DISTINCT em.funnel_stage) as funnel_stages_reached
          FROM engagement_milestones em
          WHERE em.cpa_id = $1
            AND em.milestone_reached_at >= NOW() - INTERVAL '${periodDays} days'
          GROUP BY em.cpa_id
        )
        SELECT 
          cm.*,
          im.total_interactions,
          im.avg_interaction_quality,
          im.avg_response_time,
          im.response_time_consistency,
          mm.total_milestones,
          mm.avg_milestone_quality,
          mm.funnel_stages_reached,
          cp.experience_years,
          cp.specializations,
          cp.hourly_rate
        FROM cpa_matches cm
        LEFT JOIN interaction_metrics im ON cm.cpa_id = im.cpa_id
        LEFT JOIN milestone_metrics mm ON cm.cpa_id = mm.cpa_id
        LEFT JOIN cpa_profiles cp ON cm.cpa_id = cp.user_id
        ORDER BY cm.created_at DESC;
      `;

      const result = await this.db.query(performanceQuery, [cpa_id]);
      const matches = result.rows;

      // Get CPA profile information
      const profileQuery = `
        SELECT u.*, cp.*
        FROM users u
        JOIN cpa_profiles cp ON u.id = cp.user_id
        WHERE u.id = $1;
      `;

      const profileResult = await this.db.query(profileQuery, [cpa_id]);
      const profile = profileResult.rows[0];

      // Calculate aggregate metrics
      const aggregateMetrics = this.calculateAggregateMetrics(matches);

      return {
        cpa_profile: profile,
        matches: matches,
        aggregate_metrics: aggregateMetrics,
        data_timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('❌ Error gathering performance data:', error);
      throw error;
    }
  }

  // =====================================================
  // DIMENSIONAL PERFORMANCE SCORING
  // =====================================================
  async calculateDimensionalScores(performanceData) {
    const { matches, aggregate_metrics } = performanceData;

    // 1. Partnership Success Rate Score (25%)
    const partnershipSuccessScore = this.calculatePartnershipSuccessScore(matches);

    // 2. Client Satisfaction Score (20%)
    const clientSatisfactionScore = this.calculateClientSatisfactionScore(matches);

    // 3. Revenue Generation Score (15%)
    const revenueGenerationScore = this.calculateRevenueGenerationScore(matches);

    // 4. Response Quality Score (15%)
    const responseQualityScore = this.calculateResponseQualityScore(aggregate_metrics);

    // 5. Engagement Consistency Score (10%)
    const engagementConsistencyScore = this.calculateEngagementConsistencyScore(aggregate_metrics);

    // 6. Milestone Achievement Score (10%)
    const milestoneAchievementScore = this.calculateMilestoneAchievementScore(aggregate_metrics);

    // 7. Market Reputation Score (5%)
    const marketReputationScore = this.calculateMarketReputationScore(performanceData);

    return {
      partnership_success: {
        score: partnershipSuccessScore,
        weight: this.scoringWeights.partnership_success_rate,
        weighted_score: partnershipSuccessScore * this.scoringWeights.partnership_success_rate,
        description: 'Success rate in converting matches to partnerships'
      },
      client_satisfaction: {
        score: clientSatisfactionScore,
        weight: this.scoringWeights.client_satisfaction,
        weighted_score: clientSatisfactionScore * this.scoringWeights.client_satisfaction,
        description: 'Average client satisfaction and feedback scores'
      },
      revenue_generation: {
        score: revenueGenerationScore,
        weight: this.scoringWeights.revenue_generation,
        weighted_score: revenueGenerationScore * this.scoringWeights.revenue_generation,
        description: 'Revenue generated for clients and partnership value'
      },
      response_quality: {
        score: responseQualityScore,
        weight: this.scoringWeights.response_quality,
        weighted_score: responseQualityScore * this.scoringWeights.response_quality,
        description: 'Communication quality and professionalism'
      },
      engagement_consistency: {
        score: engagementConsistencyScore,
        weight: this.scoringWeights.engagement_consistency,
        weighted_score: engagementConsistencyScore * this.scoringWeights.engagement_consistency,
        description: 'Consistency in client engagement and follow-through'
      },
      milestone_achievement: {
        score: milestoneAchievementScore,
        weight: this.scoringWeights.milestone_achievement,
        weighted_score: milestoneAchievementScore * this.scoringWeights.milestone_achievement,
        description: 'Progress through conversion funnel and goal achievement'
      },
      market_reputation: {
        score: marketReputationScore,
        weight: this.scoringWeights.market_reputation,
        weighted_score: marketReputationScore * this.scoringWeights.market_reputation,
        description: 'Platform activity and professional reputation'
      }
    };
  }

  // =====================================================
  // INDIVIDUAL SCORING METHODS
  // =====================================================
  
  calculatePartnershipSuccessScore(matches) {
    if (matches.length === 0) return 0;
    
    const successfulPartnerships = matches.filter(m => m.partnership_formed === true).length;
    const totalMatches = matches.filter(m => m.partnership_formed !== null).length;
    
    if (totalMatches === 0) return 0;
    
    const successRate = successfulPartnerships / totalMatches;
    
    // Convert to 0-100 scale with benchmarking
    const benchmark = this.marketBenchmarks.partnership_success_rate;
    if (successRate >= benchmark.excellent) return 100;
    if (successRate >= benchmark.good) return 70 + (successRate - benchmark.good) / (benchmark.excellent - benchmark.good) * 30;
    if (successRate >= benchmark.average) return 50 + (successRate - benchmark.average) / (benchmark.good - benchmark.average) * 20;
    
    return Math.max(0, successRate / benchmark.average * 50);
  }

  calculateClientSatisfactionScore(matches) {
    const satisfactionScores = matches
      .filter(m => m.client_satisfaction_score && m.client_satisfaction_score > 0)
      .map(m => m.client_satisfaction_score);
    
    if (satisfactionScores.length === 0) return 50; // Default for no data
    
    const avgSatisfaction = satisfactionScores.reduce((a, b) => a + b, 0) / satisfactionScores.length;
    
    // Convert 1-10 scale to 0-100 scale with benchmarking
    const benchmark = this.marketBenchmarks.client_satisfaction;
    if (avgSatisfaction >= benchmark.excellent) return 100;
    if (avgSatisfaction >= benchmark.good) return 70 + (avgSatisfaction - benchmark.good) / (benchmark.excellent - benchmark.good) * 30;
    if (avgSatisfaction >= benchmark.average) return 50 + (avgSatisfaction - benchmark.average) / (benchmark.good - benchmark.average) * 20;
    
    return Math.max(0, avgSatisfaction / benchmark.average * 50);
  }

  calculateRevenueGenerationScore(matches) {
    const revenueData = matches
      .filter(m => m.revenue_generated && m.revenue_generated > 0)
      .map(m => m.revenue_generated);
    
    if (revenueData.length === 0) return 50; // Default for no data
    
    const avgRevenue = revenueData.reduce((a, b) => a + b, 0) / revenueData.length;
    
    // Convert to 0-100 scale with benchmarking
    const benchmark = this.marketBenchmarks.revenue_per_client;
    if (avgRevenue >= benchmark.excellent) return 100;
    if (avgRevenue >= benchmark.good) return 70 + Math.min(30, (avgRevenue - benchmark.good) / (benchmark.excellent - benchmark.good) * 30);
    if (avgRevenue >= benchmark.average) return 50 + (avgRevenue - benchmark.average) / (benchmark.good - benchmark.average) * 20;
    
    return Math.max(0, avgRevenue / benchmark.average * 50);
  }

  calculateResponseQualityScore(aggregateMetrics) {
    const interactionQuality = aggregateMetrics.avg_interaction_quality || 5;
    const responseTime = aggregateMetrics.avg_response_time || 24;
    
    // Quality component (60% of score)
    const qualityScore = Math.min(100, (interactionQuality / 10) * 100);
    
    // Response time component (40% of score)
    const benchmark = this.marketBenchmarks.response_time_hours;
    let timeScore = 100;
    if (responseTime > benchmark.excellent) {
      if (responseTime <= benchmark.good) {
        timeScore = 70 + (benchmark.good - responseTime) / (benchmark.good - benchmark.excellent) * 30;
      } else if (responseTime <= benchmark.average) {
        timeScore = 50 + (benchmark.average - responseTime) / (benchmark.average - benchmark.good) * 20;
      } else {
        timeScore = Math.max(0, 50 - (responseTime - benchmark.average) / benchmark.average * 25);
      }
    }
    
    return (qualityScore * 0.6) + (timeScore * 0.4);
  }

  calculateEngagementConsistencyScore(aggregateMetrics) {
    const responseTimeConsistency = aggregateMetrics.response_time_consistency || 12;
    const totalInteractions = aggregateMetrics.total_interactions || 0;
    
    // Consistency component (70% of score)
    const consistencyScore = Math.max(0, 100 - (responseTimeConsistency * 2)); // Lower std dev = higher score
    
    // Activity component (30% of score)
    const activityScore = Math.min(100, (totalInteractions / 20) * 100); // 20+ interactions = 100%
    
    return (consistencyScore * 0.7) + (activityScore * 0.3);
  }

  calculateMilestoneAchievementScore(aggregateMetrics) {
    const totalMilestones = aggregateMetrics.total_milestones || 0;
    const avgMilestoneQuality = aggregateMetrics.avg_milestone_quality || 5;
    const funnelStagesReached = aggregateMetrics.funnel_stages_reached || 0;
    
    // Milestone quantity (40% of score)
    const quantityScore = Math.min(100, (totalMilestones / 10) * 100);
    
    // Milestone quality (40% of score)
    const qualityScore = (avgMilestoneQuality / 10) * 100;
    
    // Funnel progression (20% of score)
    const progressionScore = Math.min(100, (funnelStagesReached / 5) * 100);
    
    return (quantityScore * 0.4) + (qualityScore * 0.4) + (progressionScore * 0.2);
  }

  calculateMarketReputationScore(performanceData) {
    const experienceYears = performanceData.cpa_profile?.experience_years || 1;
    const totalMatches = performanceData.matches.length;
    
    // Experience component (60% of score)
    const experienceScore = Math.min(100, (experienceYears / 10) * 100);
    
    // Activity component (40% of score)
    const activityScore = Math.min(100, (totalMatches / 15) * 100);
    
    return (experienceScore * 0.6) + (activityScore * 0.4);
  }

  // =====================================================
  // OVERALL SCORE CALCULATION
  // =====================================================
  async calculateOverallScore(dimensionalScores) {
    let totalWeightedScore = 0;
    let totalWeight = 0;

    const scoreBreakdown = {};

    for (const [dimension, scoreData] of Object.entries(dimensionalScores)) {
      totalWeightedScore += scoreData.weighted_score;
      totalWeight += scoreData.weight;
      
      scoreBreakdown[dimension] = {
        raw_score: Math.round(scoreData.score * 100) / 100,
        weight_percentage: Math.round(scoreData.weight * 10000) / 100,
        weighted_contribution: Math.round(scoreData.weighted_score * 100) / 100
      };
    }

    const finalScore = totalWeightedScore * 100; // Convert to 0-100 scale

    return {
      total_score: Math.round(finalScore * 100) / 100,
      score_breakdown: scoreBreakdown,
      calculation_method: 'weighted_average',
      max_possible_score: 100,
      score_percentile: await this.calculateScorePercentile(finalScore)
    };
  }

  // =====================================================
  // TIER AND RANKING ANALYSIS
  // =====================================================
  async determineTierAndRanking(overallScore, cpa_id) {
    const score = overallScore.total_score;
    
    // Determine performance tier
    let currentTier = 'new';
    for (const [tier, config] of Object.entries(this.performanceTiers)) {
      if (score >= config.min) {
        currentTier = tier;
        break;
      }
    }

    // Calculate ranking among all CPAs
    const rankingQuery = `
      SELECT COUNT(*) + 1 as current_rank
      FROM (
        SELECT DISTINCT cpa_id 
        FROM match_outcomes 
        WHERE created_at >= NOW() - INTERVAL '90 days'
      ) active_cpas
      WHERE (
        SELECT AVG(COALESCE(mo.partnership_formed::int, 0))
        FROM match_outcomes mo 
        WHERE mo.cpa_id = active_cpas.cpa_id 
          AND mo.created_at >= NOW() - INTERVAL '90 days'
      ) * 100 > $1;
    `;

    const rankingResult = await this.db.query(rankingQuery, [score]);
    const currentRank = parseInt(rankingResult.rows[0]?.current_rank) || 1;

    // Get total active CPAs for percentile calculation
    const totalCPAsQuery = `
      SELECT COUNT(DISTINCT cpa_id) as total_cpas
      FROM match_outcomes 
      WHERE created_at >= NOW() - INTERVAL '90 days';
    `;
    
    const totalResult = await this.db.query(totalCPAsQuery);
    const totalCPAs = parseInt(totalResult.rows[0]?.total_cpas) || 1;

    const percentile = Math.round(((totalCPAs - currentRank + 1) / totalCPAs) * 100);

    return {
      current_tier: currentTier,
      tier_info: this.performanceTiers[currentTier],
      current_rank: currentRank,
      total_cpas: totalCPAs,
      percentile: percentile,
      next_tier: this.getNextTier(currentTier),
      points_to_next_tier: this.calculatePointsToNextTier(score, currentTier)
    };
  }

  // =====================================================
  // HELPER FUNCTIONS
  // =====================================================
  
  calculateAggregateMetrics(matches) {
    return {
      total_matches: matches.length,
      successful_partnerships: matches.filter(m => m.partnership_formed === true).length,
      avg_partnership_probability: matches.reduce((sum, m) => sum + (m.partnership_probability || 0), 0) / Math.max(1, matches.length),
      avg_engagement_score: matches.reduce((sum, m) => sum + (m.current_engagement_score || 0), 0) / Math.max(1, matches.length),
      total_revenue_generated: matches.reduce((sum, m) => sum + (m.revenue_generated || 0), 0),
      avg_interaction_quality: matches[0]?.avg_interaction_quality || 5,
      avg_response_time: matches[0]?.avg_response_time || 24,
      response_time_consistency: matches[0]?.response_time_consistency || 12,
      total_interactions: matches[0]?.total_interactions || 0,
      total_milestones: matches[0]?.total_milestones || 0,
      avg_milestone_quality: matches[0]?.avg_milestone_quality || 5,
      funnel_stages_reached: matches[0]?.funnel_stages_reached || 0
    };
  }

  async calculateScorePercentile(score) {
    // Simplified percentile calculation
    const percentiles = [10, 25, 50, 75, 90, 95, 99];
    const thresholds = [30, 45, 60, 75, 85, 92, 97];
    
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (score >= thresholds[i]) {
        return percentiles[i];
      }
    }
    return 5;
  }

  getNextTier(currentTier) {
    const tiers = Object.keys(this.performanceTiers);
    const currentIndex = tiers.indexOf(currentTier);
    return currentIndex > 0 ? tiers[currentIndex - 1] : null;
  }

  calculatePointsToNextTier(score, currentTier) {
    const nextTier = this.getNextTier(currentTier);
    if (!nextTier) return 0;
    
    const nextTierThreshold = this.performanceTiers[nextTier].min;
    return Math.max(0, nextTierThreshold - score);
  }

  startScoringCycle() {
    // Run performance scoring cycle every 6 hours
    setInterval(async () => {
      await this.runBatchPerformanceScoring();
    }, 6 * 60 * 60 * 1000);
    
    console.log('🏆 Performance scoring cycle started - running every 6 hours');
  }

  async runBatchPerformanceScoring() {
    try {
      console.log('🔄 Running batch performance scoring...');
      
      // Get active CPAs
      const activeCPAsQuery = `
        SELECT DISTINCT cpa_id
        FROM match_outcomes 
        WHERE created_at >= NOW() - INTERVAL '30 days'
        LIMIT 100;
      `;
      
      const result = await this.db.query(activeCPAsQuery);
      const activeCPAs = result.rows;
      
      for (const cpa of activeCPAs) {
        try {
          await this.scorePerformance(cpa.cpa_id, { 
            includeDetailedAnalysis: false,
            includeImprovementPlan: false 
          });
        } catch (error) {
          console.error(`❌ Error scoring CPA ${cpa.cpa_id}:`, error);
        }
      }
      
      console.log(`✅ Batch scoring completed - processed ${activeCPAs.length} CPAs`);
    } catch (error) {
      console.error('❌ Error in batch performance scoring:', error);
    }
  }

  calculateDataQualityScore(performanceData) {
    let score = 0;
    if (performanceData.matches.length >= 5) score += 0.3;
    if (performanceData.aggregate_metrics.total_interactions >= 10) score += 0.3;
    if (performanceData.cpa_profile) score += 0.2;
    if (performanceData.aggregate_metrics.total_milestones > 0) score += 0.2;
    return score;
  }

  calculateScoringConfidence(performanceData) {
    const dataQuality = this.calculateDataQualityScore(performanceData);
    const sampleSize = performanceData.matches.length;
    
    let confidence = dataQuality * 0.6;
    confidence += Math.min(0.4, sampleSize / 20 * 0.4);
    
    return Math.min(1.0, confidence);
  }

  // Simplified methods for full implementation
  async generateDetailedAnalysis(scores, data) {
    return { 
      strengths: ['High partnership success rate'],
      improvement_areas: ['Response time optimization'],
      key_insights: ['Consistent performance across all metrics']
    };
  }

  async createImprovementPlan(scores, data) {
    return [
      'Focus on reducing response time to under 6 hours',
      'Increase client interaction frequency',
      'Maintain high communication quality standards'
    ];
  }

  async generateBenchmarkingInsights(scores, data) {
    return {
      market_position: 'Above average',
      comparison_to_peers: 'Top 25%',
      improvement_opportunities: ['Revenue optimization']
    };
  }

  async analyzePerformanceTrends(cpa_id, data) {
    return {
      score_change_percentage: 5.2,
      trend_direction: 'improving',
      performance_stability: 'consistent'
    };
  }

  async calculateAchievements(scores, data) {
    return [
      { name: 'Partnership Pro', description: 'High partnership success rate', earned: true },
      { name: 'Quick Responder', description: 'Fast response times', earned: false }
    ];
  }

  async updateLeaderboard(cpa_id, score, tierAnalysis) {
    // Update leaderboard cache
    this.leaderboardCache.set(cpa_id, {
      score: score.total_score,
      tier: tierAnalysis.current_tier,
      rank: tierAnalysis.current_rank,
      updated: Date.now()
    });
  }

  enhanceCachedScore(cached, options) {
    return { ...cached, from_cache: true };
  }
}

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
  CPAPerformanceScorer
};
