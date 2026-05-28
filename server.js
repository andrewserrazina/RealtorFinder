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
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

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
// Stripe webhook needs raw body; everything else gets JSON parsed
app.use((req, res, next) => {
    if (req.originalUrl === '/api/webhook/stripe') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

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

// Haversine distance in miles between two lat/lng points
function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Fire-and-forget: email nearby approved realtors about a new listing
async function notifyNearbyRealtors(listing) {
    try {
        if (!listing.latitude || !listing.longitude) return;
        const { rows } = await pool.query(
            `SELECT id, first_name, email, zip_code FROM users
             WHERE user_type = 'realtor' AND is_approved = true AND is_active IS NOT FALSE
               AND email IS NOT NULL AND zip_code IS NOT NULL
               AND (email_alerts IS NULL OR email_alerts = true)`
        );
        const RADIUS_MILES = 25;
        const MAX_EMAILS = 200;
        let sent = 0;
        for (const realtor of rows) {
            if (sent >= MAX_EMAILS) break;
            const coords = await geocodeAddress(`${realtor.zip_code}, USA`);
            if (!coords) continue;
            const dist = haversineMiles(listing.latitude, listing.longitude, coords.latitude, coords.longitude);
            if (dist <= RADIUS_MILES) {
                await emailService.sendNewListingAlert(realtor, listing, dist);
                sent++;
            }
        }
        if (sent > 0) console.log(`📬 Notified ${sent} realtors about listing ${listing.id}`);
    } catch (err) {
        console.error('notifyNearbyRealtors error:', err.message);
    }
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
        const { city, type, minPrice, maxPrice, minBeds, maxBeds, minBaths, zip, swLat, swLng, neLat, neLng, page = 1, limit = 50 } = req.query;
        const filters = {};
        if (city) filters.city = city;
        if (zip) filters.zip = zip;
        if (type) filters.type = type;
        if (minPrice) filters.minPrice = minPrice;
        if (maxPrice) filters.maxPrice = maxPrice;
        if (minBeds) filters.minBeds = minBeds;
        if (maxBeds) filters.maxBeds = maxBeds;
        if (minBaths) filters.minBaths = minBaths;
        if (swLat && swLng && neLat && neLng) { filters.swLat = swLat; filters.swLng = swLng; filters.neLat = neLat; filters.neLng = neLng; }

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
        const { address, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, zestimate } = req.body;
        
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
            zestimate: zestimate || null,
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
        
        // Send confirmation email to seller
        await emailService.sendListingConfirmation(newListing);

        // Notify nearby realtors (fire-and-forget — don't block the response)
        notifyNearbyRealtors(newListing);

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

        // Monthly proposal limit for basic plan
        const planRow = await pool.query(
            `SELECT COALESCE(c.plan, u.subscription_plan, 'basic') AS plan
             FROM users u LEFT JOIN companies c ON u.company_id = c.id
             WHERE u.id = $1`,
            [req.session.userId]
        );
        const realtorPlan = planRow.rows[0]?.plan || 'basic';
        if (realtorPlan === 'basic') {
            const countRow = await pool.query(
                `SELECT COUNT(*) AS cnt FROM offers
                 WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
                [req.session.userId]
            );
            if (parseInt(countRow.rows[0].cnt) >= 5) {
                return res.status(429).json({ error: "You've reached your 5 proposals/month limit on the Basic plan. Upgrade to Professional or Firm for unlimited proposals." });
            }
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

        // In-app notification for the seller
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link)
             VALUES ($1, 'offer', 'New Realtor Proposal', $2, '/dashboard/seller')`,
            [listing.user_id, `${realtorName} from ${brokerage} submitted a proposal on ${listing.address}`]
        ).catch(() => {});

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
            if (offerRow.user_id) {
                pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'offer_accepted','Proposal Accepted!',$2,'/dashboard/realtor')`,
                    [offerRow.user_id, `Your proposal on ${offerRow.address} was accepted!`]).catch(() => {});
            }
            // Notify each losing realtor
            declinedOffers.forEach(declined => {
                emailService.sendOfferDeclinedEmail(declined, offerRow).catch(err =>
                    console.error('Offer declined email failed:', err.message)
                );
                if (declined.user_id) {
                    pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'offer_declined','Proposal Declined',$2,'/dashboard/realtor')`,
                        [declined.user_id, `Your proposal on ${offerRow.address} was not selected.`]).catch(() => {});
                }
            });
            return res.json({ success: true, status: 'accepted' });
        }

        // decline single offer
        await db.declineOffer(offerId);
        emailService.sendOfferDeclinedEmail(offerRow, offerRow).catch(err =>
            console.error('Offer declined email failed:', err.message)
        );
        if (offerRow.user_id) {
            pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'offer_declined','Proposal Declined',$2,'/dashboard/realtor')`,
                [offerRow.user_id, `Your proposal on ${offerRow.address} was not selected.`]).catch(() => {});
        }
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

// Upload profile photo
app.post('/api/profile/photo', auth.requireAuth, upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No photo provided' });
        const result = await uploadToCloudinary(req.file.buffer);
        await pool.query(`UPDATE users SET profile_photo = $1 WHERE id = $2`, [result.secure_url, req.session.userId]);
        res.json({ url: result.secure_url });
    } catch (error) {
        console.error('Profile photo upload error:', error);
        res.status(500).json({ error: 'Failed to upload photo' });
    }
});

app.put('/api/profile/password', auth.requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both current and new password are required' });
        if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
        const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

app.put('/api/profile/email-alerts', auth.requireAuth, async (req, res) => {
    try {
        const { enabled } = req.body;
        await pool.query(
            'UPDATE users SET email_alerts = $1 WHERE id = $2',
            [enabled !== false, req.session.userId]
        );
        res.json({ success: true, email_alerts: enabled !== false });
    } catch (err) {
        console.error('Email alerts pref error:', err);
        res.status(500).json({ error: 'Failed to update preference' });
    }
});

app.get('/api/analytics/realtor', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const [totalRow, wonRow, monthRow, planRow] = await Promise.all([
            pool.query('SELECT COUNT(*) AS cnt FROM offers WHERE user_id = $1', [uid]),
            pool.query("SELECT COUNT(*) AS cnt FROM offers WHERE user_id = $1 AND status = 'accepted'", [uid]),
            pool.query("SELECT COUNT(*) AS cnt FROM offers WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())", [uid]),
            pool.query(`SELECT COALESCE(c.plan, u.subscription_plan, 'basic') AS plan FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = $1`, [uid])
        ]);
        const total = parseInt(totalRow.rows[0].cnt);
        const won = parseInt(wonRow.rows[0].cnt);
        const thisMonth = parseInt(monthRow.rows[0].cnt);
        const plan = planRow.rows[0]?.plan || 'basic';
        const winRate = total > 0 ? Math.round((won / total) * 100) : 0;
        const monthlyLimit = plan === 'basic' ? 5 : null;
        const remaining = monthlyLimit !== null ? Math.max(0, monthlyLimit - thisMonth) : null;
        res.json({ total, won, winRate, thisMonth, plan, monthlyLimit, remaining });
    } catch (err) {
        console.error('Realtor analytics error:', err);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ===== PROFILE COMPLETENESS =====

app.get('/api/profile/completeness', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT profile_photo, bio, service_areas, license_number, brokerage FROM users WHERE id = $1`,
            [req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const p = rows[0];
        const items = [
            { label: 'has_photo', done: !!p.profile_photo },
            { label: 'has_bio', done: !!(p.bio && p.bio.trim().length > 20) },
            { label: 'has_service_areas', done: !!(p.service_areas && p.service_areas.trim()) },
            { label: 'has_license', done: !!p.license_number },
            { label: 'has_brokerage', done: !!p.brokerage }
        ];
        const score = (items.filter(i => i.done).length / 5) * 100;
        res.json({ score, items });
    } catch (err) {
        console.error('Profile completeness error:', err);
        res.status(500).json({ error: 'Failed to compute completeness' });
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
            `UPDATE users SET is_approved = true WHERE id = $1 RETURNING id, email, first_name, user_type, is_approved`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const u = rows[0];
        emailService.sendAccountApprovedEmail(u.email, u.first_name, u.user_type)
            .catch(err => console.error('Approval email failed:', err.message));
        res.json({ success: true, user: u });
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

app.post('/api/admin/users/approve-all', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE users SET is_approved = true
             WHERE is_approved = false AND is_active IS NOT FALSE
             RETURNING id, email, first_name, user_type`
        );
        rows.forEach(u => {
            emailService.sendAccountApprovedEmail(u.email, u.first_name, u.user_type)
                .catch(err => console.error('Approval email failed:', err.message));
        });
        res.json({ success: true, count: rows.length });
    } catch (error) {
        console.error('Admin approve-all error:', error);
        res.status(500).json({ error: 'Failed to approve users' });
    }
});

app.post('/api/admin/send-weekly-digests', requireAdmin, async (req, res) => {
    try {
        const { rows: sellers } = await pool.query(
            `SELECT u.id, u.email, u.first_name,
                    COUNT(DISTINCT l.id) AS listing_count,
                    COUNT(DISTINCT o.id) AS new_offers,
                    COALESCE(SUM(l.view_count), 0) AS total_views
             FROM users u
             JOIN listings l ON l.user_id = u.id AND l.status = 'active'
             LEFT JOIN offers o ON o.listing_id = l.id AND o.created_at >= NOW() - INTERVAL '7 days'
             WHERE u.user_type = 'seller' AND u.is_approved = true AND u.is_active IS NOT FALSE
             GROUP BY u.id, u.email, u.first_name
             HAVING COUNT(DISTINCT l.id) > 0`
        );
        let sent = 0;
        for (const seller of sellers) {
            await emailService.sendSellerWeeklyDigest(seller).catch(e => console.error(`Digest failed for ${seller.email}:`, e.message));
            sent++;
        }
        res.json({ success: true, sent });
    } catch (err) {
        console.error('Weekly digest error:', err);
        res.status(500).json({ error: 'Failed to send digests' });
    }
});

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT r.id, r.rating, r.body, r.created_at,
                   r.realtor_id, r.seller_id,
                   ru.first_name || ' ' || ru.last_name AS realtor_name,
                   su.first_name || ' ' || su.last_name AS reviewer_name,
                   l.address AS listing_address
            FROM realtor_reviews r
            JOIN users ru ON ru.id = r.realtor_id
            JOIN users su ON su.id = r.seller_id
            LEFT JOIN listings l ON l.id = r.listing_id
            ORDER BY r.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Admin reviews error:', err);
        res.status(500).json({ error: 'Failed to fetch reviews' });
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

// Contact form submission
app.post('/api/contact', createRateLimiter(60 * 60 * 1000, 10, 'Too many contact requests. Please try again later.'), async (req, res) => {
    try {
        const { name, email, subject, message } = req.body;
        if (!name || !email || !subject || !message) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (!email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        console.log(`📩 Contact form: [${subject}] from ${name} <${email}>`);
        emailService.sendContactEmail({ name, email, subject, message })
            .catch(err => console.error('Contact email failed:', err.message));
        res.json({ ok: true });
    } catch (err) {
        console.error('Contact form error:', err);
        res.status(500).json({ error: 'Failed to send message' });
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

// ===== CONFIG ROUTES =====

// Expose public API keys to the frontend
app.get('/api/config/maps-key', (req, res) => {
    res.json({ mapboxKey: process.env.MAPBOX_API_KEY || null });
});

// ===== STRIPE ROUTES =====

const STRIPE_PRICE_IDS = {
    basic:        process.env.STRIPE_PRICE_BASIC,
    professional: process.env.STRIPE_PRICE_PROFESSIONAL,
    firm:         process.env.STRIPE_PRICE_FIRM
};

// Create Stripe Checkout session
app.post('/api/stripe/checkout', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    const { plan } = req.body;
    if (!['basic', 'professional', 'firm'].includes(plan)) {
        return res.status(400).json({ error: 'Invalid plan' });
    }
    const priceId = STRIPE_PRICE_IDS[plan];
    if (!priceId) return res.status(503).json({ error: 'stripe_not_configured' });

    try {
        const user = await auth.getUserById(req.session.userId);
        const base = process.env.FRONTEND_URL || 'https://www.realtorfinder.net';
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            customer_email: user.email,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${base}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${base}/pricing`,
            metadata: { userId: String(req.session.userId), plan }
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Stripe webhook — must receive raw body
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe not configured');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Stripe webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const sess = event.data.object;
        const userId = parseInt(sess.metadata?.userId);
        const plan   = sess.metadata?.plan;
        if (userId && plan) {
            try {
                await pool.query(
                    `UPDATE companies SET plan=$1, stripe_customer_id=$2, stripe_subscription_id=$3, updated_at=NOW() WHERE owner_user_id=$4`,
                    [plan, sess.customer, sess.subscription, userId]
                );
                await pool.query(
                    `UPDATE users SET subscription_plan=$1 WHERE id=$2`,
                    [plan, userId]
                );
                console.log(`✅ Stripe: upgraded user ${userId} to ${plan}`);
            } catch (err) {
                console.error('Stripe webhook DB error:', err);
            }
        }
    }

    if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        try {
            await pool.query(
                `UPDATE companies SET plan='basic', stripe_subscription_id=NULL, updated_at=NOW() WHERE stripe_customer_id=$1`,
                [sub.customer]
            );
            console.log(`⚠️ Stripe: subscription cancelled for customer ${sub.customer}`);
        } catch (err) {
            console.error('Stripe cancellation DB error:', err);
        }
    }

    res.json({ received: true });
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
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
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
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
    const today = new Date().toISOString().split('T')[0];
    const urls = ['/', '/realtors', '/pricing', '/about', '/buyers', '/locations', '/login', '/contact', '/faq'];
    const entries = urls.map(u => `  <url><loc>${base}${u}</loc><lastmod>${today}</lastmod><priority>${u === '/' ? '1.0' : '0.7'}</priority></url>`).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`);
});

// Per-state city sitemap — /sitemap-ma.xml
app.get('/sitemap-:stateCode\\.xml', async (req, res) => {
    const stateCode = req.params.stateCode.toUpperCase();
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
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

// Public listing detail (no auth required)
app.get('/api/listings/:id/public', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, address, city, state, zip, price, zestimate, property_type,
                    bedrooms, bathrooms, sqft, description, image_urls, status, created_at
             FROM listings WHERE id = $1 AND status != 'inactive'`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
        // Fire-and-forget view count increment
        pool.query(
            `UPDATE listings SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1`,
            [parseInt(req.params.id)]
        ).catch(() => {});
        res.json(rows[0]);
    } catch (err) {
        console.error('Public listing error:', err);
        res.status(500).json({ error: 'Failed to load listing' });
    }
});

