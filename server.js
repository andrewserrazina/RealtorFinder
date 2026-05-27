// server.js - Production-ready Express backend with database
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { upload, uploadToCloudinary } = require('./config/cloudinary');

const { db, pool } = require('./db');
const emailService = require('./email');
const auth = require('./auth');
const cities = require('./cities');
const { generateCityPage } = require('./cityTemplate');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - important for Render
app.set('trust proxy', 1);

// Middleware
const allowedOrigin = process.env.FRONTEND_URL || true; // set FRONTEND_URL=https://yourdomain.com in production
app.use(cors({
    origin: allowedOrigin,
    credentials: true
}));
app.use(express.json());

// Session configuration
const sessionStore = new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
});

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'realtorfinder-temp-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true, // Trust the reverse proxy
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: true,
        sameSite: 'lax' // Back to lax since same domain
    }
}));

// Attach user to all requests
app.use(auth.attachUser);
// Static files will be added AFTER page routes

// Helper function to format date
function formatDate(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Posted today';
    if (diffDays === 1) return 'Posted 1 day ago';
    return `Posted ${diffDays} days ago`;
}

// Geocode a full address string using Nominatim (OpenStreetMap)
function geocodeAddress(address) {
    return new Promise((resolve) => {
        const query = encodeURIComponent(address + ', USA');
        const options = {
            hostname: 'nominatim.openstreetmap.org',
            path: `/search?format=json&q=${query}&limit=1`,
            headers: { 'User-Agent': 'RealtorFinder/1.0' }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const results = JSON.parse(data);
                    if (results.length > 0) {
                        resolve({ latitude: parseFloat(results[0].lat), longitude: parseFloat(results[0].lon) });
                    } else {
                        resolve(null);
                    }
                } catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

// Simple in-memory rate limiter (windowMs = window in ms, max = max requests per window per IP)
function createRateLimiter(windowMs, max, message) {
    const hits = new Map();
    setInterval(() => hits.clear(), windowMs).unref();
    return (req, res, next) => {
        const key = req.ip;
        const count = (hits.get(key) || 0) + 1;
        hits.set(key, count);
        if (count > max) {
            return res.status(429).json({ error: message || 'Too many requests. Please try again later.' });
        }
        next();
    };
}

const authLimiter     = createRateLimiter(15 * 60 * 1000, 20, 'Too many attempts. Please try again in 15 minutes.');
const waitlistLimiter = createRateLimiter(60 * 60 * 1000, 5,  'Too many signups from this IP. Please try again later.');

// ===== API ROUTES =====

// ===== AUTHENTICATION ROUTES =====

// Signup
app.post('/api/auth/signup', authLimiter, async (req, res) => {
    try {
        const { email, password, userType, firstName, lastName, zipCode, companyName } = req.body;

        if (!email || !password || !userType || !firstName || !lastName || !zipCode) {
            return res.status(400).json({ error: 'All fields required' });
        }

        if (!['seller', 'realtor', 'buyer'].includes(userType)) {
            return res.status(400).json({ error: 'Invalid user type' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const user = await auth.createUser(email, password, userType, firstName, lastName, zipCode);

        // Realtors automatically get a company (solo company if no name provided)
        if (userType === 'realtor') {
            const name = (companyName || '').trim() || `${firstName} ${lastName}`;
            try {
                await db.createCompany(name, user.id, 'basic');
            } catch (companyErr) {
                console.error('Company creation failed (non-fatal):', companyErr.message);
            }
        }

        // Send verification email (non-blocking)
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const verifyExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await db.setVerificationToken(user.id, verifyToken, verifyExpiry);
        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
        emailService.sendEmailVerification(user.email, `${baseUrl}/api/auth/verify-email?token=${verifyToken}`)
            .catch(err => console.error('Verification email failed:', err.message));

        // Create session
        req.session.userId = user.id;
        req.session.userType = user.user_type;
        req.session.firstName = user.first_name;
        req.session.lastName = user.last_name;
        req.session.zipCode = user.zip_code;
        req.session.emailVerified = false;
        req.session.isApproved = false; // new signups go to waitlist

        res.json({
            success: true,
            userId: user.id,
            email: user.email,
            userType: user.user_type,
            firstName: user.first_name,
            lastName: user.last_name,
            zipCode: user.zip_code,
            emailVerified: false,
            isApproved: false
        });
    } catch (error) {
        console.error('Signup error:', error);
        if (error.message === 'Email already registered') {
            return res.status(400).json({ error: 'Email already registered' });
        }
        res.status(500).json({ error: 'Failed to create account' });
    }
});

// ===== COMPANY ROUTES =====

// Get current realtor's company
app.get('/api/company', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const user = await db.getProfile(req.user.id);
        if (!user.company_id) return res.json(null);
        const company = await db.getCompany(user.company_id);
        const members = await db.getCompanyMembers(user.company_id);
        const locations = await db.getCompanyLocations(user.company_id);
        res.json({ company, members, locations });
    } catch (err) {
        console.error('GET /api/company error:', err);
        res.status(500).json({ error: 'Failed to load company' });
    }
});

// Update company plan (owner only)
app.put('/api/company/plan', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { plan } = req.body;
        if (!['basic', 'professional', 'firm'].includes(plan)) {
            return res.status(400).json({ error: 'Invalid plan' });
        }
        const user = await db.getProfile(req.user.id);
        if (!user.company_id || user.company_role !== 'owner') {
            return res.status(403).json({ error: 'Only the company owner can change the plan' });
        }
        await db.updateCompanyPlan(user.company_id, plan);
        res.json({ success: true });
    } catch (err) {
        console.error('PUT /api/company/plan error:', err);
        res.status(500).json({ error: 'Failed to update plan' });
    }
});

// Add an agent to the company (owner only) — by email lookup
app.post('/api/company/agents', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { email, zipCode } = req.body;
        if (!email || !zipCode) return res.status(400).json({ error: 'email and zipCode required' });

        const owner = await db.getProfile(req.user.id);
        if (!owner.company_id || owner.company_role !== 'owner') {
            return res.status(403).json({ error: 'Only the company owner can add agents' });
        }

        const agent = await db.getUserByEmail(email.toLowerCase().trim());
        if (!agent) return res.status(404).json({ error: 'No account found with that email' });
        if (agent.user_type !== 'realtor') return res.status(400).json({ error: 'User is not a realtor' });
        if (agent.company_id) return res.status(400).json({ error: 'That agent already belongs to a company' });

        await db.addAgentToCompany(agent.id, owner.company_id, zipCode);
        res.json({ success: true });
    } catch (err) {
        console.error('POST /api/company/agents error:', err);
        res.status(err.message.includes('Plan limit') ? 403 : 500).json({ error: err.message || 'Failed to add agent' });
    }
});

