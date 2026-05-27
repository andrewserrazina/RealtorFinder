-- migration-buyers.sql
-- Run after migration-launch.sql

-- Buyer agent requests
CREATE TABLE IF NOT EXISTS buyer_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(20),
    budget_min BIGINT,
    budget_max BIGINT,
    target_areas TEXT,
    property_type VARCHAR(50),
    bedrooms_min INTEGER,
    timeline VARCHAR(100),
    additional_notes TEXT,
    zip_code VARCHAR(10),
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    status VARCHAR(50) DEFAULT 'active',
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Realtor responses to buyer requests
CREATE TABLE IF NOT EXISTS buyer_request_responses (
    id SERIAL PRIMARY KEY,
    buyer_request_id INTEGER REFERENCES buyer_requests(id) ON DELETE CASCADE,
    realtor_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(buyer_request_id, realtor_user_id)
);

CREATE INDEX IF NOT EXISTS idx_buyer_requests_user ON buyer_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_buyer_requests_active ON buyer_requests(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brr_buyer ON buyer_request_responses(buyer_request_id);
CREATE INDEX IF NOT EXISTS idx_brr_realtor ON buyer_request_responses(realtor_user_id);
