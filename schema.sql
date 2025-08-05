-- CanadaAccountants Database Schema
-- PostgreSQL schema for the complete platform

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (unified for both CPAs and SMEs)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    user_type VARCHAR(10) NOT NULL CHECK (user_type IN ('CPA', 'SME')),
    email_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    profile_completed BOOLEAN DEFAULT FALSE
);

-- CPA Profiles
CREATE TABLE cpa_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    license_number VARCHAR(50) NOT NULL,
    province VARCHAR(2) NOT NULL,
    license_verified BOOLEAN DEFAULT FALSE,
    verification_date TIMESTAMP WITH TIME ZONE,
    
    -- Professional details
    firm_name VARCHAR(200),
    position VARCHAR(100),
    years_experience INTEGER,
    bio TEXT,
    
    -- Location
    city VARCHAR(100),
    postal_code VARCHAR(10),
    
    -- Contact
    phone VARCHAR(20),
    website VARCHAR(255),
    linkedin_url VARCHAR(255),
    
    -- Availability
    current_capacity INTEGER DEFAULT 10, -- max clients
    accepting_clients BOOLEAN DEFAULT TRUE,
    hourly_rate DECIMAL(8,2),
    minimum_engagement DECIMAL(10,2),
    
    -- Professional standing
    professional_standing VARCHAR(20) DEFAULT 'good',
    disciplinary_actions TEXT,
    continuing_education_current BOOLEAN DEFAULT TRUE,
    
    -- Platform specific
    platform_rating DECIMAL(3,2) DEFAULT 5.0,
    total_matches INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,
    guarantee_claims INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CPA Specializations (many-to-many)
CREATE TABLE cpa_specializations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cpa_profile_id UUID REFERENCES cpa_profiles(id) ON DELETE CASCADE,
    specialization VARCHAR(100) NOT NULL,
    experience_years INTEGER,
    certification VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CPA Services Offered
CREATE TABLE cpa_services (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cpa_profile_id UUID REFERENCES cpa_profiles(id) ON DELETE CASCADE,
    service_type VARCHAR(50) NOT NULL,
    description TEXT,
    base_price DECIMAL(10,2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- SME Profiles
CREATE TABLE sme_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Company details
    company_name VARCHAR(200) NOT NULL,
    industry VARCHAR(100) NOT NULL,
    sub_industry VARCHAR(100),
    business_type VARCHAR(50), -- corporation, partnership, sole_proprietorship
    incorporation_year INTEGER,
    
    -- Contact person
    contact_first_name VARCHAR(100) NOT NULL,
    contact_last_name VARCHAR(100) NOT NULL,
    contact_title VARCHAR(100),
    
    -- Company size
    employee_count INTEGER,
    annual_revenue_min DECIMAL(15,2),
    annual_revenue_max DECIMAL(15,2),
    revenue_currency VARCHAR(3) DEFAULT 'CAD',
    
    -- Location
    city VARCHAR(100),
    province VARCHAR(2),
    postal_code VARCHAR(10),
    operates_multiple_provinces BOOLEAN DEFAULT FALSE,
    
    -- Contact details
    phone VARCHAR(20),
    website VARCHAR(255),
    
    -- Accounting needs
    current_accounting_solution VARCHAR(100),
    accounting_software VARCHAR(100),
    complexity_level VARCHAR(20) DEFAULT 'medium',
    urgency_level VARCHAR(20) DEFAULT 'medium',
    
    -- Budget and timeline
    budget_min DECIMAL(10,2),
    budget_max DECIMAL(10,2),
    preferred_engagement_type VARCHAR(20), -- ongoing, project, consultation
    timeline_requirement VARCHAR(50),
    
    -- Platform specific
    platform_rating DECIMAL(3,2) DEFAULT 5.0,
    total_matches INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,
    guarantee_claimed BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- SME Service Needs (many-to-many)
CREATE TABLE sme_service_needs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sme_profile_id UUID REFERENCES sme_profiles(id) ON DELETE CASCADE,
    service_type VARCHAR(50) NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium',
    description TEXT,
    budget DECIMAL(10,2),
    timeline VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Matches table (core matching engine)
CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cpa_profile_id UUID REFERENCES cpa_profiles(id) ON DELETE CASCADE,
    sme_profile_id UUID REFERENCES sme_profiles(id) ON DELETE CASCADE,
    
    -- Match algorithm scores
    overall_score DECIMAL(5,2) NOT NULL,
    industry_score DECIMAL(5,2),
    size_score DECIMAL(5,2),
    services_score DECIMAL(5,2),
    location_score DECIMAL(5,2),
    availability_score DECIMAL(5,2),
    success_score DECIMAL(5,2),
    
    -- Match algorithm details
    algorithm_version VARCHAR(10) DEFAULT 'v1.0',
    match_factors JSONB, -- store detailed matching factors
    
    -- Match status workflow
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'cpa_accepted', 'sme_accepted', 'both_accepted', 'cpa_declined', 'sme_declined', 'expired', 'completed')),
    
    -- Timestamps for workflow
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cpa_responded_at TIMESTAMP WITH TIME ZONE,
    sme_responded_at TIMESTAMP WITH TIME ZONE,
    both_accepted_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days'),
    
    -- Communication
    introduction_sent BOOLEAN DEFAULT FALSE,
    first_meeting_scheduled BOOLEAN DEFAULT FALSE,
    
    -- Revenue tracking
    estimated_value DECIMAL(10,2),
    actual_value DECIMAL(10,2),
    platform_fee DECIMAL(10,2),
    cpa_fee DECIMAL(10,2),
    
    -- Quality tracking
    cpa_satisfaction INTEGER, -- 1-5 rating
    sme_satisfaction INTEGER, -- 1-5 rating
    match_quality_score DECIMAL(3,2),
    
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Match Communications
CREATE TABLE match_communications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
    sender_user_id UUID REFERENCES users(id),
    message_type VARCHAR(20) DEFAULT 'message',
    subject VARCHAR(200),
    content TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Platform transactions (ready for payments)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    match_id UUID REFERENCES matches(id),
    
    -- Transaction details
    transaction_type VARCHAR(30) NOT NULL, -- subscription, commission, refund
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'CAD',
    
    -- Payment provider details
    stripe_payment_intent_id VARCHAR(100),
    payment_method_id VARCHAR(100),
    payment_status VARCHAR(20) DEFAULT 'pending',
    
    -- Platform specific
    description TEXT,
    platform_fee_rate DECIMAL(5,4),
    platform_fee_amount DECIMAL(10,2),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    failed_at TIMESTAMP WITH TIME ZONE,
    refunded_at TIMESTAMP WITH TIME ZONE
);

