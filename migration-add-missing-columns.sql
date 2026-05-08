-- Migration: Add missing columns for authentication and user associations
-- Run this in your database before deploying the updated code

-- Add first_name, last_name, zip_code to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS zip_code VARCHAR(20);

-- Add user_type column to waitlist
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS user_type VARCHAR(20);

-- Add user_id to listings (associate listings with users)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Add user_id to offers (associate offers with users)
ALTER TABLE offers ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Add status column to listings if missing
ALTER TABLE listings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

-- Add created_at to offers if using submitted_at instead
-- (The code expects created_at but schema has submitted_at)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='offers' AND column_name='created_at'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='offers' AND column_name='submitted_at'
    ) THEN
        ALTER TABLE offers RENAME COLUMN submitted_at TO created_at;
    END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_listings_user_id ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_offers_user_id ON offers(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);

-- Verify the changes
SELECT 
    'users' as table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_name = 'users'
    AND column_name IN ('first_name', 'last_name', 'zip_code')
UNION ALL
SELECT 
    'waitlist' as table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_name = 'waitlist'
    AND column_name = 'user_type'
UNION ALL
SELECT 
    'listings' as table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_name = 'listings'
    AND column_name IN ('user_id', 'status')
UNION ALL
SELECT 
    'offers' as table_name,
    column_name,
    data_type
FROM information_schema.columns
WHERE table_name = 'offers'
    AND column_name IN ('user_id', 'created_at');
