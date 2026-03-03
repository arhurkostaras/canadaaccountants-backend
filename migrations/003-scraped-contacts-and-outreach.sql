-- Migration 003: Scraped contacts and outreach system
-- Creates tables for CPA/SME scraping and email outreach campaigns

-- Scraped CPA contacts from provincial directories
CREATE TABLE IF NOT EXISTS scraped_cpas (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL,            -- 'cpabc', 'cpaquebec', 'cpaontario', 'cpaalberta', 'cpamb', 'cpask'
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    full_name VARCHAR(500),
    designation VARCHAR(100),               -- 'CPA', 'CPA, CA', 'CPA, CMA', etc.
    province VARCHAR(50) NOT NULL,
    city VARCHAR(255),
    firm_name VARCHAR(500),
    phone VARCHAR(50),
    email VARCHAR(255),
    permit_number VARCHAR(100),
    address TEXT,
    -- Enrichment fields
    enriched_email VARCHAR(255),
    enrichment_source VARCHAR(100),         -- 'firm_website', 'linkedin', 'manual'
    enrichment_date TIMESTAMP,
    firm_website VARCHAR(500),
    -- Deduplication
    name_hash VARCHAR(64),                  -- SHA-256 of normalized name+province for dedup
    -- Status tracking
    status VARCHAR(50) DEFAULT 'raw',       -- 'raw', 'enriched', 'contacted', 'converted', 'invalid'
    scrape_job_id INTEGER,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scraped_cpas_province ON scraped_cpas(province);
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_city ON scraped_cpas(city);
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_email ON scraped_cpas(email);
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_enriched_email ON scraped_cpas(enriched_email);
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_name_hash ON scraped_cpas(name_hash);
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_status ON scraped_cpas(status);
CREATE INDEX IF NOT EXISTS idx_scraped_cpas_source ON scraped_cpas(source);

-- Scraped SME contacts from federal registries
CREATE TABLE IF NOT EXISTS scraped_smes (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL,            -- 'corporations_canada', 'statcan_odbus'
    business_name VARCHAR(500) NOT NULL,
    corporate_number VARCHAR(100),
    province VARCHAR(50),
    city VARCHAR(255),
    naics_code VARCHAR(10),
    industry VARCHAR(255),
    business_status VARCHAR(50),            -- 'active', 'dissolved', etc.
    incorporation_date DATE,
    -- Contact enrichment fields
    contact_name VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    website VARCHAR(500),
    enrichment_source VARCHAR(100),
    enrichment_date TIMESTAMP,
    -- Status tracking
    status VARCHAR(50) DEFAULT 'raw',       -- 'raw', 'enriched', 'contacted', 'converted', 'invalid'
    scrape_job_id INTEGER,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scraped_smes_province ON scraped_smes(province);
CREATE INDEX IF NOT EXISTS idx_scraped_smes_naics ON scraped_smes(naics_code);
CREATE INDEX IF NOT EXISTS idx_scraped_smes_industry ON scraped_smes(industry);
CREATE INDEX IF NOT EXISTS idx_scraped_smes_status ON scraped_smes(status);
CREATE INDEX IF NOT EXISTS idx_scraped_smes_source ON scraped_smes(source);

-- Outreach campaign definitions
CREATE TABLE IF NOT EXISTS outreach_campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL,              -- 'cpa' or 'sme'
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    -- Target filters (JSON)
    target_provinces TEXT[],                 -- filter by province
    target_cities TEXT[],                    -- filter by city
    target_naics_codes TEXT[],              -- SME campaigns: filter by NAICS
    -- Limits
    daily_limit INTEGER DEFAULT 50,
    total_limit INTEGER,
    -- Status
    status VARCHAR(20) DEFAULT 'draft',     -- 'draft', 'active', 'paused', 'completed'
    -- Metrics (denormalized for fast reads)
    total_queued INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_delivered INTEGER DEFAULT 0,
    total_opened INTEGER DEFAULT 0,
    total_clicked INTEGER DEFAULT 0,
    total_bounced INTEGER DEFAULT 0,
    total_complained INTEGER DEFAULT 0,
    total_converted INTEGER DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    launched_at TIMESTAMP,
    paused_at TIMESTAMP,
    completed_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_status ON outreach_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_type ON outreach_campaigns(type);

-- Individual sent outreach emails
CREATE TABLE IF NOT EXISTS outreach_emails (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES outreach_campaigns(id),
    recipient_type VARCHAR(20) NOT NULL,    -- 'cpa' or 'sme'
    recipient_id INTEGER NOT NULL,          -- FK to scraped_cpas.id or scraped_smes.id
    recipient_email VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(500),
    -- Resend tracking
    resend_email_id VARCHAR(255),
    -- Status
    status VARCHAR(20) DEFAULT 'queued',    -- 'queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'
    -- Rendered content (for auditing)
    rendered_subject TEXT,
    rendered_body TEXT,
    -- Conversion tracking
    converted BOOLEAN DEFAULT FALSE,
    converted_at TIMESTAMP,
    converted_user_id INTEGER,              -- FK to users.id if they registered
    -- Timestamps
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    opened_at TIMESTAMP,
    clicked_at TIMESTAMP,
    bounced_at TIMESTAMP,
    complained_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outreach_emails_campaign ON outreach_emails(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_emails_status ON outreach_emails(status);
CREATE INDEX IF NOT EXISTS idx_outreach_emails_recipient_email ON outreach_emails(recipient_email);
CREATE INDEX IF NOT EXISTS idx_outreach_emails_resend_id ON outreach_emails(resend_email_id);

-- CASL compliance unsubscribe list
CREATE TABLE IF NOT EXISTS outreach_unsubscribes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    unsubscribe_token VARCHAR(255),
    reason TEXT,
    unsubscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outreach_unsubscribes_email ON outreach_unsubscribes(email);
CREATE INDEX IF NOT EXISTS idx_outreach_unsubscribes_token ON outreach_unsubscribes(unsubscribe_token);

-- Scrape job tracking
CREATE TABLE IF NOT EXISTS scrape_jobs (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL,            -- 'cpabc', 'cpaquebec', 'corporations_canada', etc.
    status VARCHAR(20) DEFAULT 'running',   -- 'running', 'completed', 'failed', 'partial'
    records_found INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    records_updated INTEGER DEFAULT 0,
    records_skipped INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_source ON scrape_jobs(source);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrape_jobs(status);
