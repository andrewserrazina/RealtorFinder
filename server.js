// server.js - Production-ready Express backend with database
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
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

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - important for Render
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
    contentSecurityPolicy: false, // Disabled — we use inline scripts and external CDNs
    crossOriginEmbedderPolicy: false
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Rate limiters
const authLimiterStrict = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { error: 'Too many attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    message: { error: 'Too many requests, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many uploads, please wait.' }
});

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

app.use(cookieParser());

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

// Apply rate limiters — auth routes get the strict one first, then general API limiter covers all /api/*
app.use('/api/auth', authLimiterStrict);
app.use('/api', apiLimiter);

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

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        if (firstName.length > 100 || lastName.length > 100) {
            return res.status(400).json({ error: 'Name must be 100 characters or less' });
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

        // Handle referral code from cookie (Feature 4)
        const refCode = req.cookies?.ref_code || (req.headers.cookie || '').match(/ref_code=([^;]+)/)?.[1];
        if (refCode) {
            try {
                const { rows: refRows } = await pool.query(
                    `SELECT id FROM users WHERE referral_code = $1 AND user_type = 'realtor'`,
                    [refCode]
                );
                if (refRows.length) {
                    const referrerId = refRows[0].id;
                    await pool.query(`UPDATE users SET referred_by = $1 WHERE id = $2`, [referrerId, user.id]);
                    // Notify referrer (non-blocking)
                    pool.query(`SELECT email, first_name, last_name FROM users WHERE id = $1`, [referrerId])
                        .then(async ({ rows: rr }) => {
                            if (!rr.length) return;
                            const { rows: countRows } = await pool.query(
                                `SELECT COUNT(*) AS cnt FROM users WHERE referred_by = $1`, [referrerId]
                            );
                            const newCount = parseInt(countRows[0].cnt, 10);
                            const newMemberName = `${user.first_name} ${user.last_name}`.trim();
                            emailService.sendReferralSignup(rr[0].email, rr[0].first_name, newMemberName, newCount)
                                .catch(e => console.error('Referral signup email failed:', e.message));
                        })
                        .catch(e => console.error('Referral notify query error:', e.message));
                }
            } catch(e) { console.error('Referral attribution error:', e.message); }
        }

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
        const { area, state, city, type, property_type, budgetMin, budget_min, budgetMax, budget_max, page = 1, limit = 20 } = req.query;
        const filters = {};
        const areaFilter = area || (state && city ? `${city}, ${state}` : city || state || null);
        if (areaFilter) filters.area = areaFilter;
        if (type || property_type) filters.type = type || property_type;
        if (budgetMin || budget_min) filters.budgetMin = budgetMin || budget_min;
        if (budgetMax || budget_max) filters.budgetMax = budgetMax || budget_max;
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
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for a verification link.' });
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
        const newRequest = await db.createBuyerRequest(req.session.userId, data);
        emailService.sendBuyerRequestConfirmation(newRequest).catch(err =>
            console.error('Buyer request email failed:', err.message)
        );

        // Fire-and-forget: find matching realtors and notify them
        (async () => {
            try {
                const req_data = newRequest;
                if (!req_data.target_areas) return;

                const terms = req_data.target_areas.split(',').map(t => t.trim()).filter(Boolean).slice(0, 5);
                if (!terms.length) return;

                const conditions = terms.map((_, i) => `u.service_areas ILIKE $${i + 1}`);
                const params = terms.map(t => `%${t}%`);

                const { rows: matchedRealtors } = await pool.query(
                    `SELECT u.id, u.first_name, u.last_name, u.email
                     FROM users u
                     WHERE u.user_type = 'realtor'
                       AND u.is_approved = true
                       AND u.is_active IS NOT FALSE
                       AND (${conditions.join(' OR ')})
                     LIMIT 20`,
                    params
                );

                for (const realtor of matchedRealtors) {
                    pool.query(
                        `INSERT INTO notifications (user_id, type, title, body, link)
                         VALUES ($1, 'buyer_match', 'New Buyer Looking in Your Area', $2, '/dashboard/realtor')`,
                        [realtor.id, `A buyer is looking for a ${req_data.property_type || 'home'} in ${req_data.target_areas} with a budget of ${req_data.budget_min ? '$' + Number(req_data.budget_min).toLocaleString() : 'unspecified'}–${req_data.budget_max ? '$' + Number(req_data.budget_max).toLocaleString() : 'open'}.`]
                    ).catch(() => {});

                    emailService.sendBuyerMatchEmail(realtor.email, realtor.first_name, req_data).catch(() => {});
                }
            } catch(e) { console.error('Buyer matching error:', e.message); }
        })();

        res.status(201).json(newRequest);
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
        status: listing.status || 'active',
        shareToken: listing.share_token || null,
        shareViews: parseInt(listing.share_views) || 0
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
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address before creating a listing. Check your inbox for a verification link.' });
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

        const numericPrice = parseFloat(String(price).replace(/[^0-9.]/g, ''));
        if (isNaN(numericPrice) || numericPrice <= 0) {
            return res.status(400).json({ error: 'Price must be a positive number' });
        }

        if (String(address).length > 200) {
            return res.status(400).json({ error: 'Address must be 200 characters or less' });
        }

        if (String(description).length > 5000) {
            return res.status(400).json({ error: 'Description must be 5000 characters or less' });
        }
        
        const fullAddress = `${addressParts[0]}, ${city}, ${state || ''} ${zip || ''}`.trim();
        const coords = await geocodeAddress(fullAddress);

        const listingData = {
            address: addressParts[0],
            city,
            state: state || '',
            zip: zip || '',
            price: numericPrice,
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

        // Generate share token
        const shareToken = require('crypto').randomBytes(12).toString('hex');
        await pool.query(`UPDATE listings SET share_token = $1 WHERE id = $2`, [shareToken, newListing.id]);
        newListing.share_token = shareToken;

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

        // Feature 2: When marked sold/closed, request review from seller
        if (status === 'sold') {
            (async () => {
                try {
                    const { rows: proposalRows } = await pool.query(
                        `SELECT p.realtor_id, u.first_name AS r_first, u.last_name AS r_last
                         FROM proposals p
                         JOIN users u ON u.id = p.realtor_id
                         WHERE p.listing_id = $1 AND p.status = 'accepted'
                         LIMIT 1`,
                        [parseInt(req.params.id)]
                    );
                    if (!proposalRows.length) return;
                    const pr = proposalRows[0];
                    const sellerRes = await pool.query(
                        `SELECT u.email, u.first_name, l.address, l.city, l.state
                         FROM users u JOIN listings l ON l.user_id = u.id
                         WHERE l.id = $1`,
                        [parseInt(req.params.id)]
                    );
                    if (!sellerRes.rows.length) return;
                    const sr = sellerRes.rows[0];
                    const addr = [sr.address, sr.city, sr.state].filter(Boolean).join(', ');
                    const realtorName = `${pr.r_first || ''} ${pr.r_last || ''}`.trim();
                    await emailService.sendReviewRequestEmail(sr.email, sr.first_name, pr.realtor_id, realtorName, addr);
                } catch(e) { console.error('Review request email failed:', e.message); }
            })();
        }

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
app.post('/api/listings/:id/images', uploadLimiter, upload.array('images', 10), async (req, res) => {
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
app.post('/api/profile/photo', auth.requireAuth, uploadLimiter, upload.single('photo'), async (req, res) => {
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

// ===== LICENSE VERIFICATION ROUTES =====

// Upload license document
app.post('/api/profile/license-doc', auth.requireAuth, uploadLimiter, upload.single('license_doc'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        const result = await uploadToCloudinary(req.file.buffer);
        await pool.query(
            `UPDATE users SET license_doc_url = $1, license_verified = FALSE, license_rejection_note = NULL WHERE id = $2`,
            [result.secure_url, req.session.userId]
        );
        res.json({ url: result.secure_url });
    } catch (err) {
        console.error('License doc upload error:', err);
        res.status(500).json({ error: 'Failed to upload license document' });
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

app.post('/api/admin/seed-cities', requireAdmin, async (req, res) => {
    const allCities = require('./cities');
    const stateNames = { MA:'Massachusetts', CT:'Connecticut', RI:'Rhode Island', VT:'Vermont', NH:'New Hampshire', ME:'Maine' };
    let seeded = 0;
    for (const c of allCities) {
        try {
            await db.upsertCityPage({
                slug: c.slug, name: c.name, stateCode: c.state,
                stateName: stateNames[c.state] || c.state,
                county: c.county || null, zip: c.zip || null,
                population: c.population || null, medianPrice: c.median_price || null,
                priceTrend: c.price_trend || null, avgDom: c.avg_dom || null,
                description: c.description || null, neighborhoods: c.neighborhoods || null,
                nearby: c.nearby || null, sellerHook: c.seller_hook || null,
                realtorHook: c.realtor_hook || null, isPublished: true,
            });
            seeded++;
        } catch(e) { console.error('Seed error for', c.slug, e.message); }
    }
    res.json({ seeded });
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

// ===== LICENSE QUEUE (admin) =====

app.get('/api/admin/license-queue', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, email, license_number, license_doc_url, created_at
             FROM users
             WHERE user_type = 'realtor'
               AND license_doc_url IS NOT NULL
               AND license_verified = FALSE
             ORDER BY created_at ASC`
        );
        res.json(rows);
    } catch (err) {
        console.error('License queue error:', err);
        res.status(500).json({ error: 'Failed to fetch license queue' });
    }
});

app.put('/api/admin/license-verify/:userId', requireAdmin, async (req, res) => {
    try {
        const { approved, note } = req.body;
        const userId = parseInt(req.params.userId);
        let userRow;
        if (approved) {
            const { rows } = await pool.query(
                `UPDATE users SET license_verified = TRUE, license_verified_at = NOW(), license_rejection_note = NULL
                 WHERE id = $1 RETURNING email, first_name`,
                [userId]
            );
            userRow = rows[0];
            if (userRow) {
                emailService.sendLicenseApproved(userRow.email, userRow.first_name)
                    .catch(err => console.error('License approved email failed:', err.message));
            }
        } else {
            const { rows } = await pool.query(
                `UPDATE users SET license_verified = FALSE, license_doc_url = NULL, license_rejection_note = $1
                 WHERE id = $2 RETURNING email, first_name`,
                [note || null, userId]
            );
            userRow = rows[0];
            if (userRow) {
                emailService.sendLicenseRejected(userRow.email, userRow.first_name, note)
                    .catch(err => console.error('License rejected email failed:', err.message));
            }
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('License verify error:', err);
        res.status(500).json({ error: 'Failed to process license verification' });
    }
});

// ===== ADMIN MODERATION: LISTINGS =====

app.put('/api/admin/listings/:id/status', requireAdmin, async (req, res) => {
    try {
        const { status, note } = req.body;
        if (!['active', 'rejected', 'archived'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        const { rows } = await pool.query(
            `UPDATE listings SET status = $1 WHERE id = $2
             RETURNING id, address, city, state, user_id`,
            [status, parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
        const listing = rows[0];
        if (status === 'rejected') {
            const sellerRes = await pool.query(
                `SELECT email, first_name FROM users WHERE id = $1`, [listing.user_id]
            );
            if (sellerRes.rows.length) {
                const seller = sellerRes.rows[0];
                const address = [listing.address, listing.city, listing.state].filter(Boolean).join(', ');
                emailService.sendListingRejected(seller.email, seller.first_name, address, note)
                    .catch(err => console.error('Listing rejected email failed:', err.message));
            }
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('Admin listing status error:', err);
        res.status(500).json({ error: 'Failed to update listing status' });
    }
});

// ===== ADMIN MODERATION: REVIEWS =====

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `DELETE FROM realtor_reviews WHERE id = $1 RETURNING id`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Review not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('Admin delete review error:', err);
        res.status(500).json({ error: 'Failed to delete review' });
    }
});

// ===== ADMIN IMPERSONATION =====

app.post('/api/admin/impersonate/:userId', requireAdmin, async (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, user_type FROM users WHERE id = $1`,
            [targetId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const target = rows[0];
        req.session.impersonating = req.session.userId;
        req.session.userId = targetId;
        req.session.userType = target.user_type;
        req.session.firstName = target.first_name;
        req.session.lastName = target.last_name;
        res.json({ ok: true, userType: target.user_type });
    } catch (err) {
        console.error('Impersonate error:', err);
        res.status(500).json({ error: 'Failed to impersonate user' });
    }
});

app.post('/api/admin/impersonate/end', auth.requireAuth, async (req, res) => {
    try {
        if (!req.session.impersonating) return res.status(400).json({ error: 'Not in impersonation mode' });
        const origId = req.session.impersonating;
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, user_type FROM users WHERE id = $1`,
            [origId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Original user not found' });
        const orig = rows[0];
        req.session.userId = origId;
        req.session.userType = orig.user_type;
        req.session.firstName = orig.first_name;
        req.session.lastName = orig.last_name;
        delete req.session.impersonating;
        res.json({ ok: true });
    } catch (err) {
        console.error('End impersonation error:', err);
        res.status(500).json({ error: 'Failed to end impersonation' });
    }
});

app.get('/api/admin/impersonate/status', auth.requireAuth, async (req, res) => {
    try {
        if (!req.session.impersonating) return res.json({ impersonating: false, originalName: '' });
        const { rows } = await pool.query(
            `SELECT first_name, last_name FROM users WHERE id = $1`,
            [req.session.impersonating]
        );
        const name = rows.length ? `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim() : 'Admin';
        res.json({ impersonating: true, originalName: name });
    } catch (err) {
        res.json({ impersonating: false, originalName: '' });
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

app.get('/api/config/stripe-key', (req, res) => {
    res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null });
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

    const stateData = {
        MA: { tagline: 'The most competitive real estate market in New England', desc: 'Massachusetts combines historic charm with one of the nation\'s hottest real estate markets. From Boston\'s world-class neighborhoods to the quiet towns of the Pioneer Valley and the beaches of Cape Cod, sellers in Massachusetts benefit from strong year-round buyer demand and low days on market.', highlights: ['Spring market peaks April–June with multiple offers common', 'Boston metro drives statewide price appreciation', 'Cape Cod and islands command strong seasonal premiums', 'Pioneer Valley offers affordability relative to eastern MA'], color: '#0A2540' },
        CT: { tagline: 'New York City\'s backyard — with New England soul', desc: 'Connecticut\'s real estate market is powered by two forces: NYC commuters seeking space in Fairfield County, and a resurgent Hartford metro drawing remote workers and first-time buyers. Gold Coast towns like Greenwich, Darien, and Westport rank among the most valuable real estate in the country.', highlights: ['Fairfield County commands the highest prices in New England outside Boston', 'No NYC state income tax burden for CT residents who commute', 'New Haven\'s Yale-driven market stays resilient through cycles', 'Shoreline towns along Long Island Sound carry waterfront premiums'], color: '#1a3a5c' },
        RI: { tagline: 'The Ocean State — tight inventory, rising prices', desc: 'Rhode Island packs remarkable diversity into the smallest state in the country. Providence\'s thriving arts and food scene draws Boston overflow buyers, Newport\'s historic mansions attract luxury purchasers, and South County\'s coastal towns see some of the strongest appreciation in New England.', highlights: ['One of the lowest housing inventories in New England', 'Providence ranked top 10 nationally for buyer demand', 'Newport and Washington County coastal properties sell at premium', 'No major new construction — existing homes dominate inventory'], color: '#0f3460' },
        VT: { tagline: 'Four seasons of demand — and a booming buyer pool', desc: 'Vermont\'s real estate market has been transformed by remote work. Buyers from Boston, New York, and beyond are snapping up homes in Burlington, Stowe, and dozens of small towns across the Green Mountains. Low inventory and rising prices have made Vermont one of the fastest-appreciating states in the Northeast.', highlights: ['Remote work has permanently expanded the Vermont buyer pool', 'Ski resort towns (Stowe, Killington, Mad River) command vacation premiums', 'Burlington metro is the hottest market in northern New England', 'Fall foliage season drives peak second-home buyer interest'], color: '#1b4332' },
        NH: { tagline: 'No income tax. No sales tax. No wonder buyers keep coming.', desc: 'New Hampshire\'s tax advantage is its superpower. Buyers fleeing Massachusetts and Connecticut income taxes flood into southern NH communities like Derry, Londonderry, Bedford, and Windham. The seacoast offers ocean access without Maine\'s remoteness, and the Lakes Region draws second-home buyers year-round.', highlights: ['No state income or sales tax — powerful draw from MA and CT', 'Southern NH commuter towns see Boston-level buyer demand', 'Portsmouth and seacoast rank among NH\'s most desirable markets', 'Lakes Region and White Mountains drive strong vacation home demand'], color: '#0c2d6b' },
        ME: { tagline: 'The way life should be — and the market to prove it', desc: 'Maine has experienced one of the most dramatic real estate booms in the country since 2020. Portland is now one of the fastest-appreciating markets in the nation. Remote workers, retirees, and coastal lifestyle seekers have pushed prices to record highs while inventory remains historically tight.', highlights: ['Portland metro is among the top 5 fastest-appreciating markets in the US', 'York County seacoast (Kennebunk, York, Kittery) sees premium coastal demand', 'Mid-coast (Rockland, Camden, Brunswick) attracts lifestyle and retirement buyers', 'Statewide inventory at historic lows — a strong seller\'s market'], color: '#1c3d5a' },
        NY: { tagline: 'Upstate opportunity meets Westchester sophistication', desc: 'New York\'s real estate market extends far beyond Manhattan — from Westchester County\'s Metro-North commuter towns where NYC buyers find value and space, to upstate cities like Buffalo and Rochester that are experiencing dramatic revivals as remote work expands the buyer pool. Affordability and appreciation potential combine in markets that national attention has only recently discovered.', highlights: ['Westchester County delivers NYC commuter access at a fraction of borough prices', 'Buffalo ranked among the fastest-appreciating cities in the Northeast', 'Rochester and Syracuse benefit from university and semiconductor investment', 'Capital Region (Albany/Schenectady) offers affordability with government stability'], color: '#1a2f5e' },
        NJ: { tagline: 'Manhattan\'s most accessible suburbs — with a state all their own', desc: 'New Jersey\'s real estate market is powered by its proximity to New York City and Philadelphia, offering buyers transit-connected communities at prices well below the boroughs while still delivering true urban amenity. From Hudson County\'s Manhattan-view waterfront to Ocean County\'s Jersey Shore communities, New Jersey covers remarkable range.', highlights: ['Hudson County (Jersey City, Hoboken) delivers the fastest Manhattan commutes outside NYC', 'Ocean and Monmouth counties offer Jersey Shore lifestyle with year-round residential appeal', 'Edison and Woodbridge attract buyers with top schools and transit access', 'Statewide appreciation driven by NYC and Philadelphia overflow demand'], color: '#0c3b6e' },
        FL: { tagline: 'Sun, growth, and no state income tax — Florida\'s market is open for business', desc: 'Florida has become America\'s premier domestic migration destination — a state where no income tax, year-round sunshine, and diverse metros from Miami\'s international glamour to Tampa\'s waterfront revival and Jacksonville\'s affordability attract buyers from every region of the country. Population growth continues to outpace housing supply, keeping seller conditions favorable across the state.', highlights: ['No state income tax — a powerful draw for high-income buyers from NY, CA, and IL', 'Miami\'s international buyer pool drives premium prices and global demand', 'Tampa Bay emerged as one of the top US metros for relocation since 2020', 'Central Florida (Orlando) leads the state in population growth and new construction'], color: '#0e4d8f' },
        TX: { tagline: 'No state income tax, explosive growth, and a market built for sellers', desc: 'Texas is the nation\'s most dynamic real estate market — a massive, diverse state where no income tax, a booming economy, and population growth that has added millions of residents over the past decade keep buyer demand consistently strong. From Houston\'s diverse energy-sector economy to Austin\'s tech boom and Dallas-Fort Worth\'s corporate migration machine, Texas delivers opportunity at every price point.', highlights: ['No state income tax draws buyers from California, Illinois, and the Northeast', 'DFW metroplex is the top corporate relocation destination in the country', 'Austin and Plano attract high-earning tech and corporate buyers', 'Houston and San Antonio offer major-city scale at accessible price points'], color: '#8b1a1a' },
        CA: { tagline: 'The world\'s most recognized real estate market — with opportunity at every price point', desc: 'California\'s real estate market is the largest and most complex in the nation, encompassing Silicon Valley\'s trillion-dollar tech economy, Los Angeles\'s entertainment-industry wealth, San Diego\'s military and biotech base, and Central Valley cities offering genuine affordability within the Golden State. Despite well-publicized challenges, California remains a market of exceptional long-term fundamentals.', highlights: ['Silicon Valley produces the highest-earning buyer pool in the world', 'Los Angeles and San Diego offer coastal California lifestyle with diverse price ranges', 'Central Valley cities (Fresno, Bakersfield, Sacramento) provide in-state affordability', 'No other state matches California\'s combination of economic diversity and market size'], color: '#1a3a6b' },
        GA: { tagline: 'The capital of the New South — where growth meets affordability', desc: 'Georgia\'s real estate market is anchored by Atlanta\'s extraordinary corporate growth but extends across a diverse state where coastal Savannah\'s historic charm, Augusta\'s military stability, and college-town Athens all deliver strong market fundamentals. Georgia offers buyers and sellers the benefits of a fast-growing Sun Belt economy with price points well below comparable Northeast and West Coast markets.', highlights: ['Atlanta is the Southeast\'s top corporate relocation destination', 'Savannah\'s tourism economy and historic district command coastal premiums', 'Military bases stabilize Augusta and Columbus real estate markets', 'Athens and Roswell attract university and North Fulton buyers seeking value'], color: '#8b3a1a' },
        NC: { tagline: 'Research Triangle tech, Charlotte banking, and coastal living — North Carolina delivers it all', desc: 'North Carolina has emerged as one of America\'s most balanced real estate markets — combining the Research Triangle\'s tech and pharmaceutical economy, Charlotte\'s financial sector growth, and coastal Wilmington\'s year-round beach lifestyle with home prices that remain significantly more accessible than comparable Northeast or West Coast metros.', highlights: ['Raleigh-Durham Research Triangle attracts major tech and pharmaceutical investment', 'Charlotte is the Southeast\'s second-largest banking center after New York', 'Cary and suburban Wake County rank among America\'s best-managed communities', 'Wilmington and the Carolina coast draw retirees and remote workers from the East Coast'], color: '#1a4a2e' },
        IL: { tagline: 'World-class Chicago anchors a state full of affordable opportunity', desc: 'Illinois\'s real estate market offers an extraordinary range — from Chicago\'s world-class neighborhoods that deliver cultural richness and value unmatched by any comparable global city, to affordable mid-sized markets like Rockford, Springfield, and Peoria where home prices remain among the most accessible in the Midwest. Chicago\'s transit-connected suburbs add strong commuter options at every price point.', highlights: ['Chicago delivers world-class urban living at prices well below comparable global cities', 'Naperville and the DuPage County suburbs rank among America\'s best-managed communities', 'Aurora and Elgin offer Metra access to Chicago at entry-level prices', 'Springfield and Peoria provide state capital and manufacturing stability'], color: '#1a2a4a' },
        WA: { tagline: 'Amazon and Boeing country — Pacific Northwest real estate at its finest', desc: 'Washington State\'s real estate market is powered by one of the world\'s strongest technology economies, with Amazon, Microsoft, and Boeing creating a buyer base of high-earning professionals that keeps King and Snohomish county markets among the most competitive in the nation. No state income tax amplifies the appeal, and Puget Sound\'s spectacular scenery makes every listing a lifestyle statement.', highlights: ['No state income tax — a major draw for high-income tech workers', 'Amazon and Microsoft headquarters drive King County\'s premium buyer pool', 'Tacoma and Everett offer Sounder rail access to Seattle at meaningful price discounts', 'Spokane delivers eastern Washington affordability with strong healthcare employment'], color: '#1a3d4a' },
        PA: { tagline: 'Philadelphia sophistication meets Pittsburgh grit — and everything in between', desc: 'Pennsylvania\'s real estate market spans the full spectrum: Philadelphia\'s world-class walkable neighborhoods and Main Line estates, Pittsburgh\'s remarkable urban revival drawing national attention for affordability and livability, and a diverse interior of college towns, agricultural communities, and mid-sized cities that offer some of the most accessible home prices in the East.', highlights: ['Philadelphia Main Line communities rank among the most desirable suburban markets in the East', 'Pittsburgh consistently ranks among the most livable and affordable major metros in the US', 'Lancaster County\'s farmhouse and rural properties attract lifestyle buyers from the Northeast', 'Lehigh Valley (Allentown/Bethlehem) offers Philly commuter access at significant price discounts'], color: '#1a3060' },
        OH: { tagline: 'The heart of it all — exceptional value in America\'s underrated powerhouse', desc: 'Ohio delivers some of the most compelling real estate value in the United States — a state where Columbus\'s tech-driven growth, Cleveland\'s lakefront revival, and Cincinnati\'s thriving Over-the-Rhine neighborhood combine with home prices that remain well below national averages. Ohio\'s diversified economy and central location make it a perennial destination for corporate relocations and remote workers seeking cost-effective quality of life.', highlights: ['Columbus is one of America\'s fastest-growing metros, driven by Ohio State and Intel investment', 'Cleveland\'s lakefront neighborhoods and suburbs offer world-class amenities at Midwest prices', 'Cincinnati\'s historic neighborhoods and Northern Kentucky suburbs attract buyers from across the region', 'Dublin and Upper Arlington rank among the top suburbs in America for schools and quality of life'], color: '#1a2a4a' },
        MI: { tagline: 'Detroit\'s revival and the Pure Michigan lifestyle redefine the Great Lakes state', desc: 'Michigan\'s real estate market has undergone a dramatic transformation — Detroit\'s inner ring suburbs like Birmingham, Bloomfield Hills, and Grosse Pointe deliver world-class amenities at prices that would be unthinkable in comparable coastal markets, Ann Arbor\'s university economy keeps demand consistently strong, and Grand Rapids has emerged as one of the Midwest\'s most dynamic mid-sized metros.', highlights: ['Birmingham and Bloomfield Hills deliver premier suburban living at discounts to comparable coastal markets', 'Ann Arbor\'s University of Michigan economy insulates the market from downturns', 'Grand Rapids is among the fastest-growing mid-sized metros in the Midwest', 'Waterfront properties on the Great Lakes command premium prices with recreational lifestyle appeal'], color: '#1a3050' },
        AZ: { tagline: 'Sun, growth, and one of the nation\'s most dynamic real estate markets', desc: 'Arizona has become one of America\'s premier real estate destinations, driven by year-round sunshine, no state income tax on retirement income, explosive population growth from California and the Midwest, and a diverse economy anchored by technology, healthcare, and aerospace. Greater Phoenix\'s master-planned communities consistently rank among the top destinations for domestic migration, while Tucson\'s university economy and Flagstaff\'s mountain lifestyle create distinct markets across the state.', highlights: ['Greater Phoenix is among the top 5 domestic migration destinations in the country', 'Scottsdale delivers luxury resort lifestyle with nationally recognized restaurants and arts', 'Gilbert and Chandler rank among America\'s safest and fastest-growing suburbs', 'Flagstaff offers mountain living with northern Arizona\'s four-season climate'], color: '#8b4a1a' },
        VA: { tagline: 'Northern Virginia\'s tech economy anchors a state of remarkable diversity', desc: 'Virginia\'s real estate market is driven by two powerful engines: Northern Virginia\'s massive federal contractor and technology economy, home to Amazon\'s HQ2 and one of the highest concentrations of defense intelligence employers in the world, and the Richmond metro\'s emerging status as a destination city for young professionals seeking Southern charm and urban sophistication. Virginia Beach and Hampton Roads round out a state that offers buyers options from waterfront resort living to world-class suburbs to affordable rural communities.', highlights: ['Northern Virginia is home to Amazon HQ2 and the largest concentration of cybersecurity employers in the US', 'Loudoun County is among the fastest-growing and wealthiest counties in America', 'Richmond\'s Scott\'s Addition and Church Hill neighborhoods are among the South\'s most exciting urban markets', 'Virginia Beach\'s oceanfront and Chesapeake\'s suburbs offer Hampton Roads lifestyle at accessible prices'], color: '#1a3a5a' },
        MD: { tagline: 'DC proximity, Chesapeake charm, and a market built for long-term appreciation', desc: 'Maryland\'s real estate market benefits from one of the nation\'s most stable employment bases — the federal government and its contractors, healthcare giants like Johns Hopkins and University of Maryland, and a growing tech sector in the DC-Baltimore corridor. Montgomery County\'s Bethesda and Potomac neighborhoods rank among the most affluent zip codes in the country, while Baltimore\'s waterfront revival and historic rowhouse neighborhoods offer urban buyers remarkable value.', highlights: ['Bethesda and Potomac deliver DC access with premium suburban amenities', 'Montgomery County schools consistently rank among the best in the nation', 'Annapolis offers Chesapeake Bay waterfront lifestyle 30 minutes from DC and Baltimore', 'Howard County\'s Columbia planned community remains one of America\'s most livable suburban developments'], color: '#1a2040' },
        DC: { tagline: 'America\'s capital — where power, culture, and real estate converge', desc: 'Washington DC\'s real estate market is one of the most resilient in the nation, anchored by federal government employment, a growing technology and consulting sector, and world-class cultural amenities. From Georgetown\'s Federal architecture and Capitol Hill\'s rowhouses to the rapidly transforming neighborhoods of Shaw, Navy Yard, and Columbia Heights, DC offers buyers a diverse and appreciation-driven market within a city of permanent institutional stability.', highlights: ['Federal government employment creates a floor of demand that insulates the DC market from downturns', 'Navy Yard and Capitol Riverfront have transformed from industrial to premium residential in under a decade', 'Georgetown and Capitol Hill deliver historic DC character with long-term appreciation track records', 'Columbia Heights and Shaw offer urban renewal upside for buyers willing to invest in transitional neighborhoods'], color: '#0a2040' },
        TN: { tagline: 'Nashville\'s boom and the Volunteer State\'s remarkable rise', desc: 'Tennessee has emerged as one of America\'s most sought-after real estate destinations — a state with no income tax, explosive population growth driven by corporate relocations (Oracle, AllianceBernstein, Amazon) and a quality of life that blends Southern hospitality with genuine urban sophistication. Nashville\'s Brentwood and Franklin suburbs rank among the most desirable in the South, while Memphis, Chattanooga, and Knoxville offer buyers diverse metro options at significantly lower price points.', highlights: ['No state income tax on wages — a powerful draw from high-tax states', 'Nashville is the top US city for corporate relocations in recent years', 'Brentwood and Franklin deliver elite suburbs at prices well below comparable Northern Virginia or Chicago communities', 'Chattanooga\'s outdoor recreation economy and gigabit internet have made it a national model for mid-sized city growth'], color: '#2a4a1a' },
        SC: { tagline: 'Charleston sophistication, Greenville growth, and the Grand Strand — South Carolina has it all', desc: 'South Carolina\'s real estate market has been transformed by domestic migration from the Northeast and Midwest, drawn by no state income tax on Social Security, a mild climate, and home prices that remain well below comparable coastal Northeast or Florida markets. Charleston\'s historic district and Mount Pleasant\'s master-planned communities compete with Hilton Head\'s resort lifestyle, while Greenville\'s BMW-driven manufacturing economy creates strong demand for Upstate properties.', highlights: ['Charleston ranks among the top 5 US cities for domestic migration and quality of life', 'Mount Pleasant delivers premier Charleston access at prices competitive with comparable Northeast suburbs', 'Hilton Head and Bluffton attract retirees and remote workers from across the East Coast', 'Greenville\'s BMW and international manufacturing base creates stable, professional buyer demand'], color: '#1a3a2a' },
        OR: { tagline: 'Portland\'s innovation economy and the Oregon coast — Pacific Northwest living at its finest', desc: 'Oregon\'s real estate market is anchored by Portland\'s diverse technology and creative economy but extends across a state of remarkable natural beauty and lifestyle diversity. Lake Oswego and the West Hills deliver Portland\'s premium suburbs, Bend has emerged as the Pacific Northwest\'s top outdoor recreation destination driving some of the strongest appreciation in the region, and the Willamette Valley\'s college towns offer livable, walkable communities at more accessible prices.', highlights: ['No sales tax — a meaningful advantage for buyers coming from California or Washington', 'Bend is among the top 10 fastest-appreciating markets in the Western US', 'Lake Oswego delivers Portland metro\'s premier suburban experience with waterfront amenities', 'Eugene and Corvallis offer university-driven markets with consistent long-term demand'], color: '#1a3a1a' },
        NV: { tagline: 'No income tax, explosive growth, and a market finally growing up', desc: 'Nevada\'s real estate market has matured dramatically from its boom-bust reputation, driven by sustained in-migration from California, no state income tax, and a diversifying economy that now includes major technology, healthcare, and logistics employers alongside gaming and tourism. Las Vegas\'s master-planned communities like Summerlin consistently rank among America\'s most livable suburbs, while Reno\'s proximity to Lake Tahoe and Tesla\'s Gigafactory have transformed the Biggest Little City into a genuine destination market.', highlights: ['No state income tax — the primary driver of in-migration from California', 'Summerlin is one of America\'s best master-planned communities with national recognition for livability', 'Reno\'s proximity to Lake Tahoe, Tesla, and Apple facilities drives strong professional buyer demand', 'Las Vegas\'s short-term rental market creates investment opportunities alongside strong owner-occupant demand'], color: '#4a1a1a' },
        MN: { tagline: 'Twin Cities sophistication and the Land of 10,000 Lakes lifestyle', desc: 'Minnesota\'s real estate market offers buyers a remarkable combination of world-class urban amenities in Minneapolis-St. Paul, among the most highly educated and culturally sophisticated metros in the Midwest, with the unique recreational lifestyle of the Land of 10,000 Lakes. Edina, Eden Prairie, and Minnetonka deliver premier suburban living, while Woodbury and Eagan provide accessible entry points into the Twin Cities market with strong school districts and modern infrastructure.', highlights: ['Minneapolis-St. Paul ranks among the top US metros for healthcare and education employment', 'Edina delivers premier suburban living with walkable 50th and France and Southdale access', 'Woodbury and Eagan offer Twin Cities access at prices well below the premium western suburbs', 'Summer cabin demand on Minnesota lakes creates a uniquely active second-home market'], color: '#1a2a4a' },
        MO: { tagline: 'Where America meets — Kansas City energy and St. Louis heritage', desc: 'Missouri\'s real estate market offers buyers the benefits of two distinct major metros — Kansas City\'s emerging tech and startup scene, nationally recognized restaurant culture, and affordably priced suburbs on both sides of the state line, and St. Louis\'s historic architecture, world-class institutions like Washington University, and some of the most affordable luxury housing in the country in suburbs like Ladue, Town and Country, and Chesterfield.', highlights: ['Kansas City ranked among the top US metros for startups and tech job growth', 'St. Louis delivers world-class arts, healthcare, and education institutions at Midwest prices', 'Ladue and Town and Country offer elite St. Louis suburbs at prices unthinkable in comparable coastal markets', 'Lee\'s Summit and O\'Fallon provide accessible entry points into the KC and St. Louis markets respectively'], color: '#3a1a1a' },
        IN: { tagline: 'Carmel tops the rankings, Indianapolis anchors the Crossroads of America', desc: 'Indiana\'s real estate market is anchored by Indianapolis\'s consistent recognition as one of America\'s most livable major metros — a city of world-class sports, a growing tech and life sciences economy, and home prices that make it the most affordable major metro east of the Mississippi. Carmel and Fishers consistently rank among the best places to live in the country, while Fort Wayne and South Bend offer mid-sized city amenities at entry-level prices.', highlights: ['Carmel is regularly ranked the #1 city to live in Indiana and among the top 10 in the nation', 'Fishers is one of America\'s fastest-growing mid-sized cities by population and job growth', 'Indianapolis offers Big Ten city amenities — Colts, Pacers, IndyCar — at deeply affordable price points', 'Fort Wayne and South Bend provide manufacturing-anchored employment stability with accessible home prices'], color: '#1a2a3a' },
        WI: { tagline: 'Milwaukee\'s lakefront revival and Madison\'s perennial livability rankings', desc: 'Wisconsin\'s real estate market is powered by two distinct engines: Milwaukee\'s genuine urban revival, where neighborhoods like Bay View, Third Ward, and the East Side are attracting buyers from Chicago and Minneapolis with lakefront living at a fraction of comparable costs, and Madison\'s university-driven market that consistently ranks among the most livable mid-sized cities in the country. The Fox Valley and Green Bay offer buyers stability anchored by manufacturing and healthcare employment.', highlights: ['Milwaukee\'s lakefront neighborhoods deliver Chicago-comparable amenities at 40-50% of Chicago prices', 'Madison consistently ranks among the top 10 US cities for quality of life and livability', 'Mequon and Elm Grove deliver Milwaukee\'s most prestigious suburban addresses with shoreline access', 'Green Bay\'s Packers-anchored identity creates a uniquely stable and community-driven real estate market'], color: '#1a3a1a' },
    };
    const sd = stateData[stateCode] || { tagline: `Real estate markets across ${stateName}`, desc: `Find sellers and realtors across ${stateName} on RealtorFinder.`, highlights: [], color: '#0A2540' };

    const stateLd = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'RealEstateAgent',
        'name': `RealtorFinder — ${stateName}`,
        'description': sd.desc,
        'url': `https://www.realtorfinder.net/locations/${stateCode.toLowerCase()}`,
        'areaServed': { '@type': 'State', 'name': stateName, 'addressCountry': 'US' }
    });

    const highlightItems = sd.highlights.map(h => `<li>${h}</li>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${stateName} Real Estate Markets | RealtorFinder</title>
    <meta name="description" content="${sd.tagline}. RealtorFinder covers every major city and town in ${stateName}. Sellers list free, realtors compete for listings.">
    <link rel="canonical" href="https://www.realtorfinder.net/locations/${stateCode.toLowerCase()}">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>
    <script type="application/ld+json">${stateLd}</script>
    <style>
        :root{--primary:#0A2540;--accent:#FF6B35;--border:#e5e7eb;--soft-bg:#f8f9fa;}
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:'Work Sans',sans-serif;color:var(--primary);}

        /* Nav */
        nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(255,255,255,0.97);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:0 5%;display:flex;align-items:center;justify-content:space-between;height:68px;}
        .nav-logo{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:900;color:var(--primary);text-decoration:none;}
        .nav-logo span{color:var(--accent);}
        .nav-links{display:flex;align-items:center;gap:1.5rem;}
        .nav-links a{color:var(--primary);text-decoration:none;font-size:0.9rem;font-weight:500;opacity:0.75;transition:opacity 0.2s;}
        .nav-links a:hover{opacity:1;}
        .nav-cta{background:var(--accent);color:#fff;padding:10px 22px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.95rem;opacity:1!important;}

        /* Hero */
        .hero{background:linear-gradient(135deg,${sd.color} 0%,#0d3a5c 100%);color:#fff;padding:140px 5% 80px;text-align:center;}
        .hero h1{font-family:'Playfair Display',serif;font-size:clamp(2.2rem,5vw,3.6rem);font-weight:900;margin-bottom:12px;line-height:1.15;}
        .hero h1 em{color:var(--accent);font-style:normal;}
        .hero-tagline{font-size:1.15rem;opacity:0.85;max-width:620px;margin:0 auto 24px;line-height:1.6;}
        .breadcrumb{font-size:0.85rem;text-align:center;margin-bottom:28px;opacity:0.7;}
        .breadcrumb a{color:rgba(255,255,255,0.8);text-decoration:underline;}
        .hero-btns{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-top:8px;}
        .btn-primary{background:var(--accent);color:#fff;padding:14px 30px;border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;transition:transform 0.15s,box-shadow 0.15s;}
        .btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(255,107,53,0.4);}
        .btn-outline{background:transparent;color:#fff;padding:14px 30px;border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;border:2px solid rgba(255,255,255,0.5);transition:border-color 0.15s;}
        .btn-outline:hover{border-color:#fff;}

        /* Stats strip */
        .stats-strip{background:#fff;border-bottom:1px solid var(--border);padding:24px 5%;display:flex;justify-content:center;gap:3rem;flex-wrap:wrap;}
        .strip-stat{text-align:center;}
        .strip-val{font-family:'Playfair Display',serif;font-size:2rem;font-weight:900;color:var(--primary);}
        .strip-label{font-size:0.8rem;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;}

        /* Overview section */
        .section{max-width:1100px;margin:0 auto;padding:64px 5%;}
        .section-label{font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--accent);margin-bottom:10px;}
        .section h2{font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.4rem);font-weight:900;margin-bottom:20px;line-height:1.25;}
        .overview-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:4rem;align-items:start;}
        .overview-desc{font-size:1.05rem;line-height:1.8;color:#374151;}
        .highlights-list{list-style:none;padding:0;margin-top:0;}
        .highlights-list li{padding:12px 0 12px 28px;border-bottom:1px solid var(--border);font-size:0.95rem;color:#374151;position:relative;line-height:1.5;}
        .highlights-list li:last-child{border-bottom:none;}
        .highlights-list li::before{content:'→';position:absolute;left:0;color:var(--accent);font-weight:700;}

        /* City grid */
        .city-grid-section{background:var(--soft-bg);padding:64px 0;}
        .city-grid-inner{max-width:1100px;margin:0 auto;padding:0 5%;}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;margin-top:32px;}
        .city-card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:24px;text-decoration:none;color:var(--primary);transition:all 0.2s;display:block;}
        .city-card:hover{border-color:var(--accent);box-shadow:0 8px 24px rgba(255,107,53,0.12);transform:translateY(-2px);}
        .city-name{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:700;margin-bottom:6px;}
        .city-meta{font-size:0.85rem;color:#6b7280;margin-bottom:4px;}
        .city-trend{font-size:0.82rem;color:#16a34a;font-weight:600;}

        /* Market insight */
        .insight-section{background:#fff;border-top:1px solid var(--border);}
        .insight-inner{max-width:1100px;margin:0 auto;padding:64px 5%;}
        .insight-box{background:linear-gradient(135deg,var(--soft-bg) 0%,#fff 100%);border:1px solid var(--border);border-radius:16px;padding:40px;border-left:4px solid var(--accent);}
        .insight-box p{font-size:1rem;line-height:1.8;color:#374151;margin-bottom:16px;}
        .insight-box p:last-child{margin-bottom:0;}

        /* CTA band */
        .cta-band{background:linear-gradient(135deg,#FF6B35 0%,#e85a25 100%);color:#fff;text-align:center;padding:72px 5%;}
        .cta-band h2{font-family:'Playfair Display',serif;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:900;margin-bottom:12px;}
        .cta-band p{font-size:1.1rem;opacity:0.9;margin-bottom:32px;max-width:500px;margin-left:auto;margin-right:auto;}
        .cta-band .hero-btns .btn-primary{background:#fff;color:var(--accent);}
        .cta-band .hero-btns .btn-outline{border-color:rgba(255,255,255,0.6);color:#fff;}

        /* Footer */
        footer{background:var(--primary);color:rgba(255,255,255,0.6);padding:32px 5%;text-align:center;font-size:0.84rem;}
        footer a{color:rgba(255,255,255,0.6);margin:0 8px;text-decoration:none;}

        @media(max-width:768px){
            .overview-grid{grid-template-columns:1fr;gap:2rem;}
            .stats-strip{gap:1.5rem;}
            .nav-links{display:none;}
            .hero{padding:110px 5% 60px;}
        }
    </style>
</head>
<body>
<nav>
    <a href="/" class="nav-logo">Realtor<span>Finder</span></a>
    <div class="nav-links">
        <a href="/locations">All States</a>
        <a href="/realtors">For Realtors</a>
        <a href="/login?tab=signup&type=seller" class="nav-cta">Get Started Free</a>
    </div>
</nav>

<div class="hero">
    <div class="breadcrumb"><a href="/locations">← All States</a></div>
    <h1><em>${stateName}</em><br>Real Estate Markets</h1>
    <p class="hero-tagline">${sd.tagline}</p>
    <div class="hero-btns">
        <a href="/login?tab=signup&type=seller" class="btn-primary">List My Home Free</a>
        <a href="/realtors" class="btn-outline">I'm a Realtor →</a>
    </div>
</div>

<div class="stats-strip">
    <div class="strip-stat">
        <div class="strip-val">${cities.length}</div>
        <div class="strip-label">Markets Covered</div>
    </div>
    <div class="strip-stat">
        <div class="strip-val">$0</div>
        <div class="strip-label">Free for Sellers</div>
    </div>
    <div class="strip-stat">
        <div class="strip-val">100%</div>
        <div class="strip-label">Licensed Realtors</div>
    </div>
</div>

<div class="section">
    <div class="overview-grid">
        <div>
            <div class="section-label">Market Overview</div>
            <h2>Selling in ${stateName}</h2>
            <p class="overview-desc">${sd.desc}</p>
        </div>
        <div>
            <div class="section-label" style="margin-bottom:16px;">Key Market Highlights</div>
            <ul class="highlights-list">
                ${highlightItems}
            </ul>
        </div>
    </div>
</div>

<div class="city-grid-section">
    <div class="city-grid-inner">
        <div class="section-label">Browse by City</div>
        <h2 style="font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.4rem);font-weight:900;line-height:1.25;">Browse ${stateName} Markets</h2>
        <div class="grid">${cards}</div>
    </div>
</div>

<div class="insight-section">
    <div class="insight-inner">
        <div class="section-label">For Sellers</div>
        <h2 style="font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.4rem);font-weight:900;line-height:1.25;margin-bottom:28px;">Why sell in ${stateName} now?</h2>
        <div class="insight-box">
            <p>${stateName} sellers who list on RealtorFinder put themselves in the driver's seat. Instead of cold-calling agents or taking the first offer, you post your home once — for free — and licensed local realtors compete for your business. You compare commission rates, track records, and proposals side by side, then choose the agent who earns it.</p>
            <p>In a competitive market like ${stateName}, the difference between a 2% and 3% commission on a $500,000 home is $5,000 in your pocket. RealtorFinder gives you the leverage to negotiate from a position of strength. It's always free for sellers, with no obligation to accept any proposal.</p>
        </div>
    </div>
</div>

<div class="cta-band">
    <h2>Ready to list in ${stateName}?</h2>
    <p>Join thousands of sellers who have used RealtorFinder to find their perfect agent — for free.</p>
    <div class="hero-btns">
        <a href="/login?tab=signup&type=seller" class="btn-primary">List My Home Free</a>
        <a href="/realtors" class="btn-outline">I'm a Realtor →</a>
    </div>
</div>

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
        const { zip, name, state, city } = req.query;

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
        if (state) {
            params.push(`%${state}%`);
            conditions.push(`u.service_areas ILIKE $${params.length}`);
        }
        if (city) {
            params.push(`%${city}%`);
            conditions.push(`u.service_areas ILIKE $${params.length}`);
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
                    u.profile_photo, u.brokerage,
                    COALESCE(u.license_verified, false) AS license_verified,
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
                    u.profile_photo, u.license_verified, u.license_doc_url, u.license_rejection_note,
                    c.name AS company_name, c.plan AS company_plan
             FROM users u
             LEFT JOIN companies c ON u.company_id = c.id
             WHERE u.id = $1 AND u.user_type = 'realtor' AND u.is_active IS NOT FALSE`,
            [parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Realtor not found' });
        // Track profile view (fire-and-forget)
        pool.query(
            `INSERT INTO profile_views (realtor_id, viewer_ip) VALUES ($1, $2)`,
            [parseInt(req.params.id), req.ip]
        ).catch(() => {});
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

// ===== PROPOSAL ROUTES (Feature 1) =====

app.post('/api/proposals', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address before submitting proposals. Check your inbox for a verification link.' });
        const { listing_id, commission_pct, cover_note, timeline } = req.body;
        if (!listing_id || commission_pct === undefined) return res.status(400).json({ error: 'listing_id and commission_pct are required' });
        const pct = parseFloat(commission_pct);
        if (isNaN(pct) || pct < 0.1 || pct > 10) return res.status(400).json({ error: 'commission_pct must be between 0.1 and 10' });
        const { rows } = await pool.query(
            `INSERT INTO proposals (listing_id, realtor_id, commission_pct, cover_note, timeline)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (listing_id, realtor_id) DO UPDATE SET commission_pct=$3, cover_note=$4, timeline=$5, status='pending'
             RETURNING *`,
            [listing_id, req.session.userId, pct, cover_note || null, timeline || null]
        );
        const proposal = rows[0];
        // Fire-and-forget: notify seller
        (async () => {
            try {
                const sellerRes = await pool.query(
                    `SELECT u.email, u.first_name, u.last_name, l.address, l.city, l.state
                     FROM listings l JOIN users u ON u.id = l.user_id
                     WHERE l.id = $1`,
                    [listing_id]
                );
                if (!sellerRes.rows.length) return;
                const s = sellerRes.rows[0];
                const addr = [s.address, s.city, s.state].filter(Boolean).join(', ');
                const realtorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim();
                await emailService.sendProposalNotification(s.email, s.first_name, addr, realtorName, pct);
            } catch(e) { console.error('Proposal notification failed:', e.message); }
        })();
        res.status(201).json(proposal);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'You already submitted a proposal for this listing' });
        console.error('POST /api/proposals error:', error);
        res.status(500).json({ error: 'Failed to submit proposal' });
    }
});

app.get('/api/proposals/my', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT p.*, l.address, l.city, l.state, l.price
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             WHERE p.realtor_id = $1
             ORDER BY p.created_at DESC`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (error) {
        console.error('GET /api/proposals/my error:', error);
        res.status(500).json({ error: 'Failed to fetch proposals' });
    }
});

app.get('/api/proposals/listing/:listingId', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
        const listingId = parseInt(req.params.listingId);
        const listing = await db.getListingById(listingId);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query(
            `SELECT p.*, u.first_name, u.last_name, u.profile_photo, u.brokerage, u.years_experience,
                    COALESCE(
                        (SELECT AVG(rating)::numeric(3,1) FROM realtor_reviews WHERE realtor_id = u.id),
                        NULL
                    ) AS rating
             FROM proposals p
             JOIN users u ON u.id = p.realtor_id
             WHERE p.listing_id = $1
             ORDER BY p.commission_pct ASC`,
            [listingId]
        );
        res.json(rows);
    } catch (error) {
        console.error('GET /api/proposals/listing/:id error:', error);
        res.status(500).json({ error: 'Failed to fetch proposals' });
    }
});

app.delete('/api/proposals/:id', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `DELETE FROM proposals WHERE id = $1 AND realtor_id = $2 RETURNING id`,
            [parseInt(req.params.id), req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Proposal not found or not yours' });
        res.json({ success: true });
    } catch (error) {
        console.error('DELETE /api/proposals/:id error:', error);
        res.status(500).json({ error: 'Failed to delete proposal' });
    }
});

app.put('/api/proposals/:id/accept', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
        const proposalId = parseInt(req.params.id);
        // Verify seller owns the listing
        const { rows: pRows } = await pool.query(
            `SELECT p.*, l.user_id as listing_owner_id, l.address, l.city, l.state,
                    u.email as realtor_email, u.first_name as realtor_first, u.last_name as realtor_last
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users u ON u.id = p.realtor_id
             WHERE p.id = $1`,
            [proposalId]
        );
        if (!pRows.length) return res.status(404).json({ error: 'Proposal not found' });
        const proposal = pRows[0];
        if (proposal.listing_owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        // Accept this proposal, decline all others for same listing
        await pool.query(`UPDATE proposals SET status = 'accepted' WHERE id = $1`, [proposalId]);
        await pool.query(`UPDATE proposals SET status = 'declined' WHERE listing_id = $1 AND id != $2`, [proposal.listing_id, proposalId]);
        // Fire-and-forget: email the winning realtor
        (async () => {
            try {
                const addr = [proposal.address, proposal.city, proposal.state].filter(Boolean).join(', ');
                const realtorName = `${proposal.realtor_first || ''} ${proposal.realtor_last || ''}`.trim();
                await emailService.sendProposalAccepted(proposal.realtor_email, realtorName, addr);
            } catch(e) { console.error('Proposal accepted email failed:', e.message); }
        })();
        res.json({ success: true });
    } catch (error) {
        console.error('PUT /api/proposals/:id/accept error:', error);
        res.status(500).json({ error: 'Failed to accept proposal' });
    }
});

// ===== REVIEWS ROUTES (Feature 2) =====

app.post('/api/reviews', auth.requireAuth, async (req, res) => {
    try {
        const { realtor_id, listing_id, rating, comment } = req.body;
        if (!realtor_id || !rating) return res.status(400).json({ error: 'realtor_id and rating required' });
        if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
        // Check for accepted proposal to set verified_sale
        let verifiedSale = false;
        if (listing_id) {
            const { rows: vRows } = await pool.query(
                `SELECT id FROM proposals WHERE listing_id = $1 AND realtor_id = $2 AND status = 'accepted'`,
                [listing_id, realtor_id]
            );
            verifiedSale = vRows.length > 0;
        }
        const { rows } = await pool.query(
            `INSERT INTO reviews (realtor_id, reviewer_id, listing_id, rating, comment, verified_sale)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (realtor_id, reviewer_id, listing_id) DO UPDATE SET rating=$4, comment=$5
             RETURNING *`,
            [realtor_id, req.session.userId, listing_id || null, rating, comment || null, verifiedSale]
        );
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('POST /api/reviews error:', error);
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

app.get('/api/reviews/:realtorId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT r.id, r.rating, r.comment, r.verified_sale, r.created_at,
                    u.first_name, u.last_name,
                    l.address AS listing_address
             FROM reviews r
             JOIN users u ON u.id = r.reviewer_id
             LEFT JOIN listings l ON l.id = r.listing_id
             WHERE r.realtor_id = $1
             ORDER BY r.created_at DESC`,
            [parseInt(req.params.realtorId)]
        );
        const avg = rows.length ? (rows.reduce((s, r) => s + r.rating, 0) / rows.length).toFixed(1) : null;
        res.json({ reviews: rows, avg_rating: avg, count: rows.length });
    } catch (error) {
        console.error('GET /api/reviews/:realtorId error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

// ===== REFERRAL ROUTES (Feature 4) =====

app.get('/api/referrals/my', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        // Generate referral code if missing
        let { rows } = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [req.session.userId]);
        let code = rows[0]?.referral_code;
        if (!code) {
            code = crypto.randomBytes(6).toString('hex');
            await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [code, req.session.userId]);
        }
        const [countRes, referredRes] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE referred_by = $1`, [req.session.userId]),
            pool.query(
                `SELECT first_name, last_name, user_type, subscription_plan, created_at
                 FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 50`,
                [req.session.userId]
            ),
        ]);
        const referral_count = parseInt(countRes.rows[0].cnt);
        const tier = referral_count >= 10 ? 'ambassador' : referral_count >= 5 ? 'top-referrer' : referral_count >= 3 ? 'connector' : referral_count >= 1 ? 'rising-star' : null;
        const referral_url = `${req.protocol}://${req.get('host')}/join?ref=${code}`;
        res.json({ referral_code: code, referral_url, referral_count, tier, referred_users: referredRes.rows });
    } catch (error) {
        console.error('GET /api/referrals/my error:', error);
        res.status(500).json({ error: 'Failed to fetch referral info' });
    }
});

// Referral leaderboard (top 10 realtors by referral count)
app.get('/api/referrals/leaderboard', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT u.first_name, u.last_name, u.profile_photo,
                   COUNT(r.id) AS referral_count
            FROM users u
            JOIN users r ON r.referred_by = u.id
            WHERE u.user_type = 'realtor'
            GROUP BY u.id, u.first_name, u.last_name, u.profile_photo
            ORDER BY referral_count DESC
            LIMIT 10
        `);
        res.json(rows);
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

// Join page — stores ref code in cookie then redirects to signup
app.get('/join', (req, res) => {
    const ref = req.query.ref;
    if (ref) {
        res.setHeader('Set-Cookie', `ref_code=${ref}; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
    }
    res.redirect('/login?tab=signup');
});

// ===== PWA ROUTES (Feature 5) =====

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
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

app.get('/api/realtors/:id/response-time', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT AVG(response_hours) as avg_hours, COUNT(*) as sample_count
             FROM realtor_response_times WHERE realtor_id = $1`,
            [parseInt(req.params.id)]
        );
        const avg = parseFloat(rows[0]?.avg_hours);
        const count = parseInt(rows[0]?.sample_count);
        if (!count || isNaN(avg)) return res.json({ label: null });
        let label;
        if (avg < 1) label = 'Typically responds within an hour';
        else if (avg < 4) label = 'Typically responds within a few hours';
        else if (avg < 24) label = 'Typically responds same day';
        else if (avg < 48) label = 'Typically responds within a day';
        else label = 'Typically responds within a few days';
        res.json({ label, avg_hours: Math.round(avg * 10) / 10, sample_count: count });
    } catch(err) { res.status(500).json({ error: 'Failed' }); }
});

// ===== FEATURE 1: PAY-PER-LEAD =====

// Purchase a lead (free plan realtors only)
app.post('/api/leads/purchase', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { buyer_request_id } = req.body;
        if (!buyer_request_id) return res.status(400).json({ error: 'buyer_request_id required' });

        const userRow = await pool.query(`SELECT subscription_plan FROM users WHERE id = $1`, [req.session.userId]);
        const plan = userRow.rows[0]?.subscription_plan || 'free';
        if (plan !== 'free') {
            return res.status(400).json({ error: 'Pro subscribers see all leads for free — upgrade your plan to access this feature.' });
        }

        // Check no existing purchase
        const existing = await pool.query(
            `SELECT id FROM lead_purchases WHERE realtor_id = $1 AND buyer_request_id = $2`,
            [req.session.userId, buyer_request_id]
        );
        if (existing.rows.length) return res.status(400).json({ error: 'You have already purchased this lead' });

        const paymentIntent = await stripe.paymentIntents.create({
            amount: 999,
            currency: 'usd',
            metadata: { realtor_id: String(req.session.userId), buyer_request_id: String(buyer_request_id) }
        });

        await pool.query(
            `INSERT INTO lead_purchases (realtor_id, buyer_request_id, stripe_payment_intent_id, amount_cents)
             VALUES ($1, $2, $3, 999) ON CONFLICT DO NOTHING`,
            [req.session.userId, buyer_request_id, paymentIntent.id]
        );

        res.json({ clientSecret: paymentIntent.client_secret, amount: 999 });
    } catch (err) {
        console.error('POST /api/leads/purchase error:', err);
        res.status(500).json({ error: 'Failed to create payment' });
    }
});

// Confirm a lead payment
app.post('/api/leads/confirm', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { payment_intent_id } = req.body;
        if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

        const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
        if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Payment not completed' });

        res.json({ ok: true });
    } catch (err) {
        console.error('POST /api/leads/confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm payment' });
    }
});

// Get purchased lead IDs for current realtor
app.get('/api/leads/purchased', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT buyer_request_id FROM lead_purchases WHERE realtor_id = $1`,
            [req.session.userId]
        );
        res.json(rows.map(r => r.buyer_request_id));
    } catch (err) {
        console.error('GET /api/leads/purchased error:', err);
        res.status(500).json({ error: 'Failed to fetch purchased leads' });
    }
});