// Founding realtor spot counter (public)
app.get('/api/realtors/founding-count', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT COUNT(*) AS count FROM users WHERE user_type = 'realtor' AND is_active IS NOT FALSE`
        );
        const claimed = Math.min(parseInt(rows[0].count) || 0, 100);
        res.json({ claimed, total: 100, remaining: Math.max(100 - claimed, 0) });
    } catch {
        res.json({ claimed: 0, total: 100, remaining: 100 });
    }
});

// ===== PUBLIC REALTOR SEARCH API =====

app.get('/api/realtors/search', async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
        const offset = (page - 1) * limit;
        const { zip, name } = req.query;

        const conditions = [
            `u.user_type = 'realtor'`,
            `u.is_approved = true`,
            `u.is_active IS NOT FALSE`
        ];
        const params = [];

        if (zip) {
            params.push(zip);
            conditions.push(`(u.zip_code = $${params.length} OR u.service_areas ILIKE '%' || $${params.length} || '%')`);
        }
        if (name) {
            params.push(name);
            conditions.push(`CONCAT(u.first_name, ' ', u.last_name) ILIKE '%' || $${params.length} || '%'`);
        }

        const where = conditions.join(' AND ');

        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM users u WHERE ${where}`,
            params
        );
        const total = parseInt(countResult.rows[0].total) || 0;

        params.push(limit);
        params.push(offset);
        const { rows } = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.bio, u.years_experience,
                    u.license_number, u.service_areas, u.subscription_plan, u.zip_code,
                    c.name AS company_name, c.plan AS company_plan
             FROM users u
             LEFT JOIN companies c ON u.company_id = c.id
             WHERE ${where}
             ORDER BY
               CASE u.subscription_plan
                 WHEN 'firm'         THEN 1
                 WHEN 'professional' THEN 2
                 ELSE 3
               END ASC,
               u.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            realtors: rows,
            total,
            page,
            pages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('Realtor search error:', err);
        res.status(500).json({ error: 'Failed to search realtors' });
    }
});