-- CPA Subscriptions
CREATE TABLE cpa_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cpa_profile_id UUID REFERENCES cpa_profiles(id) ON DELETE CASCADE,
    
    -- Subscription details
    plan_type VARCHAR(20) NOT NULL, -- basic, premium, enterprise
    monthly_price DECIMAL(8,2) NOT NULL,
    billing_cycle VARCHAR(20) DEFAULT 'monthly',
    
    -- Status
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'past_due', 'suspended')),
    
    -- Stripe integration
    stripe_subscription_id VARCHAR(100),
    stripe_customer_id VARCHAR(100),
    
    -- Billing
    current_period_start TIMESTAMP WITH TIME ZONE,
    current_period_end TIMESTAMP WITH TIME ZONE,
    trial_end TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Platform analytics and metrics
CREATE TABLE platform_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    metric_date DATE NOT NULL,
    
    -- User metrics
    total_cpas INTEGER DEFAULT 0,
    active_cpas INTEGER DEFAULT 0,
    total_smes INTEGER DEFAULT 0,
    active_smes INTEGER DEFAULT 0,
    new_registrations_today INTEGER DEFAULT 0,
    
    -- Match metrics
    matches_created_today INTEGER DEFAULT 0,
    matches_accepted_today INTEGER DEFAULT 0,
    matches_completed_today INTEGER DEFAULT 0,
    average_match_score DECIMAL(5,2),
    
    -- Revenue metrics
    revenue_today DECIMAL(10,2) DEFAULT 0,
    subscription_revenue DECIMAL(10,2) DEFAULT 0,
    commission_revenue DECIMAL(10,2) DEFAULT 0,
    
    -- Platform health
    algorithm_success_rate DECIMAL(5,2),
    cpa_utilization_rate DECIMAL(5,2),
    guarantee_claim_rate DECIMAL(5,2),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notification logs
CREATE TABLE notification_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    notification_type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL, -- email, sms, browser, slack
    subject VARCHAR(200),
    content TEXT,
    status VARCHAR(20) DEFAULT 'sent',
    opened_at TIMESTAMP WITH TIME ZONE,
    clicked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_type ON users(user_type);
CREATE INDEX idx_cpa_province ON cpa_profiles(province);
CREATE INDEX idx_cpa_accepting ON cpa_profiles(accepting_clients);
CREATE INDEX idx_sme_industry ON sme_profiles(industry);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_score ON matches(overall_score DESC);
CREATE INDEX idx_matches_created ON matches(created_at DESC);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_platform_metrics_date ON platform_metrics(metric_date DESC);

-- Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_cpa_profiles_updated_at BEFORE UPDATE ON cpa_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sme_profiles_updated_at BEFORE UPDATE ON sme_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_matches_updated_at BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sme_subscriptions_updated_at BEFORE UPDATE ON cpa_subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Sample data for testing
INSERT INTO users (email, password_hash, user_type, email_verified, profile_completed) VALUES
('sarah.chen@example.com', '$2b$10$example_hash_1', 'CPA', TRUE, TRUE),
('michael.thompson@example.com', '$2b$10$example_hash_2', 'CPA', TRUE, TRUE),
('emily.rodriguez@example.com', '$2b$10$example_hash_3', 'CPA', TRUE, TRUE),
('techstart@example.com', '$2b$10$example_hash_4', 'SME', TRUE, TRUE),
('manufacturing@example.com', '$2b$10$example_hash_5', 'SME', TRUE, TRUE);

-- Sample CPA profiles
INSERT INTO cpa_profiles (user_id, first_name, last_name, license_number, province, license_verified, city, years_experience, hourly_rate, current_capacity, accepting_clients) VALUES
((SELECT id FROM users WHERE email = 'sarah.chen@example.com'), 'Sarah', 'Chen', 'ON-12345', 'ON', TRUE, 'Toronto', 8, 150.00, 12, TRUE),
((SELECT id FROM users WHERE email = 'michael.thompson@example.com'), 'Michael', 'Thompson', 'BC-67890', 'BC', TRUE, 'Vancouver', 12, 175.00, 8, TRUE),
((SELECT id FROM users WHERE email = 'emily.rodriguez@example.com'), 'Emily', 'Rodriguez', 'AB-54321', 'AB', TRUE, 'Calgary', 6, 140.00, 15, TRUE);

-- Sample CPA specializations
INSERT INTO cpa_specializations (cpa_profile_id, specialization, experience_years) VALUES
((SELECT id FROM cpa_profiles WHERE license_number = 'ON-12345'), 'Technology', 8),
((SELECT id FROM cpa_profiles WHERE license_number = 'ON-12345'), 'Startups', 5),
((SELECT id FROM cpa_profiles WHERE license_number = 'BC-67890'), 'Manufacturing', 12),
((SELECT id FROM cpa_profiles WHERE license_number = 'BC-67890'), 'SME Advisory', 10),
((SELECT id FROM cpa_profiles WHERE license_number = 'AB-54321'), 'Real Estate', 6),
((SELECT id FROM cpa_profiles WHERE license_number = 'AB-54321'), 'Construction', 4);

-- Sample SME profiles
INSERT INTO sme_profiles (user_id, company_name, industry, contact_first_name, contact_last_name, employee_count, annual_revenue_min, annual_revenue_max, city, province) VALUES
((SELECT id FROM users WHERE email = 'techstart@example.com'), 'TechStart Solutions', 'Technology', 'John', 'Smith', 25, 1000000, 5000000, 'Toronto', 'ON'),
((SELECT id FROM users WHERE email = 'manufacturing@example.com'), 'Maple Manufacturing', 'Manufacturing', 'Jane', 'Wilson', 75, 5000000, 15000000, 'Vancouver', 'BC');

