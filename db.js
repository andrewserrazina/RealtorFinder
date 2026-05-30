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
                    description, image_urls, created_at, user_id, COALESCE(view_count, 0) AS view_count,
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
                    description, image_urls, created_at, user_id, status, COALESCE(view_count, 0) AS view_count,
                    share_token, COALESCE(share_views, 0) AS share_views,
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
        const { address, city, state, zip, price, zestimate, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, userId, latitude, longitude } = listingData;

        const result = await pool.query(
            `INSERT INTO listings (address, city, state, zip, price, zestimate, property_type, bedrooms, bathrooms, sqft, description, owner_name, owner_email, owner_phone, user_id, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING *`,
            [address, city, state, zip, price, zestimate || null, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, userId, latitude || null, longitude || null]
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
        const { city, type, minPrice, maxPrice, minBeds, maxBeds, minBaths, zip, swLat, swLng, neLat, neLng } = filters;
        const offset = (page - 1) * limit;
        const params = [];
        const conditions = ["(l.status = 'active' OR l.status IS NULL)", "l.deleted_at IS NULL"];

        if (city) {
            params.push(`%${city.trim()}%`);
            conditions.push(`l.city ILIKE $${params.length}`);
        }
        if (zip) {
            params.push(zip.trim());
            conditions.push(`l.zip = $${params.length}`);
        }
        if (type) {
            params.push(type);
            conditions.push(`l.property_type = $${params.length}`);
        }
        if (minBeds) {
            params.push(parseInt(minBeds));
            conditions.push(`l.bedrooms >= $${params.length}`);
        }
        if (maxBeds) {
            params.push(parseInt(maxBeds));
            conditions.push(`l.bedrooms <= $${params.length}`);
        }
        if (minBaths) {
            params.push(parseFloat(minBaths));
            conditions.push(`l.bathrooms >= $${params.length}`);
        }
        if (minPrice) {
            params.push(parseFloat(minPrice));
            conditions.push(`l.price >= $${params.length}`);
        }
        if (maxPrice) {
            params.push(parseFloat(maxPrice));
            conditions.push(`l.price <= $${params.length}`);
        }
        if (swLat && swLng && neLat && neLng) {
            params.push(parseFloat(swLat), parseFloat(neLat));
            conditions.push(`l.latitude BETWEEN $${params.length - 1} AND $${params.length}`);
            params.push(parseFloat(swLng), parseFloat(neLng));
            conditions.push(`l.longitude BETWEEN $${params.length - 1} AND $${params.length}`);
        }

        const where = `WHERE ${conditions.join(' AND ')}`;
        const countResult = await pool.query(`SELECT COUNT(*) FROM listings l ${where}`, params);
        const total = parseInt(countResult.rows[0].count);

        params.push(limit, offset);
        const result = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price, l.property_type,
                    l.bedrooms, l.bathrooms, l.sqft, l.description, l.image_urls,
                    l.created_at, l.user_id, l.latitude, l.longitude, l.status,
                    COALESCE(l.view_count, 0) as view_count,
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
                `SELECT u.id, u.email, u.user_type, u.first_name, u.last_name, u.zip_code,
                        u.phone, u.license_number, u.bio, u.years_experience, u.service_areas,
                        u.profile_photo, u.company_id, u.company_name, u.subscription_plan, u.company_role,
                        c.name AS company_display_name, c.plan AS company_plan
                 FROM users u
                 LEFT JOIN companies c ON c.id = u.company_id
                 WHERE u.id = $1`,
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
                    phone, license_number, bio, years_experience, service_areas,
                    company_id, company_name, subscription_plan, company_role`,
            [phone || null, licenseNumber || null, bio || null,
             yearsExperience ? parseInt(yearsExperience) : null, serviceAreas || null, userId]
        );
        return result.rows[0];
    },

    // ===== COMPANY METHODS =====

    async createCompany(name, ownerUserId, plan = 'basic') {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const co = await client.query(
                `INSERT INTO companies (name, owner_user_id, plan)
                 VALUES ($1, $2, $3) RETURNING *`,
                [name, ownerUserId, plan]
            );
            const company = co.rows[0];
            await client.query(
                `UPDATE users SET company_id=$1, company_name=$2, subscription_plan=$3, company_role='owner'
                 WHERE id=$4`,
                [company.id, name, plan, ownerUserId]
            );
            await client.query('COMMIT');
            return company;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    },

    async getCompany(companyId) {
        const result = await pool.query(
            `SELECT c.*, u.first_name AS owner_first_name, u.last_name AS owner_last_name, u.email AS owner_email
             FROM companies c
             LEFT JOIN users u ON u.id = c.owner_user_id
             WHERE c.id = $1`,
            [companyId]
        );
        return result.rows[0];
    },

    async getCompanyByOwner(userId) {
        const result = await pool.query(
            `SELECT * FROM companies WHERE owner_user_id = $1 AND is_active = TRUE`,
            [userId]
        );
        return result.rows[0];
    },

    async getCompanyMembers(companyId) {
        const result = await pool.query(
            `SELECT id, first_name, last_name, email, zip_code, phone,
                    license_number, company_role, subscription_plan, created_at
             FROM users
             WHERE company_id = $1 AND (is_active IS NULL OR is_active = TRUE)
             ORDER BY company_role DESC, created_at ASC`,
            [companyId]
        );
        return result.rows;
    },

    // Returns false if the plan doesn't allow adding more agents at this zip
    async canAddAgent(companyId, zipCode) {
        const co = await pool.query(`SELECT plan FROM companies WHERE id = $1`, [companyId]);
        const company = co.rows[0];
        if (!company) return false;
        if (company.plan === 'firm') return true;
        // basic / professional: max 1 agent per location
        const count = await pool.query(
            `SELECT COUNT(*) FROM users WHERE company_id = $1 AND zip_code = $2 AND (is_active IS NULL OR is_active = TRUE)`,
            [companyId, zipCode]
        );
        return parseInt(count.rows[0].count) === 0;
    },

    async addAgentToCompany(userId, companyId, zipCode) {
        const allowed = await this.canAddAgent(companyId, zipCode);
        if (!allowed) throw new Error('Plan limit reached: upgrade to the Firm plan to add more agents at this location');
        const co = await pool.query(`SELECT plan, name FROM companies WHERE id = $1`, [companyId]);
        const company = co.rows[0];
        await pool.query(
            `UPDATE users SET company_id=$1, company_name=$2, subscription_plan=$3, company_role='agent'
             WHERE id=$4`,
            [companyId, company.name, company.plan, userId]
        );
    },

    async removeAgentFromCompany(userId, companyId) {
        await pool.query(
            `UPDATE users SET company_id=NULL, company_role='owner', subscription_plan='basic'
             WHERE id=$1 AND company_id=$2 AND company_role != 'owner'`,
            [userId, companyId]
        );
    },

    async updateCompanyPlan(companyId, plan) {
        await pool.query(
            `UPDATE companies SET plan=$1, updated_at=NOW() WHERE id=$2`,
            [plan, companyId]
        );
        await pool.query(
            `UPDATE users SET subscription_plan=$1 WHERE company_id=$2`,
            [plan, companyId]
        );
    },

    // Company locations (firm plan — $499/location)
    async getCompanyLocations(companyId) {
        const result = await pool.query(
            `SELECT cl.*,
                    (SELECT COUNT(*) FROM users u WHERE u.company_id = $1 AND u.zip_code = cl.zip_code AND (u.is_active IS NULL OR u.is_active = TRUE)) AS agent_count
             FROM company_locations cl
             WHERE cl.company_id = $1 AND cl.is_active = TRUE
             ORDER BY cl.created_at ASC`,
            [companyId]
        );
        return result.rows;
    },

    async addCompanyLocation(companyId, zipCode, label) {
        const co = await pool.query(`SELECT plan FROM companies WHERE id = $1`, [companyId]);
        if (!co.rows[0] || co.rows[0].plan !== 'firm') {
            throw new Error('Multiple locations require the Firm plan ($499/location)');
        }
        let lat = null, lng = null;
        try {
            const geo = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${zipCode}&country=US&format=json&limit=1`, {
                headers: { 'User-Agent': 'RealtorFinder/1.0' }
            });
            const geoData = await geo.json();
            if (geoData.length > 0) { lat = parseFloat(geoData[0].lat); lng = parseFloat(geoData[0].lon); }
        } catch { /* geocoding optional */ }
        const result = await pool.query(
            `INSERT INTO company_locations (company_id, zip_code, label, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (company_id, zip_code) DO UPDATE SET label=EXCLUDED.label, is_active=TRUE
             RETURNING *`,
            [companyId, zipCode, label || null, lat, lng]
        );
        return result.rows[0];
    },

    async removeCompanyLocation(locationId, companyId) {
        await pool.query(
            `UPDATE company_locations SET is_active=FALSE WHERE id=$1 AND company_id=$2`,
            [locationId, companyId]
        );
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
                    email_verified, is_active, is_admin, is_approved, created_at
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
                (SELECT COUNT(*) FROM users WHERE user_type = 'buyer') as total_buyers,
                (SELECT COUNT(*) FROM listings WHERE deleted_at IS NULL) as total_listings,
                (SELECT COUNT(*) FROM listings WHERE status = 'active' AND deleted_at IS NULL) as active_listings,
                (SELECT COUNT(*) FROM offers) as total_offers,
                (SELECT COUNT(*) FROM messages) as total_messages,
                (SELECT COUNT(*) FROM waitlist) as total_waitlist,
                (SELECT COUNT(*) FROM waitlist) as waitlist_count
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
    },

    // ===== CITY PAGE METHODS =====

    async getCityPage(stateCode, slug) {
        const result = await pool.query(
            `SELECT * FROM city_pages WHERE state_code = $1 AND slug = $2 AND is_published = TRUE`,
            [stateCode.toUpperCase(), slug]
        );
        return result.rows[0];
    },

    async getCitiesByState(stateCode) {
        const result = await pool.query(
            `SELECT slug, name, county, median_price, price_trend, avg_dom
             FROM city_pages WHERE state_code = $1 AND is_published = TRUE
             ORDER BY name ASC`,
            [stateCode.toUpperCase()]
        );
        return result.rows;
    },

    async getPublishedStates() {
        const result = await pool.query(
            `SELECT state_code, state_name, COUNT(*) AS city_count
             FROM city_pages WHERE is_published = TRUE
             GROUP BY state_code, state_name
             ORDER BY state_name ASC`
        );
        return result.rows;
    },

    async getAllPublishedCities() {
        const result = await pool.query(
            `SELECT state_code, slug, updated_at FROM city_pages
             WHERE is_published = TRUE ORDER BY state_code, name`
        );
        return result.rows;
    },

    async getCityLiveCounts(zip) {
        const [listings, realtors] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) FROM listings WHERE zip = $1 AND deleted_at IS NULL`,
                [zip]
            ),
            pool.query(
                `SELECT COUNT(*) FROM users WHERE zip_code = $1 AND user_type = 'realtor' AND (is_active IS NULL OR is_active = TRUE)`,
                [zip]
            )
        ]);
        return {
            listingCount: parseInt(listings.rows[0].count),
            realtorCount: parseInt(realtors.rows[0].count)
        };
    },

    async upsertCityPage(data) {
        const {
            slug, name, stateCode, stateName, county, zip, population,
            medianPrice, priceTrend, avgDom, description, neighborhoods,
            nearby, sellerHook, realtorHook, isPublished = true
        } = data;
        const result = await pool.query(
            `INSERT INTO city_pages
                (slug, name, state_code, state_name, county, zip, population, median_price, price_trend, avg_dom,
                 description, neighborhoods, nearby, seller_hook, realtor_hook, is_published, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
             ON CONFLICT (state_code, slug) DO UPDATE SET
                name=EXCLUDED.name, county=EXCLUDED.county, zip=EXCLUDED.zip,
                population=EXCLUDED.population, median_price=EXCLUDED.median_price,
                price_trend=EXCLUDED.price_trend, avg_dom=EXCLUDED.avg_dom,
                description=EXCLUDED.description, neighborhoods=EXCLUDED.neighborhoods,
                nearby=EXCLUDED.nearby, seller_hook=EXCLUDED.seller_hook,
                realtor_hook=EXCLUDED.realtor_hook, is_published=EXCLUDED.is_published,
                updated_at=NOW()
             RETURNING *`,
            [slug, name, stateCode, stateName, county, zip, population,
             medianPrice, priceTrend, avgDom ? parseInt(avgDom) : null,
             description, neighborhoods, nearby, sellerHook, realtorHook, isPublished]
        );
        return result.rows[0];
    },

    async toggleCityPagePublished(id) {
        const result = await pool.query(
            `UPDATE city_pages SET is_published = NOT is_published, updated_at = NOW()
             WHERE id = $1 RETURNING id, name, state_code, is_published`,
            [id]
        );
        return result.rows[0];
    }
};

module.exports = { pool, db };