// ===== PUBLIC REALTOR PROFILE API =====

app.get('/api/realtors/:id/public', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.bio, u.years_experience,
                    u.license_number, u.service_areas, u.subscription_plan, u.zip_code,
                    u.profile_photo, c.name AS company_name, c.plan AS company_plan
             FROM users u
             LEFT JOIN companies c ON u.company_id = c.id
             WHERE u.id = $1 AND u.user_type = 'realtor' AND u.is_active IS NOT FALSE`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Realtor not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Public profile error:', err);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

// ===== SAVED LISTINGS =====

app.post('/api/saved-listings/:id', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `INSERT INTO saved_listings (user_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [req.session.userId, parseInt(req.params.id)]
        );
        res.json({ saved: true });
    } catch (err) { res.status(500).json({ error: 'Failed to save listing' }); }
});

app.delete('/api/saved-listings/:id', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM saved_listings WHERE user_id = $1 AND listing_id = $2`,
            [req.session.userId, parseInt(req.params.id)]
        );
        res.json({ saved: false });
    } catch (err) { res.status(500).json({ error: 'Failed to unsave listing' }); }
});

app.get('/api/saved-listings', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price, l.property_type,
                    l.bedrooms, l.bathrooms, l.sqft, l.image_urls, l.status,
                    COALESCE(l.view_count, 0) AS view_count,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = l.id) AS offer_count,
                    sl.created_at AS saved_at
             FROM saved_listings sl
             JOIN listings l ON l.id = sl.listing_id
             WHERE sl.user_id = $1 AND l.deleted_at IS NULL
             ORDER BY sl.created_at DESC`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch saved listings' }); }
});