// Remove an agent from the company (owner only)
app.delete('/api/company/agents/:userId', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const owner = await db.getProfile(req.user.id);
        if (!owner.company_id || owner.company_role !== 'owner') {
            return res.status(403).json({ error: 'Only the company owner can remove agents' });
        }
        await db.removeAgentFromCompany(parseInt(req.params.userId), owner.company_id);
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE /api/company/agents error:', err);
        res.status(500).json({ error: 'Failed to remove agent' });
    }
});

// Add a location to the company (owner only, firm plan only)
app.post('/api/company/locations', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { zipCode, label } = req.body;
        if (!zipCode) return res.status(400).json({ error: 'zipCode required' });

        const owner = await db.getProfile(req.user.id);
        if (!owner.company_id || owner.company_role !== 'owner') {
            return res.status(403).json({ error: 'Only the company owner can add locations' });
        }
        const location = await db.addCompanyLocation(owner.company_id, zipCode, label);
        res.json(location);
    } catch (err) {
        console.error('POST /api/company/locations error:', err);
        res.status(err.message.includes('Firm plan') ? 403 : 500).json({ error: err.message || 'Failed to add location' });
    }
});

// Remove a location (owner only)
app.delete('/api/company/locations/:locationId', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const owner = await db.getProfile(req.user.id);
        if (!owner.company_id || owner.company_role !== 'owner') {
            return res.status(403).json({ error: 'Only the company owner can remove locations' });
        }
        await db.removeCompanyLocation(parseInt(req.params.locationId), owner.company_id);
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE /api/company/locations error:', err);
        res.status(500).json({ error: 'Failed to remove location' });
    }
});

// ===== BUYER REQUEST ROUTES =====

// Get current buyer's own request (buyer) OR list active requests (realtor)
app.get('/api/buyer-requests', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type === 'buyer') {
            const request = await db.getBuyerRequestByUser(req.session.userId);
            return res.json(request || null);
        }
        // Realtor: browse active requests with filters
        const { area, type, budgetMin, budgetMax, page = 1, limit = 20 } = req.query;
        const filters = {};
        if (area) filters.area = area;
        if (type) filters.type = type;
        if (budgetMin) filters.budgetMin = budgetMin;
        if (budgetMax) filters.budgetMax = budgetMax;
        const result = await db.getActiveBuyerRequests(filters, parseInt(page), Math.min(parseInt(limit), 50));
        // Also return which ones the realtor has already responded to
        const responded = await db.getRealtorBuyerResponses(req.session.userId);
        res.json({ ...result, responded });
    } catch (error) {
        console.error('Error fetching buyer requests:', error);
        res.status(500).json({ error: 'Failed to fetch buyer requests' });
    }
});

// Get responses for the logged-in buyer
app.get('/api/buyer-requests/responses', auth.requireAuth, async (req, res) => {
    try {
        const responses = await db.getResponsesForBuyer(req.session.userId);
        res.json(responses);
    } catch (error) {
        console.error('Error fetching buyer responses:', error);
        res.status(500).json({ error: 'Failed to fetch responses' });
    }
});

// Create a buyer request
app.post('/api/buyer-requests', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'buyer') return res.status(403).json({ error: 'Buyers only' });
        const user = req.user;
        const data = {
            ...req.body,
            firstName: user.first_name,
            lastName: user.last_name,
            email: user.email,
            zipCode: user.zip_code
        };
        const coords = await geocodeAddress(`${user.zip_code}, USA`);
        if (coords) { data.latitude = coords.latitude; data.longitude = coords.longitude; }
        const request = await db.createBuyerRequest(req.session.userId, data);
        emailService.sendBuyerRequestConfirmation(request).catch(err =>
            console.error('Buyer request email failed:', err.message)
        );
        res.status(201).json(request);
    } catch (error) {
        console.error('Error creating buyer request:', error);
        res.status(500).json({ error: 'Failed to create buyer request' });
    }
});

// Update a buyer request
app.put('/api/buyer-requests/:id', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'buyer') return res.status(403).json({ error: 'Buyers only' });
        const updated = await db.updateBuyerRequest(req.params.id, req.session.userId, req.body);
        if (!updated) return res.status(404).json({ error: 'Request not found' });
        res.json(updated);
    } catch (error) {
        console.error('Error updating buyer request:', error);
        res.status(500).json({ error: 'Failed to update buyer request' });
    }
});

// Deactivate a buyer request
app.delete('/api/buyer-requests/:id', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'buyer') return res.status(403).json({ error: 'Buyers only' });
        await db.deleteBuyerRequest(req.params.id, req.session.userId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting buyer request:', error);
        res.status(500).json({ error: 'Failed to delete buyer request' });
    }
});

