// PHASE 3B STEP 2C: REVENUE FORECASTING ALGORITHMS
// Advanced financial prediction system for canadaaccountants.app

const EventEmitter = require('events');

// =====================================================
// REVENUE FORECASTING ENGINE
// =====================================================
class RevenueForecaster extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.forecastCache = new Map();
    this.cacheTimeout = 15 * 60 * 1000; // 15 minutes
    
    // Canadian CPA Market Intelligence
    this.marketData = {
      baseRates: {
        tax_preparation: { min: 150, avg: 300, max: 800 },
        bookkeeping: { min: 50, avg: 85, max: 150 },
        financial_statements: { min: 1500, avg: 3500, max: 8000 },
        business_consulting: { min: 200, avg: 400, max: 1000 },
        audit_assurance: { min: 5000, avg: 15000, max: 50000 },
        payroll_services: { min: 75, avg: 125, max: 250 }
      },
      provincialMultipliers: {
        'ON': 1.15, 'BC': 1.10, 'AB': 1.05, 'QC': 1.08,
        'NS': 0.95, 'NB': 0.92, 'MB': 0.95, 'SK': 0.93,
        'PE': 0.90, 'NL': 0.88, 'NT': 1.20, 'NU': 1.25, 'YT': 1.15
      },
      businessSizeMultipliers: {
        'startup': 0.8, 'small': 1.0, 'medium': 1.5, 'large': 2.5, 'enterprise': 4.0
      },
      seasonalFactors: this.calculateSeasonalFactors(),
      marketTrends: {
        digital_transformation: 1.15,
        compliance_complexity: 1.08,
        remote_work_impact: 1.05
      }
    };
  }

  // =====================================================
  // COMPREHENSIVE REVENUE FORECASTING
  // =====================================================
  async generateRevenueForecast(match_id, options = {}) {
    try {
      const {
        forecastPeriodMonths = 12,
        includeConfidenceIntervals = true,
        includeScenarioAnalysis = true,
        includeMarketFactors = true
      } = options;

      console.log(`💰 Generating revenue forecast for match ${match_id}`);

      // Check cache first
      const cacheKey = `forecast_${match_id}_${forecastPeriodMonths}`;
      if (this.forecastCache.has(cacheKey)) {
        const cached = this.forecastCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          return this.enhanceCachedForecast(cached.data, options);
        }
      }

      // Get comprehensive match data
      const matchData = await this.getMatchDataForForecasting(match_id);
      
      // Analyze historical patterns
      const historicalAnalysis = await this.analyzeHistoricalRevenue(matchData);
      
      // Calculate base revenue projections
      const baseProjections = await this.calculateBaseRevenueProjections(matchData, forecastPeriodMonths);
      
      // Apply market intelligence
      const marketAdjustments = includeMarketFactors ? 
        await this.applyMarketIntelligence(baseProjections, matchData) : null;
      
      // Generate scenario analysis
      const scenarioAnalysis = includeScenarioAnalysis ? 
        await this.generateScenarioAnalysis(baseProjections, matchData) : null;
      
      // Calculate confidence intervals
      const confidenceIntervals = includeConfidenceIntervals ? 
        await this.calculateConfidenceIntervals(baseProjections, matchData) : null;
      
      // Generate revenue breakdown
      const revenueBreakdown = await this.generateRevenueBreakdown(baseProjections, matchData);
      
      // Calculate risk factors
      const riskAssessment = await this.assessRevenueRisks(baseProjections, matchData);
      
      // Generate recommendations
      const optimizationRecommendations = await this.generateOptimizationRecommendations(
        baseProjections, marketAdjustments, riskAssessment
      );

      const forecast = {
        match_id,
        forecast_period_months: forecastPeriodMonths,
        base_projections: baseProjections,
        market_adjustments: marketAdjustments,
        scenario_analysis: scenarioAnalysis,
        confidence_intervals: confidenceIntervals,
        revenue_breakdown: revenueBreakdown,
        risk_assessment: riskAssessment,
        optimization_recommendations: optimizationRecommendations,
        historical_analysis: historicalAnalysis,
        forecast_metadata: {
          generated_at: new Date().toISOString(),
          model_version: '2.1.0',
          data_quality_score: this.calculateDataQualityScore(matchData),
          forecast_confidence: this.calculateForecastConfidence(matchData)
        }
      };

      // Cache results
      this.forecastCache.set(cacheKey, {
        data: forecast,
        timestamp: Date.now()
      });

      // Emit analytics event
      this.emit('revenue_forecast_generated', {
        match_id,
        projected_annual_revenue: baseProjections.annual_total,
        forecast_confidence: forecast.forecast_metadata.forecast_confidence
      });

      return forecast;

    } catch (error) {
      console.error('❌ Error generating revenue forecast:', error);
      throw error;
    }
  }

  // =====================================================
  // MATCH DATA RETRIEVAL FOR FORECASTING
  // =====================================================
  async getMatchDataForForecasting(match_id) {
    const query = `
      SELECT 
        mo.*,
        u1.email as cpa_email,
        cp.specializations,
        cp.experience_years,
        cp.hourly_rate,
        cp.typical_project_size,
        u2.email as client_email,
        -- Client business data would go here when available
        ep.partnership_probability,
        ep.estimated_revenue_potential,
        COUNT(ei.id) as total_interactions,
        AVG(ei.interaction_quality_score) as avg_interaction_quality
      FROM match_outcomes mo
      LEFT JOIN users u1 ON mo.cpa_id = u1.id
      LEFT JOIN cpa_profiles cp ON u1.id = cp.user_id
      LEFT JOIN users u2 ON mo.client_id = u2.id
      LEFT JOIN engagement_predictions ep ON mo.match_id = ep.match_id
      LEFT JOIN engagement_interactions ei ON mo.match_id = ei.match_id
      WHERE mo.match_id = $1
      GROUP BY mo.id, u1.id, cp.id, u2.id, ep.id;
    `;

    const result = await this.db.query(query, [match_id]);
    return result.rows[0] || {};
  }

  // =====================================================
  // BASE REVENUE PROJECTIONS CALCULATION
  // =====================================================
  async calculateBaseRevenueProjections(matchData, periodMonths) {
    // Extract key financial factors
    const cpaHourlyRate = parseFloat(matchData.hourly_rate) || 200; // Default CAD rate
    const experienceYears = parseInt(matchData.experience_years) || 5;
    const partnershipProbability = parseFloat(matchData.partnership_probability) || 0.7;
    
    // Estimate client business characteristics (simplified for now)
    const estimatedBusinessSize = this.estimateBusinessSize(matchData);
    const estimatedServices = this.estimateRequiredServices(matchData);
    const estimatedComplexity = this.estimateProjectComplexity(matchData);

    // Calculate base service revenues
    const serviceRevenues = {};
    let totalProjectRevenue = 0;
    let totalOngoingRevenue = 0;

    for (const [service, demand] of Object.entries(estimatedServices)) {
      const serviceRates = this.marketData.baseRates[service];
      if (serviceRates && demand > 0) {
        const baseRate = serviceRates.avg;
        const complexityMultiplier = estimatedComplexity;
        const sizeMultiplier = this.marketData.businessSizeMultipliers[estimatedBusinessSize];
        
        const adjustedRate = baseRate * complexityMultiplier * sizeMultiplier;
        const annualVolume = this.estimateAnnualServiceVolume(service, estimatedBusinessSize);
        
        serviceRevenues[service] = {
          rate_per_service: Math.round(adjustedRate),
          annual_volume: annualVolume,
          annual_revenue: Math.round(adjustedRate * annualVolume * demand),
          service_type: this.classifyServiceType(service)
        };

        if (serviceRevenues[service].service_type === 'project') {
          totalProjectRevenue += serviceRevenues[service].annual_revenue;
        } else {
          totalOngoingRevenue += serviceRevenues[service].annual_revenue;
        }
      }
    }

    // Calculate growth projections
    const monthlyGrowthRate = this.calculateMonthlyGrowthRate(matchData);
    const monthlyProjections = this.generateMonthlyProjections(
      totalOngoingRevenue, totalProjectRevenue, monthlyGrowthRate, periodMonths
    );

    // Apply partnership probability
    const probabilityAdjustedRevenue = {
      project_revenue: Math.round(totalProjectRevenue * partnershipProbability),
      ongoing_revenue: Math.round(totalOngoingRevenue * partnershipProbability),
      monthly_projections: monthlyProjections.map(month => ({
        ...month,
        adjusted_revenue: Math.round(month.projected_revenue * partnershipProbability)
      }))
    };

    return {
      raw_projections: {
        annual_project_revenue: totalProjectRevenue,
        annual_ongoing_revenue: totalOngoingRevenue,
        annual_total: totalProjectRevenue + totalOngoingRevenue
      },
      probability_adjusted: {
        annual_project_revenue: probabilityAdjustedRevenue.project_revenue,
        annual_ongoing_revenue: probabilityAdjustedRevenue.ongoing_revenue,
        annual_total: probabilityAdjustedRevenue.project_revenue + probabilityAdjustedRevenue.ongoing_revenue
      },
      service_breakdown: serviceRevenues,
      monthly_projections: probabilityAdjustedRevenue.monthly_projections,
      projection_factors: {
        cpa_hourly_rate: cpaHourlyRate,
        experience_years: experienceYears,
        business_size: estimatedBusinessSize,
        complexity_multiplier: estimatedComplexity,
        partnership_probability: partnershipProbability,
        monthly_growth_rate: monthlyGrowthRate
      }
    };
  }

  // =====================================================
  // MARKET INTELLIGENCE APPLICATION
  // =====================================================
  async applyMarketIntelligence(baseProjections, matchData) {
    // Apply provincial adjustments
    const province = this.extractProvince(matchData);
    const provincialMultiplier = this.marketData.provincialMultipliers[province] || 1.0;

    // Apply seasonal factors
    const currentSeason = this.getCurrentSeason();
    const seasonalMultiplier = this.marketData.seasonalFactors[currentSeason] || 1.0;

    // Apply market trend factors
    let trendMultiplier = 1.0;
    for (const [trend, factor] of Object.entries(this.marketData.marketTrends)) {
      trendMultiplier *= factor;
    }

    // Calculate market-adjusted projections
    const marketMultiplier = provincialMultiplier * seasonalMultiplier * trendMultiplier;
    
    const adjustedProjections = {
      annual_total: Math.round(baseProjections.probability_adjusted.annual_total * marketMultiplier),
      annual_project_revenue: Math.round(baseProjections.probability_adjusted.annual_project_revenue * marketMultiplier),
      annual_ongoing_revenue: Math.round(baseProjections.probability_adjusted.annual_ongoing_revenue * marketMultiplier),
      monthly_projections: baseProjections.monthly_projections.map(month => ({
        ...month,
        market_adjusted_revenue: Math.round(month.adjusted_revenue * marketMultiplier)
      }))
    };

    return {
      market_multiplier: Math.round(marketMultiplier * 10000) / 10000,
      adjustment_factors: {
        provincial_factor: provincialMultiplier,
        seasonal_factor: seasonalMultiplier,
        trend_factor: trendMultiplier,
        province: province,
        season: currentSeason
      },
      adjusted_projections: adjustedProjections,
      market_insights: this.generateMarketInsights(province, currentSeason)
    };
  }

  // =====================================================
  // SCENARIO ANALYSIS
  // =====================================================
  async generateScenarioAnalysis(baseProjections, matchData) {
    const baseRevenue = baseProjections.probability_adjusted.annual_total;
    
    const scenarios = {
      conservative: {
        multiplier: 0.7,
        description: 'Lower engagement, basic services only',
        annual_revenue: Math.round(baseRevenue * 0.7),
        probability: 0.25
      },
      expected: {
        multiplier: 1.0,
        description: 'Standard engagement with projected growth',
        annual_revenue: baseRevenue,
        probability: 0.50
      },
      optimistic: {
        multiplier: 1.4,
        description: 'High engagement, expanded service offerings',
        annual_revenue: Math.round(baseRevenue * 1.4),
        probability: 0.20
      },
      best_case: {
        multiplier: 2.0,
        description: 'Premium partnership with strategic consulting',
        annual_revenue: Math.round(baseRevenue * 2.0),
        probability: 0.05
      }
    };

    // Calculate weighted average
    const weightedAverage = Object.values(scenarios).reduce((sum, scenario) => {
      return sum + (scenario.annual_revenue * scenario.probability);
    }, 0);

    return {
      scenarios: scenarios,
      weighted_average_revenue: Math.round(weightedAverage),
      scenario_range: {
        min: scenarios.conservative.annual_revenue,
        max: scenarios.best_case.annual_revenue,
        spread: scenarios.best_case.annual_revenue - scenarios.conservative.annual_revenue
      },
      recommended_planning_revenue: Math.round(weightedAverage * 0.9) // 90% of weighted average for planning
    };
  }

  // =====================================================
  // CONFIDENCE INTERVALS CALCULATION
  // =====================================================
  async calculateConfidenceIntervals(baseProjections, matchData) {
    const baseRevenue = baseProjections.probability_adjusted.annual_total;
    const dataQuality = this.calculateDataQualityScore(matchData);
    
    // Calculate standard deviation based on data quality and market volatility
    const baseStdDev = baseRevenue * 0.25; // 25% base volatility
    const qualityAdjustment = (1 - dataQuality) * 0.5; // More uncertainty with lower quality data
    const adjustedStdDev = baseStdDev * (1 + qualityAdjustment);

    return {
      confidence_95: {
        lower_bound: Math.round(baseRevenue - (1.96 * adjustedStdDev)),
        upper_bound: Math.round(baseRevenue + (1.96 * adjustedStdDev)),
        confidence_level: 0.95
      },
      confidence_80: {
        lower_bound: Math.round(baseRevenue - (1.28 * adjustedStdDev)),
        upper_bound: Math.round(baseRevenue + (1.28 * adjustedStdDev)),
        confidence_level: 0.80
      },
      confidence_50: {
        lower_bound: Math.round(baseRevenue - (0.67 * adjustedStdDev)),
        upper_bound: Math.round(baseRevenue + (0.67 * adjustedStdDev)),
        confidence_level: 0.50
      },
      standard_deviation: Math.round(adjustedStdDev),
      data_quality_impact: qualityAdjustment
    };
  }

  // =====================================================
  // HELPER FUNCTIONS
  // =====================================================
  
  calculateSeasonalFactors() {
    // Canadian CPA seasonal patterns
    return {
      'Q1': 1.25, // Tax season peak
      'Q2': 0.85, // Post-tax lull
      'Q3': 0.90, // Summer slowdown
      'Q4': 1.15  // Year-end planning
    };
  }

  estimateBusinessSize(matchData) {
    // Simplified business size estimation
    const revenue = parseFloat(matchData.estimated_revenue_potential) || 50000;
    if (revenue < 100000) return 'startup';
    if (revenue < 1000000) return 'small';
    if (revenue < 10000000) return 'medium';
    if (revenue < 100000000) return 'large';
    return 'enterprise';
  }

  estimateRequiredServices(matchData) {
    // Estimate service demand based on business characteristics
    return {
      'tax_preparation': 0.9,
      'bookkeeping': 0.8,
      'financial_statements': 0.6,
      'business_consulting': 0.4,
      'payroll_services': 0.5
    };
  }

  estimateProjectComplexity(matchData) {
    const experienceYears = parseInt(matchData.experience_years) || 5;
    const interactionQuality = parseFloat(matchData.avg_interaction_quality) || 5;
    
    // Higher experience and quality suggest ability to handle more complex projects
    return 0.8 + (experienceYears / 20) + (interactionQuality / 50);
  }

  estimateAnnualServiceVolume(service, businessSize) {
    const volumeMatrix = {
      'tax_preparation': { 'startup': 1, 'small': 2, 'medium': 4, 'large': 8, 'enterprise': 12 },
      'bookkeeping': { 'startup': 12, 'small': 12, 'medium': 12, 'large': 12, 'enterprise': 12 },
      'financial_statements': { 'startup': 1, 'small': 2, 'medium': 4, 'large': 4, 'enterprise': 4 },
      'business_consulting': { 'startup': 2, 'small': 4, 'medium': 8, 'large': 12, 'enterprise': 24 },
      'payroll_services': { 'startup': 12, 'small': 12, 'medium': 12, 'large': 12, 'enterprise': 12 }
    };
    
    return volumeMatrix[service]?.[businessSize] || 1;
  }

  classifyServiceType(service) {
    const projectServices = ['tax_preparation', 'financial_statements', 'audit_assurance'];
    return projectServices.includes(service) ? 'project' : 'ongoing';
  }

  calculateMonthlyGrowthRate(matchData) {
    // Estimate monthly growth based on partnership strength
    const partnershipProbability = parseFloat(matchData.partnership_probability) || 0.7;
    const interactionQuality = parseFloat(matchData.avg_interaction_quality) || 5;
    
    const baseGrowthRate = 0.02; // 2% monthly base
    const qualityBonus = (interactionQuality - 5) / 100; // Quality above 5 adds growth
    const probabilityBonus = (partnershipProbability - 0.5) * 0.02; // High probability adds growth
    
    return Math.max(0, baseGrowthRate + qualityBonus + probabilityBonus);
  }

  generateMonthlyProjections(ongoingRevenue, projectRevenue, growthRate, periodMonths) {
    const projections = [];
    const monthlyOngoing = ongoingRevenue / 12;
    
    for (let month = 1; month <= periodMonths; month++) {
      const growthMultiplier = Math.pow(1 + growthRate, month - 1);
      const monthlyRevenue = monthlyOngoing * growthMultiplier;
      
      // Add project revenue distribution (simplified)
      const projectContribution = month <= 12 ? projectRevenue / 12 : 0;
      
      projections.push({
        month: month,
        ongoing_revenue: Math.round(monthlyRevenue),
        project_revenue: Math.round(projectContribution),
        projected_revenue: Math.round(monthlyRevenue + projectContribution),
        cumulative_revenue: month === 1 ? Math.round(monthlyRevenue + projectContribution) :
          projections[month - 2].cumulative_revenue + Math.round(monthlyRevenue + projectContribution)
      });
    }
    
    return projections;
  }

  extractProvince(matchData) {
    // Extract province from CPA or client location data
    return 'ON'; // Default to Ontario
  }

  getCurrentSeason() {
    const month = new Date().getMonth() + 1;
    if (month <= 3) return 'Q1';
    if (month <= 6) return 'Q2';
    if (month <= 9) return 'Q3';
    return 'Q4';
  }

  generateMarketInsights(province, season) {
    return {
      provincial_market: `${province} market shows strong demand for CPA services`,
      seasonal_trends: `${season} typically sees ${season === 'Q1' ? 'peak' : 'moderate'} activity`,
      recommendations: ['Focus on tax services in Q1', 'Expand consulting in Q4']
    };
  }

  calculateDataQualityScore(matchData) {
    let score = 0;
    if (matchData.hourly_rate) score += 0.2;
    if (matchData.experience_years) score += 0.2;
    if (matchData.specializations) score += 0.2;
    if (matchData.partnership_probability) score += 0.2;
    if (matchData.avg_interaction_quality) score += 0.2;
    return score;
  }

  calculateForecastConfidence(matchData) {
    const dataQuality = this.calculateDataQualityScore(matchData);
    const interactionCount = parseInt(matchData.total_interactions) || 0;
    const partnershipProbability = parseFloat(matchData.partnership_probability) || 0;
    
    let confidence = dataQuality * 0.5;
    confidence += Math.min(0.3, interactionCount / 20 * 0.3);
    confidence += partnershipProbability * 0.2;
    
    return Math.min(1.0, confidence);
  }

  async analyzeHistoricalRevenue(matchData) {
    return { trend: 'stable', growth_rate: 0.02 };
  }

  async generateRevenueBreakdown(projections, matchData) {
    return {
      service_mix: projections.service_breakdown,
      revenue_streams: { project: 0.4, ongoing: 0.6 }
    };
  }

  async assessRevenueRisks(projections, matchData) {
    return {
      overall_risk: 'moderate',
      risk_factors: ['seasonal_variation', 'competition'],
      mitigation_strategies: ['diversify_services', 'strengthen_relationship']
    };
  }

  async generateOptimizationRecommendations(projections, adjustments, risks) {
    return [
      'Focus on high-value services during peak season',
      'Develop ongoing revenue streams for stability',
      'Consider premium pricing for specialized services'
    ];
  }

  enhanceCachedForecast(cached, options) {
    return { ...cached, from_cache: true };
  }
}

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
  RevenueForecaster
};
