-- Add password reset token columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP WITH TIME ZONE;
