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
        const { address, city, state, zip, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, userId, latitude, longitude } = listingData;

        const result = await pool.query(
            `INSERT INTO listings (address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft, description, owner_name, owner_email, owner_phone, user_id, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             RETURNING *`,
            [address, city, state, zip, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, userId, latitude || null, longitude || null]
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

    // Get all offers across a seller's own listings
    async getSellerOffers(userId) {
        const result = await pool.query(
            `SELECT o.*, l.address, l.city, l.state, l.zip, l.price, l.id AS listing_id_ref
             FROM offers o
             JOIN listings l ON o.listing_id = l.id
             WHERE l.user_id = $1
             ORDER BY o.created_at DESC`,
            [userId]
        );
        return result.rows;
    },

    // Get offers made by a specific user (realtor)
    async getUserOffers(userId) {
        const result = await pool.query(
            `SELECT o.*, l.address, l.city, l.state, l.zip, l.price,
                    l.owner_name, l.owner_email, l.owner_phone
             FROM offers o
             JOIN listings l ON o.listing_id = l.id
             WHERE o.user_id = $1
             ORDER BY o.created_at DESC`,
            [userId]
        );
        return result.rows;
    },

    // Update listing fields
    async updateListing(id, data) {
        const { price, type, bedrooms, bathrooms, sqft, description } = data;
        const result = await pool.query(
            `UPDATE listings
             SET price=$1, property_type=$2, bedrooms=$3, bathrooms=$4, sqft=$5, description=$6, updated_at=NOW()
             WHERE id=$7
             RETURNING *`,
            [price, type, parseInt(bedrooms), parseFloat(bathrooms), parseInt(sqft), description, id]
        );
        return result.rows[0];
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
    },

    // Filtered listings with pagination (realtors — active only)
    async getFilteredListings(filters = {}, page = 1, limit = 20) {
        const { city, type, minPrice, maxPrice, minBeds } = filters;
        const offset = (page - 1) * limit;
        const params = [];
        const conditions = ["(l.status = 'active' OR l.status IS NULL)"];

        if (city) {
            params.push(`%${city.trim()}%`);
            conditions.push(`l.city ILIKE $${params.length}`);
        }
        if (type) {
            params.push(type);
            conditions.push(`l.property_type = $${params.length}`);
        }
        if (minBeds) {
            params.push(parseInt(minBeds));
            conditions.push(`l.bedrooms >= $${params.length}`);
        }
        if (minPrice) {
            params.push(parseInt(minPrice));
            conditions.push(`CAST(REGEXP_REPLACE(l.price, '[^0-9]', '', 'g') AS BIGINT) >= $${params.length}`);
        }
        if (maxPrice) {
            params.push(parseInt(maxPrice));
            conditions.push(`CAST(REGEXP_REPLACE(l.price, '[^0-9]', '', 'g') AS BIGINT) <= $${params.length}`);
        }

        const where = `WHERE ${conditions.join(' AND ')}`;
        const countResult = await pool.query(`SELECT COUNT(*) FROM listings l ${where}`, params);
        const total = parseInt(countResult.rows[0].count);

        params.push(limit, offset);
        const result = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price, l.property_type,
                    l.bedrooms, l.bathrooms, l.sqft, l.description, l.image_urls,
                    l.created_at, l.user_id, l.latitude, l.longitude, l.status,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = l.id) as offer_count
             FROM listings l
             ${where}
             ORDER BY l.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        return { listings: result.rows, total, page: parseInt(page), limit: parseInt(limit) };
    },

    // Accept an offer — sets it to accepted, declines all other pending offers, marks listing as under_contract.
    // Returns the array of declined offers so the caller can send notification emails.
    async acceptOffer(offerId, listingId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const declined = await client.query(
                `SELECT * FROM offers WHERE listing_id = $1 AND id != $2 AND status = 'pending'`,
                [listingId, offerId]
            );
            await client.query(`UPDATE offers SET status = 'accepted' WHERE id = $1`, [offerId]);
            await client.query(
                `UPDATE offers SET status = 'declined' WHERE listing_id = $1 AND id != $2 AND status = 'pending'`,
                [listingId, offerId]
            );
            await client.query(`UPDATE listings SET status = 'under_contract' WHERE id = $1`, [listingId]);
            await client.query('COMMIT');
            return declined.rows;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    },

    // Decline a single offer
    async declineOffer(offerId) {
        const result = await pool.query(
            `UPDATE offers SET status = 'declined' WHERE id = $1 RETURNING *`,
            [offerId]
        );
        return result.rows[0];
    },

    // Look up user by email (for password reset)
    async getUserByEmail(email) {
        const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
        return result.rows[0];
    },

    // Password reset token management
    async createPasswordResetToken(userId, token, expiresAt) {
        await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
        const result = await pool.query(
            `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING *`,
            [userId, token, expiresAt]
        );
        return result.rows[0];
    },

    async getUserByResetToken(token) {
        const result = await pool.query(
            `SELECT u.id, u.email, u.user_type, u.first_name, u.last_name, u.zip_code,
                    prt.expires_at, prt.used
             FROM users u
             JOIN password_reset_tokens prt ON prt.user_id = u.id
             WHERE prt.token = $1`,
            [token]
        );
        return result.rows[0];
    },

    async markResetTokenUsed(token) {
        await pool.query(`UPDATE password_reset_tokens SET used = TRUE WHERE token = $1`, [token]);
    },

    async updateUserPassword(userId, hashedPassword) {
        await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashedPassword, userId]);
    },

    // Email verification
    async setVerificationToken(userId, token, expiresAt) {
        await pool.query(
            `UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3`,
            [token, expiresAt, userId]
        );
    },

    async verifyEmailToken(token) {
        const result = await pool.query(
            `UPDATE users
             SET email_verified = TRUE, verification_token = NULL, verification_token_expires = NULL
             WHERE verification_token = $1 AND verification_token_expires > NOW()
             RETURNING id, email, user_type`,
            [token]
        );
        return result.rows[0];
    },

    // Get user's email_verified status (for session refresh)
    async getUserEmailVerified(userId) {
        const result = await pool.query(
            `SELECT email_verified FROM users WHERE id = $1`,
            [userId]
        );
        return result.rows[0]?.email_verified ?? false;
    }
};

module.exports = { pool, db };