// Return which listing IDs the current user has saved (used to render bookmark state)
app.get('/api/saved-listings/ids', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT listing_id FROM saved_listings WHERE user_id = $1`,
            [req.session.userId]
        );
        res.json(rows.map(r => r.listing_id));
    } catch (err) { res.status(500).json({ error: 'Failed to fetch saved ids' }); }
});

// ===== REALTOR REVIEWS =====

app.post('/api/realtors/:id/reviews', auth.requireAuth, async (req, res) => {
    try {
        const { rating, body, listingId } = req.body;
        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
        const { rows } = await pool.query(
            `INSERT INTO realtor_reviews (realtor_id, seller_id, listing_id, rating, body)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (seller_id, listing_id) DO UPDATE SET rating=$4, body=$5, created_at=NOW()
             RETURNING *`,
            [parseInt(req.params.id), req.session.userId, listingId || null, rating, body || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Review error:', err);
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

app.get('/api/realtors/:id/reviews', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT r.id, r.rating, r.body, r.created_at,
                    u.first_name, u.last_name,
                    l.address AS listing_address
             FROM realtor_reviews r
             JOIN users u ON u.id = r.seller_id
             LEFT JOIN listings l ON l.id = r.listing_id
             WHERE r.realtor_id = $1
             ORDER BY r.created_at DESC`,
            [parseInt(req.params.id)]
        );
        const avg = rows.length ? (rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(1) : null;
        res.json({ reviews: rows, avg, count: rows.length });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch reviews' }); }
});