// Realtor responds to a buyer request
app.post('/api/buyer-requests/:id/respond', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { message } = req.body;
        if (!message || message.trim().length < 10) {
            return res.status(400).json({ error: 'Message must be at least 10 characters' });
        }
        const request = await db.getBuyerRequestById(req.params.id);
        if (!request) return res.status(404).json({ error: 'Buyer request not found' });
        await db.respondToBuyerRequest(req.params.id, req.session.userId, message);
        // Email the buyer
        emailService.sendRealtorBuyerLeadEmail(request.user_email, request.first_name, req.user, message)
            .catch(err => console.error('Buyer lead email failed:', err.message));
        res.json({ success: true });
    } catch (error) {
        console.error('Error responding to buyer request:', error);
        res.status(500).json({ error: 'Failed to send response' });
    }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        console.log('🔑 Login attempt for:', req.body.email);
        
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        const user = await auth.verifyUser(email, password);
        
        if (!user) {
            console.log('❌ Invalid credentials');
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        console.log('✅ User verified:', user.id, user.userType);
        
        // Create session
        req.session.userId = user.id;
        req.session.userType = user.userType;
        req.session.firstName = user.firstName;
        req.session.lastName = user.lastName;
        req.session.zipCode = user.zipCode;
        req.session.isApproved = user.isApproved || false;

        console.log('💾 Attempting to save session...');

        // Force save the session
        req.session.save((err) => {
            if (err) {
                console.error('❌ Session save error:', err);
                return res.status(500).json({ error: 'Session save failed' });
            }

            console.log('✅ Session saved successfully!');
            console.log('   Session ID:', req.sessionID);
            console.log('   User ID:', req.session.userId);
            console.log('   User Type:', req.session.userType);

            res.json({
                success: true,
                userId: user.id,
                email: user.email,
                userType: user.userType,
                firstName: user.firstName,
                lastName: user.lastName,
                zipCode: user.zipCode,
                isApproved: user.isApproved || false
            });
        });
    } catch (error) {
        console.error('💥 Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ success: true });
    });
});

// Get current user
app.get('/api/auth/me', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
        id: req.user.id,
        email: req.user.email,
        userType: req.user.user_type,
        firstName: req.user.first_name,
        lastName: req.user.last_name,
        zipCode: req.user.zip_code,
        emailVerified: req.user.email_verified || false,
        isAdmin: req.user.is_admin || false
    });
});

// Verify email via token link
app.get('/api/auth/verify-email', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.redirect('/login?error=missing_token');
    try {
        const user = await db.verifyEmailToken(token);
        if (!user) return res.redirect('/login?error=invalid_token');
        if (req.session?.userId === user.id) req.session.emailVerified = true;
        const dashMap = { seller: '/dashboard/seller', realtor: '/dashboard/realtor', buyer: '/dashboard/buyer' };
        const dash = dashMap[user.user_type] || '/dashboard/seller';
        res.redirect(`${dash}?verified=1`);
    } catch (error) {
        console.error('Email verification error:', error);
        res.redirect('/login?error=verification_failed');
    }
});

// Resend verification email
app.post('/api/auth/resend-verification', auth.requireAuth, authLimiter, async (req, res) => {
    try {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await db.setVerificationToken(req.session.userId, token, expiresAt);
        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
        const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;
        await emailService.sendEmailVerification(req.user.email, verifyUrl);
        res.json({ success: true });
    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Failed to send verification email' });
    }
});

// Forgot password
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
    }
    try {
        const user = await db.getUserByEmail(email);
        // Always return success to prevent email enumeration
        if (user) {
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
            await db.createPasswordResetToken(user.id, token, expiresAt);
            const baseUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
            const resetUrl = `${baseUrl}/reset-password?token=${token}`;
            await emailService.sendPasswordResetEmail(user.email, resetUrl).catch(err =>
                console.error('Reset email send failed:', err.message)
            );
        }
        res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// Reset password
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Token and a password of at least 8 characters are required' });
    }
    try {
        const row = await db.getUserByResetToken(token);
        if (!row) return res.status(400).json({ error: 'Invalid or expired reset link' });
        if (row.used) return res.status(400).json({ error: 'This reset link has already been used' });
        if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'This reset link has expired' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.updateUserPassword(row.id, hashedPassword);
        await db.markResetTokenUsed(token);
        res.json({ success: true, message: 'Password updated. You can now log in.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ===== LISTINGS ROUTES =====

function formatListing(listing) {
    return {
        id: listing.id,
        address: `${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}`,
        zip: listing.zip,
        price: listing.price,
        type: listing.property_type,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        sqft: listing.sqft,
        description: listing.description,
        image_urls: listing.image_urls,
        lat: listing.latitude ? parseFloat(listing.latitude) : null,
        lng: listing.longitude ? parseFloat(listing.longitude) : null,
        date: formatDate(listing.created_at),
        offerCount: parseInt(listing.offer_count) || 0,
        userId: listing.user_id,
        status: listing.status || 'active'
    };
}

// Get all listings
app.get('/api/listings', async (req, res) => {
    try {
        // Sellers see only their own listings (all statuses)
        if (req.user && req.user.user_type === 'seller') {
            const listings = await db.getUserListings(req.user.id);
            return res.json(listings.map(formatListing));
        }

        // Realtors/public: filtered, paginated, active only
        const { city, type, minPrice, maxPrice, minBeds, page = 1, limit = 20 } = req.query;
        const filters = {};
        if (city) filters.city = city;
        if (type) filters.type = type;
        if (minPrice) filters.minPrice = minPrice;
        if (maxPrice) filters.maxPrice = maxPrice;
        if (minBeds) filters.minBeds = minBeds;

        const result = await db.getFilteredListings(filters, parseInt(page), Math.min(parseInt(limit), 50));
        res.json({
            listings: result.listings.map(formatListing),
            total: result.total,
            page: result.page,
            limit: result.limit,
            totalPages: Math.ceil(result.total / result.limit)
        });
    } catch (error) {
        console.error('Error fetching listings:', error);
        res.status(500).json({ error: 'Failed to fetch listings' });
    }
});

// Get single listing
app.get('/api/listings/:id', async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) {
            return res.status(404).json({ error: 'Listing not found' });
        }
        res.json({
            ...listing,
            date: formatDate(listing.created_at)
        });
    } catch (error) {
        console.error('Error fetching listing:', error);
        res.status(500).json({ error: 'Failed to fetch listing' });
    }
});

