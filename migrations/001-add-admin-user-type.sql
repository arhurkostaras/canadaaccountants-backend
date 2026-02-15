-- Migration: Add 'admin' to users.user_type CHECK constraint
-- Run against your Railway PostgreSQL database

-- Step 1: Drop the existing CHECK constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;

-- Step 2: Add updated CHECK constraint with 'admin'
ALTER TABLE users ADD CONSTRAINT users_user_type_check
  CHECK (user_type IN ('CPA', 'SME', 'admin'));
