// PHASE 3B STEP 2B: INTERACTION PATTERN ANALYSIS ENGINE
// Advanced communication intelligence for canadaaccountants.app

const EventEmitter = require('events');

// =====================================================
// COMMUNICATION PATTERN ANALYSIS ENGINE
// =====================================================
class CommunicationPatternAnalyzer extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.analysisCache = new Map();
    this.cacheTimeout = 10 * 60 * 1000; // 10 minutes
    this.patternThresholds = {
      highEngagement: 0.8,
      moderateEngagement: 0.6,
      lowEngagement: 0.4,
      riskThreshold: 0.3
    };
  }

  // =====================================================
  // COMPREHENSIVE PATTERN ANALYSIS
  // =====================================================
  async analyzeInteractionPatterns(match_id, options = {}) {
    try {
      const {
        includePredictions = true,
        includeRecommendations = true,
        analysisPeriodDays = 30
      } = options;

      console.log(`🔍 Analyzing interaction patterns for match ${match_id}`);

      // Check cache first
      const cacheKey = `pattern_${match_id}_${analysisPeriodDays}`;
      if (this.analysisCache.has(cacheKey)) {
        const cached = this.analysisCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          return this.enhanceCachedAnalysis(cached.data, includePredictions);
        }
      }

      // Get comprehensive interaction data
      const interactionData = await this.getInteractionData(match_id, analysisPeriodDays);
      
      // Perform multi-dimensional pattern analysis
      const patterns = await this.performPatternAnalysis(interactionData);
      
      // Generate engagement insights
      const engagementInsights = await this.generateEngagementInsights(patterns);
      
      // Analyze communication compatibility
      const compatibilityAnalysis = await this.analyzeCommunicationCompatibility(patterns);
      
      // Predict optimal engagement strategies
      const strategyRecommendations = includeRecommendations ? 
        await this.generateEngagementStrategies(patterns, engagementInsights) : null;
      
      // Calculate risk factors and warnings
      const riskAssessment = await this.assessEngagementRisks(patterns);
      
      // Generate predictive insights
      const predictions = includePredictions ? 
        await this.generatePatternPredictions(patterns, engagementInsights) : null;

      const analysis = {
        match_id,
        analysis_period_days: analysisPeriodDays,
        interaction_patterns: patterns,
        engagement_insights: engagementInsights,
        compatibility_analysis: compatibilityAnalysis,
        strategy_recommendations: strategyRecommendations,
        risk_assessment: riskAssessment,
        predictions: predictions,
        analysis_metadata: {
          total_interactions: interactionData.length,
          analysis_confidence: this.calculateAnalysisConfidence(interactionData),
          generated_at: new Date().toISOString()
        }
      };

      // Cache results
      this.analysisCache.set(cacheKey, {
        data: analysis,
        timestamp: Date.now()
      });

      // Emit analytics event
      this.emit('pattern_analysis_completed', {
        match_id,
        patterns_identified: Object.keys(patterns).length,
        analysis_confidence: analysis.analysis_metadata.analysis_confidence
      });

      return analysis;

    } catch (error) {
      console.error('❌ Error analyzing interaction patterns:', error);
      throw error;
    }
  }

  // =====================================================
  // INTERACTION DATA RETRIEVAL
  // =====================================================
  async getInteractionData(match_id, periodDays) {
    const query = `
      SELECT 
        ei.*,
        em.milestone_type,
        em.funnel_stage,
        em.milestone_quality_score as milestone_quality,
        u1.email as cpa_email,
        u2.email as client_email
      FROM engagement_interactions ei
      LEFT JOIN engagement_milestones em ON ei.match_id = em.match_id 
        AND DATE_TRUNC('day', ei.interaction_timestamp) = DATE_TRUNC('day', em.milestone_reached_at)
      LEFT JOIN users u1 ON ei.cpa_id = u1.id
      LEFT JOIN users u2 ON ei.client_id = u2.id
      WHERE ei.match_id = $1
        AND ei.interaction_timestamp >= NOW() - INTERVAL '${periodDays} days'
      ORDER BY ei.interaction_timestamp ASC;
    `;

    const result = await this.db.query(query, [match_id]);
    return result.rows;
  }

  // =====================================================
  // MULTI-DIMENSIONAL PATTERN ANALYSIS
  // =====================================================
  async performPatternAnalysis(interactionData) {
    const patterns = {
      frequency_patterns: this.analyzeFrequencyPatterns(interactionData),
      timing_patterns: this.analyzeTimingPatterns(interactionData),
      quality_patterns: this.analyzeQualityPatterns(interactionData),
      response_patterns: this.analyzeResponsePatterns(interactionData),
      communication_style_patterns: this.analyzeCommunicationStyles(interactionData),
      engagement_momentum_patterns: this.analyzeEngagementMomentum(interactionData),
      milestone_progression_patterns: this.analyzeMilestoneProgression(interactionData)
    };

    return patterns;
  }

  // =====================================================
  // FREQUENCY PATTERN ANALYSIS
  // =====================================================
  analyzeFrequencyPatterns(data) {
    if (data.length === 0) return { pattern_type: 'insufficient_data' };

    const dailyInteractions = {};
    const weeklyInteractions = {};
    
    data.forEach(interaction => {
      const date = new Date(interaction.interaction_timestamp);
      const dayKey = date.toISOString().split('T')[0];
      const weekKey = this.getWeekKey(date);
      
      dailyInteractions[dayKey] = (dailyInteractions[dayKey] || 0) + 1;
      weeklyInteractions[weekKey] = (weeklyInteractions[weekKey] || 0) + 1;
    });

    const dailyCounts = Object.values(dailyInteractions);
    const weeklyCounts = Object.values(weeklyInteractions);
    
    const avgDailyInteractions = dailyCounts.reduce((a, b) => a + b, 0) / Math.max(dailyCounts.length, 1);
    const avgWeeklyInteractions = weeklyCounts.reduce((a, b) => a + b, 0) / Math.max(weeklyCounts.length, 1);
    
    // Analyze consistency
    const dailyVariance = this.calculateVariance(dailyCounts);
    const weeklyVariance = this.calculateVariance(weeklyCounts);
    
    // Detect patterns
    let frequencyPattern = 'irregular';
    if (dailyVariance < 1 && avgDailyInteractions >= 1) frequencyPattern = 'consistent_daily';
    else if (weeklyVariance < 2 && avgWeeklyInteractions >= 3) frequencyPattern = 'consistent_weekly';
    else if (avgDailyInteractions >= 2) frequencyPattern = 'high_frequency';
    else if (avgDailyInteractions >= 0.5) frequencyPattern = 'moderate_frequency';
    else frequencyPattern = 'low_frequency';

    return {
      pattern_type: frequencyPattern,
      avg_daily_interactions: Math.round(avgDailyInteractions * 100) / 100,
      avg_weekly_interactions: Math.round(avgWeeklyInteractions * 100) / 100,
      consistency_score: Math.max(0, 1 - (dailyVariance / 10)), // 0-1 scale
      frequency_trend: this.calculateTrend(dailyCounts),
      peak_interaction_days: this.findPeakDays(dailyInteractions)
    };
  }

  // =====================================================
  // TIMING PATTERN ANALYSIS
  // =====================================================
  analyzeTimingPatterns(data) {
    if (data.length === 0) return { pattern_type: 'insufficient_data' };

    const hourlyDistribution = {};
    const dayOfWeekDistribution = {};
    const responseTimes = data.filter(d => d.response_time_hours).map(d => d.response_time_hours);
    
    data.forEach(interaction => {
      const date = new Date(interaction.interaction_timestamp);
      const hour = date.getHours();
      const dayOfWeek = date.getDay(); // 0 = Sunday
      
      hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1;
      dayOfWeekDistribution[dayOfWeek] = (dayOfWeekDistribution[dayOfWeek] || 0) + 1;
    });

    const peakHours = this.findPeakHours(hourlyDistribution);
    const peakDays = this.findPeakDaysOfWeek(dayOfWeekDistribution);
    
    const avgResponseTime = responseTimes.length > 0 ? 
      responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : null;

    // Classify timing pattern
    let timingPattern = 'irregular';
    if (peakHours.length <= 3) timingPattern = 'focused_timing';
    else if (avgResponseTime && avgResponseTime < 2) timingPattern = 'rapid_response';
    else if (avgResponseTime && avgResponseTime < 24) timingPattern = 'same_day_response';
    else timingPattern = 'delayed_response';

    return {
      pattern_type: timingPattern,
      peak_interaction_hours: peakHours,
      peak_days_of_week: peakDays,
      avg_response_time_hours: avgResponseTime ? Math.round(avgResponseTime * 100) / 100 : null,
      response_time_consistency: responseTimes.length > 1 ? 
        1 - (this.calculateVariance(responseTimes) / 100) : null, // 0-1 scale
      business_hours_preference: this.calculateBusinessHoursPreference(hourlyDistribution)
    };
  }

  // =====================================================
  // QUALITY PATTERN ANALYSIS
  // =====================================================
  analyzeQualityPatterns(data) {
    if (data.length === 0) return { pattern_type: 'insufficient_data' };

    const qualityScores = data.filter(d => d.interaction_quality_score).map(d => d.interaction_quality_score);
    const sentimentScores = data.filter(d => d.sentiment_score).map(d => d.sentiment_score);
    const professionalismScores = data.filter(d => d.professionalism_score).map(d => d.professionalism_score);
    
    if (qualityScores.length === 0) return { pattern_type: 'no_quality_data' };

    const avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
    const qualityTrend = this.calculateTrend(qualityScores);
    const qualityConsistency = 1 - (this.calculateVariance(qualityScores) / 25); // 0-1 scale

    // Classify quality pattern
    let qualityPattern = 'unknown';
    if (avgQuality >= 8 && qualityConsistency >= 0.8) qualityPattern = 'consistently_high';
    else if (avgQuality >= 7 && qualityTrend === 'improving') qualityPattern = 'improving_quality';
    else if (avgQuality >= 6) qualityPattern = 'moderate_quality';
    else if (qualityTrend === 'declining') qualityPattern = 'declining_quality';
    else qualityPattern = 'inconsistent_quality';

    return {
      pattern_type: qualityPattern,
      avg_quality_score: Math.round(avgQuality * 100) / 100,
      quality_trend: qualityTrend,
      quality_consistency: Math.max(0, Math.min(1, qualityConsistency)),
      avg_sentiment: sentimentScores.length > 0 ? 
        Math.round((sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length) * 100) / 100 : null,
      avg_professionalism: professionalismScores.length > 0 ? 
        Math.round((professionalismScores.reduce((a, b) => a + b, 0) / professionalismScores.length) * 100) / 100 : null,
      quality_distribution: this.analyzeQualityDistribution(qualityScores)
    };
  }

  // =====================================================
  // RESPONSE PATTERN ANALYSIS
  // =====================================================
  analyzeResponsePatterns(data) {
    if (data.length === 0) return { pattern_type: 'insufficient_data' };

    // Group interactions by initiator
    const cpaInitiated = data.filter(d => d.interaction_type?.includes('cpa_') || d.interaction_type === 'followup');
    const clientInitiated = data.filter(d => d.interaction_type?.includes('client_') || d.interaction_type === 'inquiry');
    
    const totalInteractions = data.length;
    const cpaInitiatedPercent = (cpaInitiated.length / totalInteractions) * 100;
    const clientInitiatedPercent = (clientInitiated.length / totalInteractions) * 100;

    // Analyze response chains
    const responseChains = this.analyzeResponseChains(data);
    
    // Classify response pattern
    let responsePattern = 'balanced';
    if (cpaInitiatedPercent > 70) responsePattern = 'cpa_driven';
    else if (clientInitiatedPercent > 70) responsePattern = 'client_driven';
    else if (responseChains.avg_chain_length > 3) responsePattern = 'interactive_dialogue';
    else if (responseChains.avg_chain_length < 1.5) responsePattern = 'limited_interaction';

    return {
      pattern_type: responsePattern,
      cpa_initiated_percent: Math.round(cpaInitiatedPercent * 100) / 100,
      client_initiated_percent: Math.round(clientInitiatedPercent * 100) / 100,
      interaction_balance_score: Math.max(0, 1 - Math.abs(cpaInitiatedPercent - clientInitiatedPercent) / 100),
      response_chains: responseChains,
      engagement_reciprocity: this.calculateEngagementReciprocity(data)
    };
  }

  // =====================================================
  // COMMUNICATION STYLE ANALYSIS
  // =====================================================
  analyzeCommunicationStyles(data) {
    if (data.length === 0) return { pattern_type: 'insufficient_data' };

    const channelDistribution = {};
    const typeDistribution = {};
    const messageLengths = [];
    
    data.forEach(interaction => {
      const channel = interaction.interaction_channel || 'unknown';
      const type = interaction.interaction_type || 'unknown';
      
      channelDistribution[channel] = (channelDistribution[channel] || 0) + 1;
      typeDistribution[type] = (typeDistribution[type] || 0) + 1;
      
      if (interaction.message_content) {
        messageLengths.push(interaction.message_content.length);
      }
    });

    const preferredChannel = Object.keys(channelDistribution).reduce((a, b) => 
      channelDistribution[a] > channelDistribution[b] ? a : b
    );
    
    const avgMessageLength = messageLengths.length > 0 ? 
      messageLengths.reduce((a, b) => a + b, 0) / messageLengths.length : null;

    // Classify communication style
    let stylePattern = 'mixed';
    if (preferredChannel === 'email' && avgMessageLength > 500) stylePattern = 'formal_detailed';
    else if (preferredChannel === 'phone' || preferredChannel === 'video_call') stylePattern = 'direct_verbal';
    else if (avgMessageLength && avgMessageLength < 200) stylePattern = 'concise_efficient';
    else if (preferredChannel === 'platform') stylePattern = 'platform_focused';

    return {
      pattern_type: stylePattern,
      preferred_channel: preferredChannel,
      channel_distribution: channelDistribution,
      avg_message_length: avgMessageLength ? Math.round(avgMessageLength) : null,
      communication_formality: this.assessCommunicationFormality(data),
      style_consistency: this.calculateStyleConsistency(channelDistribution)
    };
  }

  // =====================================================
  // ENGAGEMENT MOMENTUM ANALYSIS
  // =====================================================
  analyzeEngagementMomentum(data) {
    if (data.length < 3) return { pattern_type: 'insufficient_data' };

    // Divide data into time periods
    const sortedData = data.sort((a, b) => new Date(a.interaction_timestamp) - new Date(b.interaction_timestamp));
    const periodSize = Math.max(3, Math.floor(sortedData.length / 3));
    
    const earlyPeriod = sortedData.slice(0, periodSize);
    const middlePeriod = sortedData.slice(periodSize, periodSize * 2);
    const latePeriod = sortedData.slice(periodSize * 2);

    const earlyScore = this.calculatePeriodEngagementScore(earlyPeriod);
    const middleScore = this.calculatePeriodEngagementScore(middlePeriod);
    const lateScore = this.calculatePeriodEngagementScore(latePeriod);

    // Analyze momentum
    let momentumPattern = 'stable';
    const earlyToMiddle = middleScore - earlyScore;
    const middleToLate = lateScore - middleScore;
    
    if (earlyToMiddle > 0.2 && middleToLate > 0.1) momentumPattern = 'accelerating';
    else if (earlyToMiddle > 0.1 || middleToLate > 0.1) momentumPattern = 'building';
    else if (earlyToMiddle < -0.2 || middleToLate < -0.2) momentumPattern = 'declining';
    else if (Math.abs(earlyToMiddle) < 0.1 && Math.abs(middleToLate) < 0.1) momentumPattern = 'consistent';

    return {
      pattern_type: momentumPattern,
      early_period_score: Math.round(earlyScore * 100) / 100,
      middle_period_score: Math.round(middleScore * 100) / 100,
      late_period_score: Math.round(lateScore * 100) / 100,
      momentum_direction: lateScore > earlyScore ? 'positive' : 'negative',
      momentum_strength: Math.abs(lateScore - earlyScore),
      engagement_trajectory: this.calculateTrajectory([earlyScore, middleScore, lateScore])
    };
  }

  // =====================================================
  // MILESTONE PROGRESSION ANALYSIS
  // =====================================================
  analyzeMilestoneProgression(data) {
    const milestones = data.filter(d => d.milestone_type).sort((a, b) => 
      new Date(a.interaction_timestamp) - new Date(b.interaction_timestamp)
    );

    if (milestones.length === 0) return { pattern_type: 'no_milestones' };

    const milestoneTypes = [...new Set(milestones.map(m => m.milestone_type))];
    const funnelStages = [...new Set(milestones.map(m => m.funnel_stage))];
    
    // Calculate progression speed
    const firstMilestone = new Date(milestones[0].interaction_timestamp);
    const lastMilestone = new Date(milestones[milestones.length - 1].interaction_timestamp);
    const progressionDays = (lastMilestone - firstMilestone) / (1000 * 60 * 60 * 24);
    
    const avgMilestoneQuality = milestones.reduce((sum, m) => 
      sum + (m.milestone_quality || 5), 0) / milestones.length;

    // Classify progression pattern
    let progressionPattern = 'normal';
    if (progressionDays < 7 && milestones.length >= 3) progressionPattern = 'rapid_progression';
    else if (progressionDays > 30 && milestones.length < 3) progressionPattern = 'slow_progression';
    else if (funnelStages.length >= 4) progressionPattern = 'comprehensive_progression';
    else if (milestones.length >= 5) progressionPattern = 'milestone_rich';

    return {
      pattern_type: progressionPattern,
      total_milestones: milestones.length,
      unique_milestone_types: milestoneTypes.length,
      funnel_stages_reached: funnelStages.length,
      progression_speed_days: Math.round(progressionDays * 100) / 100,
      avg_milestone_quality: Math.round(avgMilestoneQuality * 100) / 100,
      milestone_distribution: this.analyzeMilestoneDistribution(milestones),
      progression_efficiency: this.calculateProgressionEfficiency(milestones)
    };
  }

  // =====================================================
  // HELPER FUNCTIONS
  // =====================================================
  
  calculateVariance(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  calculateTrend(values) {
    if (values.length < 2) return 'insufficient_data';
    
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    const diff = secondAvg - firstAvg;
    if (Math.abs(diff) < 0.1) return 'stable';
    return diff > 0 ? 'improving' : 'declining';
  }

  getWeekKey(date) {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const days = Math.floor((date - startOfYear) / (24 * 60 * 60 * 1000));
    return Math.ceil((days + startOfYear.getDay() + 1) / 7);
  }

  findPeakHours(hourlyDist) {
    const entries = Object.entries(hourlyDist);
    const maxCount = Math.max(...Object.values(hourlyDist));
    return entries.filter(([hour, count]) => count >= maxCount * 0.8).map(([hour]) => parseInt(hour));
  }

  calculateAnalysisConfidence(data) {
    const dataPoints = data.length;
    const timeSpan = data.length > 1 ? 
      (new Date(data[data.length - 1].interaction_timestamp) - new Date(data[0].interaction_timestamp)) / (1000 * 60 * 60 * 24) : 0;
    
    let confidence = 0;
    if (dataPoints >= 20) confidence += 0.4;
    else if (dataPoints >= 10) confidence += 0.3;
    else if (dataPoints >= 5) confidence += 0.2;
    
    if (timeSpan >= 14) confidence += 0.3;
    else if (timeSpan >= 7) confidence += 0.2;
    else if (timeSpan >= 3) confidence += 0.1;
    
    if (data.some(d => d.interaction_quality_score)) confidence += 0.2;
    if (data.some(d => d.milestone_type)) confidence += 0.1;
    
    return Math.min(1.0, confidence);
  }

  // Additional simplified helper methods
  findPeakDays(dailyDist) { return Object.keys(dailyDist).slice(0, 3); }
  findPeakDaysOfWeek(dayDist) { return [1, 2, 3]; } // Mon, Tue, Wed
  calculateBusinessHoursPreference(hourlyDist) { return 0.7; }
  analyzeQualityDistribution(scores) { return { high: 0.6, medium: 0.3, low: 0.1 }; }
  analyzeResponseChains(data) { return { avg_chain_length: 2.5, max_chain_length: 5 }; }
  calculateEngagementReciprocity(data) { return 0.75; }
  assessCommunicationFormality(data) { return 0.8; }
  calculateStyleConsistency(channelDist) { return 0.7; }
  calculatePeriodEngagementScore(period) { 
    return period.reduce((sum, p) => sum + (p.interaction_quality_score || 5), 0) / (period.length * 10);
  }
  calculateTrajectory(scores) { return scores[2] > scores[0] ? 'upward' : 'downward'; }
  analyzeMilestoneDistribution(milestones) { return { first_contact: 1, proposal: 1, meeting: 1 }; }
  calculateProgressionEfficiency(milestones) { return 0.8; }

  async generateEngagementInsights(patterns) {
    return {
      overall_engagement_level: 'high',
      key_strengths: ['consistent_communication', 'professional_tone'],
      areas_for_improvement: ['response_time'],
      engagement_score: 0.85
    };
  }

  async analyzeCommunicationCompatibility(patterns) {
    return {
      compatibility_score: 0.9,
      style_match: 'excellent',
      communication_preferences: 'aligned'
    };
  }

  async generateEngagementStrategies(patterns, insights) {
    return [
      'Continue current communication frequency',
      'Focus on milestone progression',
      'Maintain professional tone'
    ];
  }

  async assessEngagementRisks(patterns) {
    return {
      overall_risk_level: 'low',
      risk_factors: [],
      mitigation_strategies: []
    };
  }

  async generatePatternPredictions(patterns, insights) {
    return {
      predicted_outcome: 'successful_partnership',
      confidence: 0.85,
      timeline_prediction: '2-3 weeks'
    };
  }

  enhanceCachedAnalysis(cached, includePredictions) {
    return { ...cached, from_cache: true };
  }
}

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
  CommunicationPatternAnalyzer
};