// Create new listing (requires authentication)
app.post('/api/listings', auth.requireAuth, async (req, res) => {
    try {
        const { address, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone } = req.body;
        
        // Parse address into components (basic parsing - could be enhanced with address validation API)
        const addressParts = address.split(',').map(s => s.trim());
        const city = addressParts[1] || '';
        const stateZip = addressParts[2] || '';
        const [state, zip] = stateZip.split(' ');
        
        // Validation
        if (!address || !price || !type || !bedrooms || !bathrooms || !sqft || !description || !ownerName || !ownerEmail || !ownerPhone) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        const fullAddress = `${addressParts[0]}, ${city}, ${state || ''} ${zip || ''}`.trim();
        const coords = await geocodeAddress(fullAddress);

        const listingData = {
            address: addressParts[0],
            city,
            state: state || '',
            zip: zip || '',
            price,
            type,
            bedrooms: parseInt(bedrooms),
            bathrooms: parseFloat(bathrooms),
            sqft: parseInt(sqft),
            description,
            ownerName,
            ownerEmail,
            ownerPhone,
            userId: req.session.userId,
            latitude: coords?.latitude || null,
            longitude: coords?.longitude || null
        };

        const newListing = await db.createListing(listingData);
        
        // Send confirmation email
        await emailService.sendListingConfirmation(newListing);
        
        res.status(201).json({
            ...newListing,
            date: formatDate(newListing.created_at)
        });
    } catch (error) {
        console.error('Error creating listing:', error);
        res.status(500).json({ error: 'Failed to create listing' });
    }
});

// Update a listing (owner only)
app.put('/api/listings/:id', auth.requireAuth, async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

        const { price, type, bedrooms, bathrooms, sqft, description } = req.body;
        if (!price || !type || !bedrooms || !bathrooms || !sqft || !description) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const updated = await db.updateListing(req.params.id, { price, type, bedrooms, bathrooms, sqft, description });
        res.json({ ...updated, date: formatDate(updated.created_at) });
    } catch (error) {
        console.error('Error updating listing:', error);
        res.status(500).json({ error: 'Failed to update listing' });
    }
});

// Submit offer for a listing (requires authentication)
app.post('/api/listings/:id/offers', auth.requireAuth, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);
        const listing = await db.getListingById(listingId);
        
        if (!listing) {
            return res.status(404).json({ error: 'Listing not found' });
        }
        
        const { realtorName, brokerage, realtorEmail, realtorPhone, commission, offerDetails } = req.body;
        
        // Validation
        if (!realtorName || !brokerage || !realtorEmail || !realtorPhone || !offerDetails) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        const offerData = {
            realtorName,
            brokerage,
            realtorEmail,
            realtorPhone,
            commission: commission || null,
            offerDetails,
            userId: req.session.userId  // Associate offer with logged-in realtor
        };
        
        const newOffer = await db.createOffer(listingId, offerData);
        
        // Send email notifications
        await emailService.sendOfferNotification(listing, newOffer);
        await emailService.sendOfferConfirmation(listing, newOffer);
        
        res.status(201).json({
            message: 'Offer submitted successfully',
            offer: newOffer
        });
    } catch (error) {
        console.error('Error submitting offer:', error);
        res.status(500).json({ error: 'Failed to submit offer' });
    }
});

// Accept or decline an offer (listing owner only)
app.put('/api/offers/:id/status', auth.requireAuth, async (req, res) => {
    try {
        const offerId = parseInt(req.params.id);
        const { action } = req.body; // 'accept' or 'decline'
        if (!['accept', 'decline'].includes(action)) {
            return res.status(400).json({ error: 'action must be accept or decline' });
        }

        // Verify the offer exists and belongs to the current seller's listing
        const offerRows = await pool.query(
            `SELECT o.*, l.user_id as listing_owner_id, l.address, l.city, l.state, l.zip, l.price,
                    l.owner_name, l.owner_email, l.owner_phone
             FROM offers o JOIN listings l ON o.listing_id = l.id WHERE o.id = $1`,
            [offerId]
        );
        if (!offerRows.rows.length) return res.status(404).json({ error: 'Offer not found' });
        const offerRow = offerRows.rows[0];
        if (offerRow.listing_owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

        if (action === 'accept') {
            const declinedOffers = await db.acceptOffer(offerId, offerRow.listing_id);
            // Notify winning realtor
            emailService.sendOfferAcceptedEmail(offerRow, offerRow).catch(err =>
                console.error('Offer accepted email failed:', err.message)
            );
            // Notify each losing realtor
            declinedOffers.forEach(declined => {
                emailService.sendOfferDeclinedEmail(declined, offerRow).catch(err =>
                    console.error('Offer declined email failed:', err.message)
                );
            });
            return res.json({ success: true, status: 'accepted' });
        }

        // decline single offer
        await db.declineOffer(offerId);
        emailService.sendOfferDeclinedEmail(offerRow, offerRow).catch(err =>
            console.error('Offer declined email failed:', err.message)
        );
        res.json({ success: true, status: 'declined' });
    } catch (error) {
        console.error('Error updating offer status:', error);
        res.status(500).json({ error: 'Failed to update offer status' });
    }
});

// Update listing status (seller only: active | sold)
app.put('/api/listings/:id/status', auth.requireAuth, async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

        const { status } = req.body;
        if (!['active', 'under_contract', 'sold'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        const updated = await db.updateListingStatus(req.params.id, status);
        res.json({ success: true, status: updated.status });
    } catch (error) {
        console.error('Error updating listing status:', error);
        res.status(500).json({ error: 'Failed to update listing status' });
    }
});

// Get all offers received across a seller's listings (seller only)
app.get('/api/seller/offers', auth.requireAuth, async (req, res) => {
    try {
        const offers = await db.getSellerOffers(req.session.userId);
        res.json(offers);
    } catch (error) {
        console.error('Error fetching seller offers:', error);
        res.status(500).json({ error: 'Failed to fetch offers' });
    }
});

// Get current user's offers (for realtors)
app.get('/api/my-offers', auth.requireAuth, async (req, res) => {
    try {
        const offers = await db.getUserOffers(req.session.userId);
        res.json(offers);
    } catch (error) {
        console.error('Error fetching user offers:', error);
        res.status(500).json({ error: 'Failed to fetch offers' });
    }
});

// Withdraw a pending offer (realtor only — must be own offer, must be pending)
app.delete('/api/offers/:id', auth.requireAuth, async (req, res) => {
    try {
        const offerId = parseInt(req.params.id);
        const offerRow = await pool.query(
            `SELECT * FROM offers WHERE id = $1`,
            [offerId]
        );
        if (!offerRow.rows.length) return res.status(404).json({ error: 'Offer not found' });
        const offer = offerRow.rows[0];
        if (offer.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        if (offer.status && offer.status !== 'pending') {
            return res.status(400).json({ error: 'Only pending offers can be withdrawn' });
        }
        await db.deleteOffer(offerId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error withdrawing offer:', error);
        res.status(500).json({ error: 'Failed to withdraw offer' });
    }
});

// Get offers for a listing (listing owner only)
app.get('/api/listings/:id/offers', auth.requireAuth, async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) {
            return res.status(404).json({ error: 'Listing not found' });
        }
        if (listing.user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const offers = await db.getOffersByListingId(req.params.id);
        res.json(offers);
    } catch (error) {
        console.error('Error fetching offers:', error);
        res.status(500).json({ error: 'Failed to fetch offers' });
    }
});

// Replace/update image list for a listing (seller only) — used to remove images
app.put('/api/listings/:id/images', auth.requireAuth, async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        const { imageUrls } = req.body;
        if (!Array.isArray(imageUrls)) return res.status(400).json({ error: 'imageUrls must be an array' });
        await db.updateListingImages(req.params.id, imageUrls);
        res.json({ success: true, imageUrls });
    } catch (error) {
        console.error('Error updating listing images:', error);
        res.status(500).json({ error: 'Failed to update images' });
    }
});