-- Sample service needs
INSERT INTO sme_service_needs (sme_profile_id, service_type, priority, budget) VALUES
((SELECT id FROM sme_profiles WHERE company_name = 'TechStart Solutions'), 'Tax Preparation', 'high', 5000),
((SELECT id FROM sme_profiles WHERE company_name = 'TechStart Solutions'), 'Bookkeeping', 'medium', 3000),
((SELECT id FROM sme_profiles WHERE company_name = 'Maple Manufacturing'), 'Audit Services', 'high', 15000),
((SELECT id FROM sme_profiles WHERE company_name = 'Maple Manufacturing'), 'Financial Advisory', 'medium', 8000);

-- =====================================================
-- PHASE 3B: MACHINE LEARNING SYSTEM TABLES
-- =====================================================

-- TABLE 1: Track success of every CPA-client match
CREATE TABLE match_outcomes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id VARCHAR(255) UNIQUE NOT NULL,
    cpa_id UUID NOT NULL REFERENCES users(id),
    client_id UUID NOT NULL REFERENCES users(id),
    
    -- Partnership Formation Tracking
    partnership_formed BOOLEAN DEFAULT FALSE,
    partnership_start_date DATE,
    partnership_duration_months INTEGER,
    partnership_status VARCHAR(50) DEFAULT 'pending',
    
    -- Satisfaction Scores (1-10 scale)
    client_satisfaction_score INTEGER CHECK (client_satisfaction_score >= 1 AND client_satisfaction_score <= 10),
    cpa_satisfaction_score INTEGER CHECK (cpa_satisfaction_score >= 1 AND cpa_satisfaction_score <= 10),
    
    -- Financial Success Metrics
    revenue_generated DECIMAL(12,2),
    project_value DECIMAL(12,2),
    ongoing_monthly_value DECIMAL(10,2),
    
    -- Communication & Engagement
    initial_contact_made BOOLEAN DEFAULT FALSE,
    proposal_submitted BOOLEAN DEFAULT FALSE,
    contract_signed BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 2: Dynamic AI factor importance weights
CREATE TABLE learning_weights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    factor_name VARCHAR(100) UNIQUE NOT NULL,
    factor_category VARCHAR(50) NOT NULL,
    
    -- Current AI Weights
    current_weight DECIMAL(5,4) DEFAULT 1.0000,
    baseline_weight DECIMAL(5,4) DEFAULT 1.0000,
    
    -- Success Correlation Analytics
    success_correlation DECIMAL(5,4),
    confidence_score DECIMAL(5,4),
    
    -- Learning Statistics
    total_matches_analyzed INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,
    failed_matches INTEGER DEFAULT 0,
    
    -- Update Tracking
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    learning_iterations INTEGER DEFAULT 0,
    accuracy_improvement DECIMAL(5,4) DEFAULT 0.0000
);

-- TABLE 3: Granular success patterns
CREATE TABLE predictive_features (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    feature_name VARCHAR(200) NOT NULL,
    feature_value VARCHAR(500) NOT NULL,
    feature_type VARCHAR(50) NOT NULL,
    
    -- Success Analytics
    success_rate DECIMAL(5,4),
    total_matches INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,
    
    -- Statistical Confidence
    confidence_score DECIMAL(5,4),
    sample_size_adequacy BOOLEAN DEFAULT FALSE,
    
    -- Feature Context
    related_factor VARCHAR(100),
    
    -- Temporal Analysis
    trend_direction VARCHAR(20),
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_analyzed TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 4: Track AI improvements
CREATE TABLE ml_model_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version_number VARCHAR(20) NOT NULL,
    model_type VARCHAR(50) NOT NULL,
    
    -- Performance Metrics
    accuracy_score DECIMAL(5,4),
    precision_score DECIMAL(5,4),
    recall_score DECIMAL(5,4),
    
    -- Comparison with Previous
    improvement_over_previous DECIMAL(5,4),
    baseline_comparison DECIMAL(5,4),
    
    -- Training Data
    training_samples INTEGER,
    validation_samples INTEGER,
    
    -- Deployment
    deployed_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(100) DEFAULT 'system'
);

-- TABLE 5: Live learning results
CREATE TABLE real_time_insights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    insight_type VARCHAR(100) NOT NULL,
    insight_category VARCHAR(50) NOT NULL,
    
    -- Insight Content
    title VARCHAR(200) NOT NULL,
    description TEXT,
    actionable_recommendation TEXT,
    
    -- Relevance & Impact
    confidence_level VARCHAR(20),
    potential_impact VARCHAR(20),
    target_audience VARCHAR(50),
    
    -- Data Supporting Insight
    supporting_data JSONB,
    sample_size INTEGER,
    
    -- Status & Lifecycle
    is_active BOOLEAN DEFAULT TRUE,
    expiry_date TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_validated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX idx_match_outcomes_cpa_id ON match_outcomes(cpa_id);
CREATE INDEX idx_match_outcomes_client_id ON match_outcomes(client_id);
CREATE INDEX idx_match_outcomes_partnership_formed ON match_outcomes(partnership_formed);
CREATE INDEX idx_learning_weights_factor_category ON learning_weights(factor_category);
CREATE INDEX idx_predictive_features_success_rate ON predictive_features(success_rate DESC);
CREATE INDEX idx_real_time_insights_is_active ON real_time_insights(is_active);

-- =====================================================
-- INITIAL ML DATA
-- =====================================================

-- Initialize baseline learning weights for 6-factor matching
INSERT INTO learning_weights (factor_name, factor_category, current_weight, baseline_weight) VALUES
('industry_expertise', 'industry', 1.0000, 1.0000),
('geographic_proximity', 'geographic', 1.0000, 1.0000),
('business_size_match', 'size', 1.0000, 1.0000),
('service_specialization', 'services', 1.0000, 1.0000),
('experience_level', 'experience', 1.0000, 1.0000),
('communication_style', 'communication', 1.0000, 1.0000);

