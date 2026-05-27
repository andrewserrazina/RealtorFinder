-- migration-cities.sql
-- Run after migration-companies.sql

CREATE TABLE IF NOT EXISTS city_pages (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    state_code CHAR(2) NOT NULL,
    state_name VARCHAR(100) NOT NULL,
    county VARCHAR(100),
    zip VARCHAR(10),
    population VARCHAR(20),
    median_price VARCHAR(20),
    price_trend VARCHAR(20),
    avg_dom INTEGER,
    description TEXT,
    neighborhoods TEXT,
    nearby TEXT,
    seller_hook TEXT,
    realtor_hook TEXT,
    is_published BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(state_code, slug)
);

CREATE INDEX IF NOT EXISTS idx_city_pages_state ON city_pages(state_code);
CREATE INDEX IF NOT EXISTS idx_city_pages_published ON city_pages(is_published) WHERE is_published = TRUE;
CREATE INDEX IF NOT EXISTS idx_city_pages_slug ON city_pages(slug);
