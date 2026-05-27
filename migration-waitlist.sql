-- Add is_approved column for waitlist gating
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false;

-- Approve existing admin users so they retain dashboard access
UPDATE users SET is_approved = true WHERE is_admin = true;

CREATE INDEX IF NOT EXISTS idx_users_approved ON users(is_approved) WHERE is_approved = false;