-- Initialize first model version
INSERT INTO ml_model_versions (version_number, model_type, accuracy_score, is_active) VALUES
('1.0.0', 'baseline_matching', 0.9500, TRUE);

-- =====================================================
-- PHASE 3B STEP 2A: ENGAGEMENT SUCCESS PREDICTION TABLES
-- =====================================================

-- TABLE 1: Track every CPA-client interaction
CREATE TABLE engagement_interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id VARCHAR(255) NOT NULL,
    cpa_id UUID NOT NULL REFERENCES users(id),
    client_id UUID NOT NULL REFERENCES users(id),
    
    -- Interaction Details
    interaction_type VARCHAR(50) NOT NULL, -- profile_view, contact_made, response, meeting_scheduled, etc.
    interaction_channel VARCHAR(30), -- platform, email, phone, video_call
    interaction_duration INTEGER, -- seconds for calls/meetings
    interaction_quality_score DECIMAL(3,2), -- 0.00 to 10.00
    
    -- Content Analysis
    message_content TEXT,
    sentiment_score DECIMAL(3,2), -- -1.00 to 1.00
    professionalism_score DECIMAL(3,2), -- 0.00 to 10.00
    
    -- Timing Analysis
    response_time_hours DECIMAL(8,2),
    interaction_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 2: Engagement milestones and conversion funnel
CREATE TABLE engagement_milestones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id VARCHAR(255) NOT NULL,
    cpa_id UUID NOT NULL REFERENCES users(id),
    client_id UUID NOT NULL REFERENCES users(id),
    
    -- Milestone Tracking
    milestone_type VARCHAR(50) NOT NULL, -- first_contact, proposal_sent, meeting_held, contract_discussed, etc.
    milestone_reached_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    milestone_quality_score DECIMAL(3,2), -- How well was this milestone achieved
    
    -- Conversion Funnel Position
    funnel_stage VARCHAR(30) NOT NULL, -- awareness, interest, consideration, intent, decision
    funnel_progression_score DECIMAL(5,4), -- 0.0000 to 1.0000
    
    -- Predictive Factors
    time_to_milestone_hours DECIMAL(10,2),
    milestone_completion_quality VARCHAR(20), -- excellent, good, average, poor
    next_expected_milestone VARCHAR(50),
    predicted_next_milestone_date TIMESTAMP WITH TIME ZONE,
    
    -- Success Indicators
    positive_signals JSONB, -- Array of positive engagement signals
    warning_signals JSONB, -- Array of concerning signals
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 3: Real-time engagement scores and predictions
CREATE TABLE engagement_predictions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id VARCHAR(255) UNIQUE NOT NULL,
    cpa_id UUID NOT NULL REFERENCES users(id),
    client_id UUID NOT NULL REFERENCES users(id),
    
    -- Current Engagement Metrics
    current_engagement_score DECIMAL(5,4), -- 0.0000 to 1.0000
    interaction_frequency_score DECIMAL(5,4),
    response_quality_score DECIMAL(5,4),
    communication_consistency_score DECIMAL(5,4),
    
    -- Predictive Analytics
    partnership_probability DECIMAL(5,4), -- 0.0000 to 1.0000
    conversion_confidence_level VARCHAR(20), -- very_high, high, medium, low, very_low
    predicted_conversion_date TIMESTAMP WITH TIME ZONE,
    estimated_revenue_potential DECIMAL(12,2),
    
    -- Risk Assessment
    dropout_risk_score DECIMAL(5,4), -- 0.0000 to 1.0000
    risk_factors JSONB,
    recommended_actions JSONB,
    
    -- Time-based Predictions
    days_to_conversion_estimate INTEGER,
    optimal_followup_timing TIMESTAMP WITH TIME ZONE,
    
    -- Model Performance
    prediction_model_version VARCHAR(20),
    prediction_confidence DECIMAL(5,4),
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 4: Communication pattern analysis
CREATE TABLE communication_patterns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id VARCHAR(255) NOT NULL,
    
    -- Communication Frequency
    total_interactions INTEGER DEFAULT 0,
    cpa_initiated_interactions INTEGER DEFAULT 0,
    client_initiated_interactions INTEGER DEFAULT 0,
    average_response_time_hours DECIMAL(8,2),
    
    -- Communication Quality
    average_message_length INTEGER,
    professional_language_score DECIMAL(3,2),
    clarity_score DECIMAL(3,2),
    enthusiasm_indicators INTEGER DEFAULT 0,
    
    -- Engagement Patterns
    peak_communication_hours JSONB, -- Array of most active hours
    preferred_communication_channel VARCHAR(30),
    communication_consistency_score DECIMAL(5,4),
    
    -- Success Indicators
    meeting_requests INTEGER DEFAULT 0,
    document_shares INTEGER DEFAULT 0,
    follow_up_actions INTEGER DEFAULT 0,
    
    -- Calculated Metrics
    engagement_momentum_score DECIMAL(5,4), -- Is engagement increasing or decreasing
    communication_compatibility_score DECIMAL(5,4),
    
    -- Temporal Analysis
    analysis_period_start TIMESTAMP WITH TIME ZONE,
    analysis_period_end TIMESTAMP WITH TIME ZONE,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 5: Success prediction models and versions
