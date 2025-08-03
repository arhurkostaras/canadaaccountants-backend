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

