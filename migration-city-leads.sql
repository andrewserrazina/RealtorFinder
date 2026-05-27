-- migration-city-leads.sql
-- Run after migration-cities.sql

CREATE TABLE IF NOT EXISTS city_leads (
    id SERIAL PRIMARY KEY,
    type VARCHAR(10) NOT NULL CHECK (type IN ('seller', 'realtor')),
    name VARCHAR(255),
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    city_slug VARCHAR(100),
    city_name VARCHAR(255),
    state_code CHAR(2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_city_leads_email ON city_leads(email);
CREATE INDEX IF NOT EXISTS idx_city_leads_state ON city_leads(state_code);
CREATE INDEX IF NOT EXISTS idx_city_leads_created ON city_leads(created_at DESC);