CREATE TABLE prediction_models (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    model_name VARCHAR(100) NOT NULL,
    model_version VARCHAR(20) NOT NULL,
    model_type VARCHAR(50) NOT NULL, -- engagement_success, revenue_prediction, dropout_risk
    
    -- Model Performance Metrics
    accuracy_score DECIMAL(5,4),
    precision_score DECIMAL(5,4),
    recall_score DECIMAL(5,4),
    f1_score DECIMAL(5,4),
    
    -- Training Data
    training_samples INTEGER,
    validation_samples INTEGER,
    test_accuracy DECIMAL(5,4),
    
    -- Model Configuration
    model_parameters JSONB,
    feature_weights JSONB,
    threshold_settings JSONB,
    
    -- Deployment Status
    is_active BOOLEAN DEFAULT FALSE,
    deployed_at TIMESTAMP WITH TIME ZONE,
    performance_benchmark DECIMAL(5,4),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR ENGAGEMENT PREDICTION PERFORMANCE
-- =====================================================

-- Engagement Interactions Indexes
CREATE INDEX idx_engagement_interactions_match_id ON engagement_interactions(match_id);
CREATE INDEX idx_engagement_interactions_cpa_id ON engagement_interactions(cpa_id);
CREATE INDEX idx_engagement_interactions_client_id ON engagement_interactions(client_id);
CREATE INDEX idx_engagement_interactions_type ON engagement_interactions(interaction_type);
CREATE INDEX idx_engagement_interactions_timestamp ON engagement_interactions(interaction_timestamp);

-- Engagement Milestones Indexes
CREATE INDEX idx_engagement_milestones_match_id ON engagement_milestones(match_id);
CREATE INDEX idx_engagement_milestones_funnel_stage ON engagement_milestones(funnel_stage);
CREATE INDEX idx_engagement_milestones_milestone_type ON engagement_milestones(milestone_type);

-- Engagement Predictions Indexes
CREATE INDEX idx_engagement_predictions_match_id ON engagement_predictions(match_id);
CREATE INDEX idx_engagement_predictions_partnership_probability ON engagement_predictions(partnership_probability DESC);
CREATE INDEX idx_engagement_predictions_dropout_risk ON engagement_predictions(dropout_risk_score DESC);

-- Communication Patterns Indexes
CREATE INDEX idx_communication_patterns_match_id ON communication_patterns(match_id);
CREATE INDEX idx_communication_patterns_engagement_score ON communication_patterns(engagement_momentum_score DESC);

-- Prediction Models Indexes
CREATE INDEX idx_prediction_models_active ON prediction_models(is_active);
CREATE INDEX idx_prediction_models_type ON prediction_models(model_type);

-- =====================================================
-- INITIAL PREDICTION MODEL DATA
-- =====================================================

-- Initialize baseline prediction models
INSERT INTO prediction_models (model_name, model_version, model_type, accuracy_score, is_active) VALUES
('baseline_engagement_predictor', '1.0.0', 'engagement_success', 0.8500, TRUE),
('revenue_forecasting_model', '1.0.0', 'revenue_prediction', 0.8200, TRUE),
('dropout_risk_classifier', '1.0.0', 'dropout_risk', 0.7800, TRUE);


-- =====================================================
-- FRICTION ELIMINATION SYSTEM TABLES
-- Add these tables to the end of your existing schema.sql
-- =====================================================

-- TABLE 1: SME Friction Elimination Requests
CREATE TABLE sme_friction_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id VARCHAR(255) UNIQUE NOT NULL,
    
    -- Core Friction Data
    pain_point VARCHAR(50) NOT NULL, -- time-drain, tax-stress, cpa-search, financial-chaos
    business_type VARCHAR(50) NOT NULL,
    business_size VARCHAR(20) NOT NULL, -- startup, small, medium, large
    
    -- Services and Requirements
    services_needed JSONB, -- Array of required services
    time_being_lost VARCHAR(20), -- minimal, moderate, significant, severe
    urgency_level VARCHAR(20) DEFAULT 'urgent', -- emergency, urgent, soon, flexible
    budget_range VARCHAR(30), -- standard, premium, enterprise
    
    -- Contact Information
    contact_info JSONB NOT NULL, -- name, email, phone, company
    additional_context TEXT,
    
    -- Friction Analysis
    friction_score INTEGER DEFAULT 0, -- 0-100 calculated friction severity
    estimated_time_savings VARCHAR(50), -- projected time recovery
    estimated_cost_savings VARCHAR(50), -- projected cost savings
    
    -- Status Tracking
    status VARCHAR(30) DEFAULT 'pending', -- pending, matched, completed, expired
    matched_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);

-- TABLE 2: CPA Friction Elimination Profiles
CREATE TABLE cpa_friction_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registration_id VARCHAR(255) UNIQUE NOT NULL,
    
    -- Current Friction Points
    marketing_waste_amount VARCHAR(20), -- Annual $ wasted on ineffective marketing
    sales_cycle_length VARCHAR(10), -- Current sales cycle in days
    current_win_rate VARCHAR(10), -- Current win rate percentage
    lead_generation_method VARCHAR(50), -- How they currently get leads
    biggest_challenge VARCHAR(100), -- Primary business challenge
    
    -- Target Client Profile
    target_client_size VARCHAR(30), -- startup, small, medium, large, enterprise
    preferred_industries JSONB, -- Array of preferred industries
    service_specializations JSONB, -- Array of specialized services
    
    -- Contact and Availability
    contact_info JSONB NOT NULL, -- name, email, phone, firm
    availability VARCHAR(30) DEFAULT 'immediately', -- immediately, within_week, within_month
    capacity_level VARCHAR(20) DEFAULT 'medium', -- low, medium, high, unlimited
    
    -- Friction Elimination Metrics
    friction_elimination_score INTEGER DEFAULT 0, -- 0-100 CPA friction level
    projected_savings VARCHAR(50), -- Marketing waste elimination projection
    projected_cycle_improvement VARCHAR(50), -- Sales cycle improvement projection
    projected_win_rate VARCHAR(10), -- Projected new win rate
    
    -- Status and Performance
    status VARCHAR(30) DEFAULT 'active', -- active, inactive, pending_review
    clients_matched INTEGER DEFAULT 0,
    successful_partnerships INTEGER DEFAULT 0,
    avg_client_satisfaction DECIMAL(3,2) DEFAULT 0.00,
    
    -- Onboarding and Training
    onboarding_completed BOOLEAN DEFAULT FALSE,
    onboarding_completed_at TIMESTAMP WITH TIME ZONE,
    training_modules_completed JSONB, -- Array of completed training modules
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 3: Friction-Based CPA Matches
CREATE TABLE friction_matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id VARCHAR(255) UNIQUE NOT NULL,
    
    -- Request and CPA References
    request_id VARCHAR(255) NOT NULL REFERENCES sme_friction_requests(request_id),
    cpa_id VARCHAR(255) NOT NULL,
    cpa_name VARCHAR(200) NOT NULL,
    
    -- Match Quality Metrics
    match_score DECIMAL(5,2) NOT NULL, -- 0.00 to 100.00
    friction_compatibility_score DECIMAL(5,2), -- How well CPA addresses specific friction
    specializations JSONB, -- CPA specializations relevant to request
    
    -- Friction Elimination Specifics
    friction_expertise VARCHAR(50), -- CPA's friction elimination expertise
    success_rate INTEGER, -- CPA's historical success rate
    avg_time_savings VARCHAR(50), -- Average time savings CPA delivers
    avg_cost_savings VARCHAR(50), -- Average cost savings CPA delivers
    
    -- Availability and Location
    location VARCHAR(100),
    availability VARCHAR(30),
    response_time_estimate VARCHAR(30), -- Expected response time
    
    -- Match Status and Outcomes
    status VARCHAR(30) DEFAULT 'presented', -- presented, contacted, meeting_scheduled, partnership_formed, declined
    client_contacted_cpa BOOLEAN DEFAULT FALSE,
    cpa_responded BOOLEAN DEFAULT FALSE,
    meeting_scheduled BOOLEAN DEFAULT FALSE,
    partnership_formed BOOLEAN DEFAULT FALSE,
    
    -- Success Tracking
    actual_time_savings VARCHAR(50), -- Actual time savings achieved
    actual_cost_savings VARCHAR(50), -- Actual cost savings achieved
    client_satisfaction_score INTEGER, -- 1-10 rating
    partnership_duration_months INTEGER,
    
    -- Communication Log
    first_contact_at TIMESTAMP WITH TIME ZONE,
    last_interaction_at TIMESTAMP WITH TIME ZONE,
    total_interactions INTEGER DEFAULT 0,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 4: Friction Elimination Analytics and Metrics
