-- CanadaAccountants Database Schema
-- PostgreSQL schema for the complete platform
-- Reconciled to match live database (SERIAL IDs, verification_status, created_date)

-- Users table (unified for both CPAs and SMEs)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    user_type VARCHAR(10) NOT NULL CHECK (user_type IN ('CPA', 'SME', 'admin')),
    email_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    profile_completed BOOLEAN DEFAULT FALSE,
    -- Password reset
    reset_token_hash VARCHAR(255),
    reset_token_expires TIMESTAMP WITH TIME ZONE
);

-- CPA Profiles
CREATE TABLE cpa_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    cpa_id VARCHAR(255) UNIQUE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(50),
    province VARCHAR(100),

    -- Professional details
    firm_name VARCHAR(200),
    firm_size VARCHAR(50),
    years_experience INTEGER,

    -- Location
    city VARCHAR(255),

    -- Rate
    hourly_rate_min DECIMAL(10,2),

    -- Specializations & services (JSON arrays)
    specializations JSONB,
    industries_served JSONB,

    -- Verification
    verification_status VARCHAR(50) DEFAULT 'unverified',
    profile_status VARCHAR(50) DEFAULT 'pending',
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_date TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- SME Profiles
CREATE TABLE sme_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,

    -- Company details
    company_name VARCHAR(200) NOT NULL,
    industry VARCHAR(100) NOT NULL,
    sub_industry VARCHAR(100),
    business_type VARCHAR(50),
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
    preferred_engagement_type VARCHAR(20),
    timeline_requirement VARCHAR(50),

    -- Platform specific
    platform_rating DECIMAL(3,2) DEFAULT 5.0,
    total_matches INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,
    guarantee_claimed BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Matches table (core matching engine)
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    cpa_profile_id INTEGER REFERENCES cpa_profiles(id) ON DELETE CASCADE,
    sme_profile_id INTEGER REFERENCES sme_profiles(id) ON DELETE CASCADE,

    -- Match algorithm scores
    overall_score DECIMAL(5,2) NOT NULL,
    industry_score DECIMAL(5,2),
    size_score DECIMAL(5,2),
    services_score DECIMAL(5,2),
    location_score DECIMAL(5,2),
    availability_score DECIMAL(5,2),
    success_score DECIMAL(5,2),

    algorithm_version VARCHAR(10) DEFAULT 'v1.0',
    match_factors JSONB,

    status VARCHAR(20) DEFAULT 'pending',

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    cpa_responded_at TIMESTAMP WITH TIME ZONE,
    sme_responded_at TIMESTAMP WITH TIME ZONE,
    both_accepted_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days'),

    introduction_sent BOOLEAN DEFAULT FALSE,
    first_meeting_scheduled BOOLEAN DEFAULT FALSE,

    estimated_value DECIMAL(10,2),
    actual_value DECIMAL(10,2),
    platform_fee DECIMAL(10,2),
    cpa_fee DECIMAL(10,2),

    cpa_satisfaction INTEGER,
    sme_satisfaction INTEGER,
    match_quality_score DECIMAL(3,2),

    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Platform transactions
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    match_id INTEGER REFERENCES matches(id),

    transaction_type VARCHAR(30) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'CAD',

    stripe_payment_intent_id VARCHAR(100),
    payment_method_id VARCHAR(100),
    payment_status VARCHAR(20) DEFAULT 'pending',

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
    id SERIAL PRIMARY KEY,
    cpa_profile_id INTEGER REFERENCES cpa_profiles(id) ON DELETE CASCADE,

    plan_type VARCHAR(20) NOT NULL,
    monthly_price DECIMAL(8,2) NOT NULL,
    billing_cycle VARCHAR(20) DEFAULT 'monthly',

    status VARCHAR(20) DEFAULT 'active',

    stripe_subscription_id VARCHAR(100),
    stripe_customer_id VARCHAR(100),

    current_period_start TIMESTAMP WITH TIME ZONE,
    current_period_end TIMESTAMP WITH TIME ZONE,
    trial_end TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Platform analytics