// ===== REALTOR REVIEWS TABLE INIT =====
pool.query(`
    CREATE TABLE IF NOT EXISTS realtor_reviews (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER REFERENCES users(id),
        seller_id INTEGER REFERENCES users(id),
        listing_id INTEGER REFERENCES listings(id),
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        body TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(seller_id, listing_id)
    )
`).catch(err => console.error('realtor_reviews table init error:', err.message));

// ===== MESSAGING =====

// Ensure messages table exists
pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user_id INTEGER NOT NULL REFERENCES users(id),
        to_user_id INTEGER NOT NULL REFERENCES users(id),
        listing_id INTEGER REFERENCES listings(id),
        body TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
`).catch(err => console.error('messages table init error:', err.message));

// List conversations for current user
app.get('/api/messages/conversations', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const { rows } = await pool.query(`
            SELECT DISTINCT ON (conv_key)
                conv_key,
                other_user_id,
                u.first_name, u.last_name, u.user_type,
                listing_id,
                l.address AS listing_address,
                last_body,
                last_at,
                unread_count
            FROM (
                SELECT
                    LEAST(from_user_id, to_user_id)::text || '-' || GREATEST(from_user_id, to_user_id)::text || '-' || COALESCE(listing_id::text,'0') AS conv_key,
                    CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS other_user_id,
                    listing_id,
                    body AS last_body,
                    created_at AS last_at,
                    (SELECT COUNT(*) FROM messages m2
                     WHERE m2.to_user_id = $1
                       AND m2.from_user_id = CASE WHEN messages.from_user_id = $1 THEN messages.to_user_id ELSE messages.from_user_id END
                       AND COALESCE(m2.listing_id,0) = COALESCE(messages.listing_id,0)
                       AND m2.read_at IS NULL) AS unread_count
                FROM messages
                WHERE from_user_id = $1 OR to_user_id = $1
                ORDER BY created_at DESC
            ) sub
            JOIN users u ON u.id = sub.other_user_id
            LEFT JOIN listings l ON l.id = sub.listing_id
            ORDER BY conv_key, last_at DESC
        `, [uid]);
        res.json(rows);
    } catch (err) {
        console.error('conversations error:', err);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
});

// Get messages in a conversation thread
app.get('/api/messages/thread', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const withUser = parseInt(req.query.with);
        const listingId = req.query.listing ? parseInt(req.query.listing) : null;
        if (!withUser) return res.status(400).json({ error: 'with parameter required' });

        const { rows } = await pool.query(`
            SELECT m.id, m.from_user_id, m.to_user_id, m.body, m.read_at, m.created_at,
                   u.first_name, u.last_name
            FROM messages m
            JOIN users u ON u.id = m.from_user_id
            WHERE ((m.from_user_id = $1 AND m.to_user_id = $2) OR (m.from_user_id = $2 AND m.to_user_id = $1))
              AND ($3::int IS NULL OR m.listing_id = $3)
            ORDER BY m.created_at ASC
        `, [uid, withUser, listingId]);

        // Mark received messages as read
        await pool.query(`
            UPDATE messages SET read_at = NOW()
            WHERE to_user_id = $1 AND from_user_id = $2
              AND ($3::int IS NULL OR listing_id = $3) AND read_at IS NULL
        `, [uid, withUser, listingId]);

        res.json(rows);
    } catch (err) {
        console.error('thread error:', err);
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

// Send a message
app.post('/api/messages', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const { toUserId, listingId, body } = req.body;
        if (!toUserId || !body || !body.trim()) return res.status(400).json({ error: 'toUserId and body required' });

        const { rows } = await pool.query(`
            INSERT INTO messages (from_user_id, to_user_id, listing_id, body)
            VALUES ($1, $2, $3, $4) RETURNING *
        `, [uid, toUserId, listingId || null, body.trim()]);

        // Create notification for recipient
        await pool.query(`
            INSERT INTO notifications (user_id, type, title, body, link)
            VALUES ($1, 'message', 'New Message', $2, '/dashboard/' || (SELECT user_type FROM users WHERE id=$1))
            ON CONFLICT DO NOTHING
        `, [toUserId, `You have a new message`]).catch(() => {});

        // Fire-and-forget email notification
        (async () => {
            try {
                const [recipientRes, senderRes] = await Promise.all([
                    pool.query(`SELECT email FROM users WHERE id = $1`, [toUserId]),
                    pool.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [uid])
                ]);
                if (!recipientRes.rows.length) return;
                const recipientEmail = recipientRes.rows[0].email;
                const s = senderRes.rows[0] || {};
                const senderName = [s.first_name, s.last_name].filter(Boolean).join(' ') || 'Someone';
                let listingAddress = null;
                if (listingId) {
                    const lRes = await pool.query(`SELECT address FROM listings WHERE id = $1`, [listingId]);
                    if (lRes.rows.length) listingAddress = lRes.rows[0].address;
                }
                await emailService.sendMessageNotification(recipientEmail, senderName, listingAddress);
            } catch (_) {}
        })();

        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('send message error:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Unread message count
app.get('/api/messages/unread-count', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT COUNT(*) AS count FROM messages WHERE to_user_id = $1 AND read_at IS NULL`,
            [req.session.userId]
        );
        res.json({ count: parseInt(rows[0].count) });
    } catch (err) { res.status(500).json({ error: 'Failed to get count' }); }
});

