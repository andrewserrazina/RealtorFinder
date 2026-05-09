-- Migration: Add geocoding coordinates to listings table
ALTER TABLE listings ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8);

CREATE INDEX IF NOT EXISTS idx_listings_coords ON listings(latitude, longitude)
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