CREATE TABLE platform_metrics (
    id SERIAL PRIMARY KEY,
    metric_date DATE NOT NULL,

    total_cpas INTEGER DEFAULT 0,
    active_cpas INTEGER DEFAULT 0,
    total_smes INTEGER DEFAULT 0,
    active_smes INTEGER DEFAULT 0,
    new_registrations_today INTEGER DEFAULT 0,

    matches_created_today INTEGER DEFAULT 0,
    matches_accepted_today INTEGER DEFAULT 0,
    matches_completed_today INTEGER DEFAULT 0,
    average_match_score DECIMAL(5,2),

    revenue_today DECIMAL(10,2) DEFAULT 0,
    subscription_revenue DECIMAL(10,2) DEFAULT 0,
    commission_revenue DECIMAL(10,2) DEFAULT 0,

    algorithm_success_rate DECIMAL(5,2),
    cpa_utilization_rate DECIMAL(5,2),
    guarantee_claim_rate DECIMAL(5,2),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notification logs
CREATE TABLE notification_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    notification_type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    subject VARCHAR(200),
    content TEXT,
    status VARCHAR(20) DEFAULT 'sent',
    opened_at TIMESTAMP WITH TIME ZONE,
    clicked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- ML SYSTEM TABLES
-- =====================================================

CREATE TABLE match_outcomes (
    id SERIAL PRIMARY KEY,
    match_id VARCHAR(255) UNIQUE NOT NULL,
    cpa_id INTEGER NOT NULL REFERENCES users(id),
    client_id INTEGER NOT NULL REFERENCES users(id),

    partnership_formed BOOLEAN DEFAULT FALSE,
    partnership_start_date DATE,
    partnership_duration_months INTEGER,
    partnership_status VARCHAR(50) DEFAULT 'pending',

    client_satisfaction_score INTEGER CHECK (client_satisfaction_score >= 1 AND client_satisfaction_score <= 10),
    cpa_satisfaction_score INTEGER CHECK (cpa_satisfaction_score >= 1 AND cpa_satisfaction_score <= 10),

    revenue_generated DECIMAL(12,2),
    project_value DECIMAL(12,2),
    ongoing_monthly_value DECIMAL(10,2),

    initial_contact_made BOOLEAN DEFAULT FALSE,
    proposal_submitted BOOLEAN DEFAULT FALSE,
    contract_signed BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE learning_weights (
    id SERIAL PRIMARY KEY,
    factor_name VARCHAR(100) UNIQUE NOT NULL,
    factor_category VARCHAR(50) NOT NULL,

    current_weight DECIMAL(5,4) DEFAULT 1.0000,
    baseline_weight DECIMAL(5,4) DEFAULT 1.0000,

    success_correlation DECIMAL(5,4),
    confidence_score DECIMAL(5,4),

    total_matches_analyzed INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,
    failed_matches INTEGER DEFAULT 0,

    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    learning_iterations INTEGER DEFAULT 0,
    accuracy_improvement DECIMAL(5,4) DEFAULT 0.0000
);

CREATE TABLE predictive_features (
    id SERIAL PRIMARY KEY,
    feature_name VARCHAR(200) NOT NULL,
    feature_value VARCHAR(500) NOT NULL,
    feature_type VARCHAR(50) NOT NULL,

    success_rate DECIMAL(5,4),
    total_matches INTEGER DEFAULT 0,
    successful_matches INTEGER DEFAULT 0,

    confidence_score DECIMAL(5,4),
    sample_size_adequacy BOOLEAN DEFAULT FALSE,

    related_factor VARCHAR(100),
    trend_direction VARCHAR(20),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_analyzed TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE ml_model_versions (
    id SERIAL PRIMARY KEY,
    version_number VARCHAR(20) NOT NULL,
    model_type VARCHAR(50) NOT NULL,

    accuracy_score DECIMAL(5,4),
    precision_score DECIMAL(5,4),
    recall_score DECIMAL(5,4),

    improvement_over_previous DECIMAL(5,4),
    baseline_comparison DECIMAL(5,4),

    training_samples INTEGER,
    validation_samples INTEGER,

    deployed_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(100) DEFAULT 'system'
);

-- =====================================================
-- FRICTION ELIMINATION SYSTEM TABLES
-- =====================================================

CREATE TABLE sme_friction_requests (
    id SERIAL PRIMARY KEY,
    request_id VARCHAR(255) UNIQUE NOT NULL,

    pain_point VARCHAR(50) NOT NULL,
    business_type VARCHAR(50) NOT NULL,
    business_size VARCHAR(20) NOT NULL,

    services_needed JSONB,
    time_being_lost VARCHAR(20),
    urgency_level VARCHAR(20) DEFAULT 'urgent',
    budget_range VARCHAR(30),

    contact_info JSONB NOT NULL,
    additional_context TEXT,

    friction_score INTEGER DEFAULT 0,
    estimated_time_savings VARCHAR(50),
    estimated_cost_savings VARCHAR(50),

    matched_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE cpa_friction_profiles (
    id SERIAL PRIMARY KEY,
    registration_id VARCHAR(255) UNIQUE NOT NULL,

    marketing_waste_amount VARCHAR(20),
    sales_cycle_length VARCHAR(10),
    current_win_rate VARCHAR(10),
    lead_generation_method VARCHAR(50),
    biggest_challenge VARCHAR(100),

    target_client_size VARCHAR(30),
    specializations JSONB,

    contact_info JSONB NOT NULL,
    availability VARCHAR(30) DEFAULT 'immediately',

    friction_elimination_score INTEGER DEFAULT 0,

    status VARCHAR(30) DEFAULT 'active',
    clients_matched INTEGER DEFAULT 0,
    successful_partnerships INTEGER DEFAULT 0,
    avg_client_satisfaction DECIMAL(3,2) DEFAULT 0.00,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE friction_matches (
    match_id SERIAL PRIMARY KEY,

    request_id VARCHAR(255) NOT NULL,
    cpa_id VARCHAR(255) NOT NULL,
    cpa_name VARCHAR(200) NOT NULL,

    match_score DECIMAL(5,2) NOT NULL,
    specializations JSONB,

    friction_expertise VARCHAR(50),
    success_rate INTEGER,
    avg_time_savings VARCHAR(50),
    avg_cost_savings VARCHAR(50),

    location VARCHAR(100),
    availability VARCHAR(30),

    status VARCHAR(30) DEFAULT 'presented',
    client_contacted_cpa BOOLEAN DEFAULT FALSE,
    cpa_responded BOOLEAN DEFAULT FALSE,
    meeting_scheduled BOOLEAN DEFAULT FALSE,
    partnership_formed BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE friction_analytics (
    id SERIAL PRIMARY KEY,
    metric_date DATE NOT NULL UNIQUE,

    total_requests_today INTEGER DEFAULT 0,
    total_cpa_registrations_today INTEGER DEFAULT 0,
    total_matches_generated_today INTEGER DEFAULT 0,
    total_partnerships_formed_today INTEGER DEFAULT 0,

    time_drain_requests INTEGER DEFAULT 0,
    tax_stress_requests INTEGER DEFAULT 0,
    cpa_search_requests INTEGER DEFAULT 0,
    financial_chaos_requests INTEGER DEFAULT 0,

    emergency_requests INTEGER DEFAULT 0,
    urgent_requests INTEGER DEFAULT 0,

    avg_match_score DECIMAL(5,2) DEFAULT 0.00,
    avg_friction_score DECIMAL(5,2) DEFAULT 0.00,

    total_time_saved_hours INTEGER DEFAULT 0,
    total_cost_savings_amount DECIMAL(12,2) DEFAULT 0.00,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE friction_success_stories (
    id SERIAL PRIMARY KEY,

    match_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    cpa_id VARCHAR(255) NOT NULL,

    client_industry VARCHAR(100),
    business_size VARCHAR(20),
    original_pain_point VARCHAR(50),

    time_saved_hours_monthly INTEGER,
    cost_savings_annual DECIMAL(10,2),
    efficiency_improvement_percentage INTEGER,
    stress_reduction_score INTEGER,

    partnership_start_date DATE,
    days_to_first_results INTEGER,

    client_testimonial TEXT,
    client_satisfaction_rating INTEGER,
    would_recommend BOOLEAN DEFAULT TRUE,

    cpa_satisfaction_rating INTEGER,

    is_featured BOOLEAN DEFAULT FALSE,
    is_public BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_type ON users(user_type);
CREATE INDEX idx_cpa_profiles_province ON cpa_profiles(province);
CREATE INDEX idx_cpa_profiles_email ON cpa_profiles(email);
CREATE INDEX idx_cpa_profiles_verification ON cpa_profiles(verification_status);
CREATE INDEX idx_cpa_profiles_active ON cpa_profiles(is_active);
CREATE INDEX idx_sme_industry ON sme_profiles(industry);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_score ON matches(overall_score DESC);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_platform_metrics_date ON platform_metrics(metric_date DESC);

CREATE INDEX idx_sme_friction_requests_pain_point ON sme_friction_requests(pain_point);
CREATE INDEX idx_sme_friction_requests_urgency ON sme_friction_requests(urgency_level);
CREATE INDEX idx_sme_friction_requests_created_at ON sme_friction_requests(created_at DESC);

CREATE INDEX idx_friction_matches_request_id ON friction_matches(request_id);
CREATE INDEX idx_friction_matches_cpa_id ON friction_matches(cpa_id);
CREATE INDEX idx_friction_matches_score ON friction_matches(match_score DESC);
CREATE INDEX idx_friction_matches_status ON friction_matches(status);

CREATE INDEX idx_friction_analytics_date ON friction_analytics(metric_date DESC);

-- =====================================================
-- TRIGGERS
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sme_profiles_updated_at BEFORE UPDATE ON sme_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_matches_updated_at BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sme_friction_requests_updated_at BEFORE UPDATE ON sme_friction_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_cpa_friction_profiles_updated_at BEFORE UPDATE ON cpa_friction_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_friction_matches_updated_at BEFORE UPDATE ON friction_matches FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- INITIAL ML DATA
-- =====================================================

INSERT INTO learning_weights (factor_name, factor_category, current_weight, baseline_weight) VALUES
('industry_expertise', 'industry', 1.0000, 1.0000),
('geographic_proximity', 'geographic', 1.0000, 1.0000),
('business_size_match', 'size', 1.0000, 1.0000),
('service_specialization', 'services', 1.0000, 1.0000),
('experience_level', 'experience', 1.0000, 1.0000),
('communication_style', 'communication', 1.0000, 1.0000);

INSERT INTO ml_model_versions (version_number, model_type, accuracy_score, is_active) VALUES
('1.0.0', 'baseline_matching', 0.9500, TRUE);