// ===== NOTIFICATIONS =====

// Ensure notifications table exists
pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT,
        link VARCHAR(500),
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
`).catch(err => console.error('notifications table init error:', err.message));

// Get notifications for current user
app.get('/api/notifications', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, type, title, body, link, read_at, created_at
            FROM notifications WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 30
        `, [req.session.userId]);
        const unread = rows.filter(r => !r.read_at).length;
        res.json({ notifications: rows, unread });
    } catch (err) { res.status(500).json({ error: 'Failed to load notifications' }); }
});

// Mark one notification as read
app.put('/api/notifications/:id/read', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2`,
            [parseInt(req.params.id), req.session.userId]
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to mark read' }); }
});

// Mark all notifications as read
app.put('/api/notifications/read-all', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
            [req.session.userId]
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to mark all read' }); }
});

// ===== SAVED SEARCHES =====

pool.query(`
    CREATE TABLE IF NOT EXISTS saved_searches (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        label TEXT,
        city TEXT,
        zip TEXT,
        type TEXT,
        min_price INTEGER,
        max_price INTEGER,
        min_beds INTEGER,
        min_baths NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
`).catch(err => console.error('saved_searches table init error:', err.message));

app.post('/api/saved-searches', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const { label, city, zip, type, minPrice, maxPrice, minBeds, minBaths } = req.body;
        const { rows } = await pool.query(
            `INSERT INTO saved_searches (user_id, label, city, zip, type, min_price, max_price, min_beds, min_baths)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [uid, label || null, city || null, zip || null, type || null,
             minPrice ? parseInt(minPrice) : null, maxPrice ? parseInt(maxPrice) : null,
             minBeds ? parseInt(minBeds) : null, minBaths ? parseFloat(minBaths) : null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Save search error:', err);
        res.status(500).json({ error: 'Failed to save search' });
    }
});

