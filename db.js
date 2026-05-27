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
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC`
        );
        return result.rows;
    },

    // Get listings for a specific user
    async getUserListings(userId) {
        const result = await pool.query(
            `SELECT id, address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft,
                    description, image_urls, created_at, user_id, status,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = listings.id) as offer_count
             FROM listings
             WHERE user_id = $1 AND deleted_at IS NULL
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
        const conditions = ["(l.status = 'active' OR l.status IS NULL)", "l.deleted_at IS NULL"];

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
    },

    // Get realtor profile fields
    async getProfile(userId) {
        try {
            const result = await pool.query(
                `SELECT id, email, user_type, first_name, last_name, zip_code,
                        phone, license_number, bio, years_experience, service_areas
                 FROM users WHERE id = $1`,
                [userId]
            );
            return result.rows[0];
        } catch {
            const result = await pool.query(
                `SELECT id, email, user_type, first_name, last_name, zip_code FROM users WHERE id = $1`,
                [userId]
            );
            return result.rows[0];
        }
    },

    // Update realtor profile fields
    async updateProfile(userId, data) {
        const { phone, licenseNumber, bio, yearsExperience, serviceAreas } = data;
        const result = await pool.query(
            `UPDATE users SET phone=$1, license_number=$2, bio=$3, years_experience=$4, service_areas=$5
             WHERE id=$6 RETURNING id, email, user_type, first_name, last_name, zip_code,
                    phone, license_number, bio, years_experience, service_areas`,
            [phone || null, licenseNumber || null, bio || null,
             yearsExperience ? parseInt(yearsExperience) : null, serviceAreas || null, userId]
        );
        return result.rows[0];
    },

    // Soft-delete a listing
    async softDeleteListing(listingId) {
        const result = await pool.query(
            `UPDATE listings SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [listingId]
        );
        return result.rows[0];
    },

    // Update listing images
    async updateListingImages(listingId, imageUrls) {
        const result = await pool.query(
            `UPDATE listings SET image_urls = $1 WHERE id = $2 RETURNING *`,
            [imageUrls, listingId]
        );
        return result.rows[0];
    },

    // Withdraw (delete) an offer — only the realtor who submitted it
    async deleteOffer(offerId) {
        const result = await pool.query(
            `DELETE FROM offers WHERE id = $1 RETURNING *`,
            [offerId]
        );
        return result.rows[0];
    },

    // Admin: all users
    async getAllUsersAdmin() {
        const result = await pool.query(
            `SELECT id, email, user_type, first_name, last_name, zip_code,
                    email_verified, is_active, is_admin, created_at
             FROM users ORDER BY created_at DESC`
        );
        return result.rows;
    },

    // Admin: all listings (including soft-deleted)
    async getAllListingsAdmin() {
        const result = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price, l.property_type,
                    l.bedrooms, l.bathrooms, l.status, l.deleted_at, l.created_at,
                    u.first_name, u.last_name, u.email as owner_email,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = l.id) as offer_count
             FROM listings l
             JOIN users u ON l.user_id = u.id
             ORDER BY l.created_at DESC`
        );
        return result.rows;
    },

    // Admin: aggregate stats
    async getAdminStats() {
        const result = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE user_type = 'seller') as total_sellers,
                (SELECT COUNT(*) FROM users WHERE user_type = 'realtor') as total_realtors,
                (SELECT COUNT(*) FROM listings WHERE deleted_at IS NULL) as total_listings,
                (SELECT COUNT(*) FROM listings WHERE status = 'active' AND deleted_at IS NULL) as active_listings,
                (SELECT COUNT(*) FROM offers) as total_offers,
                (SELECT COUNT(*) FROM waitlist) as total_waitlist
        `);
        return result.rows[0];
    },

    // Admin: deactivate user
    async deactivateUser(userId) {
        const result = await pool.query(
            `UPDATE users SET is_active = FALSE WHERE id = $1 RETURNING id, email, is_active`,
            [userId]
        );
        return result.rows[0];
    },

    // Admin: reactivate user
    async reactivateUser(userId) {
        const result = await pool.query(
            `UPDATE users SET is_active = TRUE WHERE id = $1 RETURNING id, email, is_active`,
            [userId]
        );
        return result.rows[0];
    },

    // Admin: hard-delete a listing (or use softDeleteListing for soft-delete)
    async adminDeleteListing(listingId) {
        const result = await pool.query(
            `UPDATE listings SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [listingId]
        );
        return result.rows[0];
    },

    // ===== BUYER REQUEST METHODS =====

    async createBuyerRequest(userId, data) {
        const { firstName, lastName, email, phone, budgetMin, budgetMax, targetAreas, propertyType, bedroomsMin, timeline, additionalNotes, zipCode, latitude, longitude } = data;
        const result = await pool.query(
            `INSERT INTO buyer_requests
             (user_id, first_name, last_name, email, phone, budget_min, budget_max,
              target_areas, property_type, bedrooms_min, timeline, additional_notes,
              zip_code, latitude, longitude)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING *`,
            [userId, firstName, lastName, email, phone,
             budgetMin || null, budgetMax || null, targetAreas, propertyType || null,
             bedroomsMin || null, timeline, additionalNotes, zipCode,
             latitude || null, longitude || null]
        );
        return result.rows[0];
    },

    async getBuyerRequestByUser(userId) {
        const result = await pool.query(
            `SELECT * FROM buyer_requests WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
        return result.rows[0];
    },

    async updateBuyerRequest(id, userId, data) {
        const { phone, budgetMin, budgetMax, targetAreas, propertyType, bedroomsMin, timeline, additionalNotes } = data;
        const result = await pool.query(
            `UPDATE buyer_requests
             SET phone=$1, budget_min=$2, budget_max=$3, target_areas=$4, property_type=$5,
                 bedrooms_min=$6, timeline=$7, additional_notes=$8, updated_at=NOW()
             WHERE id=$9 AND user_id=$10 AND deleted_at IS NULL
             RETURNING *`,
            [phone, budgetMin || null, budgetMax || null, targetAreas, propertyType || null,
             bedroomsMin || null, timeline, additionalNotes, id, userId]
        );
        return result.rows[0];
    },

    async deleteBuyerRequest(id, userId) {
        const result = await pool.query(
            `UPDATE buyer_requests SET deleted_at = NOW(), status = 'inactive'
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [id, userId]
        );
        return result.rows[0];
    },

    async getActiveBuyerRequests(filters = {}, page = 1, limit = 20) {
        const { area, type, budgetMin, budgetMax } = filters;
        const offset = (page - 1) * limit;
        const params = [];
        const conditions = ["status = 'active'", "deleted_at IS NULL"];

        if (area) {
            params.push(`%${area.trim()}%`);
            conditions.push(`target_areas ILIKE $${params.length}`);
        }
        if (type) {
            params.push(type);
            conditions.push(`(property_type = $${params.length} OR property_type IS NULL)`);
        }
        if (budgetMin) {
            params.push(parseInt(budgetMin));
            conditions.push(`(budget_max >= $${params.length} OR budget_max IS NULL)`);
        }
        if (budgetMax) {
            params.push(parseInt(budgetMax));
            conditions.push(`(budget_min <= $${params.length} OR budget_min IS NULL)`);
        }

        const where = `WHERE ${conditions.join(' AND ')}`;
        const countResult = await pool.query(`SELECT COUNT(*) FROM buyer_requests ${where}`, params);
        const total = parseInt(countResult.rows[0].count);

        params.push(limit, offset);
        const result = await pool.query(
            `SELECT id, first_name, last_name, budget_min, budget_max, target_areas,
                    property_type, bedrooms_min, timeline, additional_notes, zip_code,
                    created_at, status
             FROM buyer_requests ${where}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        return { requests: result.rows, total, page: parseInt(page), limit };
    },

    async respondToBuyerRequest(buyerRequestId, realtorUserId, message) {
        const result = await pool.query(
            `INSERT INTO buyer_request_responses (buyer_request_id, realtor_user_id, message)
             VALUES ($1, $2, $3)
             ON CONFLICT (buyer_request_id, realtor_user_id)
             DO UPDATE SET message = $3, created_at = NOW()
             RETURNING *`,
            [buyerRequestId, realtorUserId, message || '']
        );
        return result.rows[0];
    },

    async getBuyerRequestById(id) {
        const result = await pool.query(
            `SELECT br.*, u.email as user_email, u.first_name as user_first, u.last_name as user_last
             FROM buyer_requests br
             JOIN users u ON br.user_id = u.id
             WHERE br.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async getResponsesForBuyer(userId) {
        const result = await pool.query(
            `SELECT brr.*, u.first_name as realtor_first, u.last_name as realtor_last,
                    u.email as realtor_email, u.phone as realtor_phone,
                    u.license_number, u.years_experience, u.service_areas, u.bio
             FROM buyer_request_responses brr
             JOIN buyer_requests br ON brr.buyer_request_id = br.id
             JOIN users u ON brr.realtor_user_id = u.id
             WHERE br.user_id = $1
             ORDER BY brr.created_at DESC`,
            [userId]
        );
        return result.rows;
    },

    async getRealtorBuyerResponses(realtorUserId) {
        const result = await pool.query(
            `SELECT brr.buyer_request_id FROM buyer_request_responses
             WHERE realtor_user_id = $1`,
            [realtorUserId]
        );
        return result.rows.map(r => r.buyer_request_id);
    }
};

module.exports = { pool, db };
