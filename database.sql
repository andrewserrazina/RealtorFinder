-- database.sql - PostgreSQL schema for HomeDirect

-- Create database
-- Run this first: CREATE DATABASE homedirect;

-- Connect to the database
-- \c homedirect;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (for future authentication)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    user_type VARCHAR(20) CHECK (user_type IN ('homeowner', 'realtor')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Listings table
CREATE TABLE IF NOT EXISTS listings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    price VARCHAR(50) NOT NULL,
    property_type VARCHAR(50) NOT NULL,
    bedrooms INTEGER NOT NULL,
    bathrooms DECIMAL(3,1) NOT NULL,
    sqft INTEGER NOT NULL,
    description TEXT NOT NULL,
    owner_name VARCHAR(255) NOT NULL,
    owner_email VARCHAR(255) NOT NULL,
    owner_phone VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'pending', 'sold', 'withdrawn')),
    image_urls TEXT[], -- Array of image URLs
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Offers table
CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
    realtor_name VARCHAR(255) NOT NULL,
    brokerage VARCHAR(255) NOT NULL,
    realtor_email VARCHAR(255) NOT NULL,
    realtor_phone VARCHAR(50) NOT NULL,
    commission DECIMAL(5,2),
    offer_details TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_created_at ON listings(created_at DESC);
CREATE INDEX idx_offers_listing_id ON offers(listing_id);
CREATE INDEX idx_offers_status ON offers(status);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON listings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_offers_updated_at BEFORE UPDATE ON offers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data
INSERT INTO listings (address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft, description, owner_name, owner_email, owner_phone, created_at) VALUES
('456 Oak Avenue', 'Springfield', 'MA', '01105', '$525,000', 'Single Family', 4, 2.5, 2400, 'Beautiful colonial with updated kitchen, hardwood floors throughout, and spacious backyard. Walking distance to top-rated schools.', 'Sarah Johnson', 'sarah.j@email.com', '(555) 234-5678', NOW() - INTERVAL '2 days'),
('789 Maple Street', 'Springfield', 'MA', '01109', '$385,000', 'Townhouse', 3, 2, 1850, 'Modern townhouse with open concept living, granite counters, finished basement, and attached garage. Low HOA fees.', 'Michael Chen', 'm.chen@email.com', '(555) 345-6789', NOW() - INTERVAL '5 days');