// Upload images for a listing
app.post('/api/listings/:id/images', upload.array('images', 10), async (req, res) => {
    try {
        const listingId = req.params.id;
        const imageUrls = [];

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No images provided' });
        }

        console.log(`Uploading ${req.files.length} images for listing ${listingId}`);
        
        // Upload each image to Cloudinary
        for (const file of req.files) {
            console.log(`Uploading ${file.originalname}...`);
            const result = await uploadToCloudinary(file.buffer);
            imageUrls.push(result.secure_url);
            console.log(`✅ Uploaded: ${result.secure_url}`);
        }
        
        // Update listing with image URLs in database
        await pool.query(
            'UPDATE listings SET image_urls = $1 WHERE id = $2',
            [imageUrls, listingId]
        );
        
        console.log(`✅ Successfully uploaded ${imageUrls.length} images to listing ${listingId}`);
        
        res.json({ 
            success: true, 
            imageUrls,
            message: `Successfully uploaded ${imageUrls.length} images`
        });
    } catch (error) {
        console.error('❌ Image upload error:', error);
        res.status(500).json({ 
            error: 'Failed to upload images',
            details: error.message 
        });
    }
});

// Soft-delete a listing (seller only)
app.delete('/api/listings/:id', auth.requireAuth, async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        await db.softDeleteListing(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting listing:', error);
        res.status(500).json({ error: 'Failed to delete listing' });
    }
});

// Get user profile
app.get('/api/profile', auth.requireAuth, async (req, res) => {
    try {
        const profile = await db.getProfile(req.session.userId);
        res.json(profile);
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// Update user profile
app.put('/api/profile', auth.requireAuth, async (req, res) => {
    try {
        const updated = await db.updateProfile(req.session.userId, req.body);
        res.json(updated);
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// ===== ADMIN ROUTES =====

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
}

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const stats = await db.getAdminStats();
        res.json(stats);
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await db.getAllUsersAdmin();
        res.json(users);
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.get('/api/admin/listings', requireAdmin, async (req, res) => {
    try {
        const listings = await db.getAllListingsAdmin();
        res.json(listings);
    } catch (error) {
        console.error('Admin listings error:', error);
        res.status(500).json({ error: 'Failed to fetch listings' });
    }
});

app.put('/api/admin/users/:id/deactivate', requireAdmin, async (req, res) => {
    try {
        const user = await db.deactivateUser(parseInt(req.params.id));
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    } catch (error) {
        console.error('Admin deactivate error:', error);
        res.status(500).json({ error: 'Failed to deactivate user' });
    }
});

app.put('/api/admin/users/:id/reactivate', requireAdmin, async (req, res) => {
    try {
        const user = await db.reactivateUser(parseInt(req.params.id));
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    } catch (error) {
        console.error('Admin reactivate error:', error);
        res.status(500).json({ error: 'Failed to reactivate user' });
    }
});

app.put('/api/admin/users/:id/approve', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE users SET is_approved = true WHERE id = $1 RETURNING id, email, is_approved`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user: rows[0] });
    } catch (error) {
        console.error('Admin approve error:', error);
        res.status(500).json({ error: 'Failed to approve user' });
    }
});

app.put('/api/admin/users/:id/unapprove', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE users SET is_approved = false WHERE id = $1 RETURNING id, email, is_approved`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user: rows[0] });
    } catch (error) {
        console.error('Admin unapprove error:', error);
        res.status(500).json({ error: 'Failed to unapprove user' });
    }
});

app.delete('/api/admin/listings/:id', requireAdmin, async (req, res) => {
    try {
        const listing = await db.adminDeleteListing(parseInt(req.params.id));
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        res.json({ success: true });
    } catch (error) {
        console.error('Admin delete listing error:', error);
        res.status(500).json({ error: 'Failed to delete listing' });
    }
});

app.get('/api/admin/leads', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, type, name, email, phone, city_name, state_code, created_at
             FROM city_leads
             ORDER BY created_at DESC
             LIMIT 1000`
        );
        res.json(rows);
    } catch (error) {
        console.error('Admin leads error:', error);
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});

app.get('/api/admin/leads/export.csv', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, type, name, email, phone, city_name, state_code, created_at
             FROM city_leads ORDER BY created_at DESC`
        );
        const header = 'ID,Type,Name,Email,Phone,City,State,Date\n';
        const csv = rows.map(r =>
            [r.id, r.type, r.name || '', r.email, r.phone || '', r.city_name || '', r.state_code || '',
             new Date(r.created_at).toISOString().slice(0, 10)]
            .map(v => `"${String(v).replace(/"/g, '""')}"`)
            .join(',')
        ).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="city-leads.csv"');
        res.send(header + csv);
    } catch (error) {
        console.error('Leads CSV error:', error);
        res.status(500).json({ error: 'Failed to export leads' });
    }
});