app.get('/api/saved-searches', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM saved_searches WHERE user_id = $1 ORDER BY created_at DESC`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Get saved searches error:', err);
        res.status(500).json({ error: 'Failed to fetch saved searches' });
    }
});

app.delete('/api/saved-searches/:id', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 RETURNING id`,
            [parseInt(req.params.id), req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('Delete saved search error:', err);
        res.status(500).json({ error: 'Failed to delete saved search' });
    }
});

app.post('/api/admin/send-listing-alerts', requireAdmin, async (req, res) => {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const { rows: searches } = await pool.query(
            `SELECT ss.*, u.email, u.first_name FROM saved_searches ss
             JOIN users u ON u.id = ss.user_id
             WHERE u.is_active IS NOT FALSE`
        );
        let totalEmails = 0;
        for (const s of searches) {
            const conditions = [`l.status = 'active'`, `l.created_at >= $1`];
            const params = [since];
            let pi = 2;
            if (s.city) { conditions.push(`LOWER(l.city) = LOWER($${pi++})`); params.push(s.city); }
            if (s.zip) { conditions.push(`l.zip = $${pi++}`); params.push(s.zip); }
            if (s.type) { conditions.push(`l.property_type = $${pi++}`); params.push(s.type); }
            if (s.min_price) { conditions.push(`l.price_numeric >= $${pi++}`); params.push(s.min_price); }
            if (s.max_price) { conditions.push(`l.price_numeric <= $${pi++}`); params.push(s.max_price); }
            if (s.min_beds) { conditions.push(`l.bedrooms >= $${pi++}`); params.push(s.min_beds); }
            if (s.min_baths) { conditions.push(`l.bathrooms >= $${pi++}`); params.push(s.min_baths); }
            const { rows: matches } = await pool.query(
                `SELECT id, address, city, state, price, bedrooms, bathrooms FROM listings l
                 WHERE ${conditions.join(' AND ')} LIMIT 5`,
                params
            );
            if (matches.length > 0) {
                await emailService.sendListingAlert(s.email, s.first_name, s.label || 'Your saved search', matches)
                    .catch(err => console.error('Listing alert email failed:', err.message));
                totalEmails++;
            }
        }
        res.json({ sent: totalEmails });
    } catch (err) {
        console.error('Send listing alerts error:', err);
        res.status(500).json({ error: 'Failed to send alerts' });
    }
});

// ===== ANNOUNCE =====

app.post('/api/admin/announce', requireAdmin, async (req, res) => {
    try {
        const { subject, message, userType } = req.body;
        if (!subject || !message || !userType) return res.status(400).json({ error: 'subject, message, userType required' });
        const typeFilter = userType === 'all' ? '' : `AND user_type = '${['seller','realtor','buyer'].includes(userType) ? userType : 'seller'}'`;
        const { rows } = await pool.query(
            `SELECT email, first_name FROM users WHERE is_active IS NOT FALSE ${typeFilter}`
        );
        let sent = 0;
        for (const u of rows) {
            await emailService.sendAnnouncement(u.email, u.first_name, subject, message)
                .catch(err => console.error('Announcement email failed:', err.message));
            sent++;
        }
        res.json({ sent });
    } catch (err) {
        console.error('Announce error:', err);
        res.status(500).json({ error: 'Failed to send announcement' });
    }
});