// ===== FEATURE 2: SHOWING REQUESTS =====

const VALID_TIMES = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'];

// Request a showing
app.post('/api/showings', auth.requireAuth, async (req, res) => {
    try {
        const { listing_id, requested_date, requested_time, message } = req.body;
        if (!listing_id || !requested_date || !requested_time) {
            return res.status(400).json({ error: 'listing_id, requested_date, and requested_time are required' });
        }
        if (!VALID_TIMES.includes(requested_time)) {
            return res.status(400).json({ error: 'Invalid time. Choose a time between 9:00 AM and 5:00 PM.' });
        }
        const reqDate = new Date(requested_date);
        const today = new Date(); today.setHours(0,0,0,0);
        if (reqDate <= today) return res.status(400).json({ error: 'requested_date must be a future date' });

        const { rows } = await pool.query(
            `INSERT INTO showings (listing_id, buyer_id, requested_date, requested_time, message)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [listing_id, req.session.userId, requested_date, requested_time, message || null]
        );
        const showing = rows[0];

        // Fire-and-forget: notify seller and accepted proposal realtor
        (async () => {
            try {
                const listingRes = await pool.query(
                    `SELECT l.id, l.address, l.city, l.state, u.email as seller_email, u.first_name as seller_name
                     FROM listings l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
                    [listing_id]
                );
                if (!listingRes.rows.length) return;
                const lr = listingRes.rows[0];
                const addr = [lr.address, lr.city, lr.state].filter(Boolean).join(', ');
                const buyerRes = await pool.query(`SELECT first_name, last_name FROM users WHERE id = $1`, [req.session.userId]);
                const buyerName = buyerRes.rows.length ? `${buyerRes.rows[0].first_name} ${buyerRes.rows[0].last_name}` : 'A buyer';

                await emailService.sendShowingRequest(lr.seller_email, lr.seller_name, buyerName, addr, requested_date, requested_time, message || '').catch(() => {});

                const proposalRes = await pool.query(
                    `SELECT u.email, u.first_name FROM proposals p JOIN users u ON u.id = p.realtor_id
                     WHERE p.listing_id = $1 AND p.status = 'accepted' LIMIT 1`,
                    [listing_id]
                );
                if (proposalRes.rows.length) {
                    const pr = proposalRes.rows[0];
                    await emailService.sendShowingRequest(pr.email, pr.first_name, buyerName, addr, requested_date, requested_time, message || '').catch(() => {});
                }
            } catch(e) { console.error('Showing notification error:', e.message); }
        })();

        res.status(201).json(showing);
    } catch (err) {
        console.error('POST /api/showings error:', err);
        res.status(500).json({ error: 'Failed to create showing request' });
    }
});