// Waitlist signup endpoint
app.post('/api/waitlist', waitlistLimiter, async (req, res) => {
    try {
        const { email, type } = req.body; // type = 'seller' or 'realtor'
        
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        
        const normalizedType = ['seller', 'realtor'].includes(type) ? type : 'seller';

        // Save to database
        const result = await pool.query(
            'INSERT INTO waitlist (email, user_type) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET user_type = $2 RETURNING *',
            [email.trim().toLowerCase(), normalizedType]
        );
        
        // Log the signup
        console.log(`📧 Waitlist signup: ${email} (${type})`);
        
        // Send confirmation email for both new and existing signups
        let emailSent = false;
        let emailErrorMessage = null;
        const isNewSignup = result.rows.length > 0;

        try {
            console.log('📤 Attempting to send email via emailService...');
            await emailService.sendWaitlistConfirmation(email.trim().toLowerCase(), normalizedType);
            emailSent = true;
            console.log('✅ Email sent successfully');
        } catch (emailError) {
            console.error('❌ EMAIL ERROR:', emailError.message);
            console.error('❌ FULL ERROR:', emailError);
            emailErrorMessage = emailError.message;
            // Don't fail the API call if email fails
        }
        
        res.json({
            success: true,
            message: isNewSignup ? 'Added to waitlist' : 'Already on waitlist',
            isNewSignup,
            emailSent,
            emailError: emailErrorMessage
        });
    } catch (error) {
        console.error('Waitlist error:', error);
        res.status(500).json({ error: 'Failed to add to waitlist' });
    }
});