// ===== PAGE ROUTES (Must come AFTER API routes, BEFORE static files) =====

// Password reset page
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// Public realtor profile page
app.get('/realtor/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'realtor-profile.html'));
});

// Public listing detail page
app.get('/listing/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.sendFile(path.join(__dirname, 'public', 'listing-detail.html'));
        const { rows } = await pool.query(
            `SELECT address, city, state, zip, price, bedrooms, bathrooms, sqft, property_type, description, image_urls, latitude, longitude FROM listings WHERE id = $1 AND status != 'inactive'`,
            [id]
        );
        if (!rows.length) return res.sendFile(path.join(__dirname, 'public', 'listing-detail.html'));
        const l = rows[0];
        const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
        const title = `${l.address}${l.city ? ', ' + l.city : ''} — RealtorFinder`;
        const desc = [
            l.price ? '$' + Number(l.price).toLocaleString() : null,
            l.bedrooms ? l.bedrooms + ' bed' : null,
            l.bathrooms ? l.bathrooms + ' bath' : null,
            l.sqft ? Number(l.sqft).toLocaleString() + ' sqft' : null
        ].filter(Boolean).join(' · ') + ' — View this home on RealtorFinder';
        const img = (Array.isArray(l.image_urls) && l.image_urls[0]) ? l.image_urls[0] : `${base}/og-default.png`;
        const canonicalUrl = `${base}/listing/${id}`;

        const jsonLd = {
            '@context': 'https://schema.org',
            '@type': 'RealEstateListing',
            name: l.address,
            description: l.description || desc,
            url: canonicalUrl,
            image: Array.isArray(l.image_urls) ? l.image_urls : (l.image_urls ? [l.image_urls] : []),
            address: {
                '@type': 'PostalAddress',
                streetAddress: l.address,
                addressLocality: l.city,
                addressRegion: l.state,
                postalCode: l.zip,
                addressCountry: 'US'
            },
            ...(l.bedrooms ? { numberOfRooms: l.bedrooms } : {}),
            ...(l.sqft ? { floorSize: { '@type': 'QuantitativeValue', value: l.sqft, unitCode: 'FTK' } } : {}),
            ...(l.price ? { offers: { '@type': 'Offer', price: String(l.price).replace(/[^0-9]/g, ''), priceCurrency: 'USD' } } : {}),
            ...(l.latitude && l.longitude ? { geo: { '@type': 'GeoCoordinates', latitude: l.latitude, longitude: l.longitude } } : {})
        };

        const fs = require('fs');
        let html = fs.readFileSync(path.join(__dirname, 'public', 'listing-detail.html'), 'utf8');
        html = html
            .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
            .replace(/(<meta name="description" content=")[^"]*(")/i, `$1${desc}$2`)
            .replace(/(<meta property="og:title" content=")[^"]*(")/i, `$1${title}$2`)
            .replace(/(<meta property="og:description" content=")[^"]*(")/i, `$1${desc}$2`)
            .replace(/(<meta property="og:image" content=")[^"]*(")/i, `$1${img}$2`)
            .replace(/(<meta property="og:url" content=")[^"]*(")/i, `$1${canonicalUrl}$2`)
            .replace(/(<meta name="twitter:title" content=")[^"]*(")/i, `$1${title}$2`)
            .replace(/(<meta name="twitter:description" content=")[^"]*(")/i, `$1${desc}$2`)
            .replace(/(<meta name="twitter:image" content=")[^"]*(")/i, `$1${img}$2`)
            .replace('</head>', `<link rel="canonical" href="${canonicalUrl}"><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head>`);
        res.send(html);
    } catch (err) {
        console.error('Listing OG SSR error:', err);
        res.sendFile(path.join(__dirname, 'public', 'listing-detail.html'));
    }
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

// Pricing page
app.get('/pricing', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Subscription success/cancel pages
app.get('/subscription/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'subscription-success.html'));
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
app.get('/features', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'features.html'));
});
app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});
app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});
app.get('/faq', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'faq.html'));
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
