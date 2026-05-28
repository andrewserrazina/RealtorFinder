-- Realtor reviews (left by sellers after accepting a proposal)
CREATE TABLE IF NOT EXISTS realtor_reviews (
    id          SERIAL PRIMARY KEY,
    realtor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id  INTEGER REFERENCES listings(id) ON DELETE SET NULL,
    rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body        TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (seller_id, listing_id)   -- one review per listing
);
CREATE INDEX IF NOT EXISTS idx_reviews_realtor ON realtor_reviews(realtor_id);

-- Saved listings (realtors bookmarking listings)
CREATE TABLE IF NOT EXISTS saved_listings (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_listings(user_id);