CREATE TABLE friction_analytics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    metric_date DATE NOT NULL,
    
    -- Daily Request Metrics
    total_requests_today INTEGER DEFAULT 0,
    total_cpa_registrations_today INTEGER DEFAULT 0,
    total_matches_generated_today INTEGER DEFAULT 0,
    total_partnerships_formed_today INTEGER DEFAULT 0,
    
    -- Pain Point Distribution
    time_drain_requests INTEGER DEFAULT 0,
    tax_stress_requests INTEGER DEFAULT 0,
    cpa_search_requests INTEGER DEFAULT 0,
    financial_chaos_requests INTEGER DEFAULT 0,
    
    -- Urgency Distribution
    emergency_requests INTEGER DEFAULT 0,
    urgent_requests INTEGER DEFAULT 0,
    soon_requests INTEGER DEFAULT 0,
    flexible_requests INTEGER DEFAULT 0,
    
    -- Business Size Distribution
    startup_requests INTEGER DEFAULT 0,
    small_business_requests INTEGER DEFAULT 0,
    medium_business_requests INTEGER DEFAULT 0,
    large_business_requests INTEGER DEFAULT 0,
    
    -- Success Metrics
    avg_match_score DECIMAL(5,2) DEFAULT 0.00,
    avg_friction_score DECIMAL(5,2) DEFAULT 0.00,
    partnership_conversion_rate DECIMAL(5,2) DEFAULT 0.00,
    
    -- Time and Cost Savings Impact
    total_time_saved_hours INTEGER DEFAULT 0,
    total_cost_savings_amount DECIMAL(12,2) DEFAULT 0.00,
    avg_response_time_hours DECIMAL(5,2) DEFAULT 0.00,
    
    -- CPA Performance Metrics
    active_cpas_today INTEGER DEFAULT 0,
    avg_cpa_utilization DECIMAL(5,2) DEFAULT 0.00,
    top_performing_cpa_id VARCHAR(255),
    
    -- System Performance
    avg_processing_time_seconds DECIMAL(5,2) DEFAULT 0.00,
    system_uptime_percentage DECIMAL(5,2) DEFAULT 100.00,
    api_calls_today INTEGER DEFAULT 0,
    
    -- Revenue Impact (Future)
    estimated_revenue_impact DECIMAL(12,2) DEFAULT 0.00,
    platform_fee_collected DECIMAL(10,2) DEFAULT 0.00,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- TABLE 5: Friction Elimination Success Stories
CREATE TABLE friction_success_stories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Reference Data
    match_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    cpa_id VARCHAR(255) NOT NULL,
    
    -- Success Story Details
    client_industry VARCHAR(100),
    business_size VARCHAR(20),
    original_pain_point VARCHAR(50),
    
    -- Quantified Results
    time_saved_hours_monthly INTEGER,
    cost_savings_annual DECIMAL(10,2),
    efficiency_improvement_percentage INTEGER,
    stress_reduction_score INTEGER, -- 1-10
    
    -- Success Timeline
    partnership_start_date DATE,
    first_results_date DATE,
    full_implementation_date DATE,
    days_to_first_results INTEGER,
    
    -- Client Testimonial
    client_testimonial TEXT,
    client_satisfaction_rating INTEGER, -- 1-10
    would_recommend BOOLEAN DEFAULT TRUE,
    
    -- CPA Perspective
    cpa_satisfaction_rating INTEGER, -- 1-10
    cpa_notes TEXT,
    services_provided JSONB, -- Array of services delivered
    
    -- Success Story Status
    is_featured BOOLEAN DEFAULT FALSE,
    is_public BOOLEAN DEFAULT FALSE,
    client_approved_sharing BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    featured_at TIMESTAMP WITH TIME ZONE
);

-- =====================================================
-- INDEXES FOR FRICTION ELIMINATION PERFORMANCE
-- =====================================================

-- SME Friction Requests Indexes
CREATE INDEX idx_sme_friction_requests_pain_point ON sme_friction_requests(pain_point);
CREATE INDEX idx_sme_friction_requests_urgency ON sme_friction_requests(urgency_level);
CREATE INDEX idx_sme_friction_requests_business_size ON sme_friction_requests(business_size);
CREATE INDEX idx_sme_friction_requests_status ON sme_friction_requests(status);
CREATE INDEX idx_sme_friction_requests_friction_score ON sme_friction_requests(friction_score DESC);
CREATE INDEX idx_sme_friction_requests_created_at ON sme_friction_requests(created_at DESC);