// City page lead capture
app.post('/api/city-lead', waitlistLimiter, async (req, res) => {
    try {
        const { type, name, email, phone, city_slug, city_name, state_code } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        const normalizedType = ['seller', 'realtor'].includes(type) ? type : 'seller';

        await pool.query(
            `INSERT INTO city_leads (type, name, email, phone, city_slug, city_name, state_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                normalizedType,
                (name || '').trim().slice(0, 255) || null,
                email.trim().toLowerCase(),
                (phone || '').trim().slice(0, 50) || null,
                (city_slug || '').trim().slice(0, 100) || null,
                (city_name || '').trim().slice(0, 255) || null,
                (state_code || '').trim().toUpperCase().slice(0, 2) || null,
            ]
        );

        console.log(`🏠 City lead: ${normalizedType} in ${city_name}, ${state_code} — ${email}`);

        try {
            await emailService.sendWaitlistConfirmation(email.trim().toLowerCase(), normalizedType);
        } catch (emailErr) {
            console.error('City lead email failed:', emailErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('City lead error:', err);
        res.status(500).json({ error: 'Failed to save lead' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ===== SEO CITY PAGES =====

// API: cities by state (used by city page JS for nearby links)
app.get('/api/cities/:stateCode', async (req, res) => {
    try {
        const cities = await db.getCitiesByState(req.params.stateCode);
        res.json(cities);
    } catch (err) {
        res.json([]);
    }
});

// Redirect old /locations/:slug → /locations/ma/:slug for backwards compat
app.get('/locations/:citySlug', (req, res, next) => {
    const slug = req.params.citySlug;
    // If it looks like a state code (2 chars), let the state handler deal with it
    if (slug.length === 2) return next();
    // Check if it's an old western MA slug — redirect to /locations/ma/:slug
    const westernMaSlugs = ['springfield','northampton','amherst','holyoke','chicopee','pittsfield','westfield','longmeadow','easthampton','south-hadley','agawam','great-barrington'];
    if (westernMaSlugs.includes(slug)) {
        return res.redirect(301, `/locations/ma/${slug}`);
    }
    next();
});

// National locations index — browse by state
app.get('/locations', async (req, res) => {
    let states = [];
    try { states = await db.getPublishedStates(); } catch (e) { /* DB not migrated yet — show empty */ }

    const newEngland = ['MA','CT','RI','VT','NH','ME'];
    const neStates = states.filter(s => newEngland.includes(s.state_code));
    const otherStates = states.filter(s => !newEngland.includes(s.state_code));

    const stateCard = (s) => `
        <a href="/locations/${s.state_code.toLowerCase()}" class="state-card">
            <div class="state-code">${s.state_code}</div>
            <div class="state-name">${s.state_name}</div>
            <div class="state-count">${s.city_count} ${parseInt(s.city_count) === 1 ? 'city' : 'cities'}</div>
        </a>`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Real Estate Markets by City | RealtorFinder</title>
    <meta name="description" content="Find your city on RealtorFinder. Sellers list free, realtors compete for listings. Covering New England and growing nationwide.">
    <link rel="canonical" href="https://www.realtorfinder.net/locations">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>
    <style>
        :root{--primary:#0A2540;--accent:#FF6B35;--border:#e5e7eb;--soft-bg:#f8f9fa;}
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:'Work Sans',sans-serif;color:var(--primary);}
        nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(255,255,255,0.97);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:0 5%;display:flex;align-items:center;justify-content:space-between;height:68px;}
        .nav-logo{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:900;color:var(--primary);text-decoration:none;}
        .nav-logo span{color:var(--accent);}
        .nav-cta{background:var(--accent);color:#fff;padding:10px 22px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.95rem;}
        .hero{background:linear-gradient(135deg,var(--primary) 0%,#0d3a5c 100%);color:#fff;padding:130px 5% 70px;text-align:center;}
        .hero h1{font-family:'Playfair Display',serif;font-size:clamp(2rem,4vw,3.2rem);font-weight:900;margin-bottom:14px;}
        .hero h1 em{color:var(--accent);font-style:normal;}
        .hero p{font-size:1.1rem;opacity:0.85;max-width:560px;margin:0 auto;}
        .content{max-width:1100px;margin:0 auto;padding:60px 5%;}
        h2{font-family:'Playfair Display',serif;font-size:1.6rem;font-weight:900;margin-bottom:24px;color:var(--primary);}
        .section-label{font-size:0.78rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;}
        .states-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:52px;}
        .state-card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:20px;text-decoration:none;color:var(--primary);transition:all 0.2s;text-align:center;display:block;}
        .state-card:hover{border-color:var(--accent);box-shadow:0 6px 20px rgba(255,107,53,0.12);transform:translateY(-2px);}
        .state-code{font-family:'Playfair Display',serif;font-size:1.8rem;font-weight:900;color:var(--primary);}
        .state-name{font-size:0.85rem;color:#6b7280;margin:4px 0;}
        .state-count{font-size:0.78rem;color:var(--accent);font-weight:600;}
        footer{background:var(--primary);color:rgba(255,255,255,0.6);padding:32px 5%;text-align:center;font-size:0.84rem;}
        footer a{color:rgba(255,255,255,0.6);margin:0 8px;text-decoration:none;}
    </style>
</head>
<body>
<nav>
    <a href="/" class="nav-logo">Realtor<span>Finder</span></a>
    <a href="/login" class="nav-cta">Get Started Free</a>
</nav>
<div class="hero">
    <h1>Find Your Market on<br><em>RealtorFinder</em></h1>
    <p>Sellers list free. Realtors compete. Covering New England now — and growing nationwide.</p>
</div>
<div class="content">
    ${neStates.length ? `<div class="section-label">New England</div><h2>Our Home Market</h2><div class="states-grid">${neStates.map(stateCard).join('')}</div>` : ''}
    ${otherStates.length ? `<div class="section-label">Expanding Coverage</div><h2>More States</h2><div class="states-grid">${otherStates.map(stateCard).join('')}</div>` : ''}
    ${!states.length ? '<p style="color:#6b7280;text-align:center;padding:40px 0;">City pages loading — check back soon.</p>' : ''}
</div>
<footer>
    <p>© ${new Date().getFullYear()} RealtorFinder &nbsp;·&nbsp; <a href="/">Home</a><a href="/realtors">For Realtors</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></p>
</footer>
</body>
</html>`);
});

// State index page — /locations/ma
app.get('/locations/:stateCode', async (req, res, next) => {
    const stateCode = req.params.stateCode.toUpperCase();
    if (stateCode.length !== 2) return next();
    let cities = [];
    let stateName = stateCode;
    try {
        cities = await db.getCitiesByState(stateCode);
        if (cities.length === 0) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        stateName = cities[0].state_name || stateCode; // fallback
    } catch (e) {
        return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    }
    // Get stateName from DB
    try {
        const stateRes = await db.getPublishedStates();
        const s = stateRes.find(s => s.state_code === stateCode);
        if (s) stateName = s.state_name;
    } catch (e) {}

    const cards = cities.map(c => `
        <a href="/locations/${stateCode.toLowerCase()}/${c.slug}" class="city-card">
            <div class="city-name">${c.name}</div>
            <div class="city-meta">${c.county ? c.county + ' County · ' : ''}Median ${c.median_price || '—'}</div>
            <div class="city-trend">↑ ${(c.price_trend || '').replace('up ', '')} YoY &nbsp;·&nbsp; ${c.avg_dom || '—'} days avg.</div>
        </a>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${stateName} Real Estate Markets | RealtorFinder</title>
    <meta name="description" content="RealtorFinder covers every major city and town in ${stateName}. Sellers list free, realtors compete for listings.">
    <link rel="canonical" href="https://www.realtorfinder.net/locations/${stateCode.toLowerCase()}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>
    <style>
        :root{--primary:#0A2540;--accent:#FF6B35;--border:#e5e7eb;--soft-bg:#f8f9fa;}
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:'Work Sans',sans-serif;color:var(--primary);}
        nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(255,255,255,0.97);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:0 5%;display:flex;align-items:center;justify-content:space-between;height:68px;}
        .nav-logo{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:900;color:var(--primary);text-decoration:none;}
        .nav-logo span{color:var(--accent);}
        .nav-cta{background:var(--accent);color:#fff;padding:10px 22px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.95rem;}
        .hero{background:linear-gradient(135deg,var(--primary) 0%,#0d3a5c 100%);color:#fff;padding:130px 5% 70px;text-align:center;}
        .hero h1{font-family:'Playfair Display',serif;font-size:clamp(2rem,4vw,3.2rem);font-weight:900;margin-bottom:14px;}
        .hero h1 em{color:var(--accent);font-style:normal;}
        .hero p{font-size:1.1rem;opacity:0.85;max-width:560px;margin:0 auto;}
        .breadcrumb{font-size:0.85rem;text-align:center;margin-top:16px;opacity:0.7;}
        .breadcrumb a{color:rgba(255,255,255,0.8);text-decoration:underline;}
        .grid{max-width:1100px;margin:60px auto;padding:0 5%;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;}
        .city-card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:24px;text-decoration:none;color:var(--primary);transition:all 0.2s;display:block;}
        .city-card:hover{border-color:var(--accent);box-shadow:0 8px 24px rgba(255,107,53,0.12);transform:translateY(-2px);}
        .city-name{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:700;margin-bottom:6px;}
        .city-meta{font-size:0.85rem;color:#6b7280;margin-bottom:4px;}
        .city-trend{font-size:0.82rem;color:#16a34a;font-weight:600;}
        footer{background:var(--primary);color:rgba(255,255,255,0.6);padding:32px 5%;text-align:center;font-size:0.84rem;margin-top:60px;}
        footer a{color:rgba(255,255,255,0.6);margin:0 8px;text-decoration:none;}
    </style>
</head>
<body>
<nav>
    <a href="/" class="nav-logo">Realtor<span>Finder</span></a>
    <a href="/login" class="nav-cta">Get Started Free</a>
</nav>
<div class="hero">
    <h1><em>${stateName}</em><br>Real Estate Markets</h1>
    <p>Connecting home sellers and local realtors across every city and town in ${stateName}.</p>
    <div class="breadcrumb"><a href="/locations">← All States</a></div>
</div>
<div class="grid">${cards}</div>
<footer>
    <p>© ${new Date().getFullYear()} RealtorFinder &nbsp;·&nbsp; <a href="/">Home</a><a href="/locations">All Markets</a><a href="/realtors">For Realtors</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></p>
</footer>
</body>
</html>`);
});

// Individual city page — /locations/ma/northampton
app.get('/locations/:stateCode/:citySlug', async (req, res) => {
    try {
        const city = await db.getCityPage(req.params.stateCode, req.params.citySlug);
        if (!city) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        let liveData = { listingCount: 0, realtorCount: 0 };
        if (city.zip) {
            try { liveData = await db.getCityLiveCounts(city.zip); } catch (e) {}
        }
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(generateCityPage(city, liveData));
    } catch (err) {
        console.error('City page error:', err);
        res.status(500).send('Server error');
    }
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send('User-agent: *\nAllow: /\nDisallow: /dashboard/\nDisallow: /api/\nSitemap: https://www.realtorfinder.net/sitemap-index.xml\n');
});

// Sitemap index — points to per-state sitemaps
app.get('/sitemap-index.xml', async (req, res) => {
    const base = 'https://www.realtorfinder.net';
    const today = new Date().toISOString().split('T')[0];
    let states = [];
    try { states = await db.getPublishedStates(); } catch (e) {}
    const staticEntry = `  <sitemap><loc>${base}/sitemap-static.xml</loc><lastmod>${today}</lastmod></sitemap>`;
    const stateEntries = states.map(s =>
        `  <sitemap><loc>${base}/sitemap-${s.state_code.toLowerCase()}.xml</loc><lastmod>${today}</lastmod></sitemap>`
    ).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticEntry}\n${stateEntries}\n</sitemapindex>`);
});

// Static pages sitemap
app.get('/sitemap-static.xml', (req, res) => {
    const base = 'https://www.realtorfinder.net';
    const today = new Date().toISOString().split('T')[0];
    const urls = ['/', '/login', '/buyers', '/realtors', '/locations'];
    const entries = urls.map(u => `  <url><loc>${base}${u}</loc><lastmod>${today}</lastmod><priority>${u === '/' ? '1.0' : '0.7'}</priority></url>`).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`);
});