// Get showings for current user
app.get('/api/showings/my', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const userType = req.user.user_type;

        if (userType === 'buyer') {
            const { rows } = await pool.query(
                `SELECT s.*, l.address, l.city, l.state FROM showings s
                 JOIN listings l ON l.id = s.listing_id
                 WHERE s.buyer_id = $1 ORDER BY s.created_at DESC`,
                [uid]
            );
            return res.json(rows);
        }

        // seller or realtor
        const { rows } = await pool.query(
            `SELECT s.*, l.address, l.city, l.state,
                    b.first_name AS buyer_first, b.last_name AS buyer_last, b.email AS buyer_email
             FROM showings s
             JOIN listings l ON l.id = s.listing_id
             JOIN users b ON b.id = s.buyer_id
             WHERE l.user_id = $1
                OR EXISTS (SELECT 1 FROM proposals p WHERE p.listing_id = l.id AND p.realtor_id = $1 AND p.status = 'accepted')
             ORDER BY s.created_at DESC`,
            [uid]
        );
        res.json(rows);
    } catch (err) {
        console.error('GET /api/showings/my error:', err);
        res.status(500).json({ error: 'Failed to fetch showings' });
    }
});

// Confirm a showing
app.put('/api/showings/:id/confirm', auth.requireAuth, async (req, res) => {
    try {
        const showingId = parseInt(req.params.id);
        const { rows } = await pool.query(
            `UPDATE showings SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW()
             WHERE id = $2 RETURNING *`,
            [req.session.userId, showingId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Showing not found' });
        const showing = rows[0];

        // Email buyer
        (async () => {
            try {
                const buyerRes = await pool.query(`SELECT email, first_name FROM users WHERE id = $1`, [showing.buyer_id]);
                if (!buyerRes.rows.length) return;
                const listingRes = await pool.query(`SELECT address, city, state FROM listings WHERE id = $1`, [showing.listing_id]);
                if (!listingRes.rows.length) return;
                const lr = listingRes.rows[0];
                const addr = [lr.address, lr.city, lr.state].filter(Boolean).join(', ');
                await emailService.sendShowingConfirmed(buyerRes.rows[0].email, buyerRes.rows[0].first_name, addr, showing.requested_date, showing.requested_time).catch(() => {});
            } catch(e) { console.error('Showing confirmed email error:', e.message); }
        })();

        res.json({ success: true, showing });
    } catch (err) {
        console.error('PUT /api/showings/:id/confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm showing' });
    }
});

// Cancel a showing
app.put('/api/showings/:id/cancel', auth.requireAuth, async (req, res) => {
    try {
        const showingId = parseInt(req.params.id);
        const { rows } = await pool.query(
            `UPDATE showings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
            [showingId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Showing not found' });
        const showing = rows[0];

        // Fire-and-forget: email the other party
        (async () => {
            try {
                const listingRes = await pool.query(`SELECT address, city, state, user_id FROM listings WHERE id = $1`, [showing.listing_id]);
                if (!listingRes.rows.length) return;
                const lr = listingRes.rows[0];
                const addr = [lr.address, lr.city, lr.state].filter(Boolean).join(', ');
                const cancellerIsbuyer = req.session.userId === showing.buyer_id;
                if (cancellerIsbuyer) {
                    // notify seller
                    const sellerRes = await pool.query(`SELECT email, first_name FROM users WHERE id = $1`, [lr.user_id]);
                    if (sellerRes.rows.length) {
                        await emailService.sendShowingCancelled(sellerRes.rows[0].email, sellerRes.rows[0].first_name, addr, showing.requested_date, showing.requested_time).catch(() => {});
                    }
                } else {
                    // notify buyer
                    const buyerRes = await pool.query(`SELECT email, first_name FROM users WHERE id = $1`, [showing.buyer_id]);
                    if (buyerRes.rows.length) {
                        await emailService.sendShowingCancelled(buyerRes.rows[0].email, buyerRes.rows[0].first_name, addr, showing.requested_date, showing.requested_time).catch(() => {});
                    }
                }
            } catch(e) { console.error('Showing cancelled email error:', e.message); }
        })();

        res.json({ success: true });
    } catch (err) {
        console.error('PUT /api/showings/:id/cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel showing' });
    }
});

// ===== FEATURE 3: REALTOR PERFORMANCE ANALYTICS =====

// Track profile view — injected into existing GET /api/realtors/:id/public above

// Analytics endpoint for current realtor
app.get('/api/realtors/me/analytics', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const uid = req.session.userId;

        const [views7, views30, viewsAll, proposalStats, listingStats, rtStats] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS cnt FROM profile_views WHERE realtor_id = $1 AND viewed_at >= NOW() - INTERVAL '7 days'`, [uid]),
            pool.query(`SELECT COUNT(*) AS cnt FROM profile_views WHERE realtor_id = $1 AND viewed_at >= NOW() - INTERVAL '30 days'`, [uid]),
            pool.query(`SELECT COUNT(*) AS cnt FROM profile_views WHERE realtor_id = $1`, [uid]),
            pool.query(`SELECT status, COUNT(*) AS cnt FROM proposals WHERE realtor_id = $1 GROUP BY status`, [uid]),
            pool.query(`SELECT COUNT(DISTINCT p.listing_id) AS active_bids, SUM(CASE WHEN p.status='accepted' THEN 1 ELSE 0 END) AS won FROM proposals p WHERE p.realtor_id = $1`, [uid]),
            pool.query(`SELECT AVG(response_hours) AS avg_hours FROM realtor_response_times WHERE realtor_id = $1`, [uid])
        ]);

        const proposalMap = {};
        for (const r of proposalStats.rows) proposalMap[r.status] = parseInt(r.cnt);
        const totalProposals = Object.values(proposalMap).reduce((s, v) => s + v, 0);
        const accepted = proposalMap['accepted'] || 0;
        const pending = proposalMap['pending'] || 0;
        const declined = proposalMap['declined'] || 0;
        const winRate = totalProposals > 0 ? Math.round((accepted / totalProposals) * 100) + '%' : '0%';

        const avgHours = parseFloat(rtStats.rows[0]?.avg_hours);
        let responseTime = 'N/A';
        if (!isNaN(avgHours)) {
            if (avgHours < 1) responseTime = '< 1 hour';
            else if (avgHours < 24) responseTime = Math.round(avgHours) + ' hours';
            else responseTime = Math.round(avgHours / 24) + ' days';
        }

        // Profile views per day for last 7 days
        const viewsByDay = await pool.query(
            `SELECT DATE(viewed_at) AS day, COUNT(*) AS cnt
             FROM profile_views WHERE realtor_id = $1 AND viewed_at >= NOW() - INTERVAL '7 days'
             GROUP BY day ORDER BY day`,
            [uid]
        );

        res.json({
            profileViews: {
                last7Days: parseInt(views7.rows[0].cnt),
                last30Days: parseInt(views30.rows[0].cnt),
                allTime: parseInt(viewsAll.rows[0].cnt),
                byDay: viewsByDay.rows
            },
            proposals: { total: totalProposals, accepted, pending, declined, winRate },
            listings: {
                activeBids: parseInt(listingStats.rows[0]?.active_bids) || 0,
                wonListings: parseInt(listingStats.rows[0]?.won) || 0
            },
            responseTime
        });
    } catch (err) {
        console.error('GET /api/realtors/me/analytics error:', err);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ===== FEATURE 4: SAVED REALTORS =====

app.post('/api/saved-realtors/:realtorId', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `INSERT INTO saved_realtors (buyer_id, realtor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [req.session.userId, parseInt(req.params.realtorId)]
        );
        res.json({ saved: true });
    } catch (err) {
        console.error('POST /api/saved-realtors error:', err);
        res.status(500).json({ error: 'Failed to save realtor' });
    }
});

app.delete('/api/saved-realtors/:realtorId', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM saved_realtors WHERE buyer_id = $1 AND realtor_id = $2`,
            [req.session.userId, parseInt(req.params.realtorId)]
        );
        res.json({ saved: false });
    } catch (err) {
        console.error('DELETE /api/saved-realtors error:', err);
        res.status(500).json({ error: 'Failed to unsave realtor' });
    }
});