-- CPA Friction Profiles Indexes
CREATE INDEX idx_cpa_friction_profiles_status ON cpa_friction_profiles(status);
CREATE INDEX idx_cpa_friction_profiles_availability ON cpa_friction_profiles(availability);
CREATE INDEX idx_cpa_friction_profiles_target_size ON cpa_friction_profiles(target_client_size);
CREATE INDEX idx_cpa_friction_profiles_score ON cpa_friction_profiles(friction_elimination_score DESC);
CREATE INDEX idx_cpa_friction_profiles_success ON cpa_friction_profiles(successful_partnerships DESC);

-- Friction Matches Indexes
CREATE INDEX idx_friction_matches_request_id ON friction_matches(request_id);
CREATE INDEX idx_friction_matches_cpa_id ON friction_matches(cpa_id);
CREATE INDEX idx_friction_matches_match_score ON friction_matches(match_score DESC);
CREATE INDEX idx_friction_matches_status ON friction_matches(status);
CREATE INDEX idx_friction_matches_partnership_formed ON friction_matches(partnership_formed);
CREATE INDEX idx_friction_matches_created_at ON friction_matches(created_at DESC);

-- Friction Analytics Indexes
CREATE INDEX idx_friction_analytics_date ON friction_analytics(metric_date DESC);
CREATE INDEX idx_friction_analytics_requests ON friction_analytics(total_requests_today DESC);
CREATE INDEX idx_friction_analytics_partnerships ON friction_analytics(total_partnerships_formed_today DESC);

-- Friction Success Stories Indexes  
CREATE INDEX idx_friction_success_stories_match_id ON friction_success_stories(match_id);
CREATE INDEX idx_friction_success_stories_featured ON friction_success_stories(is_featured);
CREATE INDEX idx_friction_success_stories_public ON friction_success_stories(is_public);
CREATE INDEX idx_friction_success_stories_pain_point ON friction_success_stories(original_pain_point);

-- =====================================================
-- TRIGGERS FOR UPDATED_AT TIMESTAMPS
-- =====================================================

-- SME Friction Requests trigger
CREATE TRIGGER update_sme_friction_requests_updated_at 
    BEFORE UPDATE ON sme_friction_requests 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- CPA Friction Profiles trigger
CREATE TRIGGER update_cpa_friction_profiles_updated_at 
    BEFORE UPDATE ON cpa_friction_profiles 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Friction Matches trigger  
CREATE TRIGGER update_friction_matches_updated_at 
    BEFORE UPDATE ON friction_matches 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Friction Success Stories trigger
CREATE TRIGGER update_friction_success_stories_updated_at 
    BEFORE UPDATE ON friction_success_stories 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SAMPLE FRICTION ELIMINATION DATA
-- =====================================================

-- Sample SME Friction Request
INSERT INTO sme_friction_requests (
    request_id, pain_point, business_type, business_size, services_needed,
    time_being_lost, urgency_level, budget_range, contact_info, friction_score
) VALUES (
    'req_sample_001',
    'time-drain',
    'technology_startup',
    'small',
    '["bookkeeping", "tax_planning", "financial_consulting"]',
    'significant',
    'urgent',
    'standard',
    '{"name": "John Smith", "email": "john@techstartup.com", "phone": "416-555-0123", "company": "TechStart Solutions"}',
    75
);

-- Sample CPA Friction Profile
INSERT INTO cpa_friction_profiles (
    registration_id, marketing_waste_amount, sales_cycle_length, current_win_rate,
    lead_generation_method, biggest_challenge, target_client_size, contact_info,
    friction_elimination_score, status
) VALUES (
    'cpa_sample_001',
    '35000',
    '420',
    '30',
    'cold_calling',
    'lead_qualification',
    'small_medium',
    '{"name": "Sarah Johnson CPA", "email": "sarah@johnsoncpa.com", "phone": "416-555-0156", "firm": "Johnson & Associates CPA"}',
    82,
    'active'
);

-- Sample Friction Match
INSERT INTO friction_matches (
    match_id, request_id, cpa_id, cpa_name, match_score,
    friction_compatibility_score, specializations, friction_expertise,
    success_rate, avg_time_savings, avg_cost_savings, location, availability
) VALUES (
    'match_sample_001',
    'req_sample_001',
    'cpa_sample_001',
    'Sarah Johnson CPA',
    92.50,
    88.75,
    '["Small Business Tax", "Startup Consulting", "Financial Planning"]',
    'time-drain',
    94,
    '25 hours/month',
    '$4,200/year',
    'Toronto, ON',
    'immediate'
);

-- Sample Success Story
INSERT INTO friction_success_stories (
    match_id, request_id, cpa_id, client_industry, business_size,
    original_pain_point, time_saved_hours_monthly, cost_savings_annual,
    efficiency_improvement_percentage, stress_reduction_score,
    partnership_start_date, days_to_first_results, client_testimonial,
    client_satisfaction_rating, cpa_satisfaction_rating, is_featured
) VALUES (
    'match_sample_001',
    'req_sample_001', 
    'cpa_sample_001',
    'Technology',
    'small',
    'time-drain',
    28,
    4650.00,
    85,
    9,
    '2024-11-01',
    3,
    'Sarah eliminated our financial chaos in just 3 days. We saved 28 hours per month and $4,650 annually. Best business decision ever!',
    10,
    9,
    TRUE
);

-- =====================================================
-- FRICTION ELIMINATION SYSTEM VIEWS
-- =====================================================

-- View: Active Friction Requests Summary
CREATE VIEW active_friction_requests_summary AS
SELECT 
    pain_point,
    COUNT(*) as request_count,
    AVG(friction_score) as avg_friction_score,
    COUNT(CASE WHEN urgency_level = 'emergency' THEN 1 END) as emergency_count,
    COUNT(CASE WHEN status = 'matched' THEN 1 END) as matched_count
FROM sme_friction_requests 
WHERE status IN ('pending', 'matched')
    AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY pain_point
ORDER BY request_count DESC;