// Per-state city sitemap — /sitemap-ma.xml
app.get('/sitemap-:stateCode\\.xml', async (req, res) => {
    const stateCode = req.params.stateCode.toUpperCase();
    const base = 'https://www.realtorfinder.net';
    const today = new Date().toISOString().split('T')[0];
    let cities = [];
    try { cities = await db.getCitiesByState(stateCode); } catch (e) {}
    const stateEntry = `  <url><loc>${base}/locations/${stateCode.toLowerCase()}</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>`;
    const cityEntries = cities.map(c =>
        `  <url><loc>${base}/locations/${stateCode.toLowerCase()}/${c.slug}</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>`
    ).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${stateEntry}\n${cityEntries}\n</urlset>`);
});

// Legacy sitemap.xml redirect
app.get('/sitemap.xml', (req, res) => res.redirect(301, '/sitemap-index.xml'));

// ===== PAGE ROUTES (Must come AFTER API routes, BEFORE static files) =====

// Password reset page
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// Login page
app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
        if (!req.session.isApproved) return res.redirect('/waitlist');
        const dashMap2 = { seller: '/dashboard/seller', realtor: '/dashboard/realtor', buyer: '/dashboard/buyer' };
        const dashboardPath = dashMap2[req.session.userType] || '/dashboard/seller';
        return res.redirect(dashboardPath);
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Waitlist holding page
app.get('/waitlist', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'waitlist.html'));
});

// Seller landing page (homepage) — also serves realtors.html on realtors.realtorfinder.net
app.get('/', (req, res) => {
    if ((req.hostname || '').startsWith('realtors.')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.sendFile(path.join(__dirname, 'public', 'realtors.html'));
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Realtor landing page
app.get('/realtors', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'realtors.html'));
});

// Seller Dashboard (PROTECTED)
app.get('/dashboard/seller', (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    if (!req.session.isApproved) return res.redirect('/waitlist');
    if (req.session.userType !== 'seller') return res.redirect('/dashboard/realtor');
    res.sendFile(path.join(__dirname, 'public', 'seller-dashboard.html'));
});

// Realtor Dashboard (PROTECTED)
app.get('/dashboard/realtor', (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    if (!req.session.isApproved) return res.redirect('/waitlist');
    if (req.session.userType !== 'realtor') {
        const dest = req.session.userType === 'buyer' ? '/dashboard/buyer' : '/dashboard/seller';
        return res.redirect(dest);
    }
    res.sendFile(path.join(__dirname, 'public', 'realtor-dashboard.html'));
});

// Buyer Dashboard (PROTECTED)
app.get('/dashboard/buyer', (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    if (!req.session.isApproved) return res.redirect('/waitlist');
    if (req.session.userType !== 'buyer') {
        const dest = req.session.userType === 'realtor' ? '/dashboard/realtor' : '/dashboard/seller';
        return res.redirect(dest);
    }
    res.sendFile(path.join(__dirname, 'public', 'buyer-dashboard.html'));
});

// Buyer landing page
app.get('/buyers', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'buyers.html'));
});

// Legal pages
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Admin panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Main application (legacy)
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static files (CSS, JS, images) AFTER page routes
app.use(express.static('public', {
    index: false  // Don't serve index.html automatically
}));

// ===== ERROR HANDLING =====

// 404 — no route matched
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).sendFile(require('path').join(__dirname, 'public', 'landing.html'));
});

// Unhandled errors
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🏠 RealtorFinder server running on port ${PORT}`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`\n📄 Routes:`);
    console.log(`   / → Seller landing page`);
    console.log(`   /realtors → Realtor landing page`);
    console.log(`   /dashboard/seller → Seller dashboard`);
    console.log(`   /dashboard/realtor → Realtor dashboard`);
    console.log(`   /app → Main application (legacy)`);
});
