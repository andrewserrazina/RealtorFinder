-- migration-launch.sql
-- Run this migration after migration-features.sql

-- Realtor profile fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_number VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS years_experience INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_areas TEXT;

-- Admin and active flags
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Soft delete for listings
ALTER TABLE listings ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_listings_deleted ON listings(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = TRUE;