-- View: CPA Friction Performance
CREATE VIEW cpa_friction_performance AS
SELECT 
    cp.registration_id,
    cp.contact_info->>'name' as cpa_name,
    cp.friction_elimination_score,
    cp.clients_matched,
    cp.successful_partnerships,
    cp.avg_client_satisfaction,
    CASE 
        WHEN cp.clients_matched > 0 THEN 
            ROUND((cp.successful_partnerships::DECIMAL / cp.clients_matched * 100), 2)
        ELSE 0 
    END as conversion_rate,
    COUNT(fm.id) as total_matches,
    AVG(fm.match_score) as avg_match_score
FROM cpa_friction_profiles cp
LEFT JOIN friction_matches fm ON cp.registration_id = fm.cpa_id
WHERE cp.status = 'active'
GROUP BY cp.id, cp.registration_id, cp.contact_info, cp.friction_elimination_score,
         cp.clients_matched, cp.successful_partnerships, cp.avg_client_satisfaction
ORDER BY conversion_rate DESC, avg_match_score DESC;

-- View: Daily Friction Elimination Impact
CREATE VIEW daily_friction_impact AS
SELECT 
    fa.metric_date,
    fa.total_requests_today,
    fa.total_partnerships_formed_today,
    fa.total_time_saved_hours,
    fa.total_cost_savings_amount,
    CASE 
        WHEN fa.total_requests_today > 0 THEN 
            ROUND((fa.total_partnerships_formed_today::DECIMAL / fa.total_requests_today * 100), 2)
        ELSE 0 
    END as daily_conversion_rate,
    fa.avg_friction_score,
    fa.avg_match_score
FROM friction_analytics fa
WHERE fa.metric_date >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY fa.metric_date DESC;

-- =====================================================
-- FRICTION ELIMINATION FUNCTIONS
-- =====================================================

-- Function: Calculate Friction Elimination ROI
CREATE OR REPLACE FUNCTION calculate_friction_roi(
    time_saved_hours INTEGER,
    cost_savings_annual DECIMAL,
    hourly_rate DECIMAL DEFAULT 75.00
) RETURNS JSON AS $$
DECLARE
    time_value DECIMAL;
    total_annual_value DECIMAL;
    monthly_value DECIMAL;
    roi_data JSON;
BEGIN
    -- Calculate time value
    time_value := time_saved_hours * hourly_rate * 12; -- Monthly hours * rate * 12 months
    
    -- Calculate total annual value
    total_annual_value := time_value + cost_savings_annual;
    
    -- Calculate monthly value
    monthly_value := total_annual_value / 12;
    
    -- Build return JSON
    roi_data := json_build_object(
        'time_saved_hours_monthly', time_saved_hours,
        'time_value_annual', time_value,
        'cost_savings_annual', cost_savings_annual,
        'total_annual_value', total_annual_value,
        'monthly_value', monthly_value,
        'hourly_rate_used', hourly_rate
    );
    
    RETURN roi_data;
END;
$$ LANGUAGE plpgsql;

-- Function: Update Friction Analytics
CREATE OR REPLACE FUNCTION update_daily_friction_analytics() RETURNS VOID AS $$
DECLARE
    today_date DATE := CURRENT_DATE;
BEGIN
    -- Insert or update today's friction analytics
    INSERT INTO friction_analytics (
        metric_date,
        total_requests_today,
        total_cpa_registrations_today,
        total_matches_generated_today,
        total_partnerships_formed_today,
        time_drain_requests,
        tax_stress_requests,
        cpa_search_requests,
        financial_chaos_requests,
        emergency_requests,
        urgent_requests,
        avg_match_score,
        avg_friction_score
    )
    SELECT 
        today_date,
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date),
        (SELECT COUNT(*) FROM cpa_friction_profiles WHERE DATE(created_at) = today_date),
        (SELECT COUNT(*) FROM friction_matches WHERE DATE(created_at) = today_date),
        (SELECT COUNT(*) FROM friction_matches WHERE DATE(created_at) = today_date AND partnership_formed = TRUE),
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date AND pain_point = 'time-drain'),
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date AND pain_point = 'tax-stress'),
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date AND pain_point = 'cpa-search'),
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date AND pain_point = 'financial-chaos'),
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date AND urgency_level = 'emergency'),
        (SELECT COUNT(*) FROM sme_friction_requests WHERE DATE(created_at) = today_date AND urgency_level = 'urgent'),
        (SELECT COALESCE(AVG(match_score), 0) FROM friction_matches WHERE DATE(created_at) = today_date),
        (SELECT COALESCE(AVG(friction_score), 0) FROM sme_friction_requests WHERE DATE(created_at) = today_date)
    ON CONFLICT (metric_date) DO UPDATE SET
        total_requests_today = EXCLUDED.total_requests_today,
        total_cpa_registrations_today = EXCLUDED.total_cpa_registrations_today,
        total_matches_generated_today = EXCLUDED.total_matches_generated_today,
        total_partnerships_formed_today = EXCLUDED.total_partnerships_formed_today,
        time_drain_requests = EXCLUDED.time_drain_requests,
        tax_stress_requests = EXCLUDED.tax_stress_requests,
        cpa_search_requests = EXCLUDED.cpa_search_requests,
        financial_chaos_requests = EXCLUDED.financial_chaos_requests,
        emergency_requests = EXCLUDED.emergency_requests,
        urgent_requests = EXCLUDED.urgent_requests,
        avg_match_score = EXCLUDED.avg_match_score,
        avg_friction_score = EXCLUDED.avg_friction_score,
        calculated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

-- Add this comment to confirm friction elimination schema is complete
/* 
FRICTION ELIMINATION SYSTEM SCHEMA COMPLETE!

This schema adds comprehensive friction elimination capabilities to your existing CanadaAccountants platform:

✅ SME Friction Requests - Track all friction elimination requests
✅ CPA Friction Profiles - Manage CPA friction elimination capabilities  
✅ Friction Matches - Store and track friction-based matches
✅ Friction Analytics - Comprehensive metrics and reporting
✅ Success Stories - Track and showcase friction elimination successes
✅ Performance Views - Real-time friction elimination insights
✅ ROI Functions - Calculate friction elimination value
✅ Sample Data - Ready-to-test example records

Your friction elimination system is now fully integrated with your existing ML-powered backend!
*/