app.get('/api/saved-realtors', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.profile_photo, u.brokerage,
                    u.service_areas, u.years_experience, u.subscription_plan, u.license_verified,
                    sr.saved_at
             FROM saved_realtors sr
             JOIN users u ON u.id = sr.realtor_id
             WHERE sr.buyer_id = $1
             ORDER BY sr.saved_at DESC`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('GET /api/saved-realtors error:', err);
        res.status(500).json({ error: 'Failed to fetch saved realtors' });
    }
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

// ALTER TABLE migrations run at startup — collected here so they await before listen
const _schemaMigrations = [
    // Core column additions
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS expiry_warning_sent BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS share_token TEXT`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS share_views INTEGER DEFAULT 0`,
    // Fix price column: convert from text to NUMERIC so filtering doesn't need REGEXP_REPLACE
    `DO $$ BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='listings' AND column_name='price') NOT IN ('numeric','integer','bigint','double precision')
        THEN
            ALTER TABLE listings ALTER COLUMN price
                TYPE NUMERIC(12,2)
                USING NULLIF(REGEXP_REPLACE(COALESCE(price::text,'0'), '[^0-9.]', '', 'g'), '')::NUMERIC(12,2);
        END IF;
    END $$`,
    // Core tables
    `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user_id INTEGER NOT NULL REFERENCES users(id),
        to_user_id INTEGER NOT NULL REFERENCES users(id),
        listing_id INTEGER REFERENCES listings(id),
        body TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS realtor_response_times (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        response_hours NUMERIC(6,2) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS proposals (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        commission_pct NUMERIC(4,2) NOT NULL,
        cover_note TEXT,
        timeline TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(listing_id, realtor_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        reviewer_id INTEGER NOT NULL REFERENCES users(id),
        listing_id INTEGER REFERENCES listings(id),
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        verified_sale BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(realtor_id, reviewer_id, listing_id)
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT,
        link VARCHAR(500),
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS drip_emails (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sequence_step INTEGER NOT NULL DEFAULT 1,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, sequence_step)
    )`,
    `CREATE TABLE IF NOT EXISTS buyer_request_responses (
        id SERIAL PRIMARY KEY,
        buyer_request_id INTEGER NOT NULL REFERENCES buyer_requests(id) ON DELETE CASCADE,
        realtor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(buyer_request_id, realtor_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS lead_purchases (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        buyer_request_id INTEGER NOT NULL REFERENCES buyer_requests(id),
        stripe_payment_intent_id TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 999,
        purchased_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(realtor_id, buyer_request_id)
    )`,
    `CREATE TABLE IF NOT EXISTS showings (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        buyer_id INTEGER NOT NULL REFERENCES users(id),
        requested_date DATE NOT NULL,
        requested_time TEXT NOT NULL,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        confirmed_by INTEGER REFERENCES users(id),
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS profile_views (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        viewer_ip TEXT,
        viewed_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS saved_realtors (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id),
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        saved_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(buyer_id, realtor_id)
    )`,
    // Indexes for performance
    `CREATE INDEX IF NOT EXISTS idx_proposals_realtor ON proposals(realtor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_proposals_listing ON proposals(listing_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_to_unread ON messages(to_user_id) WHERE read_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(from_user_id, to_user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_profile_views_realtor ON profile_views(realtor_id, viewed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_showings_listing ON showings(listing_id)`,
    `CREATE INDEX IF NOT EXISTS idx_drip_emails_user ON drip_emails(user_id, sequence_step)`,
];

// ===== REFERRAL COLUMNS (Feature 4) =====
_schemaMigrations.push(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id)`
);

// ===== LICENSE VERIFICATION COLUMNS =====
_schemaMigrations.push(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS license_doc_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS license_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS license_verified_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS license_rejection_note TEXT`
);

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
        if (body.length > 2000) return res.status(400).json({ error: 'Message body must be 2000 characters or less' });

        const { rows } = await pool.query(`
            INSERT INTO messages (from_user_id, to_user_id, listing_id, body)
            VALUES ($1, $2, $3, $4) RETURNING *
        `, [uid, toUserId, listingId || null, body.trim()]);

        const newMsgId = rows[0].id;
        const fromUserId = uid;

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

        // Track response time if realtor is replying for the first time in this thread
        (async () => {
            try {
                const sender = await pool.query(`SELECT user_type FROM users WHERE id = $1`, [fromUserId]);
                if (sender.rows[0]?.user_type !== 'realtor') return;
                // Check if this is the first reply from this realtor in this thread
                const prevReplies = await pool.query(
                    `SELECT id FROM messages WHERE from_user_id = $1 AND to_user_id = $2 AND ($3::int IS NULL OR listing_id = $3) AND id != $4`,
                    [fromUserId, toUserId, listingId || null, newMsgId]
                );
                if (prevReplies.rows.length > 0) return; // not first reply
                // Find the original message sent TO this realtor
                const original = await pool.query(
                    `SELECT created_at FROM messages WHERE to_user_id = $1 AND from_user_id = $2 AND ($3::int IS NULL OR listing_id = $3) ORDER BY created_at ASC LIMIT 1`,
                    [fromUserId, toUserId, listingId || null]
                );
                if (!original.rows.length) return;
                const hours = (Date.now() - new Date(original.rows[0].created_at).getTime()) / 3600000;
                await pool.query(
                    `INSERT INTO realtor_response_times (realtor_id, response_hours) VALUES ($1, $2)`,
                    [fromUserId, Math.round(hours * 100) / 100]
                );
            } catch(e) {}
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

// ===== PUBLIC LISTING SEARCH =====

app.get('/api/listings/search', async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));
        const offset = (page - 1) * limit;
        const { city, state, type, minPrice, maxPrice, minBedrooms } = req.query;

        const conditions = [`l.status = 'active'`, `l.deleted_at IS NULL`];
        const params = [];

        if (city) {
            params.push(`%${city}%`);
            conditions.push(`(l.city ILIKE $${params.length} OR l.zip ILIKE $${params.length} OR l.address ILIKE $${params.length})`);
        }
        if (state) {
            params.push(state);
            conditions.push(`l.state ILIKE $${params.length}`);
        }
        if (type && type !== 'Any') {
            params.push(type);
            conditions.push(`l.property_type = $${params.length}`);
        }
        if (minPrice) {
            params.push(parseInt(minPrice));
            conditions.push(`l.price >= $${params.length}`);
        }
        if (maxPrice) {
            params.push(parseInt(maxPrice));
            conditions.push(`l.price <= $${params.length}`);
        }
        if (minBedrooms) {
            params.push(parseInt(minBedrooms));
            conditions.push(`l.bedrooms >= $${params.length}`);
        }

        const where = conditions.join(' AND ');

        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM listings l WHERE ${where}`, params
        );
        const total = parseInt(countResult.rows[0].total) || 0;

        params.push(limit);
        params.push(offset);
        const { rows } = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price,
                    l.property_type AS type, l.bedrooms, l.bathrooms, l.sqft,
                    l.image_urls, l.share_token, l.created_at,
                    u.first_name AS owner_first, u.last_name AS owner_last
             FROM listings l
             JOIN users u ON u.id = l.user_id
             WHERE ${where}
             ORDER BY l.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({ listings: rows, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
        console.error('Listing search error:', err);
        res.status(500).json({ error: 'Failed to search listings' });
    }
});

// Public listing by share token
app.get('/api/listings/share/:token', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price, l.zestimate,
                    l.property_type AS type, l.bedrooms, l.bathrooms, l.sqft,
                    l.description, l.image_urls, l.status, l.share_token,
                    l.created_at, l.latitude, l.longitude,
                    u.id AS seller_id, u.first_name AS owner_first, u.last_name AS owner_last
             FROM listings l
             JOIN users u ON u.id = l.user_id
             WHERE l.share_token = $1 AND l.status != 'inactive'`,
            [req.params.token]
        );
        if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
        pool.query(`UPDATE listings SET share_views = COALESCE(share_views,0)+1 WHERE share_token=$1`, [req.params.token]).catch(() => {});
        res.json(rows[0]);
    } catch (err) {
        console.error('Share listing error:', err);
        res.status(500).json({ error: 'Failed to load listing' });
    }
});

// ===== LISTING RENEWAL =====

app.post('/api/listings/:id/renew', auth.requireAuth, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);
        const { rows } = await pool.query(
            `SELECT id, user_id, address FROM listings WHERE id = $1`,
            [listingId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
        if (rows[0].user_id !== req.session.userId) return res.status(403).json({ error: 'Not your listing' });

        await pool.query(
            `UPDATE listings
             SET status = 'active',
                 expiry_warning_sent = FALSE,
                 expires_at = NOW() + INTERVAL '90 days',
                 updated_at = NOW()
             WHERE id = $1`,
            [listingId]
        );
        res.json({ ok: true, message: 'Listing renewed for 90 days' });
    } catch (err) {
        console.error('Listing renew error:', err);
        res.status(500).json({ error: 'Failed to renew listing' });
    }
});

// ===== STRIPE BILLING PORTAL =====

app.post('/api/billing/portal', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        const user = await auth.getUserById(req.session.userId);
        // Look up stripe_customer_id from the user's company
        const { rows } = await pool.query(
            `SELECT stripe_customer_id FROM companies WHERE owner_user_id = $1 AND stripe_customer_id IS NOT NULL`,
            [req.session.userId]
        );
        if (!rows.length || !rows[0].stripe_customer_id) {
            return res.status(400).json({ error: 'No active subscription found. Please subscribe first.' });
        }
        const base = process.env.FRONTEND_URL || 'https://www.realtorfinder.net';
        const session = await stripe.billingPortal.sessions.create({
            customer: rows[0].stripe_customer_id,
            return_url: `${base}/dashboard/company`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Billing portal error:', err);
        res.status(500).json({ error: 'Failed to open billing portal' });
    }
});

// ===== COMPANY ANALYTICS =====

app.get('/api/company/analytics', auth.requireAuth, async (req, res) => {
    try {
        const user = await auth.getUserById(req.session.userId);
        if (!user.company_id) return res.status(400).json({ error: 'No company found' });

        const { rows: members } = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.subscription_plan
             FROM users u WHERE u.company_id = $1 AND u.is_active IS NOT FALSE`,
            [user.company_id]
        );

        // Per-agent stats
        const agentStats = await Promise.all(members.map(async m => {
            const [listings, proposals, reviews] = await Promise.all([
                pool.query(`SELECT COUNT(*) AS c FROM listings WHERE user_id=$1 AND status='active'`, [m.id]),
                pool.query(`SELECT COUNT(*) AS c FROM proposals WHERE realtor_id=$1`, [m.id]),
                pool.query(`SELECT AVG(rating)::numeric(3,1) AS avg FROM reviews WHERE realtor_id=$1`, [m.id]),
            ]);
            return {
                id: m.id,
                name: `${m.first_name} ${m.last_name}`,
                email: m.email,
                plan: m.subscription_plan,
                listingCount: parseInt(listings.rows[0].c) || 0,
                proposalCount: parseInt(proposals.rows[0].c) || 0,
                avgRating: parseFloat(reviews.rows[0].avg) || null,
            };
        }));

        const totals = agentStats.reduce((acc, a) => ({
            activeListings:  acc.activeListings  + a.listingCount,
            totalProposals:  acc.totalProposals  + a.proposalCount,
        }), { activeListings: 0, totalProposals: 0 });

        const ratedAgents = agentStats.filter(a => a.avgRating);
        const avgRating = ratedAgents.length
            ? (ratedAgents.reduce((s, a) => s + a.avgRating, 0) / ratedAgents.length).toFixed(1)
            : null;

        res.json({
            totalAgents: members.length,
            activeListings: totals.activeListings,
            totalProposals: totals.totalProposals,
            avgRating,
            agents: agentStats,
        });
    } catch (err) {
        console.error('Company analytics error:', err);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// ===== LISTING SHARE REDIRECT =====

app.get('/s/:token', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id FROM listings WHERE share_token = $1 AND status != 'inactive'`,
            [req.params.token]
        );
        if (!rows.length) return res.redirect('/');
        await pool.query(`UPDATE listings SET share_views = COALESCE(share_views, 0) + 1 WHERE id = $1`, [rows[0].id]);
        res.redirect(`/listing/${rows[0].id}`);
    } catch { res.redirect('/'); }
});

// ===== EMAIL UNSUBSCRIBE =====
app.get('/unsubscribe/:token', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE users SET email_unsubscribed = true WHERE unsubscribe_token = $1 RETURNING first_name`,
            [req.params.token]
        );
        if (!rows.length) return res.redirect('/?unsubscribed=notfound');
        res.redirect('/?unsubscribed=1');
    } catch { res.redirect('/'); }
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
            ...(l.price ? { offers: { '@type': 'Offer', price: parseFloat(l.price), priceCurrency: 'USD' } } : {}),
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

// Browse listings (public)
app.get('/search', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'search.html'));
});

// Inbox (requires login)
app.get('/inbox', (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login?next=/inbox');
    res.sendFile(path.join(__dirname, 'public', 'inbox.html'));
});

// Company / brokerage dashboard
app.get('/dashboard/company', (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'company-dashboard.html'));
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
    if (!req.cookies || !req.cookies.ab_variant) {
        const variant = Math.random() < 0.5 ? 'a' : 'b';
        res.cookie('ab_variant', variant, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false });
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Public realtor directory page
app.get('/realtors/directory', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'realtor-directory.html'));
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
app.get('/cookies', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cookies.html'));
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

// Listing expiry job — runs every 24 hours
async function runListingExpiryJob() {
    try {
        const now = new Date();
        // Warn listings at day 87 (3 days before 90-day expiry)
        const warnCutoff = new Date(now - 87 * 24 * 3600 * 1000);
        const toWarn = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.created_at,
                    u.email, u.first_name, u.last_name
             FROM listings l JOIN users u ON u.id = l.user_id
             WHERE l.status IN ('active','pending')
               AND l.deleted_at IS NULL
               AND l.expiry_warning_sent = FALSE
               AND l.created_at <= $1
               AND NOT EXISTS (SELECT 1 FROM offers WHERE listing_id = l.id AND status = 'accepted')`,
            [warnCutoff]
        );
        for (const l of toWarn.rows) {
            await emailService.sendListingExpiryWarning(l.email, l.first_name, l).catch(() => {});
            await pool.query(`UPDATE listings SET expiry_warning_sent = TRUE WHERE id = $1`, [l.id]);
        }

        // Archive listings at day 90
        const archiveCutoff = new Date(now - 90 * 24 * 3600 * 1000);
        const toArchive = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.created_at,
                    u.email, u.first_name, u.last_name
             FROM listings l JOIN users u ON u.id = l.user_id
             WHERE l.status IN ('active','pending')
               AND l.deleted_at IS NULL
               AND l.created_at <= $1
               AND NOT EXISTS (SELECT 1 FROM offers WHERE listing_id = l.id AND status = 'accepted')`,
            [archiveCutoff]
        );
        for (const l of toArchive.rows) {
            await pool.query(`UPDATE listings SET status = 'expired' WHERE id = $1`, [l.id]);
            await emailService.sendListingExpired(l.email, l.first_name, l).catch(() => {});
        }

        if (toWarn.rows.length || toArchive.rows.length) {
            console.log(`📋 Expiry job: warned ${toWarn.rows.length}, archived ${toArchive.rows.length}`);
        }
    } catch(err) {
        console.error('Listing expiry job error:', err.message);
    }
}
runListingExpiryJob();
setInterval(runListingExpiryJob, 24 * 60 * 60 * 1000).unref();

_schemaMigrations.push(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_unsubscribed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT UNIQUE`
);

// Drip email onboarding job — sends 3-step sequences to sellers, realtors, and buyers
async function ensureUnsubscribeToken(userId) {
    const token = require('crypto').randomBytes(16).toString('hex');
    const { rows } = await pool.query(
        `UPDATE users SET unsubscribe_token = $1 WHERE id = $2 AND unsubscribe_token IS NULL RETURNING unsubscribe_token`,
        [token, userId]
    );
    if (rows.length) return rows[0].unsubscribe_token;
    const { rows: existing } = await pool.query(`SELECT unsubscribe_token FROM users WHERE id = $1`, [userId]);
    return existing[0]?.unsubscribe_token;
}

async function runDripEmailJob() {
    try {
        const baseWhere = `u.is_active IS NOT FALSE AND u.email_unsubscribed IS NOT TRUE`;

        // Step 1: send to users who signed up 1+ days ago and haven't received step 1
        const { rows: step1Users } = await pool.query(`
            SELECT u.id, u.email, u.first_name, u.user_type, u.unsubscribe_token
            FROM users u
            WHERE ${baseWhere}
              AND u.created_at < NOW() - INTERVAL '1 day'
              AND NOT EXISTS (SELECT 1 FROM drip_emails d WHERE d.user_id = u.id AND d.sequence_step = 1)
            LIMIT 50
        `);
        for (const user of step1Users) {
            try {
                const token = user.unsubscribe_token || await ensureUnsubscribeToken(user.id);
                if (user.user_type === 'seller') await emailService.sendSellerDrip1(user.email, user.first_name, token);
                else if (user.user_type === 'realtor') await emailService.sendRealtorDrip1(user.email, user.first_name, token);
                else if (user.user_type === 'buyer') await emailService.sendBuyerDrip1(user.email, user.first_name, token);
                await pool.query(`INSERT INTO drip_emails (user_id, sequence_step) VALUES ($1, 1) ON CONFLICT DO NOTHING`, [user.id]);
            } catch(e) { console.error('Drip step 1 error:', e.message); }
        }

        // Step 2: 3+ days after signup, step 1 already sent
        const { rows: step2Users } = await pool.query(`
            SELECT u.id, u.email, u.first_name, u.user_type, u.unsubscribe_token
            FROM users u
            WHERE ${baseWhere}
              AND u.created_at < NOW() - INTERVAL '3 days'
              AND EXISTS (SELECT 1 FROM drip_emails d WHERE d.user_id = u.id AND d.sequence_step = 1)
              AND NOT EXISTS (SELECT 1 FROM drip_emails d WHERE d.user_id = u.id AND d.sequence_step = 2)
            LIMIT 50
        `);
        for (const user of step2Users) {
            try {
                const token = user.unsubscribe_token || await ensureUnsubscribeToken(user.id);
                if (user.user_type === 'seller') await emailService.sendSellerDrip2(user.email, user.first_name, token);
                else if (user.user_type === 'realtor') await emailService.sendRealtorDrip2(user.email, user.first_name, token);
                else if (user.user_type === 'buyer') await emailService.sendBuyerDrip2(user.email, user.first_name, token);
                await pool.query(`INSERT INTO drip_emails (user_id, sequence_step) VALUES ($1, 2) ON CONFLICT DO NOTHING`, [user.id]);
            } catch(e) { console.error('Drip step 2 error:', e.message); }
        }

        // Step 3: 7+ days after signup, step 2 already sent
        const { rows: step3Users } = await pool.query(`
            SELECT u.id, u.email, u.first_name, u.user_type, u.unsubscribe_token
            FROM users u
            WHERE ${baseWhere}
              AND u.created_at < NOW() - INTERVAL '7 days'
              AND EXISTS (SELECT 1 FROM drip_emails d WHERE d.user_id = u.id AND d.sequence_step = 2)
              AND NOT EXISTS (SELECT 1 FROM drip_emails d WHERE d.user_id = u.id AND d.sequence_step = 3)
            LIMIT 50
        `);
        for (const user of step3Users) {
            try {
                const token = user.unsubscribe_token || await ensureUnsubscribeToken(user.id);
                if (user.user_type === 'seller') await emailService.sendSellerDrip3(user.email, user.first_name, token);
                else if (user.user_type === 'realtor') await emailService.sendRealtorDrip3(user.email, user.first_name, token);
                else if (user.user_type === 'buyer') await emailService.sendBuyerDrip3(user.email, user.first_name, token);
                await pool.query(`INSERT INTO drip_emails (user_id, sequence_step) VALUES ($1, 3) ON CONFLICT DO NOTHING`, [user.id]);
            } catch(e) { console.error('Drip step 3 error:', e.message); }
        }

        console.log(`Drip job: sent ${step1Users.length + step2Users.length + step3Users.length} emails`);
    } catch(e) { console.error('Drip job error:', e.message); }
}

// Run every 6 hours
runDripEmailJob();
setInterval(runDripEmailJob, 6 * 60 * 60 * 1000).unref();

// Run all schema migrations then start listening
async function startServer() {
    for (const sql of _schemaMigrations) {
        try {
            await pool.query(sql);
        } catch (err) {
            // "column already exists" is expected on restarts — log anything else
            if (!err.message.includes('already exists')) {
                console.error('Migration warning:', err.message);
            }
        }
    }
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
}
startServer().catch(err => {
    console.error('Server startup failed:', err);
    process.exit(1);
});
