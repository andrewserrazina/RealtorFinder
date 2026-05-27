-- migration-companies.sql
-- Run after migration-buyers.sql

-- Firms / companies that group realtors together
CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    plan VARCHAR(50) DEFAULT 'basic',   -- 'basic' ($99) | 'professional' ($249) | 'firm' ($499/location)
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One row per physical office location (firm plan only — each location = $499/mo)
CREATE TABLE IF NOT EXISTS company_locations (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    zip_code VARCHAR(10) NOT NULL,
    label VARCHAR(100),                 -- e.g. "Downtown Office", "West Side Branch"
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, zip_code)
);

-- Extend users table with company and plan info
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'basic';
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_role VARCHAR(50) DEFAULT 'owner'; -- 'owner' | 'agent'

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_company_locations_company ON company_locations(company_id);
CREATE INDEX IF NOT EXISTS idx_company_locations_zip ON company_locations(zip_code);
