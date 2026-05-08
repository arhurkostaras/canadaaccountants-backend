-- Migration 004: Inbound mail ingestion (Section 4.0 of campaign brief v1.7)
-- Stores parsed inbound replies arriving via the ACC IMAP polling cron.
-- Read by Section 4.1 (breakdown auto-reply) and Section 4.10 (reply handler).

CREATE TABLE IF NOT EXISTS inbound_messages (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(10) NOT NULL,
    from_email TEXT NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT,
    body_text TEXT NOT NULL DEFAULT '',
    body_html TEXT,
    message_id TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    classification_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (classification_status IN ('pending','classified','manual_review','suppressed')),
    classification_decision VARCHAR(20)
        CHECK (classification_decision IS NULL OR classification_decision IN ('breakdown','unsubscribe','touch7_in','touch7_out','manual')),
    processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_messages_message_id ON inbound_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_pending ON inbound_messages(received_at) WHERE classification_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbound_messages_received_at ON inbound_messages(received_at);

-- Polling cron status (single-row, upserted each poll). Only used on ACC.
CREATE TABLE IF NOT EXISTS inbound_poll_status (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_poll_at TIMESTAMPTZ,
    last_poll_status VARCHAR(20),
    last_poll_message_count INTEGER DEFAULT 0,
    last_poll_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO inbound_poll_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
