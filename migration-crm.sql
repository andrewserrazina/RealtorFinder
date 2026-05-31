-- CRM expansion migration

-- Internal admin notes (attachable to realtors, listings, matches, prospects)
CREATE TABLE IF NOT EXISTS admin_notes (
    id SERIAL PRIMARY KEY,
    resource_type TEXT NOT NULL,  -- 'realtor' | 'listing' | 'match' | 'prospect'
    resource_id INTEGER NOT NULL,
    admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_notes_resource ON admin_notes(resource_type, resource_id);

-- Realtor recruitment prospects (not yet signed up)
CREATE TABLE IF NOT EXISTS realtor_prospects (
    id SERIAL PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    brokerage TEXT,
    email TEXT,
    phone TEXT,
    city TEXT,
    state TEXT,
    source TEXT DEFAULT 'manual',
    outreach_status TEXT DEFAULT 'not_contacted',
    last_contact_date DATE,
    follow_up_date DATE,
    notes TEXT,
    converted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead-to-realtor match tracking (with revenue fields)
CREATE TABLE IF NOT EXISTS lead_matches (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
    realtor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    status TEXT DEFAULT 'pending',
    realtor_accepted BOOLEAN,
    contact_made BOOLEAN DEFAULT FALSE,
    appointment_scheduled BOOLEAN DEFAULT FALSE,
    listing_agreement_signed BOOLEAN DEFAULT FALSE,
    under_contract BOOLEAN DEFAULT FALSE,
    closed BOOLEAN DEFAULT FALSE,
    estimated_home_value NUMERIC(12,2),
    estimated_commission_pct NUMERIC(5,4),
    referral_fee_expected NUMERIC(10,2),
    referral_fee_paid NUMERIC(10,2),
    payment_status TEXT DEFAULT 'pending',
    close_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CRM status + follow-up fields on listings (homeowner leads)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS crm_status TEXT DEFAULT 'new';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS crm_follow_up_date DATE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS crm_assigned_realtor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
