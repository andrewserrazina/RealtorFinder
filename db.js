// db.js - Database connection and queries
const { Pool } = require('pg');
require('dotenv').config();

// Create PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connection
pool.on('connect', () => {
    console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});

// Database queries

const db = {
    // Get all active listings
    async getAllListings() {
        const result = await pool.query(
            `SELECT id, address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft,
                    description, image_urls, created_at, user_id,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = listings.id) as offer_count
             FROM listings
             ORDER BY created_at DESC`
        );
        return result.rows;
    },

    // Get listings for a specific user
    async getUserListings(userId) {
        const result = await pool.query(
            `SELECT id, address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft,
                    description, image_urls, created_at, user_id,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = listings.id) as offer_count
             FROM listings
             WHERE user_id = $1
             ORDER BY created_at DESC`,
            [userId]
        );
        return result.rows;
    },

    // Get single listing with contact info
    async getListingById(id) {
        const result = await pool.query(
            `SELECT * FROM listings WHERE id = $1`,
            [id]
        );
        return result.rows[0];
    },

    // Create new listing
    async createListing(listingData) {
        const { address, city, state, zip, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, userId } = listingData;
        
        const result = await pool.query(
            `INSERT INTO listings (address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft, description, owner_name, owner_email, owner_phone, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING *`,
            [address, city, state, zip, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, userId]
        );
        return result.rows[0];
    },

    // Create offer for a listing
    async createOffer(listingId, offerData) {
        const { realtorName, brokerage, realtorEmail, realtorPhone, commission, offerDetails, userId } = offerData;
        
        const result = await pool.query(
            `INSERT INTO offers (listing_id, realtor_name, brokerage, realtor_email, realtor_phone, commission, offer_details, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [listingId, realtorName, brokerage, realtorEmail, realtorPhone, commission, offerDetails, userId]
        );
        return result.rows[0];
    },

    // Get offers for a listing
    async getOffersByListingId(listingId) {
        const result = await pool.query(
            `SELECT * FROM offers WHERE listing_id = $1 ORDER BY created_at DESC`,
            [listingId]
        );
        return result.rows;
    },

    // Get offers made by a specific user (realtor)
    async getUserOffers(userId) {
        const result = await pool.query(
            `SELECT o.*, l.address, l.city, l.state, l.zip, l.price 
             FROM offers o
             JOIN listings l ON o.listing_id = l.id
             WHERE o.user_id = $1 
             ORDER BY o.created_at DESC`,
            [userId]
        );
        return result.rows;
    },

    // Update listing status
    async updateListingStatus(id, status) {
        const result = await pool.query(
            `UPDATE listings SET status = $1 WHERE id = $2 RETURNING *`,
            [status, id]
        );
        return result.rows[0];
    },

    // Update offer status
    async updateOfferStatus(id, status) {
        const result = await pool.query(
            `UPDATE offers SET status = $1 WHERE id = $2 RETURNING *`,
            [status, id]
        );
        return result.rows[0];
    },

    // Add to waitlist
    async addToWaitlist(email, userType) {
        const result = await pool.query(
            `INSERT INTO waitlist (email, user_type) VALUES ($1, $2) 
             ON CONFLICT (email) DO UPDATE SET user_type = $2
             RETURNING *`,
            [email, userType]
        );
        return result.rows[0];
    }
};

module.exports = { pool, db };
