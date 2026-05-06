-- Authentication Tables for RealtorFinder

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    user_type VARCHAR(20) NOT NULL CHECK (user_type IN ('seller', 'realtor')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Session table (for express-session)
CREATE TABLE IF NOT EXISTS "session" (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Add user_id to listings table (connect listings to users)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Add user_id to offers table (connect offers to users)  
ALTER TABLE offers ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_listings_user_id ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_offers_user_id ON offers(user_id);
