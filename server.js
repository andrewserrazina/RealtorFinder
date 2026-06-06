// server.js - Production-ready Express backend with database
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
require('dotenv').config();

// ===== STARTUP ENVIRONMENT VALIDATION =====
const _requiredEnv = ['DATABASE_URL', 'SESSION_SECRET'];
const _missingEnv = _requiredEnv.filter(k => !process.env[k]);
if (_missingEnv.length) {
    console.error(`FATAL: Missing required environment variables: ${_missingEnv.join(', ')}`);
    process.exit(1);
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('WARNING: STRIPE_WEBHOOK_SECRET not set — Stripe webhooks will fail signature verification');
}
if (process.env.NODE_ENV === 'production') {
    if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
        console.error('FATAL: STRIPE_SECRET_KEY must be a live key (sk_live_...) in production');
        process.exit(1);
    }
    if (!process.env.FRONTEND_URL) {
        console.error('FATAL: FRONTEND_URL is required in production');
        process.exit(1);
    }
}

const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { upload, uploadDoc, uploadToCloudinary, uploadToCloudinaryDoc } = require('./config/cloudinary');
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
const allowedOrigins = (() => {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const origins = new Set([base]);
    // Include localhost only in non-production environments
    if (process.env.NODE_ENV !== 'production') origins.add('http://localhost:3000');
    // Always allow both the www and realtors subdomains
    try {
        const url = new URL(base);
        const root = url.hostname.replace(/^www\./, '');
        origins.add(`${url.protocol}//www.${root}`);
        origins.add(`${url.protocol}//realtors.${root}`);
    } catch (_) {}
    return [...origins];
})();
app.use(cors({
    origin: allowedOrigins,
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
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true, // Trust the reverse proxy
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

app.use(cookieParser());

// Attach user to all requests
app.use(auth.attachUser);

// Block unapproved / deactivated accounts from all API routes except auth, admin, and webhooks
app.use('/api', (req, res, next) => {
    if (!req.user || !req.user.id) return next(); // unauthenticated — let route handle it
    // These paths work regardless of approval status
    const exempt = ['/auth/', '/webhook/', '/admin/', '/referrals/'];
    // Public read-only endpoints accessible regardless of approval status
    const publicGet = ['/realtors/founding-count', '/realtors/search', '/realtors/leaderboard', '/listings'];
    if (exempt.some(p => req.path.startsWith(p))) return next();
    if (req.method === 'GET' && publicGet.some(p => req.path.startsWith(p))) return next();
    if (req.user.is_active === false) {
        return res.status(403).json({ error: 'account_deactivated', message: 'Your account has been deactivated. Please contact support.' });
    }
    if (!req.user.is_admin && req.user.is_approved === false) {
        return res.status(403).json({ error: 'account_pending', message: 'Your account is pending approval. You will be notified by email once it is activated.' });
    }
    next();
});

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

// HTML-escape helper used in all server-rendered pages to prevent XSS
const he = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');

// Fire-and-forget: email nearby approved realtors about a new listing
const zipCoordCache = new Map();

async function notifyNearbyRealtors(listing) {
    try {
        const RADIUS_MILES = 25;
        const MAX_EMAILS = 200;
        let sent = 0;
        const notifiedIds = new Set();

        // Path 1: service_areas text match (no geocoding needed)
        if (listing.city || listing.state) {
            const cityPart = listing.city ? `%${listing.city}%` : null;
            const statePart = listing.state ? `%${listing.state}%` : null;
            let serviceAreaQuery;
            let serviceAreaParams;
            if (cityPart && statePart) {
                serviceAreaQuery = `SELECT id, first_name, email, zip_code FROM users
                     WHERE user_type = 'realtor' AND is_approved = true AND is_active IS NOT FALSE
                       AND email IS NOT NULL
                       AND (email_alerts IS NULL OR email_alerts = true)
                       AND (service_areas ILIKE $1 OR service_areas ILIKE $2)`;
                serviceAreaParams = [cityPart, statePart];
            } else {
                const pattern = cityPart || statePart;
                serviceAreaQuery = `SELECT id, first_name, email, zip_code FROM users
                     WHERE user_type = 'realtor' AND is_approved = true AND is_active IS NOT FALSE
                       AND email IS NOT NULL
                       AND (email_alerts IS NULL OR email_alerts = true)
                       AND service_areas ILIKE $1`;
                serviceAreaParams = [pattern];
            }
            const { rows: saRealtors } = await pool.query(serviceAreaQuery, serviceAreaParams);
            for (const realtor of saRealtors) {
                if (sent >= MAX_EMAILS) break;
                if (notifiedIds.has(realtor.id)) continue;
                await emailService.sendNewListingAlert(realtor, listing, 0);
                sseNotify(realtor.id, { type: 'notification' });
                notifiedIds.add(realtor.id);
                sent++;
            }
        }

        // Path 2: geocode + radius match for remaining realtors
        if (sent < MAX_EMAILS && listing.latitude && listing.longitude) {
            const { rows: allRealtors } = await pool.query(
                `SELECT id, first_name, email, zip_code FROM users
                 WHERE user_type = 'realtor' AND is_approved = true AND is_active IS NOT FALSE
                   AND email IS NOT NULL AND zip_code IS NOT NULL
                   AND (email_alerts IS NULL OR email_alerts = true)`
            );
            for (const realtor of allRealtors) {
                if (sent >= MAX_EMAILS) break;
                if (notifiedIds.has(realtor.id)) continue;
                let coords = zipCoordCache.get(realtor.zip_code);
                if (!coords) {
                    coords = await geocodeAddress(`${realtor.zip_code}, USA`);
                    if (coords) zipCoordCache.set(realtor.zip_code, coords);
                }
                if (!coords) continue;
                const dist = haversineMiles(listing.latitude, listing.longitude, coords.latitude, coords.longitude);
                if (dist <= RADIUS_MILES) {
                    await emailService.sendNewListingAlert(realtor, listing, dist);
                    sseNotify(realtor.id, { type: 'notification' });
                    notifiedIds.add(realtor.id);
                    sent++;
                }
            }
        }

        if (sent > 0) console.log(`📬 Notified ${sent} realtors about listing ${listing.id}`);
    } catch (err) {
        console.error('notifyNearbyRealtors error:', err.message);
    }
}

const waitlistLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many signups from this IP. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Too many contact requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const impersonateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Too many impersonation attempts. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false
});

async function verifyRecaptcha(token) {
    if (!process.env.RECAPTCHA_SECRET) return true; // skip if not configured
    if (!token) return false;
    try {
        const resp = await fetch(
            `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${encodeURIComponent(token)}`,
            { method: 'POST' }
        );
        const data = await resp.json();
        return data.success && data.score >= 0.5;
    } catch {
        return true; // fail open on network error so real users aren't blocked
    }
}

// SSE: in-memory client registry — userId -> Set<res>
const sseClients = new Map();
function sseNotify(userId, payload) {
    const clients = sseClients.get(userId);
    if (!clients || !clients.size) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const r of clients) {
        try { r.write(line); } catch (_) {}
    }
}

// ===== API ROUTES =====

// Apply rate limiters — auth routes get the strict one first, then general API limiter covers all /api/*
app.use('/api/auth', authLimiterStrict);
app.use('/api', apiLimiter);

// ===== AUTHENTICATION ROUTES =====

// Signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password, userType, firstName, lastName, zipCode, companyName, licenseNumber, recaptchaToken, termsAccepted, marketingConsent } = req.body;

        if (!email || !password || !userType || !firstName || !lastName || !zipCode) {
            return res.status(400).json({ error: 'All fields required' });
        }

        if (!await verifyRecaptcha(recaptchaToken)) {
            return res.status(400).json({ error: 'reCAPTCHA verification failed. Please try again.' });
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

        if (!/^\d{5}(-\d{4})?$/.test(zipCode)) {
            return res.status(400).json({ error: 'ZIP code must be a 5-digit US ZIP (e.g. 90210)' });
        }

        const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
        if (!strongPassword.test(password)) {
            return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number' });
        }

        if (firstName.length > 100 || lastName.length > 100) {
            return res.status(400).json({ error: 'Name must be 100 characters or less' });
        }

        const user = await auth.createUser(email, password, userType, firstName, lastName, zipCode);

        // Record consent timestamps (non-blocking)
        const now = new Date();
        pool.query(
            `UPDATE users SET terms_accepted_at = $1, marketing_consent_at = $2 WHERE id = $3`,
            [termsAccepted ? now : null, marketingConsent ? now : null, user.id]
        ).catch(err => console.error('Consent timestamp save failed (non-fatal):', err.message));

        // Realtors automatically get a company (solo company if no name provided)
        if (userType === 'realtor') {
            const name = (companyName || '').trim() || `${firstName} ${lastName}`;
            try {
                await db.createCompany(name, user.id, 'basic');
            } catch (companyErr) {
                console.error('Company creation failed (non-fatal):', companyErr.message);
            }
            if (licenseNumber && licenseNumber.trim()) {
                await pool.query(
                    `UPDATE users SET license_number = $1 WHERE id = $2`,
                    [licenseNumber.trim().substring(0, 50), user.id]
                ).catch(err => console.error('License number save failed (non-fatal):', err.message));
            }
        }

        // Generate public profile slug (firstname-lastname-id, lowercase, alphanumeric+hyphens)
        const rawSlug = `${firstName}-${lastName}-${user.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
        pool.query(`UPDATE users SET profile_slug = $1 WHERE id = $2`, [rawSlug, user.id])
            .catch(err => console.error('Profile slug save failed (non-fatal):', err.message));

        // Send verification email (non-blocking)
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
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
        const { property_type, target_areas, budget_min, budget_max, bedrooms } = req.body;
        if (!property_type || !target_areas) {
            return res.status(400).json({ error: 'property_type and target_areas are required' });
        }
        if (String(target_areas).length > 500) {
            return res.status(400).json({ error: 'target_areas must be under 500 characters' });
        }
        if (budget_min !== undefined && budget_min !== null && budget_min !== '') {
            const bmin = parseFloat(budget_min);
            if (isNaN(bmin) || bmin < 0) return res.status(400).json({ error: 'budget_min must be a non-negative number' });
        }
        if (budget_max !== undefined && budget_max !== null && budget_max !== '') {
            const bmax = parseFloat(budget_max);
            if (isNaN(bmax) || bmax < 0) return res.status(400).json({ error: 'budget_max must be a non-negative number' });
            if (budget_min && parseFloat(budget_min) > bmax) return res.status(400).json({ error: 'budget_min cannot exceed budget_max' });
        }
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
                    ).then(() => sseNotify(realtor.id, { type: 'notification' })).catch(() => {});

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

        // Subscription check: basic plan limited to 5 buyer-request responses/month
        const planRow = await pool.query(
            `SELECT COALESCE(c.plan, u.subscription_plan, 'basic') AS plan
             FROM users u LEFT JOIN companies c ON u.company_id = c.id
             WHERE u.id = $1`,
            [req.session.userId]
        );
        const realtorPlan = planRow.rows[0]?.plan || 'basic';
        if (realtorPlan === 'basic') {
            const countRow = await pool.query(
                `SELECT COUNT(*) AS cnt FROM buyer_request_responses
                 WHERE realtor_user_id = $1 AND created_at >= date_trunc('month', NOW())`,
                [req.session.userId]
            );
            if (parseInt(countRow.rows[0].cnt) >= 5) {
                return res.status(429).json({ error: "You've reached your 5 buyer-lead responses/month on the Basic plan. Upgrade to Professional or Firm for unlimited responses." });
            }
        }

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

// Buyer selects a realtor from their responses
app.post('/api/buyer-requests/:id/select-realtor', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'buyer') return res.status(403).json({ error: 'Buyers only' });
        const { realtorUserId } = req.body;
        if (!realtorUserId) return res.status(400).json({ error: 'realtorUserId required' });

        // Verify the request belongs to this buyer
        const reqRow = await pool.query(
            `SELECT id, status FROM buyer_requests WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.session.userId]
        );
        if (!reqRow.rows.length) return res.status(404).json({ error: 'Request not found' });
        if (reqRow.rows[0].status === 'matched') return res.status(400).json({ error: 'You already selected a realtor for this request' });

        // Verify the realtor responded to this request
        const responseRow = await pool.query(
            `SELECT brr.id, u.first_name, u.last_name, u.email FROM buyer_request_responses brr
             JOIN users u ON u.id = brr.realtor_user_id
             WHERE brr.buyer_request_id = $1 AND brr.realtor_user_id = $2`,
            [req.params.id, realtorUserId]
        );
        if (!responseRow.rows.length) return res.status(404).json({ error: 'Realtor response not found' });

        const realtor = responseRow.rows[0];

        // Mark request as matched
        await pool.query(
            `UPDATE buyer_requests SET status = 'matched', selected_realtor_id = $1, updated_at = NOW() WHERE id = $2`,
            [realtorUserId, req.params.id]
        );

        // Notify the selected realtor
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, 'buyer_selected', 'A Buyer Chose You!', $2, '/dashboard/realtor')`,
            [realtorUserId, `${req.user.first_name || 'A buyer'} selected you as their agent for their home search.`]
        ).catch(() => {});

        emailService.sendBuyerSelectedRealtor && emailService.sendBuyerSelectedRealtor(
            realtor.email, realtor.first_name, req.user
        ).catch(() => {});

        res.json({ success: true });
    } catch (error) {
        console.error('Error selecting realtor:', error);
        res.status(500).json({ error: 'Failed to select realtor' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
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
        
        // Track last login time for re-engagement detection
        pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});

        // Create session
        req.session.userId = user.id;
        req.session.userType = user.userType;
        req.session.firstName = user.firstName;
        req.session.lastName = user.lastName;
        req.session.zipCode = user.zipCode;
        req.session.isApproved = user.isApproved || false;
        req.session.emailVerified = user.emailVerified || false;

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
                isApproved: user.isApproved || false,
                emailVerified: user.emailVerified || false
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
        isAdmin: req.user.is_admin || false,
        isApproved: req.user.is_admin ? true : (req.user.is_approved === true),
        subscription_plan: req.user.subscription_plan || 'free'
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
app.post('/api/auth/resend-verification', auth.requireAuth, async (req, res) => {
    try {
        // Per-user rate limit: max 3 resends per hour (mirrors forgot-password limit)
        const { rows: recent } = await pool.query(
            `SELECT COUNT(*) AS cnt FROM verification_resend_log WHERE user_id=$1 AND created_at > NOW() - INTERVAL '1 hour'`,
            [req.session.userId]
        );
        if (parseInt(recent[0].cnt) >= 3) {
            return res.status(429).json({ error: 'Too many resend requests. Please wait before trying again.' });
        }
        await pool.query(`INSERT INTO verification_resend_log (user_id) VALUES ($1)`, [req.session.userId]);

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
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email required' });
    }
    try {
        const user = await db.getUserByEmail(email);
        // Always return success to prevent email enumeration
        if (user) {
            // Per-email rate limit: max 3 reset emails per hour
            const { rows: recentTokens } = await pool.query(
                `SELECT COUNT(*) AS cnt FROM password_reset_tokens
                 WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
                [user.id]
            );
            if (parseInt(recentTokens[0].cnt) >= 3) {
                return res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
            }
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
const _strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
app.post('/api/auth/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (!_strongPassword.test(newPassword)) {
        return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `UPDATE password_reset_tokens SET used = TRUE
             WHERE token = $1 AND used = FALSE AND expires_at > NOW()
             RETURNING user_id`,
            [token]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid, expired, or already-used reset link' });
        }
        const userId = rows[0].user_id;
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashedPassword, userId]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Password updated. You can now log in.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    } finally {
        client.release();
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
        const { city, type, minPrice, maxPrice, minBeds, maxBeds, minBaths, zip, swLat, swLng, neLat, neLng, sort, page = 1, limit = 50 } = req.query;
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
        if (['newest', 'price_asc', 'price_desc', 'most_bids'].includes(sort)) filters.sort = sort;

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

// Literal routes MUST be registered before /:id or Express treats them as id values

// Compare up to 3 listings side-by-side
app.get('/api/listings/compare', async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 3);
        if (!ids.length) return res.status(400).json({ error: 'ids required (comma-separated, max 3)' });
        const { rows } = await pool.query(
            `SELECT id, address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft,
                    description, image_urls, created_at, status,
                    COALESCE(view_count, 0) AS view_count,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = l.id) AS offer_count
             FROM listings l WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
            [ids]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load listings' });
    }
});

// Search listings with filters
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
        const countResult = await pool.query(`SELECT COUNT(*) AS total FROM listings l WHERE ${where}`, params);
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
             WHERE l.share_token = $1 AND l.status != 'inactive' AND l.deleted_at IS NULL`,
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

// Get single listing — strip owner PII for unauthenticated/non-owner callers
app.get('/api/listings/:id', async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) {
            return res.status(404).json({ error: 'Listing not found' });
        }
        const isOwner = req.session?.userId && req.session.userId === listing.user_id;
        const isAdmin = req.user?.is_admin;
        const { owner_name, owner_email, owner_phone, ...publicListing } = listing;
        const payload = { ...publicListing, date: formatDate(listing.created_at) };
        if (isOwner || isAdmin) {
            payload.owner_name = owner_name;
            payload.owner_email = owner_email;
            payload.owner_phone = owner_phone;
        }
        res.json(payload);
    } catch (error) {
        console.error('Error fetching listing:', error);
        res.status(500).json({ error: 'Failed to fetch listing' });
    }
});

// Create new listing (requires authentication)
app.post('/api/listings', auth.requireAuth, async (req, res) => {
    try {
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address before creating a listing. Check your inbox for a verification link.' });
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Only seller accounts can create listings' });
        const { address, price, type, bedrooms, bathrooms, sqft, description, ownerName, ownerEmail, ownerPhone, zestimate, owner_attested } = req.body;
        
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

        // Owner attestation
        if (owner_attested) {
            pool.query(`UPDATE listings SET owner_attested=TRUE, owner_attested_at=NOW() WHERE id=$1`, [newListing.id]).catch(() => {});
        }

        // Send confirmation email to seller (fire-and-forget — listing already created)
        emailService.sendListingConfirmation(newListing).catch(err => console.error('Listing confirmation email failed:', err));

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
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for a verification link.' });
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
        ).then(() => sseNotify(listing.user_id, { type: 'notification' })).catch(() => {});

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
    const client = await pool.connect();
    try {
        const offerId = parseInt(req.params.id);
        const { action } = req.body; // 'accept' or 'decline'
        if (!['accept', 'decline'].includes(action)) {
            client.release();
            return res.status(400).json({ error: 'action must be accept or decline' });
        }

        await client.query('BEGIN');

        // Lock the offer row and verify ownership atomically
        const offerRows = await client.query(
            `SELECT o.*, l.user_id as listing_owner_id, l.address, l.city, l.state, l.zip, l.price,
                    l.owner_name, l.owner_email, l.owner_phone
             FROM offers o JOIN listings l ON o.listing_id = l.id WHERE o.id = $1 FOR UPDATE`,
            [offerId]
        );
        if (!offerRows.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Offer not found' });
        }
        const offerRow = offerRows.rows[0];
        if (offerRow.listing_owner_id !== req.session.userId) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (action === 'accept') {
            const declinedOffers = await db.acceptOffer(offerId, offerRow.listing_id);
            await client.query('COMMIT');
            // Post-transaction notifications (fire and forget)
            emailService.sendOfferAcceptedEmail(offerRow, offerRow).catch(err =>
                console.error('Offer accepted email failed:', err.message)
            );
            if (offerRow.user_id) {
                pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'offer_accepted','Proposal Accepted!',$2,'/dashboard/realtor')`,
                    [offerRow.user_id, `Your proposal on ${offerRow.address} was accepted!`]).then(() => sseNotify(offerRow.user_id, { type: 'notification' })).catch(() => {});
            }
            declinedOffers.forEach(declined => {
                emailService.sendOfferDeclinedEmail(declined, offerRow).catch(err =>
                    console.error('Offer declined email failed:', err.message)
                );
                if (declined.user_id) {
                    pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'offer_declined','Proposal Declined',$2,'/dashboard/realtor')`,
                        [declined.user_id, `Your proposal on ${offerRow.address} was not selected.`]).then(() => sseNotify(declined.user_id, { type: 'notification' })).catch(() => {});
                }
            });
            return res.json({ success: true, status: 'accepted' });
        }

        // decline single offer
        await client.query(`UPDATE offers SET status = 'declined' WHERE id = $1`, [offerId]);
        await client.query('COMMIT');
        emailService.sendOfferDeclinedEmail(offerRow, offerRow).catch(err =>
            console.error('Offer declined email failed:', err.message)
        );
        if (offerRow.user_id) {
            pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'offer_declined','Proposal Declined',$2,'/dashboard/realtor')`,
                [offerRow.user_id, `Your proposal on ${offerRow.address} was not selected.`]).then(() => sseNotify(offerRow.user_id, { type: 'notification' })).catch(() => {});
        }
        res.json({ success: true, status: 'declined' });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error updating offer status:', error);
        res.status(500).json({ error: 'Failed to update offer status' });
    } finally {
        client.release();
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
app.get('/api/seller/offers', auth.requireAuth, (req, res, next) => {
    if (!req.user || req.user.user_type !== 'seller') return res.status(403).json({ error: 'Seller access required' });
    next();
}, async (req, res) => {
    try {
        const offers = await db.getSellerOffers(req.session.userId);
        res.json(offers);
    } catch (error) {
        console.error('Error fetching seller offers:', error);
        res.status(500).json({ error: 'Failed to fetch offers' });
    }
});

// Get current user's offers (for realtors)
app.get('/api/my-offers', auth.requireAuth, (req, res, next) => {
    if (!req.user || req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtor access required' });
    next();
}, async (req, res) => {
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
app.post('/api/listings/:id/images', auth.requireAuth, uploadLimiter, upload.array('images', 10), async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);
        // Verify the caller owns this listing
        const ownerCheck = await pool.query(`SELECT user_id FROM listings WHERE id=$1 AND deleted_at IS NULL`, [listingId]);
        if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Listing not found' });
        if (ownerCheck.rows[0].user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

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
        const { phone } = req.body;
        if (phone && !/^[\d\s\-\+\(\)\.]{7,20}$/.test(phone)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }
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
            `SELECT profile_photo, bio, service_areas, license_number, brokerage, phone FROM users WHERE id = $1`,
            [req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const p = rows[0];
        const items = [
            { label: 'has_photo', done: !!p.profile_photo },
            { label: 'has_bio', done: !!(p.bio && p.bio.trim().length > 20) },
            { label: 'has_service_areas', done: !!(p.service_areas && p.service_areas.trim()) },
            { label: 'has_license', done: !!p.license_number },
            { label: 'has_brokerage', done: !!p.brokerage },
            { label: 'has_phone', done: !!p.phone }
        ];
        const score = (items.filter(i => i.done).length / 6) * 100;
        res.json({ score, items });
    } catch (err) {
        console.error('Profile completeness error:', err);
        res.status(500).json({ error: 'Failed to compute completeness' });
    }
});

// ===== LICENSE VERIFICATION ROUTES =====

// Upload license document
app.post('/api/profile/license-doc', auth.requireAuth, uploadLimiter, uploadDoc.single('license_doc'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        const result = await uploadToCloudinaryDoc(req.file.buffer, req.file.mimetype);
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

// ===== NOTIFICATION PREFERENCES =====

app.get('/api/me/notification-preferences', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT notif_new_proposal, notif_messages, notif_weekly_digest,
                    notif_listing_alerts, notif_engagement_reminders
             FROM users WHERE id = $1`,
            [req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Notification prefs error:', err);
        res.status(500).json({ error: 'Failed to load preferences' });
    }
});

app.put('/api/me/notification-preferences', auth.requireAuth, async (req, res) => {
    try {
        const fields = ['notif_new_proposal','notif_messages','notif_weekly_digest','notif_listing_alerts','notif_engagement_reminders'];
        const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
        const vals = fields.map(f => req.body[f] !== undefined ? !!req.body[f] : true);
        vals.push(req.session.userId);
        await pool.query(`UPDATE users SET ${sets} WHERE id = $${vals.length}`, vals);
        res.json({ success: true });
    } catch (err) {
        console.error('Update notification prefs error:', err);
        res.status(500).json({ error: 'Failed to update preferences' });
    }
});

// ===== RE-ENGAGEMENT STALE CHECK =====

app.get('/api/me/stale-check', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.json({ stale: false });
        const { rows } = await pool.query(
            `SELECT last_login_at, service_areas, zip_code FROM users WHERE id = $1`,
            [req.session.userId]
        );
        if (!rows.length) return res.json({ stale: false });
        const u = rows[0];
        const daysSince = u.last_login_at
            ? Math.floor((Date.now() - new Date(u.last_login_at).getTime()) / (1000 * 60 * 60 * 24))
            : 999;
        if (daysSince < 14) return res.json({ stale: false });

        // Count new listings since last login in their area
        let newListings = 0;
        if (u.last_login_at) {
            const area = u.service_areas || u.zip_code || '';
            const terms = area.split(',').map(t => t.trim()).filter(Boolean).slice(0, 3);
            if (terms.length > 0) {
                const conditions = terms.map((_, i) => `(l.city ILIKE $${i + 2} OR l.zip ILIKE $${i + 2} OR l.state ILIKE $${i + 2})`).join(' OR ');
                const params = [u.last_login_at, ...terms.map(t => `%${t}%`)];
                const { rows: lr } = await pool.query(
                    `SELECT COUNT(*) AS cnt FROM listings l WHERE l.created_at > $1 AND l.deleted_at IS NULL AND l.status = 'active' AND (${conditions})`,
                    params
                );
                newListings = parseInt(lr[0].cnt) || 0;
            }
        }
        res.json({ stale: true, days_since_login: daysSince, new_listings: newListings });
    } catch (err) {
        console.error('Stale check error:', err);
        res.json({ stale: false });
    }
});

// ===== PROPOSAL TEMPLATES =====

app.get('/api/proposal-templates', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT id, name, content, created_at FROM proposal_templates WHERE realtor_id = $1 ORDER BY created_at DESC`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Proposal templates error:', err);
        res.status(500).json({ error: 'Failed to load templates' });
    }
});

app.post('/api/proposal-templates', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { name, content } = req.body;
        if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
        if (name.length > 100) return res.status(400).json({ error: 'Name too long' });
        if (content.length > 5000) return res.status(400).json({ error: 'Content too long' });
        const { rows } = await pool.query(
            `INSERT INTO proposal_templates (realtor_id, name, content) VALUES ($1, $2, $3) RETURNING id, name, content, created_at`,
            [req.session.userId, name.trim(), content.trim()]
        );
        res.json(rows[0]);
    } catch (err) {
        console.error('Create template error:', err);
        res.status(500).json({ error: 'Failed to create template' });
    }
});

app.put('/api/proposal-templates/:id', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { name, content } = req.body;
        if (!name || !content) return res.status(400).json({ error: 'Name and content required' });
        const { rows } = await pool.query(
            `UPDATE proposal_templates SET name = $1, content = $2 WHERE id = $3 AND realtor_id = $4 RETURNING id, name, content`,
            [name.trim(), content.trim(), parseInt(req.params.id), req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Template not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Update template error:', err);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

app.delete('/api/proposal-templates/:id', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rowCount } = await pool.query(
            `DELETE FROM proposal_templates WHERE id = $1 AND realtor_id = $2`,
            [parseInt(req.params.id), req.session.userId]
        );
        if (!rowCount) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete template error:', err);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// ===== ADMIN ROUTES =====

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// Bootstrap: grant admin to the calling user only when no admin exists yet
app.post('/api/admin/claim-admin', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id FROM users WHERE is_admin = TRUE LIMIT 1`);
        if (rows.length > 0) {
            return res.status(403).json({ error: 'An admin already exists' });
        }
        await pool.query(`UPDATE users SET is_admin = TRUE WHERE id = $1`, [req.session.userId]);
        req.session.isAdmin = true;
        res.json({ success: true, message: 'Admin access granted' });
    } catch (err) {
        console.error('claim-admin error:', err);
        res.status(500).json({ error: 'Failed to claim admin' });
    }
});

app.get('/api/admin/waitlist', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, email, user_type, created_at FROM waitlist ORDER BY created_at DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error('Admin waitlist error:', err);
        res.status(500).json({ error: 'Failed to fetch waitlist' });
    }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const stats = await db.getAdminStats();
        res.json(stats);
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ===== ADMIN ANALYTICS FUNNEL =====
app.get('/api/admin/analytics/funnel', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            WITH week_ranges AS (
                SELECT
                    DATE_TRUNC('week', NOW()) - (n * INTERVAL '1 week') AS week_start,
                    DATE_TRUNC('week', NOW()) - (n * INTERVAL '1 week') + INTERVAL '1 week' AS week_end
                FROM generate_series(0, 7) AS n
            )
            SELECT
                TO_CHAR(wr.week_start, 'Mon DD') AS week,
                wr.week_start,
                COALESCE(l.listings_posted, 0) AS listings_posted,
                COALESCE(p.proposals_submitted, 0) AS proposals_submitted,
                COALESCE(a.proposals_accepted, 0) AS proposals_accepted
            FROM week_ranges wr
            LEFT JOIN (
                SELECT DATE_TRUNC('week', created_at) AS w, COUNT(*) AS listings_posted
                FROM listings WHERE deleted_at IS NULL
                GROUP BY w
            ) l ON l.w = wr.week_start
            LEFT JOIN (
                SELECT DATE_TRUNC('week', created_at) AS w, COUNT(*) AS proposals_submitted
                FROM proposals
                GROUP BY w
            ) p ON p.w = wr.week_start
            LEFT JOIN (
                SELECT DATE_TRUNC('week', created_at) AS w, COUNT(*) AS proposals_accepted
                FROM proposals WHERE status = 'accepted'
                GROUP BY w
            ) a ON a.w = wr.week_start
            ORDER BY wr.week_start DESC
        `);
        res.json(rows.map(r => ({
            week: r.week,
            listings_posted: parseInt(r.listings_posted),
            proposals_submitted: parseInt(r.proposals_submitted),
            proposals_accepted: parseInt(r.proposals_accepted),
            conversion_rate: r.listings_posted > 0
                ? Math.round((r.proposals_accepted / r.listings_posted) * 100)
                : 0
        })));
    } catch (err) {
        console.error('Funnel analytics error:', err);
        res.status(500).json({ error: 'Failed to fetch funnel data' });
    }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { page, limit, search, userType } = req.query;
        const result = await db.getAllUsersAdmin({ page, limit, search, userType });
        res.json(result);
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.get('/api/admin/listings', requireAdmin, async (req, res) => {
    try {
        const { page, limit, search, status } = req.query;
        const result = await db.getAllListingsAdmin({ page, limit, search, status });
        res.json(result);
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
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Advisory lock prevents two concurrent approvals from both counting < 100
        await client.query(`SELECT pg_advisory_xact_lock(1001)`);

        // Count already-approved realtors to determine founding status (first 100, before August 2026 deadline)
        const { rows: countRows } = await client.query(
            `SELECT COUNT(*) AS cnt FROM users WHERE user_type = 'realtor' AND is_approved = true AND is_active IS NOT FALSE`
        );
        const approvedCount = parseInt(countRows[0].cnt) || 0;
        const foundingDeadline = new Date('2026-08-31T23:59:59Z');
        const isFounding = approvedCount < 100 && new Date() <= foundingDeadline;

        const { rows } = await client.query(
            `UPDATE users SET is_approved = true,
                is_founding_member = CASE WHEN $2 THEN TRUE ELSE is_founding_member END
             WHERE id = $1
             RETURNING id, email, first_name, user_type, is_approved, subscription_plan, is_founding_member`,
            [parseInt(req.params.id), isFounding]
        );
        if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
        await client.query('COMMIT');

        const u = rows[0];
        emailService.sendAccountApprovedEmail(u.email, u.first_name, u.user_type)
            .catch(err => console.error('Approval email failed:', err.message));
        res.json({ success: true, user: u });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Admin approve error:', error);
        res.status(500).json({ error: 'Failed to approve user' });
    } finally {
        client.release();
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
    const stateNames = {
        MA:'Massachusetts', CT:'Connecticut', RI:'Rhode Island', VT:'Vermont', NH:'New Hampshire', ME:'Maine',
        NY:'New York', NJ:'New Jersey', PA:'Pennsylvania', MD:'Maryland', VA:'Virginia', DC:'District of Columbia',
        FL:'Florida', GA:'Georgia', NC:'North Carolina', SC:'South Carolina', TN:'Tennessee', AL:'Alabama',
        AR:'Arkansas', LA:'Louisiana', MS:'Mississippi', WV:'West Virginia', KY:'Kentucky', DE:'Delaware',
        IL:'Illinois', OH:'Ohio', MI:'Michigan', WI:'Wisconsin', IN:'Indiana', MN:'Minnesota', MO:'Missouri',
        IA:'Iowa', KS:'Kansas', NE:'Nebraska', ND:'North Dakota', SD:'South Dakota', OK:'Oklahoma',
        TX:'Texas', CO:'Colorado', AZ:'Arizona', NV:'Nevada', WA:'Washington', OR:'Oregon', CA:'California',
        UT:'Utah', ID:'Idaho', MT:'Montana', WY:'Wyoming', NM:'New Mexico', AK:'Alaska', HI:'Hawaii',
    };
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

// /end and /status must be defined BEFORE /:userId or Express swallows them
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
        console.log(`[AUDIT] Admin ${origId} ended impersonation of user ${req.session.userId} from IP ${req.ip} at ${new Date().toISOString()}`);
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, action, target_user_id, ip_address) VALUES ($1, 'impersonate_end', $2, $3)`,
            [origId, req.session.userId, req.ip]
        ).catch(err => console.error('Audit log insert failed:', err.message));
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

app.post('/api/admin/impersonate/:userId', requireAdmin, impersonateLimiter, async (req, res) => {
    try {
        const adminId = req.session.userId;
        const targetId = parseInt(req.params.userId);
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, user_type FROM users WHERE id = $1`,
            [targetId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const target = rows[0];
        console.log(`[AUDIT] Admin ${adminId} impersonating user ${targetId} (${target.first_name} ${target.last_name}) from IP ${req.ip} at ${new Date().toISOString()}`);
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, action, target_user_id, ip_address) VALUES ($1, 'impersonate_start', $2, $3)`,
            [adminId, targetId, req.ip]
        ).catch(err => console.error('Audit log insert failed:', err.message));
        req.session.impersonating = adminId;
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
        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const { rows } = await pool.query(
            `SELECT id, type, name, email, phone, city_name, state_code, created_at
             FROM city_leads
             WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
             ORDER BY created_at DESC`,
            [days]
        );
        console.log(`[AUDIT] Admin ${req.user.id} exported ${rows.length} leads (last ${days} days) from IP ${req.ip} at ${new Date().toISOString()}`);
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, action, ip_address) VALUES ($1, 'leads_export', $2)`,
            [req.user.id, req.ip]
        ).catch(err => console.error('Audit log insert failed:', err.message));
        const header = 'ID,Type,Name,Email,Phone,City,State,Date\n';
        const csv = rows.map(r =>
            [r.id, r.type, r.name || '', r.email, r.phone || '', r.city_name || '', r.state_code || '',
             new Date(r.created_at).toISOString().slice(0, 10)]
            .map(v => `"${String(v).replace(/"/g, '""')}"`)
            .join(',')
        ).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="city-leads-${days}d.csv"`);
        res.send(header + csv);
    } catch (error) {
        console.error('Leads CSV error:', error);
        res.status(500).json({ error: 'Failed to export leads' });
    }
});

// ===== ADMIN CRM ROUTES =====

// --- Enhanced stats for CRM summary cards ---
app.get('/api/admin/crm-stats', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE user_type='realtor') AS total_realtors,
                COUNT(*) FILTER (WHERE user_type='realtor' AND is_approved=true AND is_active IS NOT FALSE) AS active_realtors,
                COUNT(*) FILTER (WHERE user_type='realtor' AND is_approved=false AND is_active IS NOT FALSE) AS pending_realtors,
                COUNT(*) FILTER (WHERE user_type='seller') AS total_sellers
            FROM users
        `);
        const uStats = rows[0];

        const { rows: lRows } = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total_leads,
                COUNT(*) FILTER (WHERE deleted_at IS NULL AND crm_status='new') AS new_leads,
                COUNT(*) FILTER (WHERE deleted_at IS NULL AND crm_assigned_realtor_id IS NULL AND status='active') AS unassigned_leads
            FROM listings
        `);
        const lStats = lRows[0];

        const { rows: mRows } = await pool.query(`
            SELECT
                COUNT(*) AS total_matches,
                COUNT(*) FILTER (WHERE closed=true) AS closed_deals,
                COALESCE(SUM(referral_fee_expected) FILTER (WHERE payment_status='pending' AND closed=true), 0) AS fees_due,
                COALESCE(SUM(referral_fee_paid), 0) AS fees_received
            FROM lead_matches
        `);
        const mStats = mRows[0];

        const { rows: pRows } = await pool.query(`SELECT COUNT(*) AS total FROM realtor_prospects WHERE converted_user_id IS NULL`);

        res.json({
            total_realtors: uStats.total_realtors,
            active_realtors: uStats.active_realtors,
            pending_realtors: uStats.pending_realtors,
            total_leads: lStats.total_leads,
            new_leads: lStats.new_leads,
            unassigned_leads: lStats.unassigned_leads,
            active_matches: mStats.total_matches,
            closed_deals: mStats.closed_deals,
            fees_due: mStats.fees_due,
            fees_received: mStats.fees_received,
            open_prospects: pRows[0].total,
        });
    } catch (err) {
        console.error('CRM stats error:', err);
        res.status(500).json({ error: 'Failed to fetch CRM stats' });
    }
});

// --- Admin Notes ---
app.get('/api/admin/notes/:type/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT n.id, n.body, n.created_at,
                    u.first_name || ' ' || u.last_name AS admin_name
             FROM admin_notes n
             LEFT JOIN users u ON u.id = n.admin_user_id
             WHERE n.resource_type = $1 AND n.resource_id = $2
             ORDER BY n.created_at DESC`,
            [req.params.type, parseInt(req.params.id)]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch notes' });
    }
});

app.post('/api/admin/notes', requireAdmin, async (req, res) => {
    try {
        const { resource_type, resource_id, body } = req.body;
        if (!body?.trim()) return res.status(400).json({ error: 'Note body required' });
        const { rows } = await pool.query(
            `INSERT INTO admin_notes (resource_type, resource_id, admin_user_id, body)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [resource_type, parseInt(resource_id), req.user.id, body.trim()]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to save note' });
    }
});

app.delete('/api/admin/notes/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM admin_notes WHERE id = $1`, [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete note' });
    }
});

// --- Realtor CRM ---
app.get('/api/admin/crm/realtors', requireAdmin, async (req, res) => {
    try {
        const { status, search } = req.query;
        let where = `WHERE u.user_type = 'realtor'`;
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            where += ` AND (u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
        }

        // Derive CRM status from DB fields
        if (status === 'applied')    where += ` AND u.is_approved = false AND u.is_active IS NOT FALSE`;
        else if (status === 'approved') where += ` AND u.is_approved = true AND u.is_active IS NOT FALSE AND (u.subscription_plan IS NULL OR u.subscription_plan = 'free')`;
        else if (status === 'active')   where += ` AND u.is_approved = true AND u.is_active IS NOT FALSE AND u.subscription_plan NOT IN ('free') AND u.subscription_plan IS NOT NULL`;
        else if (status === 'inactive') where += ` AND u.is_active = false`;

        const { rows } = await pool.query(`
            SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
                   u.is_approved, u.is_active, u.is_admin,
                   u.subscription_plan, u.license_number, u.license_verified,
                   u.service_areas, u.years_experience, u.bio, u.zip_code,
                   u.profile_photo, u.created_at, u.last_login_at,
                   COUNT(DISTINCT p.id) AS proposals_sent,
                   COUNT(DISTINCT lm.id) AS matches_count,
                   (
                       (CASE WHEN u.profile_photo IS NOT NULL THEN 1 ELSE 0 END) +
                       (CASE WHEN u.bio IS NOT NULL AND LENGTH(TRIM(u.bio)) > 20 THEN 1 ELSE 0 END) +
                       (CASE WHEN u.license_number IS NOT NULL THEN 1 ELSE 0 END) +
                       (CASE WHEN u.service_areas IS NOT NULL AND TRIM(u.service_areas) != '' THEN 1 ELSE 0 END) +
                       (CASE WHEN COUNT(DISTINCT p.id) > 0 THEN 1 ELSE 0 END)
                   ) AS onboarding_score
            FROM users u
            LEFT JOIN proposals p ON p.realtor_id = u.id
            LEFT JOIN lead_matches lm ON lm.realtor_id = u.id
            ${where}
            GROUP BY u.id
            ORDER BY u.created_at DESC
        `, params);
        res.json(rows);
    } catch (err) {
        console.error('CRM realtors error:', err);
        res.status(500).json({ error: 'Failed to fetch realtors' });
    }
});

// --- Homeowner Lead CRM ---
app.get('/api/admin/crm/leads', requireAdmin, async (req, res) => {
    try {
        const { status, search } = req.query;
        let where = `WHERE l.deleted_at IS NULL`;
        const params = [];

        if (status) {
            params.push(status);
            where += ` AND l.crm_status = $${params.length}`;
        }
        if (search) {
            params.push(`%${search}%`);
            where += ` AND (l.address ILIKE $${params.length} OR l.city ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
        }

        const { rows } = await pool.query(`
            SELECT l.id, l.address, l.city, l.state, l.zip, l.price,
                   l.status, l.crm_status, l.crm_follow_up_date, l.crm_assigned_realtor_id,
                   l.created_at,
                   u.first_name || ' ' || u.last_name AS seller_name,
                   u.email AS seller_email, u.phone AS seller_phone,
                   ar.first_name || ' ' || ar.last_name AS assigned_realtor_name,
                   COUNT(DISTINCT p.id) AS proposal_count
            FROM listings l
            JOIN users u ON u.id = l.user_id
            LEFT JOIN users ar ON ar.id = l.crm_assigned_realtor_id
            LEFT JOIN proposals p ON p.listing_id = l.id
            ${where}
            GROUP BY l.id, u.first_name, u.last_name, u.email, u.phone,
                     ar.first_name, ar.last_name
            ORDER BY l.created_at DESC
            LIMIT 500
        `, params);
        res.json(rows);
    } catch (err) {
        console.error('CRM leads error:', err);
        res.status(500).json({ error: 'Failed to fetch leads' });
    }
});

app.put('/api/admin/crm/leads/:id', requireAdmin, async (req, res) => {
    try {
        const { crm_status, crm_follow_up_date, crm_assigned_realtor_id } = req.body;
        const { rows } = await pool.query(
            `UPDATE listings SET
                crm_status = COALESCE($1, crm_status),
                crm_follow_up_date = COALESCE($2::date, crm_follow_up_date),
                crm_assigned_realtor_id = $3
             WHERE id = $4
             RETURNING id, crm_status, crm_follow_up_date, crm_assigned_realtor_id`,
            [crm_status || null, crm_follow_up_date || null, crm_assigned_realtor_id || null, parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('CRM lead update error:', err);
        res.status(500).json({ error: 'Failed to update lead' });
    }
});

// --- Match Tracking ---
app.get('/api/admin/matches', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT m.*,
                   l.address, l.city, l.state, l.price,
                   r.first_name || ' ' || r.last_name AS realtor_name, r.email AS realtor_email,
                   a.first_name || ' ' || a.last_name AS assigned_by_name
            FROM lead_matches m
            LEFT JOIN listings l ON l.id = m.listing_id
            LEFT JOIN users r ON r.id = m.realtor_id
            LEFT JOIN users a ON a.id = m.assigned_by
            ORDER BY m.assigned_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

app.post('/api/admin/matches', requireAdmin, async (req, res) => {
    try {
        const { listing_id, realtor_id, notes, estimated_home_value, estimated_commission_pct,
                referral_fee_expected, payment_status } = req.body;
        if (!listing_id || !realtor_id) return res.status(400).json({ error: 'listing_id and realtor_id required' });
        const { rows } = await pool.query(
            `INSERT INTO lead_matches
                (listing_id, realtor_id, assigned_by, notes, estimated_home_value,
                 estimated_commission_pct, referral_fee_expected, payment_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING *`,
            [listing_id, realtor_id, req.user.id, notes || null,
             estimated_home_value || null, estimated_commission_pct || null,
             referral_fee_expected || null, payment_status || 'pending']
        );
        // Update listing crm_status to assigned
        await pool.query(`UPDATE listings SET crm_status='assigned', crm_assigned_realtor_id=$1 WHERE id=$2`,
            [realtor_id, listing_id]);
        res.json(rows[0]);
    } catch (err) {
        console.error('Create match error:', err);
        res.status(500).json({ error: 'Failed to create match' });
    }
});

app.put('/api/admin/matches/:id', requireAdmin, async (req, res) => {
    try {
        const fields = req.body;
        const allowed = ['status','realtor_accepted','contact_made','appointment_scheduled',
            'listing_agreement_signed','under_contract','closed','notes',
            'estimated_home_value','estimated_commission_pct','referral_fee_expected',
            'referral_fee_paid','payment_status','close_date'];
        const sets = [];
        const vals = [];
        allowed.forEach(k => {
            if (k in fields) {
                vals.push(fields[k]);
                sets.push(`${k} = $${vals.length}`);
            }
        });
        if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
        vals.push(parseInt(req.params.id));
        sets.push(`updated_at = NOW()`);
        const { rows } = await pool.query(
            `UPDATE lead_matches SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
            vals
        );
        if (!rows.length) return res.status(404).json({ error: 'Match not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Update match error:', err);
        res.status(500).json({ error: 'Failed to update match' });
    }
});

app.delete('/api/admin/matches/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM lead_matches WHERE id = $1`, [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete match' });
    }
});

// --- Realtor Prospects (Recruitment) ---
app.get('/api/admin/prospects', requireAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        let where = status ? `WHERE outreach_status = $1` : '';
        const params = status ? [status] : [];
        const { rows } = await pool.query(
            `SELECT p.*, u.email AS converted_email
             FROM realtor_prospects p
             LEFT JOIN users u ON u.id = p.converted_user_id
             ${where}
             ORDER BY p.created_at DESC`, params
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch prospects' });
    }
});

app.post('/api/admin/prospects', requireAdmin, async (req, res) => {
    try {
        const { first_name, last_name, brokerage, email, phone, city, state,
                source, outreach_status, last_contact_date, follow_up_date, notes } = req.body;
        const { rows } = await pool.query(
            `INSERT INTO realtor_prospects
                (first_name, last_name, brokerage, email, phone, city, state,
                 source, outreach_status, last_contact_date, follow_up_date, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [first_name||null, last_name||null, brokerage||null, email||null, phone||null,
             city||null, state||null, source||'manual', outreach_status||'not_contacted',
             last_contact_date||null, follow_up_date||null, notes||null]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create prospect' });
    }
});

app.put('/api/admin/prospects/:id', requireAdmin, async (req, res) => {
    try {
        const { first_name, last_name, brokerage, email, phone, city, state,
                source, outreach_status, last_contact_date, follow_up_date, notes } = req.body;
        const { rows } = await pool.query(
            `UPDATE realtor_prospects SET
                first_name=$1, last_name=$2, brokerage=$3, email=$4, phone=$5,
                city=$6, state=$7, source=$8, outreach_status=$9,
                last_contact_date=$10, follow_up_date=$11, notes=$12, updated_at=NOW()
             WHERE id=$13 RETURNING *`,
            [first_name||null, last_name||null, brokerage||null, email||null, phone||null,
             city||null, state||null, source||'manual', outreach_status||'not_contacted',
             last_contact_date||null, follow_up_date||null, notes||null, parseInt(req.params.id)]
        );
        if (!rows.length) return res.status(404).json({ error: 'Prospect not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update prospect' });
    }
});

app.delete('/api/admin/prospects/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM realtor_prospects WHERE id = $1`, [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete prospect' });
    }
});

app.get('/api/admin/crm/realtors-list', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, email FROM users
             WHERE user_type='realtor' AND is_approved=true AND is_active IS NOT FALSE
             ORDER BY first_name`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch realtors list' });
    }
});

// Waitlist signup endpoint
app.post('/api/waitlist', waitlistLimiter, async (req, res) => {
    try {
        const { email, type, recaptchaToken } = req.body; // type = 'seller', 'realtor', or 'buyer'

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }

        if (!await verifyRecaptcha(recaptchaToken)) {
            return res.status(400).json({ error: 'reCAPTCHA verification failed. Please try again.' });
        }

        const normalizedType = ['seller', 'realtor', 'buyer'].includes(type) ? type : 'seller';

        // Save to database — use xmax to detect insert vs update
        const unsubToken = crypto.randomBytes(20).toString('hex');
        const result = await pool.query(
            `INSERT INTO waitlist (email, user_type, unsubscribe_token) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET user_type = $2
             RETURNING *, (xmax = 0) AS is_insert`,
            [email.trim().toLowerCase(), normalizedType, unsubToken]
        );

        // Log the signup
        console.log(`📧 Waitlist signup: ${email} (${normalizedType})`);

        // Send confirmation email for both new and existing signups
        let emailSent = false;
        let emailErrorMessage = null;
        const isNewSignup = result.rows[0]?.is_insert === true;
        const storedToken = result.rows[0]?.unsubscribe_token || unsubToken;

        try {
            console.log('📤 Attempting to send email via emailService...');
            await emailService.sendWaitlistConfirmation(email.trim().toLowerCase(), normalizedType, storedToken);
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
app.post('/api/contact', contactLimiter, async (req, res) => {
    try {
        const { name, email, subject, message, recaptchaToken } = req.body;
        if (!name || !email || !subject || !message) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (!await verifyRecaptcha(recaptchaToken)) {
            return res.status(400).json({ error: 'reCAPTCHA verification failed. Please try again.' });
        }
        if (!email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        if (name.length > 200 || subject.length > 200) {
            return res.status(400).json({ error: 'Name and subject must be under 200 characters' });
        }
        if (message.length > 5000) {
            return res.status(400).json({ error: 'Message must be under 5000 characters' });
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

        // Reuse existing Stripe customer if we have one
        const { rows: custRows } = await pool.query(
            `SELECT stripe_customer_id FROM users WHERE id = $1 AND stripe_customer_id IS NOT NULL
             UNION
             SELECT stripe_customer_id FROM companies WHERE owner_user_id = $1 AND stripe_customer_id IS NOT NULL
             LIMIT 1`,
            [req.session.userId]
        );
        const existingCustomer = custRows[0]?.stripe_customer_id;

        const sessionParams = {
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${base}/dashboard/realtor?upgraded=1`,
            cancel_url: `${base}/pricing`,
            metadata: { userId: String(req.session.userId), plan },
        };
        if (existingCustomer) {
            sessionParams.customer = existingCustomer;
        } else {
            sessionParams.customer_email = user.email;
        }

        // Apply referral credits as Stripe customer balance credit
        const { rows: credRows } = await pool.query(
            `SELECT referral_credits_cents FROM users WHERE id = $1`, [req.session.userId]
        );
        const credCents = parseInt(credRows[0]?.referral_credits_cents) || 0;
        if (credCents > 0 && stripe) {
            let customerId = existingCustomer;
            if (!customerId) {
                const cust = await stripe.customers.create({ email: user.email, name: `${user.first_name || ''} ${user.last_name || ''}`.trim() });
                customerId = cust.id;
                await pool.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [customerId, req.session.userId]);
                sessionParams.customer = customerId;
                delete sessionParams.customer_email;
            }
            await stripe.customers.createBalanceTransaction(customerId, {
                amount: -credCents,
                currency: 'usd',
                description: 'Referral credit applied',
            });
            await pool.query(`UPDATE users SET referral_credits_cents = 0 WHERE id = $1`, [req.session.userId]);
        }

        const session = await stripe.checkout.sessions.create(sessionParams);
        res.json({ url: session.url, credits_applied: credCents > 0 ? credCents : 0 });
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

    // Helper: apply plan to both users and companies rows
    async function applyPlan(stripeCustomerId, plan, subscriptionId = null) {
        const setParts = [`plan=$1`, `stripe_customer_id=$2`, `updated_at=NOW()`];
        const compParams = [plan, stripeCustomerId];
        if (subscriptionId !== null) { setParts.push(`stripe_subscription_id=$3`); compParams.push(subscriptionId); }
        await pool.query(
            `UPDATE companies SET ${setParts.join(',')} WHERE stripe_customer_id=$2 OR owner_user_id=(SELECT id FROM users WHERE stripe_customer_id=$2 LIMIT 1)`,
            compParams
        );
        await pool.query(
            `UPDATE users SET subscription_plan=$1, stripe_customer_id=$2 WHERE stripe_customer_id=$2 OR id=(SELECT owner_user_id FROM companies WHERE stripe_customer_id=$2 LIMIT 1)`,
            [plan, stripeCustomerId]
        );
    }

    if (event.type === 'checkout.session.completed') {
        const sess = event.data.object;

        // Listing boost checkout
        if (sess.metadata?.type === 'listing_boost') {
            try {
                const listingId = parseInt(sess.metadata.listing_id);
                const days = parseInt(sess.metadata.days) || 7;
                await pool.query(
                    `UPDATE listings SET boosted_until = NOW() + ($1 || ' days')::INTERVAL WHERE id = $2`,
                    [days, listingId]
                );
                console.log(`✅ Stripe: listing ${listingId} boosted for ${days} days`);
            } catch (err) {
                console.error('Stripe boost webhook DB error:', err);
            }
        }

        // Credit pack checkout
        if (sess.metadata?.type === 'credit_pack') {
            try {
                const realtorId = parseInt(sess.metadata.realtor_id);
                const credits = parseInt(sess.metadata.credits) || 0;
                if (realtorId && credits > 0) {
                    await pool.query(
                        `UPDATE users SET lead_credits = COALESCE(lead_credits, 0) + $1 WHERE id = $2`,
                        [credits, realtorId]
                    );
                    console.log(`✅ Stripe: added ${credits} lead credits to user ${realtorId}`);
                }
            } catch (err) {
                console.error('Stripe credit pack webhook DB error:', err);
            }
        }

        // Premium profile checkout
        if (sess.metadata?.type === 'premium_profile') {
            try {
                const userId = parseInt(sess.metadata.user_id);
                const days = parseInt(sess.metadata.days) || 30;
                if (userId && days > 0) {
                    await pool.query(
                        `UPDATE users SET is_premium_profile = TRUE,
                            premium_profile_expires = GREATEST(COALESCE(premium_profile_expires, NOW()), NOW()) + ($1 || ' days')::INTERVAL
                         WHERE id = $2`,
                        [days, userId]
                    );
                    console.log(`✅ Stripe: premium profile activated for user ${userId} (${days} days)`);
                }
            } catch (err) {
                console.error('Stripe premium profile webhook DB error:', err);
            }
        }

        // Lead purchase checkout
        if (sess.metadata?.type === 'listing_lead') {
            const client = await pool.connect();
            try {
                const realtorId = parseInt(sess.metadata.realtor_id);
                const listingId = parseInt(sess.metadata.listing_id);
                // Validate both records exist before updating
                const { rows: realtorCheck } = await client.query(
                    `SELECT id FROM users WHERE id = $1 AND user_type = 'realtor'`, [realtorId]
                );
                const { rows: listingCheck } = await client.query(
                    `SELECT id FROM listings WHERE id = $1`, [listingId]
                );
                if (!realtorCheck.length || !listingCheck.length) {
                    console.error(`Stripe webhook: invalid metadata — realtor ${realtorId}, listing ${listingId}`);
                } else {
                    await client.query(
                        `UPDATE lead_purchases SET paid = TRUE WHERE realtor_id = $1 AND listing_id = $2`,
                        [realtorId, listingId]
                    );
                    console.log(`✅ Stripe: lead purchase confirmed — realtor ${realtorId}, listing ${listingId}`);
                }
            } catch (err) {
                console.error('Stripe lead purchase webhook DB error:', err);
            } finally {
                client.release();
            }
        }

        // Subscription checkout
        const userId = parseInt(sess.metadata?.userId);
        const plan   = sess.metadata?.plan;
        if (userId && plan) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `UPDATE users SET subscription_plan=$1, stripe_customer_id=$2 WHERE id=$3`,
                    [plan, sess.customer, userId]
                );
                await client.query(
                    `UPDATE companies SET plan=$1, stripe_customer_id=$2, stripe_subscription_id=$3, updated_at=NOW() WHERE owner_user_id=$4`,
                    [plan, sess.customer, sess.subscription, userId]
                );
                await client.query('COMMIT');
                console.log(`✅ Stripe: upgraded user ${userId} to ${plan}`);

                // Apply founding member 2-month Professional credit (outside transaction — non-critical)
                if (sess.subscription) {
                    const { rows: foundingRows } = await pool.query(
                        `SELECT is_founding_member, founding_credit_applied FROM users WHERE id = $1`, [userId]
                    );
                    if (foundingRows[0]?.is_founding_member && !foundingRows[0]?.founding_credit_applied) {
                        try {
                            await stripe.subscriptions.update(sess.subscription, {
                                trial_end: Math.floor(Date.now() / 1000) + (60 * 24 * 60 * 60), // 60 days
                                proration_behavior: 'none',
                            });
                            await pool.query(
                                `UPDATE users SET founding_credit_applied = TRUE WHERE id = $1`, [userId]
                            );
                            console.log(`🏅 Stripe: applied 60-day founding credit to user ${userId}`);
                        } catch (e) {
                            console.error('Founding credit Stripe error:', e.message);
                        }
                    }
                }

                // Credit referrer $25 on first subscription — guard with referral_credit_paid to survive webhook retries
                const refRow = await pool.query(
                    `SELECT referred_by FROM users WHERE id=$1 AND referred_by IS NOT NULL AND referral_credit_paid IS NOT TRUE`,
                    [userId]
                );
                if (refRow.rows.length) {
                    const referrerId = refRow.rows[0].referred_by;
                    // Mark paid first so concurrent retries see it immediately
                    await pool.query(`UPDATE users SET referral_credit_paid = TRUE WHERE id=$1`, [userId]);
                    await pool.query(
                        `UPDATE users SET referral_credits_cents = referral_credits_cents + 2500 WHERE id=$1`,
                        [referrerId]
                    );
                    if (stripe) {
                        const custRow = await pool.query(
                            `SELECT stripe_customer_id FROM users WHERE id=$1 AND stripe_customer_id IS NOT NULL`, [referrerId]
                        );
                        if (custRow.rows.length) {
                            await stripe.customers.createBalanceTransaction(custRow.rows[0].stripe_customer_id, {
                                amount: -2500, currency: 'usd',
                                description: 'Referral bonus — referred realtor subscribed'
                            }).catch(e => console.error('Referral stripe credit error:', e.message));
                        }
                    }
                    console.log(`✅ Stripe: credited $25 referral bonus to user ${referrerId}`);
                }
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                console.error('Stripe webhook DB error:', err);
            } finally {
                client.release();
            }
        }
    }

    if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        // Map Stripe price ID back to our plan name
        const priceId = sub.items?.data?.[0]?.price?.id;
        const planName = Object.entries(STRIPE_PRICE_IDS).find(([, v]) => v === priceId)?.[0];
        if (planName) {
            try {
                await applyPlan(sub.customer, planName, sub.id);
                console.log(`✅ Stripe: subscription updated → ${planName} for ${sub.customer}`);
            } catch (err) {
                console.error('Stripe subscription.updated DB error:', err);
            }
        }
    }

    if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        try {
            await applyPlan(sub.customer, null, null);
            // Notify user their subscription ended
            const { rows } = await pool.query(
                `SELECT email, first_name FROM users WHERE stripe_customer_id=$1`, [sub.customer]
            );
            if (rows.length) {
                emailService.sendSubscriptionCancelled(rows[0].email, rows[0].first_name)
                    .catch(e => console.error('Cancellation email error:', e.message));
            }
            console.log(`⚠️ Stripe: subscription cancelled for ${sub.customer}`);
        } catch (err) {
            console.error('Stripe cancellation DB error:', err);
        }
    }

    if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        try {
            const { rows } = await pool.query(
                `SELECT email, first_name FROM users WHERE stripe_customer_id=$1`, [invoice.customer]
            );
            if (rows.length) {
                emailService.sendPaymentFailed(rows[0].email, rows[0].first_name, invoice.hosted_invoice_url)
                    .catch(e => console.error('Payment failed email error:', e.message));
            }
            console.log(`⚠️ Stripe: payment failed for ${invoice.customer}`);
            // After 3rd failure: mark subscription as past_due and set is_active = false as grace period enforcement
            const attempt = invoice.attempt_count || 1;
            if (attempt >= 3) {
                await pool.query(`UPDATE users SET is_active = false WHERE stripe_customer_id = $1`, [invoice.customer]);
                console.log(`⚠️ Stripe: deactivated account after ${attempt} failed payments for ${invoice.customer}`);
            }
        } catch (err) {
            console.error('Stripe payment_failed DB error:', err);
        }
    }

    if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        try {
            // Re-activate if previously suspended
            await pool.query(`UPDATE users SET is_active = true WHERE stripe_customer_id = $1 AND is_active = false`, [invoice.customer]);
            console.log(`✅ Stripe: payment succeeded, re-activated account for ${invoice.customer}`);
        } catch (err) {
            console.error('Stripe payment_succeeded DB error:', err);
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

// ===== BATCH 9: ADMIN REVENUE ANALYTICS =====

const PLAN_MONTHLY_CENTS = { basic: 2900, professional: 4900, firm: 9900 };

app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
    try {
        const [planRows, monthlyRows, churnRows] = await Promise.all([
            pool.query(`
                SELECT COALESCE(u.subscription_plan, 'free') AS plan, COUNT(*) AS cnt
                FROM users u
                WHERE u.user_type = 'realtor' AND u.is_active IS NOT FALSE
                GROUP BY plan
            `),
            pool.query(`
                SELECT DATE_TRUNC('month', created_at) AS month,
                       COUNT(*) FILTER (WHERE subscription_plan NOT IN ('free') AND subscription_plan IS NOT NULL) AS new_paid
                FROM users
                WHERE user_type = 'realtor' AND created_at >= NOW() - INTERVAL '12 months'
                GROUP BY month ORDER BY month ASC
            `),
            pool.query(`
                SELECT DATE_TRUNC('month', updated_at) AS month, COUNT(*) AS churned
                FROM users
                WHERE user_type = 'realtor'
                  AND subscription_plan = 'free'
                  AND updated_at >= NOW() - INTERVAL '12 months'
                  AND is_active IS NOT FALSE
                GROUP BY month ORDER BY month ASC
            `),
        ]);
        let mrr_cents = 0;
        const plan_breakdown = {};
        for (const r of planRows.rows) {
            const cnt = parseInt(r.cnt);
            plan_breakdown[r.plan] = cnt;
            mrr_cents += (PLAN_MONTHLY_CENTS[r.plan] || 0) * cnt;
        }
        res.json({
            mrr_cents,
            mrr_dollars: (mrr_cents / 100).toFixed(2),
            plan_breakdown,
            monthly_new_paid: monthlyRows.rows.map(r => ({
                month: r.month,
                new_paid: parseInt(r.new_paid)
            })),
            monthly_churned: churnRows.rows.map(r => ({
                month: r.month,
                churned: parseInt(r.churned)
            }))
        });
    } catch (err) {
        console.error('Revenue analytics error:', err);
        res.status(500).json({ error: 'Failed to fetch revenue data' });
    }
});

// Apply founding member 2-month Professional trial credit at launch
// Safe to re-run — only applies to founding members who haven't received the credit yet
app.post('/api/admin/apply-founding-credits', requireAdmin, async (req, res) => {
    try {
        // Find all founding members who subscribed but haven't had the credit applied
        const { rows } = await pool.query(
            `SELECT id, email, first_name, stripe_customer_id,
                    (SELECT stripe_subscription_id FROM companies WHERE owner_user_id = users.id LIMIT 1) AS stripe_subscription_id
             FROM users
             WHERE is_founding_member = TRUE
               AND founding_credit_applied = FALSE
               AND is_approved = TRUE
               AND subscription_plan IS NOT NULL
               AND subscription_plan != 'free'`
        );

        let applied = 0, skipped = 0, errors = 0;
        for (const user of rows) {
            try {
                if (stripe && user.stripe_subscription_id) {
                    await stripe.subscriptions.update(user.stripe_subscription_id, {
                        trial_end: Math.floor(Date.now() / 1000) + (60 * 24 * 60 * 60),
                        proration_behavior: 'none',
                    });
                }
                await pool.query(`UPDATE users SET founding_credit_applied = TRUE WHERE id = $1`, [user.id]);
                applied++;
            } catch (e) {
                console.error(`Founding credit failed for user ${user.id}:`, e.message);
                errors++;
            }
        }

        // Also mark founding members on free/no plan — credit applies when they subscribe
        const { rowCount: marked } = await pool.query(
            `UPDATE users SET is_founding_member = TRUE
             WHERE user_type = 'realtor'
               AND is_approved = TRUE
               AND is_active IS NOT FALSE
               AND id IN (
                   SELECT id FROM users
                   WHERE user_type = 'realtor' AND is_approved = TRUE AND is_active IS NOT FALSE
                   ORDER BY created_at ASC LIMIT 100
               )
               AND is_founding_member = FALSE`
        );

        res.json({ ok: true, applied, skipped, errors, newly_marked: marked });
    } catch (err) {
        console.error('Apply founding credits error:', err);
        res.status(500).json({ error: 'Failed to apply founding credits' });
    }
});

// ===== BATCH 9: ADMIN BULK USER ACTIONS =====

app.post('/api/admin/bulk-users', requireAdmin, async (req, res) => {
    try {
        const { user_ids, action } = req.body;
        if (!Array.isArray(user_ids) || !user_ids.length)
            return res.status(400).json({ error: 'user_ids array required' });
        if (!['approve', 'reject', 'deactivate', 'reactivate'].includes(action))
            return res.status(400).json({ error: 'Invalid action' });

        const ids = user_ids.map(Number).filter(Boolean);
        let query;
        if (action === 'approve')
            query = `UPDATE users SET is_approved = TRUE WHERE id = ANY($1::int[])`;
        else if (action === 'reject')
            query = `UPDATE users SET is_approved = FALSE WHERE id = ANY($1::int[])`;
        else if (action === 'deactivate')
            query = `UPDATE users SET is_active = FALSE WHERE id = ANY($1::int[])`;
        else
            query = `UPDATE users SET is_active = TRUE WHERE id = ANY($1::int[])`;

        const { rowCount } = await pool.query(query, [ids]);
        console.log(`[AUDIT] Admin ${req.user.id} bulk ${action} on ${rowCount} users from IP ${req.ip}`);
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, action, ip_address) VALUES ($1, $2, $3)`,
            [req.user.id, `bulk_${action}_${rowCount}_users`, req.ip]
        ).catch(() => {});
        res.json({ ok: true, affected: rowCount });
    } catch (err) {
        console.error('Bulk users error:', err);
        res.status(500).json({ error: 'Failed to perform bulk action' });
    }
});

// ===== BATCH 9: ADMIN EMAIL CAMPAIGN =====

app.post('/api/admin/campaign', requireAdmin, async (req, res) => {
    try {
        const { segment, subject, message, cta_label, cta_url, plan_filter } = req.body;
        if (!subject?.trim() || !message?.trim()) return res.status(400).json({ error: 'subject and message required' });
        if (!['realtors', 'sellers', 'buyers', 'all'].includes(segment))
            return res.status(400).json({ error: 'Invalid segment' });

        const conditions = [`u.is_active IS NOT FALSE`, `u.email_unsubscribed IS NOT TRUE`, `u.email_verified = TRUE`];
        if (segment === 'realtors') conditions.push(`u.user_type = 'realtor'`);
        else if (segment === 'sellers') conditions.push(`u.user_type = 'seller'`);
        else if (segment === 'buyers') conditions.push(`u.user_type = 'buyer'`);
        const queryParams = [];
        if (plan_filter && segment === 'realtors') {
            queryParams.push(plan_filter.replace(/[^a-z]/g, ''));
            conditions.push(`COALESCE(u.subscription_plan, 'free') = $${queryParams.length}`);
        }

        const { rows: users } = await pool.query(
            `SELECT u.id, u.email, u.first_name FROM users u WHERE ${conditions.join(' AND ')} LIMIT 5000`,
            queryParams
        );

        const sent = [];
        for (const user of users) {
            try {
                await emailService.sendCampaignEmail(user.email, user.first_name, subject, message, cta_label, cta_url);
                sent.push(user.id);
                await sleep(100); // ~10/s send rate
            } catch (_) {}
        }
        console.log(`[AUDIT] Admin ${req.user.id} sent campaign "${subject}" to ${sent.length}/${users.length} users (segment: ${segment})`);
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, action, ip_address) VALUES ($1, $2, $3)`,
            [req.user.id, `campaign_${segment}_${sent.length}`, req.ip]
        ).catch(() => {});
        res.json({ ok: true, sent: sent.length, total: users.length });
    } catch (err) {
        console.error('Campaign error:', err);
        res.status(500).json({ error: 'Failed to send campaign' });
    }
});

// ===== BATCH 9: PLATFORM HEALTH =====

app.get('/api/admin/health', requireAdmin, (req, res) => {
    const poolStats = pool.totalCount !== undefined ? {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
    } : null;
    let sseCount = 0;
    for (const clients of sseClients.values()) sseCount += clients.size;
    res.json({
        status: 'ok',
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
        environment: process.env.NODE_ENV || 'development',
        db_pool: poolStats,
        sse_connections: sseCount,
        stripe_configured: !!stripe,
        email_configured: !!process.env.SENDGRID_API_KEY,
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        timestamp: new Date().toISOString()
    });
});

// ===== BATCH 8: LISTING COMPARISON =====

app.get('/api/listings/compare', async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 3);
        if (!ids.length) return res.status(400).json({ error: 'ids required (comma-separated, max 3)' });
        const { rows } = await pool.query(
            `SELECT id, address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft,
                    description, image_urls, created_at, status,
                    COALESCE(view_count, 0) AS view_count,
                    (SELECT COUNT(*) FROM offers WHERE listing_id = l.id) AS offer_count
             FROM listings l WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
            [ids]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load listings' });
    }
});

// ===== BATCH 8: NEARBY STATS =====

app.get('/api/listings/:id/nearby-stats', async (req, res) => {
    try {
        const { rows: listing } = await pool.query(`SELECT zip, city FROM listings WHERE id=$1`, [parseInt(req.params.id)]);
        if (!listing.length) return res.status(404).json({ error: 'Listing not found' });
        const { zip, city } = listing[0];
        const { rows } = await pool.query(`
            SELECT COUNT(*) AS total_active,
                   ROUND(AVG(price)) AS avg_price,
                   ROUND(MIN(price)) AS min_price,
                   ROUND(MAX(price)) AS max_price,
                   ROUND(AVG(sqft)) AS avg_sqft
            FROM listings
            WHERE (zip = $1 OR city ILIKE $2)
              AND status = 'active' AND deleted_at IS NULL AND price > 0
        `, [zip, city]);
        res.json({ zip, city, ...rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch nearby stats' });
    }
});

// ===== BATCH 10: SUBSCRIPTION LIMITS & USAGE =====

const PLAN_LIMITS = {
    free:         { proposals_per_month: 0,  leads_included: false, label: 'Free' },
    basic:        { proposals_per_month: 5,  leads_included: false, label: 'Basic' },
    professional: { proposals_per_month: null, leads_included: true, label: 'Professional' },
    firm:         { proposals_per_month: null, leads_included: true, label: 'Firm' },
};

app.get('/api/subscription/limits', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT COALESCE(c.plan, u.subscription_plan, 'free') AS plan,
                    COALESCE(u.lead_credits, 0) AS lead_credits
             FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = $1`,
            [req.session.userId]
        );
        const plan = rows[0]?.plan || 'free';
        const lead_credits = parseInt(rows[0]?.lead_credits) || 0;
        const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

        let proposals_this_month = 0;
        if (limits.proposals_per_month !== null) {
            const cnt = await pool.query(
                `SELECT COUNT(*) AS cnt FROM proposals WHERE realtor_id=$1 AND created_at >= date_trunc('month', NOW())`,
                [req.session.userId]
            );
            proposals_this_month = parseInt(cnt.rows[0].cnt) || 0;
        }
        res.json({ plan, ...limits, proposals_this_month, lead_credits });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load limits' });
    }
});

// ===== BATCH 10: LEAD CREDIT PACKS =====

const CREDIT_PACKS = {
    starter:  { credits: 5,  price_cents: 4500,  label: '5 Credits',  tagline: '$9 each' },
    value:    { credits: 10, price_cents: 7900,  label: '10 Credits', tagline: '$7.90 each' },
    pro:      { credits: 25, price_cents: 14900, label: '25 Credits', tagline: '$5.96 each' },
};

app.get('/api/credits/packs', (req, res) => res.json(CREDIT_PACKS));

app.post('/api/credits/checkout', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const pack = CREDIT_PACKS[req.body.pack];
        if (!pack) return res.status(400).json({ error: 'Invalid pack. Choose: starter, value, or pro' });
        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    unit_amount: pack.price_cents,
                    product_data: { name: `RealtorFinder ${pack.label}`, description: `${pack.credits} lead credits (${pack.tagline})` }
                },
                quantity: 1
            }],
            metadata: { type: 'credit_pack', pack: req.body.pack, credits: pack.credits, realtor_id: req.session.userId },
            success_url: `${baseUrl}/dashboard/realtor?credits=success`,
            cancel_url: `${baseUrl}/dashboard/realtor`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Credit pack checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout' });
    }
});

// ===== BATCH 10: PREMIUM REALTOR PROFILE =====

const PREMIUM_DURATIONS = { monthly: { days: 30, price_cents: 4900, label: '1 Month' }, quarterly: { days: 90, price_cents: 9900, label: '3 Months' } };

app.get('/api/profile/premium-status', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT is_premium_profile, premium_profile_expires, profile_banner_url, profile_video_url FROM users WHERE id=$1`,
            [req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        const r = rows[0];
        const active = r.is_premium_profile && r.premium_profile_expires && new Date(r.premium_profile_expires) > new Date();
        res.json({ active, expires: r.premium_profile_expires, banner_url: r.profile_banner_url, video_url: r.profile_video_url });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/profile/premium-checkout', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const dur = PREMIUM_DURATIONS[req.body.duration];
        if (!dur) return res.status(400).json({ error: 'duration must be monthly or quarterly' });
        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    unit_amount: dur.price_cents,
                    product_data: { name: `Premium Realtor Profile — ${dur.label}`, description: 'Featured badge, custom banner, video, priority placement' }
                },
                quantity: 1
            }],
            metadata: { type: 'premium_profile', duration: req.body.duration, days: dur.days, user_id: req.session.userId },
            success_url: `${baseUrl}/dashboard/realtor?premium=success`,
            cancel_url: `${baseUrl}/dashboard/realtor`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Premium checkout error:', err);
        res.status(500).json({ error: 'Failed to create checkout' });
    }
});

app.post('/api/profile/banner', auth.requireAuth, uploadLimiter, upload.single('banner'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
        await pool.query(`UPDATE users SET profile_banner_url=$1 WHERE id=$2`, [result.secure_url, req.session.userId]);
        res.json({ url: result.secure_url });
    } catch (err) { res.status(500).json({ error: 'Failed to upload banner' }); }
});

app.put('/api/profile/video', auth.requireAuth, async (req, res) => {
    try {
        const { video_url } = req.body;
        if (video_url && !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)/.test(video_url))
            return res.status(400).json({ error: 'Only YouTube and Vimeo URLs are accepted' });
        await pool.query(`UPDATE users SET profile_video_url=$1 WHERE id=$2`, [video_url || null, req.session.userId]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update video' }); }
});

// ===== BATCH 11: ONBOARDING STATUS =====

app.get('/api/onboarding/status', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const utype = req.user.user_type;
        const { rows: [u] } = await pool.query(
            `SELECT onboarding_completed, email_verified, license_number, bio, service_areas,
                    profile_photo, license_doc_url
             FROM users WHERE id=$1`, [uid]
        );
        if (u?.onboarding_completed) return res.json({ completed: true, steps: [] });

        let steps = [];
        if (utype === 'seller') {
            const { rows: listings } = await pool.query(`SELECT id FROM listings WHERE user_id=$1 LIMIT 1`, [uid]);
            steps = [
                { id: 'verify_email', label: 'Verify your email', done: !!u.email_verified, link: null },
                { id: 'create_listing', label: 'Post your first listing', done: listings.length > 0, link: '/dashboard/seller' },
            ];
        } else if (utype === 'realtor') {
            const { rows: proposals } = await pool.query(`SELECT id FROM proposals WHERE realtor_id=$1 LIMIT 1`, [uid]);
            steps = [
                { id: 'verify_email', label: 'Verify your email', done: !!u.email_verified, link: null },
                { id: 'upload_license', label: 'Upload your license', done: !!u.license_doc_url, link: '/dashboard/realtor#settings' },
                { id: 'set_service_areas', label: 'Set your service areas', done: !!(u.service_areas?.trim()), link: '/dashboard/realtor#settings' },
                { id: 'complete_bio', label: 'Write your bio', done: !!(u.bio && u.bio.trim().length > 20), link: '/dashboard/realtor#settings' },
                { id: 'first_proposal', label: 'Submit your first proposal', done: proposals.length > 0, link: '/dashboard/realtor#browse' },
            ];
        } else if (utype === 'buyer') {
            const { rows: reqs } = await pool.query(`SELECT id FROM buyer_requests WHERE user_id=$1 LIMIT 1`, [uid]);
            steps = [
                { id: 'verify_email', label: 'Verify your email', done: !!u.email_verified, link: null },
                { id: 'create_request', label: 'Create a buyer request', done: reqs.length > 0, link: '/dashboard/buyer' },
            ];
        }
        const allDone = steps.every(s => s.done);
        if (allDone) {
            await pool.query(`UPDATE users SET onboarding_completed=TRUE WHERE id=$1`, [uid]).catch(() => {});
        }
        res.json({ completed: allDone, steps });
    } catch (err) {
        console.error('Onboarding status error:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/onboarding/dismiss', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(`UPDATE users SET onboarding_completed=TRUE WHERE id=$1`, [req.session.userId]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
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
    <meta name="description" content="Find your city on RealtorFinder. Sellers list free, realtors compete for listings. Serving buyers and sellers nationwide.">
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
    <p>Sellers list free. Realtors compete. Serving buyers and sellers nationwide.</p>
</div>
<div class="content">
    ${states.length ? `<div class="section-label">Browse by State</div><h2>All Markets</h2><div class="states-grid">${states.map(stateCard).join('')}</div>` : '<p style="color:#6b7280;text-align:center;padding:40px 0;">City pages loading — check back soon.</p>'}
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
        CO: { tagline: 'Denver\'s mile-high lifestyle and the Rocky Mountain real estate boom', desc: 'Colorado has emerged as one of America\'s most desirable real estate destinations — a state where Denver\'s thriving technology and aerospace economy, Boulder\'s world-class university and outdoor culture, and Colorado Springs\'s military-anchored stability combine with a Rocky Mountain lifestyle that attracts buyers from across the country. No-income-tax reform discussions and a booming outdoor recreation economy keep Colorado at the top of domestic migration lists.', highlights: ['Denver ranked among the top 10 US metros for job growth and in-migration', 'Boulder delivers a world-class university market with consistent long-term appreciation', 'Colorado Springs is anchored by five major military installations for employment stability', 'Summit County ski towns (Breckenridge, Vail, Keystone) command the strongest mountain lifestyle premiums in the country'], color: '#1a3a5a' },
        AL: { tagline: 'Huntsville\'s tech boom and Birmingham\'s healthcare economy anchor the Heart of Dixie', desc: 'Alabama\'s real estate market has been transformed by Huntsville\'s emergence as one of America\'s top aerospace and defense technology centers — a city that now rivals much larger metros for high-income job growth. Birmingham\'s UAB healthcare complex and financial sector, along with Gulf Coast communities like Gulf Shores and Orange Beach, give Alabama buyers remarkable range from tech-driven appreciation to affordable coastal lifestyle.', highlights: ['Huntsville is one of America\'s fastest-growing tech and aerospace metros', 'Birmingham\'s UAB is among the top 10 US research medical centers by funding', 'Gulf Shores and Orange Beach offer Gulf Coast lifestyle at prices far below comparable Florida communities', 'Auburn and Tuscaloosa provide university-driven markets with consistent long-term demand'], color: '#8b1a1a' },
        AK: { tagline: 'America\'s last frontier — unique market, unmatched lifestyle', desc: 'Alaska\'s real estate market is defined by its extraordinary geography and resource-driven economy. Anchorage serves as the state\'s commercial hub, with a diverse economy anchored by oil and gas, federal government, military, and healthcare. Low property taxes, no state income or sales tax, and the annual Permanent Fund Dividend make Alaska uniquely attractive for buyers seeking a truly differentiated lifestyle.', highlights: ['No state income tax or sales tax — plus an annual Permanent Fund Dividend for residents', 'Anchorage delivers urban amenities with immediate access to world-class wilderness', 'Military installations provide stable federal employment across Anchorage and Fairbanks', 'Eagle River and the Mat-Su Valley offer Anchorage access at meaningful price discounts'], color: '#1a2a3a' },
        AR: { tagline: 'Bentonville\'s Walmart economy and the Natural State\'s rising profile', desc: 'Arkansas\'s real estate market has gained national attention thanks to Bentonville\'s transformation into a world-class arts and cycling destination anchored by Walmart\'s global headquarters. Fayetteville consistently ranks among the South\'s most livable mid-sized cities, and the broader Northwest Arkansas corridor has become one of the fastest-growing regions in the country. Little Rock\'s government and healthcare economy provides stability across central Arkansas.', highlights: ['Northwest Arkansas (Bentonville/Fayetteville) is among the fastest-growing regions in the South', 'Walmart HQ drives world-class amenities and high-income employment in Benton County', 'Fayetteville and the University of Arkansas create consistent buyer demand year-round', 'Little Rock offers major-city government and healthcare employment at deeply affordable home prices'], color: '#2a3a1a' },
        DE: { tagline: 'Small state, outsized advantages — no sales tax and a prime Mid-Atlantic location', desc: 'Delaware punches above its weight as a real estate market — no sales tax, low property taxes, and a prime location between Philadelphia, Baltimore, and Washington DC give Delaware buyers remarkable value. Wilmington\'s corporate legal headquarters cluster makes it the registered home of more Fortune 500 companies than any other state, and Delaware\'s beaches in Rehoboth and Dewey draw Mid-Atlantic buyers seeking accessible coastal lifestyle.', highlights: ['No sales tax — a meaningful daily savings advantage over neighboring PA, MD, and NJ', 'Wilmington is the corporate legal capital of America — home to thousands of registered Fortune 500 entities', 'Rehoboth Beach and Lewes are among the most popular Mid-Atlantic vacation and second-home markets', 'Newark and the University of Delaware create consistent young professional and family buyer demand'], color: '#1a3a4a' },
        HI: { tagline: 'Paradise has a price — and long-term owners have always been rewarded', desc: 'Hawaii\'s real estate market is driven by one of the world\'s most powerful lifestyle propositions — year-round tropical climate, world-class beaches, and a unique Polynesian culture that creates irreplaceable demand. Oahu\'s Honolulu metro dominates the state\'s market, but Maui\'s resort communities, the Big Island\'s diverse landscapes, and Kauai\'s lush seclusion each attract distinct buyer profiles from luxury resort investors to military families.', highlights: ['Oahu delivers urban amenities, military employment, and world-class beaches in a single market', 'Maui\'s resort communities command luxury premiums among the highest in the Pacific', 'Military presence on Oahu and the Big Island creates stable year-round demand', 'Hawaii\'s strict land use laws limit new construction — keeping existing home values exceptionally well-supported'], color: '#0a3a5a' },
        ID: { tagline: 'Boise\'s breakout and the Gem State\'s remarkable rise', desc: 'Idaho has experienced one of the most dramatic real estate transformations in the nation — Boise emerged as one of America\'s fastest-appreciating markets as California and Pacific Northwest buyers discovered its combination of urban amenity, outdoor access, and home prices that still undercut comparable West Coast markets. Coeur d\'Alene\'s lake resort lifestyle and Idaho Falls\'s energy sector stability round out a state that has permanently joined the national conversation.', highlights: ['Boise ranked among the top 5 fastest-appreciating US markets from 2019 through 2023', 'Meridian and Eagle are among the fastest-growing cities in the Intermountain West', 'Coeur d\'Alene delivers Pacific Northwest lake resort lifestyle at prices below comparable Washington and Oregon markets', 'Sun Valley remains one of the West\'s premier ski and outdoor recreation real estate destinations'], color: '#1a3a2a' },
        IA: { tagline: 'Des Moines tops the livability rankings and the Hawkeye State delivers on value', desc: 'Iowa\'s real estate market consistently earns recognition for value, livability, and quality of life — Des Moines has been ranked among America\'s best mid-sized cities for young professionals, retirees, and families alike, with a diverse economy that spans insurance, financial services, agriculture technology, and healthcare. Iowa City\'s University of Iowa and Cedar Rapids\'s technology corridor add employment anchors that sustain demand across eastern Iowa.', highlights: ['Des Moines ranks among America\'s top 10 mid-sized cities for quality of life and affordability', 'Iowa offers some of the most accessible home prices of any state in the Midwest', 'Iowa City and the University of Iowa create consistent graduate and professional buyer demand', 'Cedar Rapids and the Corridor attract technology and advanced manufacturing employers'], color: '#2a3a1a' },
        KS: { tagline: 'Kansas City\'s Kansas side — and the Sunflower State\'s steady appreciation', desc: 'Kansas offers buyers one of the most underrated value propositions in the Midwest — Overland Park and Leawood deliver premier suburban living on the Kansas side of the Kansas City metro at prices that make comparable Johnson County communities a genuine national bargain, while Wichita\'s aviation and defense economy anchors south-central Kansas with stable employment.', highlights: ['Johnson County (Overland Park, Leawood) consistently ranks among the best places to live in the Midwest', 'Wichita is the air capital of the world — home to Boeing, Cessna, and Textron Aviation', 'No state income tax on Social Security — a draw for retiring Midwest buyers', 'Lawrence and the University of Kansas provide consistent university-driven market stability'], color: '#3a2a1a' },
        KY: { tagline: 'Louisville\'s bourbon country sophistication and Lexington\'s horse farm prestige', desc: 'Kentucky\'s real estate market is anchored by two distinct metros: Louisville\'s remarkable urban revival, where NuLu, the Highlands, and Butchertown have emerged as nationally recognized neighborhoods with strong appreciation driven by bourbon tourism and a growing healthcare economy, and Lexington\'s horse country estate market that delivers genuine luxury living at prices that would be unthinkable in comparable East or West Coast markets.', highlights: ['Louisville\'s bourbon distillery corridor has become a national tourism and economic development model', 'Lexington horse farm estates offer genuine luxury acreage at prices far below comparable coastal markets', 'No inheritance tax and modest income taxes make Kentucky attractive for retirees from higher-tax states', 'Bowling Green and Northern Kentucky provide strong manufacturing employment and Cincinnati metro access'], color: '#2a1a3a' },
        LA: { tagline: 'New Orleans culture, Baton Rouge government, and the Pelican State\'s unique market', desc: 'Louisiana\'s real estate market is shaped by its extraordinary cultural geography — New Orleans delivers a lifestyle found nowhere else in the world, with historic neighborhoods like the Garden District and Uptown offering architectural grandeur at prices far below comparable historic districts in the Northeast, while Baton Rouge\'s government and petrochemical economy and Shreveport\'s emerging tech scene round out the state.', highlights: ['New Orleans Garden District and Uptown offer historic architecture at prices well below comparable Northeast markets', 'Baton Rouge is anchored by state government, LSU, and major petrochemical employers', 'No state income tax on Social Security — an advantage for retiring Southerners', 'Louisiana\'s unique architecture and culture create irreplaceable real estate character'], color: '#3a1a2a' },
        MS: { tagline: 'The Magnolia State — Gulf Coast beauty and Deep South affordability', desc: 'Mississippi offers some of the most accessible home prices in the nation combined with the Gulf Coast lifestyle of Biloxi and Gulfport, the college-town energy of Oxford and Starkville, and Jackson\'s government and healthcare employment base. For buyers seeking maximum space and value in the South, Mississippi delivers entry-level prices that remain exceptional even by regional standards.', highlights: ['Mississippi offers the most affordable home prices of any state in the Southeast', 'Biloxi and the Gulf Coast provide casino resort employment and coastal lifestyle at accessible prices', 'Oxford and Ole Miss create a nationally recognized college town with strong lifestyle buyer demand', 'Ridgeland and Madison deliver Jackson metro access with top-rated schools'], color: '#1a3a2a' },
        NE: { tagline: 'Omaha\'s quiet powerhouse and the Cornhusker State\'s steady market', desc: 'Nebraska\'s real estate market is anchored by Omaha — a city that Warren Buffett has called home for decades and that consistently delivers world-class insurance, financial services, and logistics employment with home prices that rank among the most accessible of any major Midwest metro. Lincoln\'s University of Nebraska adds academic stability, while western Nebraska\'s agricultural communities offer buyers genuine rural space at entry-level prices.', highlights: ['Omaha is home to Berkshire Hathaway and some of the nation\'s most respected insurance and financial employers', 'Omaha and Lincoln offer Big Ten city amenities at prices well below comparable Midwest markets', 'No estate tax — an advantage for wealth-building buyers and retirees', 'Papillion and Bellevue offer Omaha access with top-ranked Sarpy County schools'], color: '#2a3a1a' },
        OK: { tagline: 'Oklahoma City\'s oil patch revival and Tulsa\'s art deco renaissance', desc: 'Oklahoma\'s real estate market offers buyers a remarkable combination of energy sector employment stability, nationally recognized arts communities, and home prices that remain among the most accessible of any state outside the Deep South. Oklahoma City\'s MAPS urban renewal projects have transformed downtown and adjacent neighborhoods, while Tulsa\'s Gathering Place and Guthrie Green have earned national recognition as models for mid-sized city revitalization.', highlights: ['Oklahoma City MAPS investments have transformed downtown and adjacent neighborhoods into national models', 'Tulsa\'s Gathering Place is among the most awarded urban parks in the nation', 'Energy sector employment provides stability but also cyclicality — diversification is underway', 'Edmond and Norman deliver Oklahoma City metro access with top-ranked suburban schools'], color: '#3a2a1a' },
        UT: { tagline: 'The Greatest Snow on Earth — and one of America\'s fastest-growing economies', desc: 'Utah has emerged as one of America\'s most dynamic real estate markets, driven by Salt Lake City\'s tech corridor (nicknamed Silicon Slopes), an extraordinary outdoor recreation lifestyle anchored by world-class ski resorts, and a young, highly educated population that keeps housing demand consistently robust. No other state combines the employment growth of Utah\'s tech economy with the lifestyle appeal of Park City, Moab, and the Wasatch Front.', highlights: ['Silicon Slopes (Utah County and Salt Lake County) is among the fastest-growing tech corridors in the US', 'Park City delivers world-class ski resort lifestyle with convenient Salt Lake City airport access', 'Utah\'s young median age and high birth rate create sustained long-term housing demand', 'Provo-Orem ranked among the top metros in the country for tech job growth and startup activity'], color: '#8b3a1a' },
        MT: { tagline: 'Big Sky country — Montana\'s remote work boom and recreational lifestyle', desc: 'Montana has experienced one of the most dramatic real estate transformations since 2020 — remote work has unlocked the state\'s extraordinary lifestyle proposition, and Bozeman has gone from college town to one of the most rapidly appreciating markets in the entire country. Missoula\'s university culture, Billings\'s energy sector stability, and the Flathead Valley\'s lake resort lifestyle each attract distinct buyer profiles to a state that has permanently emerged onto the national radar.', highlights: ['Bozeman is among the top 10 fastest-appreciating markets in the Western US since 2020', 'No sales tax — a meaningful advantage in a state where outdoor gear and vehicles cost significant sums', 'Remote work has permanently expanded Montana\'s buyer pool beyond retirees and outdoor enthusiasts', 'Flathead Valley (Whitefish, Kalispell) offers Glacier National Park access with growing luxury market demand'], color: '#1a2a3a' },
        WY: { tagline: 'Jackson Hole prestige and Wyoming\'s unmatched tax environment', desc: 'Wyoming offers one of the most favorable tax environments in the nation — no income tax, no corporate tax, and no estate tax — making it a destination for wealth preservation alongside its extraordinary outdoor lifestyle. Jackson Hole\'s ski resort luxury market ranks among the most premium in North America, while Cheyenne\'s government stability and Casper\'s energy sector provide more accessible entry points into Wyoming real estate.', highlights: ['No income, corporate, or estate tax — Wyoming is among the top states for wealth preservation', 'Jackson Hole delivers one of North America\'s most premium ski resort real estate markets', 'Cheyenne is within 90 minutes of Denver with Wyoming\'s favorable tax environment', 'Wyoming\'s low population density ensures exceptional space and privacy at every price point'], color: '#2a3a4a' },
        NM: { tagline: 'Santa Fe sophistication, Albuquerque affordability, and the Land of Enchantment\'s rise', desc: 'New Mexico\'s real estate market offers buyers a unique combination of cultural richness and relative affordability — Santa Fe\'s art market, adobe architecture, and world-class dining create a lifestyle destination that attracts buyers from both coasts, while Albuquerque\'s Kirtland Air Force Base, University of New Mexico, and growing film production industry (Breaking Bad country) provide diverse employment anchors at price points well below comparable lifestyle markets.', highlights: ['Santa Fe is among America\'s premier art market destinations, attracting buyers from both coasts', 'Albuquerque\'s film production industry has grown dramatically, generating creative economy employment', 'Kirtland Air Force Base provides stable federal defense employment in Albuquerque', 'Rio Rancho offers Albuquerque metro access at some of the most affordable prices in the Southwest'], color: '#8b2a1a' },
        ND: { tagline: 'Fargo\'s growth and the Peace Garden State\'s energy boom', desc: 'North Dakota\'s real estate market is anchored by Fargo\'s consistent recognition as one of America\'s most livable small metros — a city of top-ranked schools, strong healthcare employment (Sanford Health, Essentia), and home prices that remain well below any comparable quality-of-life market in the country. The Bakken oil patch has transformed western North Dakota, and Bismarck\'s state capital stability rounds out a market that offers buyers exceptional value.', highlights: ['Fargo consistently ranks among America\'s most livable small cities for quality of life and affordability', 'No state income tax on oil royalties — a significant advantage in Bakken country', 'Strong healthcare employment anchored by Sanford Health and Essentia Health systems', 'Bismarck and Mandan offer state capital stability with accessible home prices'], color: '#1a2a3a' },
        SD: { tagline: 'No income tax, Mount Rushmore, and a market built on stability', desc: 'South Dakota offers buyers one of the most straightforward value propositions in the nation — no state income tax, no state estate or inheritance tax, consistently low property taxes, and a stable economy anchored by agriculture, tourism, and Sioux Falls\'s growing financial and healthcare sectors. Rapid City provides a gateway to the Black Hills and Mount Rushmore with a lifestyle that combines Western heritage with modern amenities.', highlights: ['No state income, estate, or inheritance tax — among the most favorable tax environments in the nation', 'Sioux Falls is one of America\'s fastest-growing smaller cities driven by financial services and healthcare', 'Rapid City delivers Black Hills outdoor recreation lifestyle with accessible home prices', 'Strong agricultural land market provides investment stability across the state'], color: '#2a3a2a' },
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

// Google Search Console HTML verification file
// Set GSC_VERIFICATION_TOKEN env var to the token from GSC (e.g. "abc123xyz")
// GSC will request GET /google<token>.html — this route handles it without needing a static file
app.get('/google:token.html', (req, res) => {
    const token = process.env.GSC_VERIFICATION_TOKEN;
    if (!token || req.params.token !== token) return res.status(404).send('Not found');
    res.type('text/html');
    res.send(`google-site-verification: google${token}.html`);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send([
        'User-agent: *',
        'Allow: /',
        'Disallow: /dashboard/',
        'Disallow: /api/',
        'Disallow: /admin',
        'Disallow: /admin-waitlist',
        'Disallow: /login',
        'Disallow: /reset-password',
        'Disallow: /waitlist',
        'Disallow: /inbox',
        'Disallow: /subscription-success',
        'Disallow: /company-dashboard',
        '',
        'Sitemap: https://www.realtorfinder.net/sitemap-index.xml',
    ].join('\n'));
});

// Sitemap index — points to per-state sitemaps
app.get('/sitemap-index.xml', async (req, res) => {
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
    const today = new Date().toISOString().split('T')[0];
    let states = [];
    try { states = await db.getPublishedStates(); } catch (e) {}
    const staticEntry = `  <sitemap><loc>${base}/sitemap-static.xml</loc><lastmod>${today}</lastmod></sitemap>`;
    const blogEntry   = `  <sitemap><loc>${base}/sitemap-blog.xml</loc><lastmod>${today}</lastmod></sitemap>`;
    const agentsEntry = `  <sitemap><loc>${base}/sitemap-agents.xml</loc><lastmod>${today}</lastmod></sitemap>`;
    const stateEntries = states.map(s =>
        `  <sitemap><loc>${base}/sitemap-${s.state_code.toLowerCase()}.xml</loc><lastmod>${today}</lastmod></sitemap>`
    ).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticEntry}\n${blogEntry}\n${agentsEntry}\n${stateEntries}\n</sitemapindex>`);
});

// Static pages sitemap
app.get('/sitemap-static.xml', (req, res) => {
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
    const today = new Date().toISOString().split('T')[0];
    const urls = ['/', '/sellers', '/realtors', '/pricing', '/about', '/about-sellers', '/buyers', '/locations', '/blog', '/login', '/contact', '/faq', '/find-agent'];
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

// Blog sitemap
app.get('/sitemap-blog.xml', async (req, res) => {
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
    const today = new Date().toISOString().split('T')[0];
    let posts = [];
    try { posts = await db.getAllBlogSlugs(); } catch (e) {}
    const indexEntry = `  <url><loc>${base}/blog</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>`;
    const postEntries = posts.map(p => {
        const date = p.updated_at ? new Date(p.updated_at).toISOString().split('T')[0] : today;
        return `  <url><loc>${base}/blog/${p.slug}</loc><lastmod>${date}</lastmod><priority>0.7</priority></url>`;
    }).join('\n');
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexEntry}\n${postEntries}\n</urlset>`);
});

// Agent profile sitemap — /agent/:slug URLs for approved realtors with slugs
app.get('/sitemap-agents.xml', async (req, res) => {
    const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
    try {
        const { rows } = await pool.query(
            `SELECT profile_slug, updated_at FROM users
             WHERE user_type = 'realtor' AND is_approved = TRUE
               AND is_active IS NOT FALSE AND profile_slug IS NOT NULL
             ORDER BY updated_at DESC LIMIT 5000`
        );
        const entries = rows.map(r =>
            `  <url><loc>${base}/agent/${r.profile_slug}</loc><lastmod>${new Date(r.updated_at).toISOString().split('T')[0]}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`
        ).join('\n');
        res.type('application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`);
    } catch (err) {
        res.type('application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`);
    }
});

// Legacy sitemap.xml redirect
app.get('/sitemap.xml', (req, res) => res.redirect(301, '/sitemap-index.xml'));

// Public listing detail (no auth required)
app.get('/api/listings/:id/public', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, address, city, state, zip, price, zestimate, property_type,
                    bedrooms, bathrooms, sqft, description, image_urls, status, created_at
             FROM listings WHERE id = $1 AND status != 'inactive' AND deleted_at IS NULL`,
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
            params.push(`%${name.toLowerCase()}%`);
            conditions.push(`(lower(u.first_name) LIKE $${params.length} OR lower(u.last_name) LIKE $${params.length})`);
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
        const rid = parseInt(req.params.id);
        const [profileRows, reviewRow, proposalRow] = await Promise.all([
            pool.query(
                `SELECT u.id, u.first_name, u.last_name, u.bio, u.years_experience,
                        u.license_number, u.service_areas, u.subscription_plan, u.zip_code,
                        u.profile_photo, u.license_verified, u.brokerage,
                        c.name AS company_name, c.plan AS company_plan
                 FROM users u
                 LEFT JOIN companies c ON u.company_id = c.id
                 WHERE u.id = $1 AND u.user_type = 'realtor' AND u.is_active IS NOT FALSE`,
                [rid]
            ),
            pool.query(
                `SELECT ROUND(AVG(rating), 1) AS avg_rating, COUNT(*) AS review_count
                 FROM realtor_reviews WHERE realtor_id = $1`, [rid]
            ),
            pool.query(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted
                 FROM proposals WHERE realtor_id = $1`, [rid]
            ),
        ]);
        if (!profileRows.rows.length) return res.status(404).json({ error: 'Realtor not found' });
        pool.query(`INSERT INTO profile_views (realtor_id, viewer_ip) VALUES ($1, $2)`, [rid, req.ip]).catch(() => {});
        res.json({
            ...profileRows.rows[0],
            avg_rating: parseFloat(reviewRow.rows[0].avg_rating) || null,
            review_count: parseInt(reviewRow.rows[0].review_count) || 0,
            total_proposals: parseInt(proposalRow.rows[0].total) || 0,
            accepted_proposals: parseInt(proposalRow.rows[0].accepted) || 0,
        });
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
        // Free-plan realtors must purchase a lead before submitting a proposal
        const planRow = await pool.query(
            `SELECT COALESCE(c.plan, u.subscription_plan, 'free') AS plan
             FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = $1`,
            [req.session.userId]
        );
        if ((planRow.rows[0]?.plan || 'free') === 'free') {
            const leadRow = await pool.query(
                `SELECT id FROM lead_purchases WHERE realtor_id = $1 AND listing_id = $2 AND paid = TRUE`,
                [req.session.userId, listing_id]
            );
            if (!leadRow.rows.length) {
                return res.status(402).json({ error: 'free_plan_lead_required', message: 'Purchase this lead ($15) to submit a proposal.' });
            }
        }
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
                    `SELECT u.id AS seller_id, u.email, u.first_name, u.last_name, l.address, l.city, l.state
                     FROM listings l JOIN users u ON u.id = l.user_id
                     WHERE l.id = $1`,
                    [listing_id]
                );
                if (!sellerRes.rows.length) return;
                const s = sellerRes.rows[0];
                const addr = [s.address, s.city, s.state].filter(Boolean).join(', ');
                const realtorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim();
                await emailService.sendProposalNotification(s.email, s.first_name, addr, realtorName, pct);
                // In-app notification + SSE push (mirrors legacy offers system)
                pool.query(
                    `INSERT INTO notifications (user_id, type, title, body, link)
                     VALUES ($1, 'proposal', 'New Realtor Proposal', $2, '/dashboard/seller')`,
                    [s.seller_id, `${realtorName} submitted a proposal on ${addr} — ${pct}% commission`]
                ).then(() => sseNotify(s.seller_id, { type: 'notification' })).catch(() => {});
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
             WHERE p.realtor_id = $1 AND l.deleted_at IS NULL
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
            `SELECT p.*, u.first_name, u.last_name, u.profile_photo, u.brokerage, u.years_experience, u.license_verified,
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

app.put('/api/proposals/:id/mark-viewed', auth.requireAuth, async (req, res) => {
    if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
    const id = parseInt(req.params.id);
    try {
        const { rows: [prop] } = await pool.query(
            `SELECT p.id, p.seller_viewed_at, p.realtor_id, p.listing_id,
                    l.address, l.city, l.state, l.user_id AS seller_id,
                    u.email AS realtor_email, u.first_name AS realtor_first,
                    u.notif_messages AS realtor_notif_msgs
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users u ON u.id = p.realtor_id
             WHERE p.id = $1 AND l.user_id = $2`,
            [id, req.session.userId]
        );
        if (!prop) return res.status(404).json({ error: 'Not found' });
        const isFirstView = !prop.seller_viewed_at;
        if (isFirstView) {
            await pool.query(`UPDATE proposals SET seller_viewed_at = NOW() WHERE id = $1`, [id]);
            const addr = [prop.address, prop.city, prop.state].filter(Boolean).join(', ');
            sseNotify(prop.realtor_id, { type: 'proposal_viewed', listingAddress: addr });
            if (prop.realtor_notif_msgs !== false && prop.realtor_email) {
                emailService.sendProposalViewed(prop.realtor_email, prop.realtor_first, addr).catch(() => {});
            }
        }
        res.json({ ok: true, first_view: isFirstView });
    } catch (err) {
        console.error('mark-viewed error:', err);
        res.status(500).json({ error: 'Failed' });
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

// Seller sends counter-offer on a proposal
app.post('/api/proposals/:id/counter', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
        const proposalId = parseInt(req.params.id);
        const { counter_commission, counter_message } = req.body;
        if (!counter_commission || isNaN(parseFloat(counter_commission))) {
            return res.status(400).json({ error: 'counter_commission is required' });
        }
        const pct = parseFloat(counter_commission);
        if (pct < 0.5 || pct > 10) return res.status(400).json({ error: 'Commission must be between 0.5% and 10%' });

        // Verify seller owns the listing this proposal is for
        const { rows } = await pool.query(
            `SELECT p.*, l.user_id AS listing_owner, l.address, l.city, l.state,
                    u.email AS realtor_email, u.first_name AS realtor_first_name
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users u ON u.id = p.realtor_id
             WHERE p.id = $1`,
            [proposalId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Proposal not found' });
        if (rows[0].listing_owner !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        if (rows[0].status !== 'pending') return res.status(400).json({ error: 'Can only counter pending proposals' });

        await pool.query(
            `UPDATE proposals SET counter_commission=$1, counter_message=$2, counter_status='pending' WHERE id=$3`,
            [pct, counter_message || null, proposalId]
        );

        // Notify realtor
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'counter_offer','Counter-Offer Received',$2,'/dashboard/realtor')`,
            [rows[0].realtor_id, `The seller has countered your proposal on ${rows[0].address} — they're requesting ${pct}% commission.`]
        ).then(() => sseNotify(rows[0].realtor_id, { type: 'notification' })).catch(() => {});

        emailService.sendCounterOffer(
            rows[0].realtor_email, rows[0].realtor_first_name,
            `${rows[0].address}, ${rows[0].city}, ${rows[0].state}`,
            pct, counter_message || null
        ).catch(e => console.error('Counter-offer email error:', e.message));

        res.json({ success: true });
    } catch (err) {
        console.error('POST /api/proposals/:id/counter error:', err);
        res.status(500).json({ error: 'Failed to send counter-offer' });
    }
});

// Realtor responds to a counter-offer
app.put('/api/proposals/:id/counter/respond', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const proposalId = parseInt(req.params.id);
        const { accept } = req.body; // true or false
        if (typeof accept !== 'boolean' && accept !== 'true' && accept !== 'false') {
            return res.status(400).json({ error: 'accept (true/false) is required' });
        }
        const accepted = accept === true || accept === 'true';

        const { rows } = await pool.query(
            `SELECT p.*, l.address, l.city, l.state, l.user_id AS listing_owner,
                    u.email AS seller_email, u.first_name AS seller_first
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users u ON u.id = l.user_id
             WHERE p.id = $1 AND p.realtor_id = $2`,
            [proposalId, req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Proposal not found' });
        if (rows[0].counter_status !== 'pending') return res.status(400).json({ error: 'No pending counter-offer' });

        const newCounterStatus = accepted ? 'accepted' : 'declined';

        if (accepted) {
            // Accept counter: update commission and status to accepted
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `UPDATE proposals SET commission_pct=$1, counter_status='accepted', status='accepted' WHERE id=$2`,
                    [rows[0].counter_commission, proposalId]
                );
                await client.query(
                    `UPDATE proposals SET status='declined' WHERE listing_id=$1 AND id!=$2`,
                    [rows[0].listing_id, proposalId]
                );
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        } else {
            await pool.query(`UPDATE proposals SET counter_status='declined' WHERE id=$1`, [proposalId]);
        }

        // Notify seller
        const sellerMsg = accepted
            ? `Your counter-offer was accepted — the realtor agreed to ${rows[0].counter_commission}% commission on ${rows[0].address}.`
            : `The realtor declined your counter-offer on ${rows[0].address}.`;
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,'/dashboard/seller')`,
            [rows[0].listing_owner, accepted ? 'counter_accepted' : 'counter_declined',
             accepted ? 'Counter-Offer Accepted!' : 'Counter-Offer Declined', sellerMsg]
        ).then(() => sseNotify(rows[0].listing_owner, { type: 'notification' })).catch(() => {});

        res.json({ success: true, accepted });
    } catch (err) {
        console.error('PUT /api/proposals/:id/counter/respond error:', err);
        res.status(500).json({ error: 'Failed to respond to counter-offer' });
    }
});

app.put('/api/proposals/:id/accept', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
        const proposalId = parseInt(req.params.id);
        const { rows: pRows } = await pool.query(
            `SELECT p.*, l.user_id as listing_owner_id, l.address, l.city, l.state,
                    u.email as realtor_email, u.first_name as realtor_first, u.last_name as realtor_last,
                    s.email as seller_email, s.first_name as seller_first
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users u ON u.id = p.realtor_id
             JOIN users s ON s.id = l.user_id
             WHERE p.id = $1`,
            [proposalId]
        );
        if (!pRows.length) return res.status(404).json({ error: 'Proposal not found' });
        const proposal = pRows[0];
        if (proposal.listing_owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`UPDATE proposals SET status = 'accepted' WHERE id = $1`, [proposalId]);
            await client.query(`UPDATE proposals SET status = 'declined' WHERE listing_id = $1 AND id != $2`, [proposal.listing_id, proposalId]);
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
        const addr = [proposal.address, proposal.city, proposal.state].filter(Boolean).join(', ');
        const realtorName = `${proposal.realtor_first || ''} ${proposal.realtor_last || ''}`.trim();
        // SSE + notification for winning realtor
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link)
             VALUES ($1, 'proposal_accepted', 'Proposal Accepted! 🎉', $2, '/dashboard/realtor')`,
            [proposal.realtor_id, `Your proposal on ${addr} was accepted! The seller is ready to move forward.`]
        ).then(() => sseNotify(proposal.realtor_id, { type: 'notification' })).catch(() => {});
        // Create CRM match record
        pool.query(
            `INSERT INTO lead_matches (listing_id, realtor_id, assigned_by, status, realtor_accepted)
             VALUES ($1, $2, $3, 'active', true)`,
            [proposal.listing_id, proposal.realtor_id, req.session.userId]
        ).catch(e => console.error('CRM match creation failed:', e.message));
        // Update listing CRM status
        pool.query(
            `UPDATE listings SET crm_status = 'assigned', crm_assigned_realtor_id = $1 WHERE id = $2`,
            [proposal.realtor_id, proposal.listing_id]
        ).catch(e => console.error('CRM lead update failed:', e.message));
        // Email winning realtor
        emailService.sendProposalAccepted(proposal.realtor_email, realtorName, addr)
            .catch(e => console.error('Proposal accepted email failed:', e.message));
        // Auto-create deal record
        maybeCreateDealOnAccept(proposal.listing_id, proposal.realtor_id, proposalId).catch(() => {});
        res.json({ success: true, realtor_id: proposal.realtor_id, realtor_name: realtorName });
    } catch (error) {
        console.error('PUT /api/proposals/:id/accept error:', error);
        res.status(500).json({ error: 'Failed to accept proposal' });
    }
});

// ===== REVIEWS ROUTES (Feature 2) =====

app.post('/api/reviews', auth.requireAuth, async (req, res) => {
    try {
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for a verification link.' });
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
            `INSERT INTO realtor_reviews (realtor_id, seller_id, listing_id, rating, body)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (seller_id, listing_id) DO UPDATE SET rating=$4, body=$5, created_at=NOW()
             RETURNING *`,
            [realtor_id, req.session.userId, listing_id || null, rating, comment || null]
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
            `SELECT r.id, r.rating, r.body AS comment, r.created_at,
                    u.first_name || ' ' || u.last_name AS reviewer_name,
                    l.address AS listing_address
             FROM realtor_reviews r
             LEFT JOIN users u ON u.id = r.seller_id
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
        if (!['realtor', 'seller', 'buyer'].includes(req.user.user_type)) return res.status(403).json({ error: 'Account required' });
        // Generate referral code if missing
        let { rows } = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [req.session.userId]);
        let code = rows[0]?.referral_code;
        if (!code) {
            code = crypto.randomBytes(6).toString('hex');
            await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [code, req.session.userId]);
        }
        const [countRes, referredRes, creditsRes] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE referred_by = $1`, [req.session.userId]),
            pool.query(
                `SELECT first_name, last_name, user_type, subscription_plan, created_at
                 FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 50`,
                [req.session.userId]
            ),
            pool.query(`SELECT referral_credits_cents FROM users WHERE id = $1`, [req.session.userId]),
        ]);
        const referral_count = parseInt(countRes.rows[0].cnt);
        const tier = referral_count >= 10 ? 'ambassador' : referral_count >= 5 ? 'top-referrer' : referral_count >= 3 ? 'connector' : referral_count >= 1 ? 'rising-star' : null;
        const referral_url = `${req.protocol}://${req.get('host')}/join?ref=${code}`;
        const credits_cents = parseInt(creditsRes.rows[0]?.referral_credits_cents) || 0;
        res.json({ referral_code: code, referral_url, referral_count, tier, referred_users: referredRes.rows, credits_cents });
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
app.get('/join', async (req, res) => {
    const ref = req.query.ref;
    if (ref) {
        res.cookie('ref_code', ref, { path: '/', maxAge: 7 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: false });
        // Look up referrer name to show a personalised banner on the signup page
        try {
            const { rows } = await pool.query(
                `SELECT first_name FROM users WHERE referral_code = $1 AND user_type = 'realtor'`,
                [ref]
            );
            if (rows.length) {
                const name = encodeURIComponent(rows[0].first_name);
                return res.redirect(`/login?tab=signup&type=realtor&referrer=${name}`);
            }
        } catch (e) { /* non-fatal — fall through */ }
    }
    res.redirect('/login?tab=signup&type=realtor');
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

// Agent performance badges (computed from live data)
app.get('/api/realtors/:id/badges', async (req, res) => {
    try {
        const realtorId = parseInt(req.params.id);
        const [propRow, reviewRow, responseRow, profileRow] = await Promise.all([
            pool.query(
                `SELECT COUNT(*) AS total, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted
                 FROM proposals WHERE realtor_id=$1`, [realtorId]
            ),
            pool.query(
                `SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM realtor_reviews WHERE realtor_id=$1`, [realtorId]
            ),
            pool.query(
                `SELECT AVG(response_hours) AS avg FROM realtor_response_times WHERE realtor_id=$1`, [realtorId]
            ),
            pool.query(`SELECT years_experience FROM users WHERE id=$1`, [realtorId]),
        ]);
        const total = parseInt(propRow.rows[0].total) || 0;
        const accepted = parseInt(propRow.rows[0].accepted) || 0;
        const winRate = total >= 5 ? accepted / total : 0;
        const avgRating = parseFloat(reviewRow.rows[0].avg) || 0;
        const reviewCount = parseInt(reviewRow.rows[0].cnt) || 0;
        const avgResponseHours = parseFloat(responseRow.rows[0].avg) || null;
        const yearsExp = parseInt(profileRow.rows[0]?.years_experience) || 0;

        const badges = [];
        if (winRate >= 0.20 && total >= 5)
            badges.push({ id: 'top_agent', label: 'Top Agent', icon: '🏆', color: '#f59e0b' });
        if (avgResponseHours !== null && avgResponseHours < 4)
            badges.push({ id: 'fast_responder', label: 'Fast Responder', icon: '⚡', color: '#0ea5e9' });
        if (avgRating >= 4.5 && reviewCount >= 3)
            badges.push({ id: 'five_star', label: '5-Star Agent', icon: '⭐', color: '#10b981' });
        if (yearsExp >= 5)
            badges.push({ id: 'experienced', label: `${yearsExp}+ Yrs Exp`, icon: '🎓', color: '#6366f1' });

        res.json({ badges, winRate: Math.round(winRate * 100), totalProposals: total, avgRating, reviewCount });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch badges' }); }
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

const LEAD_PRICE_CENTS = 1500; // $15 per lead

// Purchase a listing lead (free plan realtors — pay $15 to unlock one listing)
app.post('/api/leads/purchase', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { listing_id } = req.body;
        if (!listing_id) return res.status(400).json({ error: 'listing_id required' });

        const planRow = await pool.query(
            `SELECT COALESCE(c.plan, u.subscription_plan, 'free') AS plan
             FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = $1`,
            [req.session.userId]
        );
        const plan = planRow.rows[0]?.plan || 'free';
        if (plan !== 'free') {
            return res.status(400).json({ error: 'Your subscription already includes unlimited leads.' });
        }

        // Check for existing paid purchase
        const existing = await pool.query(
            `SELECT id, paid FROM lead_purchases WHERE realtor_id = $1 AND listing_id = $2`,
            [req.session.userId, listing_id]
        );
        if (existing.rows.length && existing.rows[0].paid) {
            return res.status(400).json({ error: 'You have already purchased this lead.' });
        }

        // Verify listing exists
        const listingRow = await pool.query(
            `SELECT address, city, state FROM listings WHERE id = $1 AND deleted_at IS NULL`, [listing_id]
        );
        if (!listingRow.rows.length) return res.status(404).json({ error: 'Listing not found' });
        const l = listingRow.rows[0];

        const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency: 'usd',
                    unit_amount: LEAD_PRICE_CENTS,
                    product_data: {
                        name: 'RealtorFinder Lead',
                        description: `${l.address}, ${l.city}, ${l.state}`,
                    },
                },
                quantity: 1,
            }],
            metadata: { type: 'listing_lead', realtor_id: String(req.session.userId), listing_id: String(listing_id) },
            success_url: `${base}/dashboard/realtor?lead_purchased=1`,
            cancel_url: `${base}/dashboard/realtor`,
        });

        // Record pending purchase (paid=FALSE until webhook confirms)
        await pool.query(
            `INSERT INTO lead_purchases (realtor_id, listing_id, stripe_payment_intent_id, amount_cents, paid)
             VALUES ($1, $2, $3, $4, FALSE)
             ON CONFLICT (realtor_id, listing_id) DO UPDATE SET stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id`,
            [req.session.userId, listing_id, session.payment_intent, LEAD_PRICE_CENTS]
        );

        res.json({ url: session.url });
    } catch (err) {
        console.error('POST /api/leads/purchase error:', err);
        res.status(500).json({ error: 'Failed to create payment' });
    }
});

// Get purchased buyer-request lead IDs for current realtor
app.get('/api/leads/purchased', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT buyer_request_id FROM lead_purchases WHERE realtor_id = $1 AND buyer_request_id IS NOT NULL`,
            [req.session.userId]
        );
        res.json(rows.map(r => r.buyer_request_id));
    } catch (err) {
        console.error('GET /api/leads/purchased error:', err);
        res.status(500).json({ error: 'Failed to fetch purchased leads' });
    }
});

// Get purchased listing lead IDs (paid) for current realtor
app.get('/api/leads/purchased-listings', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT listing_id FROM lead_purchases WHERE realtor_id = $1 AND listing_id IS NOT NULL AND paid = TRUE`,
            [req.session.userId]
        );
        res.json(rows.map(r => r.listing_id));
    } catch (err) {
        console.error('GET /api/leads/purchased-listings error:', err);
        res.status(500).json({ error: 'Failed to fetch purchased listing leads' });
    }
});

// ===== FEATURE 2: SHOWING REQUESTS =====

const VALID_TIMES = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'];

// Request a showing
app.post('/api/showings', auth.requireAuth, async (req, res) => {
    try {
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for a verification link.' });
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
             WHERE l.deleted_at IS NULL
               AND (l.user_id = $1
                OR EXISTS (SELECT 1 FROM proposals p WHERE p.listing_id = l.id AND p.realtor_id = $1 AND p.status = 'accepted'))
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
        // Only the seller who owns the listing may confirm
        const { rows } = await pool.query(
            `UPDATE showings SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW()
             WHERE id = $2
               AND listing_id IN (SELECT id FROM listings WHERE user_id = $1)
             RETURNING *`,
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
        // Caller must be the buyer who requested OR the seller who owns the listing
        const { rows } = await pool.query(
            `UPDATE showings SET status = 'cancelled'
             WHERE id = $1
               AND (buyer_id = $2 OR listing_id IN (SELECT id FROM listings WHERE user_id = $2))
             RETURNING *`,
            [showingId, req.session.userId]
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

        // Collapse 7 round-trips into 2 parallel queries
        const [statsRow, viewsByDay] = await Promise.all([
            pool.query(`
                SELECT
                    -- Profile view counts in one pass
                    COUNT(pv.id) FILTER (WHERE pv.viewed_at >= NOW() - INTERVAL '7 days')  AS views_7,
                    COUNT(pv.id) FILTER (WHERE pv.viewed_at >= NOW() - INTERVAL '30 days') AS views_30,
                    COUNT(pv.id)                                                             AS views_all,
                    -- Proposal counts in one pass
                    COUNT(p.id) FILTER (WHERE p.status = 'pending')  AS prop_pending,
                    COUNT(p.id) FILTER (WHERE p.status = 'accepted') AS prop_accepted,
                    COUNT(p.id) FILTER (WHERE p.status = 'declined') AS prop_declined,
                    COUNT(DISTINCT p.listing_id)                      AS active_bids,
                    -- Response time average
                    AVG(rt.response_hours)                            AS avg_hours
                FROM users u
                LEFT JOIN profile_views pv ON pv.realtor_id = u.id
                LEFT JOIN proposals     p  ON p.realtor_id  = u.id
                LEFT JOIN realtor_response_times rt ON rt.realtor_id = u.id
                WHERE u.id = $1
            `, [uid]),
            pool.query(
                `SELECT DATE(viewed_at) AS day, COUNT(*) AS cnt
                 FROM profile_views WHERE realtor_id = $1 AND viewed_at >= NOW() - INTERVAL '7 days'
                 GROUP BY day ORDER BY day`,
                [uid]
            ),
        ]);

        const s = statsRow.rows[0];
        const accepted = parseInt(s.prop_accepted) || 0;
        const pending  = parseInt(s.prop_pending)  || 0;
        const declined = parseInt(s.prop_declined) || 0;
        const totalProposals = accepted + pending + declined;
        const winRate = totalProposals > 0 ? Math.round((accepted / totalProposals) * 100) + '%' : '0%';

        const avgHours = parseFloat(s.avg_hours);
        let responseTime = 'N/A';
        if (!isNaN(avgHours)) {
            if (avgHours < 1) responseTime = '< 1 hour';
            else if (avgHours < 24) responseTime = Math.round(avgHours) + ' hours';
            else responseTime = Math.round(avgHours / 24) + ' days';
        }

        res.json({
            profileViews: {
                last7Days:  parseInt(s.views_7)   || 0,
                last30Days: parseInt(s.views_30)  || 0,
                allTime:    parseInt(s.views_all) || 0,
                byDay: viewsByDay.rows
            },
            proposals: { total: totalProposals, accepted, pending, declined, winRate },
            listings: {
                activeBids:   parseInt(s.active_bids) || 0,
                wonListings:  accepted
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

// realtor_reviews moved to _schemaMigrations below

// ===== BATCH 6: LEADERBOARD =====

app.get('/api/realtors/leaderboard', async (req, res) => {
    try {
        const { area, limit: lim = 10 } = req.query;
        const params = [];
        let areaClause = '';
        if (area) { params.push(`%${area}%`); areaClause = `AND u.service_areas ILIKE $1`; }
        const { rows } = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.profile_photo, u.bio,
                    u.years_experience, u.service_areas, u.license_verified, u.subscription_plan,
                    c.name AS company_name,
                    ROUND(COALESCE(AVG(r.rating), 0), 1) AS avg_rating,
                    COUNT(DISTINCT r.id) AS review_count,
                    COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'accepted') AS accepted_proposals,
                    COUNT(DISTINCT p.id) AS total_proposals
             FROM users u
             LEFT JOIN companies c ON u.company_id = c.id
             LEFT JOIN realtor_reviews r ON r.realtor_id = u.id
             LEFT JOIN proposals p ON p.realtor_id = u.id
             WHERE u.user_type = 'realtor' AND u.is_approved = TRUE AND u.is_active IS NOT FALSE
               ${areaClause}
             GROUP BY u.id, c.name
             HAVING COUNT(DISTINCT p.id) > 0 OR COUNT(DISTINCT r.id) > 0
             ORDER BY avg_rating DESC, accepted_proposals DESC, total_proposals DESC
             LIMIT $${params.length + 1}`,
            [...params, Math.min(parseInt(lim) || 10, 50)]
        );
        res.json(rows);
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: 'Failed to load leaderboard' });
    }
});

// ===== BATCH 6: LISTING BOOST =====

const BOOST_PRICES = { 7: 900, 30: 2900 }; // cents

app.post('/api/listings/:id/boost', auth.requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
    try {
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
        const listingId = parseInt(req.params.id);
        const days = parseInt(req.body.days);
        if (![7, 30].includes(days)) return res.status(400).json({ error: 'days must be 7 or 30' });

        const { rows } = await pool.query(
            `SELECT id, address, city, state FROM listings WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
            [listingId, req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
        const l = rows[0];
        const address = [l.address, l.city, l.state].filter(Boolean).join(', ');

        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    unit_amount: BOOST_PRICES[days],
                    product_data: { name: `${days}-Day Listing Boost`, description: address }
                },
                quantity: 1
            }],
            metadata: { type: 'listing_boost', listing_id: listingId, days, seller_id: req.session.userId },
            success_url: `${baseUrl}/dashboard/seller?boost=success`,
            cancel_url: `${baseUrl}/dashboard/seller`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Boost checkout error:', err);
        res.status(500).json({ error: 'Failed to create boost checkout' });
    }
});

app.get('/api/listings/:id/boost-status', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT boosted_until FROM listings WHERE id=$1 AND user_id=$2`,
            [parseInt(req.params.id), req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        const boostedUntil = rows[0].boosted_until;
        const active = boostedUntil && new Date(boostedUntil) > new Date();
        res.json({ active, boosted_until: boostedUntil || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to check boost status' });
    }
});

// ===== BATCH 7: REALTOR AVAILABILITY =====

app.get('/api/availability', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { rows } = await pool.query(
            `SELECT id, day_of_week, start_time, end_time
             FROM realtor_availability WHERE realtor_id=$1 ORDER BY day_of_week, start_time`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to load availability' }); }
});

app.post('/api/availability', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { day_of_week, start_time, end_time } = req.body;
        if (day_of_week === undefined || !start_time || !end_time)
            return res.status(400).json({ error: 'day_of_week, start_time, end_time required' });
        const { rows } = await pool.query(
            `INSERT INTO realtor_availability (realtor_id, day_of_week, start_time, end_time)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (realtor_id, day_of_week, start_time) DO UPDATE SET end_time=EXCLUDED.end_time
             RETURNING *`,
            [req.session.userId, parseInt(day_of_week), start_time, end_time]
        );
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Failed to save availability' }); }
});

app.delete('/api/availability/:id', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        await pool.query(
            `DELETE FROM realtor_availability WHERE id=$1 AND realtor_id=$2`,
            [parseInt(req.params.id), req.session.userId]
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete slot' }); }
});

app.get('/api/realtors/:id/availability', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT day_of_week, start_time, end_time
             FROM realtor_availability WHERE realtor_id=$1 ORDER BY day_of_week, start_time`,
            [parseInt(req.params.id)]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: 'Failed to load availability' }); }
});

// ===== BATCH 7: PROPOSAL FOLLOW-UP EMAIL =====

app.post('/api/proposals/:id/followup', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const propId = parseInt(req.params.id);
        const { message } = req.body;
        if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
        if (message.length > 2000) return res.status(400).json({ error: 'Message must be under 2000 characters' });

        const { rows } = await pool.query(
            `SELECT p.id, p.listing_id,
                    l.address, l.city, l.state, l.user_id AS seller_id,
                    su.email AS seller_email, su.first_name AS seller_first,
                    su.notif_messages AS seller_notif_msgs,
                    ru.first_name AS realtor_first, ru.last_name AS realtor_last
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users su ON su.id = l.user_id
             JOIN users ru ON ru.id = p.realtor_id
             WHERE p.id=$1 AND p.realtor_id=$2`,
            [propId, req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Proposal not found' });
        const r = rows[0];
        const addr = [r.address, r.city, r.state].filter(Boolean).join(', ');
        const realtorName = `${r.realtor_first} ${r.realtor_last}`.trim();

        if (r.seller_notif_msgs !== false && r.seller_email) {
            emailService.sendFollowUpEmail(r.seller_email, r.seller_first, realtorName, addr, message.trim())
                .catch(err => console.error('Follow-up email error:', err.message));
        }
        sseNotify(r.seller_id, { type: 'proposal_followup', realtorName, listingAddress: addr });
        res.json({ ok: true });
    } catch (err) {
        console.error('Follow-up error:', err);
        res.status(500).json({ error: 'Failed to send follow-up' });
    }
});

// ===== MESSAGING =====

// ALTER TABLE migrations run at startup — collected here so they await before listen
const _schemaMigrations = [
    // Base tables — must come first so all ALTER TABLE and FK references succeed on a fresh DB
    `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        user_type VARCHAR(20) CHECK (user_type IN ('seller','realtor','buyer')),
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        zip_code VARCHAR(20),
        phone VARCHAR(50),
        bio TEXT,
        license_number VARCHAR(100),
        brokerage VARCHAR(255),
        years_experience INTEGER,
        service_areas TEXT,
        profile_photo TEXT,
        subscription_plan VARCHAR(50),
        subscription_id TEXT,
        company_id INTEGER,
        email_verified BOOLEAN DEFAULT FALSE,
        verification_token TEXT,
        verification_token_expires TIMESTAMPTZ,
        is_admin BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        is_approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS waitlist (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        user_type VARCHAR(20) NOT NULL CHECK (user_type IN ('seller','realtor','buyer')),
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        plan VARCHAR(50) DEFAULT 'basic',
        stripe_customer_id TEXT UNIQUE,
        stripe_subscription_id TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_role VARCHAR(50)`,
    `CREATE TABLE IF NOT EXISTS listings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        address TEXT NOT NULL,
        city VARCHAR(100),
        state VARCHAR(50),
        zip VARCHAR(20),
        price NUMERIC(12,2),
        property_type VARCHAR(50),
        bedrooms INTEGER,
        bathrooms DECIMAL(3,1),
        sqft INTEGER,
        description TEXT,
        owner_name VARCHAR(255),
        owner_email VARCHAR(255),
        owner_phone VARCHAR(50),
        status VARCHAR(30) DEFAULT 'active',
        image_urls TEXT[],
        view_count INTEGER DEFAULT 0,
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        zestimate NUMERIC(12,2),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS offers (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        realtor_name VARCHAR(255),
        brokerage VARCHAR(255),
        realtor_email VARCHAR(255),
        realtor_phone VARCHAR(50),
        commission DECIMAL(5,2),
        offer_details TEXT,
        status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
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
        updated_at TIMESTAMPTZ DEFAULT NOW(),
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
    `CREATE TABLE IF NOT EXISTS buyer_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        budget_min NUMERIC(12,2),
        budget_max NUMERIC(12,2),
        target_areas TEXT,
        property_type VARCHAR(50),
        bedrooms_min INTEGER,
        timeline TEXT,
        additional_notes TEXT,
        zip_code VARCHAR(20),
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        status VARCHAR(30) DEFAULT 'active',
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
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
        buyer_request_id INTEGER REFERENCES buyer_requests(id),
        listing_id INTEGER REFERENCES listings(id),
        stripe_payment_intent_id TEXT,
        amount_cents INTEGER NOT NULL DEFAULT 1500,
        paid BOOLEAN NOT NULL DEFAULT FALSE,
        purchased_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(realtor_id, buyer_request_id),
        UNIQUE(realtor_id, listing_id)
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
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_credit_paid BOOLEAN DEFAULT FALSE`,
    `CREATE TABLE IF NOT EXISTS verification_resend_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Counter-offer columns on proposals
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS counter_commission NUMERIC(5,2)`,
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS counter_message TEXT`,
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS counter_status TEXT DEFAULT 'none'`,
    // Seller attestation on listings
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS owner_attested BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS owner_attested_at TIMESTAMPTZ`,
];

// ===== BATCH 6+7 SCHEMA =====
_schemaMigrations.push(
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS boosted_until TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS realtor_availability (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        UNIQUE(realtor_id, day_of_week, start_time)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_realtor_avail ON realtor_availability(realtor_id)`
);

// ===== ADMIN AUDIT LOG =====
_schemaMigrations.push(
    `CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        target_user_id INTEGER REFERENCES users(id),
        ip_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log(admin_id, created_at DESC)`
);

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

// ===== BUYER USER TYPE + SEARCH INDEXES =====
_schemaMigrations.push(
    // Allow buyer accounts — drop old 2-value constraint and replace with 3-value
    `DO $$ BEGIN
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;
        ALTER TABLE users ADD CONSTRAINT users_user_type_check
            CHECK (user_type IN ('seller', 'realtor', 'buyer'));
    EXCEPTION WHEN others THEN NULL; END $$`,
    // Indexes to support first/last name search without full table scan
    `CREATE INDEX IF NOT EXISTS idx_users_first_name ON users(lower(first_name))`,
    `CREATE INDEX IF NOT EXISTS idx_users_last_name  ON users(lower(last_name))`,
    `CREATE INDEX IF NOT EXISTS idx_users_type_approved ON users(user_type, is_approved) WHERE is_active IS NOT FALSE`
);

// List conversations for current user
app.get('/api/messages/conversations', auth.requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        // Pre-aggregate unread counts once, then join — avoids a correlated subquery per row
        const { rows } = await pool.query(`
            WITH unread AS (
                SELECT from_user_id AS sender_id,
                       COALESCE(listing_id, 0) AS listing_id,
                       COUNT(*) AS cnt
                FROM messages
                WHERE to_user_id = $1 AND read_at IS NULL
                GROUP BY from_user_id, COALESCE(listing_id, 0)
            ),
            latest AS (
                SELECT DISTINCT ON (
                    LEAST(from_user_id, to_user_id)::text || '-' ||
                    GREATEST(from_user_id, to_user_id)::text || '-' ||
                    COALESCE(listing_id::text, '0')
                )
                    LEAST(from_user_id, to_user_id)::text || '-' ||
                    GREATEST(from_user_id, to_user_id)::text || '-' ||
                    COALESCE(listing_id::text, '0')                         AS conv_key,
                    CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS other_user_id,
                    listing_id,
                    body       AS last_body,
                    created_at AS last_at
                FROM messages
                WHERE from_user_id = $1 OR to_user_id = $1
                ORDER BY
                    LEAST(from_user_id, to_user_id)::text || '-' ||
                    GREATEST(from_user_id, to_user_id)::text || '-' ||
                    COALESCE(listing_id::text, '0'),
                    created_at DESC
            )
            SELECT
                l.conv_key, l.other_user_id,
                u.first_name, u.last_name, u.user_type,
                l.listing_id,
                lst.address AS listing_address,
                l.last_body, l.last_at,
                COALESCE(ur.cnt, 0) AS unread_count
            FROM latest l
            JOIN users u ON u.id = l.other_user_id
            LEFT JOIN listings lst ON lst.id = l.listing_id
            LEFT JOIN unread ur ON ur.sender_id = l.other_user_id
                                AND ur.listing_id = COALESCE(l.listing_id, 0)
            ORDER BY l.last_at DESC
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
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for a verification link.' });
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
        `, [toUserId, `You have a new message`]).then(() => sseNotify(toUserId, { type: 'new_message', fromUserId: uid, listingId: listingId || null, messageId: newMsgId })).catch(() => {});

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

app.get('/api/notifications/stream', auth.requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const uid = req.session.userId;
    if (!sseClients.has(uid)) sseClients.set(uid, new Set());
    sseClients.get(uid).add(res);

    // Send initial heartbeat
    res.write(': heartbeat\n\n');
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(_) {} }, 25000);

    req.on('close', () => {
        clearInterval(hb);
        const s = sseClients.get(uid);
        if (s) { s.delete(res); if (!s.size) sseClients.delete(uid); }
    });
});

// Mark all notifications as read (must be before /:id/read to avoid route shadowing)
app.put('/api/notifications/read-all', auth.requireAuth, async (req, res) => {
    try {
        await pool.query(
            `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
            [req.session.userId]
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to mark all read' }); }
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

// saved_searches moved to _schemaMigrations below

// ===== SAVED SEARCHES =====

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
            if (s.min_price) { conditions.push(`l.price >= $${pi++}`); params.push(s.min_price); }
            if (s.max_price) { conditions.push(`l.price <= $${pi++}`); params.push(s.max_price); }
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
             WHERE l.share_token = $1 AND l.status != 'inactive' AND l.deleted_at IS NULL`,
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

// ===== SELLER LISTING ANALYTICS =====

app.get('/api/listings/:id/analytics', auth.requireAuth, async (req, res) => {
    try {
        const listingId = parseInt(req.params.id);
        const { rows: listingRows } = await pool.query(
            `SELECT l.*, u.first_name AS owner_first FROM listings l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
            [listingId]
        );
        if (!listingRows.length) return res.status(404).json({ error: 'Listing not found' });
        const l = listingRows[0];
        if (req.user.user_type !== 'admin' && l.user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const { rows: proposals } = await pool.query(
            `SELECT p.id, p.commission_pct, p.status, p.counter_status, p.created_at,
                    u.first_name, u.last_name, u.profile_photo, u.years_experience, u.brokerage,
                    COALESCE(AVG(r.rating), 0) AS avg_rating,
                    COUNT(DISTINCT r.id) AS review_count,
                    COUNT(DISTINCT wp.id) AS accepted_count
             FROM proposals p
             JOIN users u ON u.id = p.realtor_id
             LEFT JOIN reviews r ON r.realtor_id = u.id
             LEFT JOIN proposals wp ON wp.realtor_id = u.id AND wp.status = 'accepted'
             WHERE p.listing_id = $1
             GROUP BY p.id, u.id
             ORDER BY p.created_at DESC`,
            [listingId]
        );
        const days_on_market = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 86400000);
        res.json({
            listing_id: listingId,
            view_count: l.view_count || 0,
            share_views: l.share_views || 0,
            days_on_market,
            proposal_count: proposals.length,
            accepted_proposal: proposals.find(p => p.status === 'accepted') || null,
            proposals: proposals.map(p => ({
                id: p.id,
                realtor_name: `${p.first_name} ${p.last_name}`.trim(),
                profile_photo: p.profile_photo,
                commission_pct: parseFloat(p.commission_pct),
                status: p.status,
                counter_status: p.counter_status,
                years_experience: p.years_experience,
                brokerage: p.brokerage,
                avg_rating: parseFloat(p.avg_rating).toFixed(1),
                review_count: parseInt(p.review_count),
                accepted_count: parseInt(p.accepted_count),
                submitted_at: p.created_at,
            }))
        });
    } catch (err) {
        console.error('Listing analytics error:', err);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ===== REALTOR SHOWING REQUESTS =====

app.post('/api/realtor-showings', auth.requireAuth, async (req, res) => {
    try {
        if (!req.session.emailVerified && !req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first. Check your inbox for a verification link.' });
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const { listing_id, proposed_slots, message } = req.body;
        if (!listing_id || !Array.isArray(proposed_slots) || !proposed_slots.length) {
            return res.status(400).json({ error: 'listing_id and at least one proposed_slot required' });
        }
        const { rows: listingRows } = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.user_id,
                    u.email AS seller_email, u.first_name AS seller_first
             FROM listings l JOIN users u ON u.id = l.user_id
             WHERE l.id = $1 AND l.status = 'active'`, [parseInt(listing_id)]
        );
        if (!listingRows.length) return res.status(404).json({ error: 'Listing not found' });
        const listing = listingRows[0];
        const { rows } = await pool.query(
            `INSERT INTO realtor_showing_requests (listing_id, realtor_id, proposed_slots, message)
             VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
            [listing.id, req.session.userId, JSON.stringify(proposed_slots), message || null]
        );
        const addr = [listing.address, listing.city, listing.state].filter(Boolean).join(', ');
        const r = req.user;
        const realtorName = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'showing_request','Showing Request',$2,'/dashboard/seller')`,
            [listing.user_id, `${realtorName} has requested a showing for ${addr}.`]
        ).then(() => sseNotify(listing.user_id, { type: 'notification' })).catch(() => {});
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Realtor showing request error:', err);
        res.status(500).json({ error: 'Failed to create showing request' });
    }
});

app.get('/api/realtor-showings/my', auth.requireAuth, async (req, res) => {
    try {
        const col = req.user.user_type === 'realtor' ? 'rsr.realtor_id' : 'l.user_id';
        const { rows } = await pool.query(
            `SELECT rsr.*, l.address, l.city, l.state, l.id AS listing_id,
                    u.first_name AS realtor_first, u.last_name AS realtor_last, u.profile_photo AS realtor_photo,
                    s.first_name AS seller_first, s.last_name AS seller_last
             FROM realtor_showing_requests rsr
             JOIN listings l ON l.id = rsr.listing_id
             JOIN users u ON u.id = rsr.realtor_id
             JOIN users s ON s.id = l.user_id
             WHERE ${col} = $1
             ORDER BY rsr.created_at DESC LIMIT 100`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Get realtor showings error:', err);
        res.status(500).json({ error: 'Failed to fetch showing requests' });
    }
});

app.put('/api/realtor-showings/:id/respond', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'seller') return res.status(403).json({ error: 'Sellers only' });
        const { action, confirmed_slot } = req.body; // action: 'confirm' | 'decline'
        if (!['confirm', 'decline'].includes(action)) return res.status(400).json({ error: 'action must be confirm or decline' });
        const { rows: sr } = await pool.query(
            `SELECT rsr.*, l.user_id AS seller_id, l.address, l.city, l.state,
                    u.email AS realtor_email, u.first_name AS realtor_first
             FROM realtor_showing_requests rsr
             JOIN listings l ON l.id = rsr.listing_id
             JOIN users u ON u.id = rsr.realtor_id
             WHERE rsr.id = $1`,
            [parseInt(req.params.id)]
        );
        if (!sr.length) return res.status(404).json({ error: 'Not found' });
        if (sr[0].seller_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        const newStatus = action === 'confirm' ? 'confirmed' : 'declined';
        const { rows } = await pool.query(
            `UPDATE realtor_showing_requests SET status = $1, confirmed_slot = $2, responded_at = NOW()
             WHERE id = $3 RETURNING *`,
            [newStatus, action === 'confirm' ? (confirmed_slot || sr[0].proposed_slots[0]) : null, sr[0].id]
        );
        const addr = [sr[0].address, sr[0].city, sr[0].state].filter(Boolean).join(', ');
        const msg = action === 'confirm'
            ? `Your showing request for ${addr} has been confirmed.`
            : `Your showing request for ${addr} was declined by the seller.`;
        pool.query(
            `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,'/dashboard/realtor')`,
            [sr[0].realtor_id, `showing_${newStatus}`, action === 'confirm' ? 'Showing Confirmed!' : 'Showing Declined', msg]
        ).then(() => sseNotify(sr[0].realtor_id, { type: 'notification' })).catch(() => {});
        res.json(rows[0]);
    } catch (err) {
        console.error('Respond to showing error:', err);
        res.status(500).json({ error: 'Failed to respond to showing request' });
    }
});

// ===== DEAL / TRANSACTION TRACKER =====

app.post('/api/deals', auth.requireAuth, async (req, res) => {
    try {
        if (!['realtor', 'admin'].includes(req.user.user_type)) return res.status(403).json({ error: 'Forbidden' });
        const { listing_id, proposal_id, sale_price, notes } = req.body;
        if (!listing_id) return res.status(400).json({ error: 'listing_id required' });
        const { rows } = await pool.query(
            `INSERT INTO deals (listing_id, realtor_id, proposal_id, sale_price, notes)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [parseInt(listing_id), req.session.userId, proposal_id ? parseInt(proposal_id) : null,
             sale_price ? parseFloat(sale_price) : null, notes || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Create deal error:', err);
        res.status(500).json({ error: 'Failed to create deal' });
    }
});

app.get('/api/deals/my', auth.requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT d.*, l.address, l.city, l.state, l.price AS list_price,
                    l.bedrooms, l.bathrooms,
                    u.first_name AS seller_first, u.last_name AS seller_last
             FROM deals d
             JOIN listings l ON l.id = d.listing_id
             JOIN users u ON u.id = l.user_id
             WHERE d.realtor_id = $1
             ORDER BY d.created_at DESC`,
            [req.session.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Get deals error:', err);
        res.status(500).json({ error: 'Failed to fetch deals' });
    }
});

app.put('/api/deals/:id', auth.requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { status, sale_price, close_date, notes, referral_fee_due, referral_fee_paid } = req.body;
        const isAdmin = req.user.user_type === 'admin';
        const params = [
            status || null, sale_price ? parseFloat(sale_price) : null,
            close_date || null, notes || null,
            referral_fee_due ? parseFloat(referral_fee_due) : null,
            referral_fee_paid !== undefined ? !!referral_fee_paid : null,
            id
        ];
        const ownerClause = isAdmin ? '' : `AND realtor_id = $${params.push(req.session.userId)}`;
        const { rows } = await pool.query(
            `UPDATE deals SET
                status = COALESCE($1, status),
                sale_price = COALESCE($2, sale_price),
                close_date = COALESCE($3::date, close_date),
                notes = COALESCE($4, notes),
                referral_fee_due = COALESCE($5, referral_fee_due),
                referral_fee_paid = COALESCE($6, referral_fee_paid),
                updated_at = NOW()
             WHERE id = $7 ${ownerClause} RETURNING *`,
            params
        );
        if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
        if (status === 'closed' && rows[0]) {
            try {
                const { rows: info } = await pool.query(
                    `SELECT seller.email AS seller_email, seller.first_name AS seller_name,
                            realtor.first_name AS realtor_first, realtor.last_name AS realtor_last,
                            realtor.id AS realtor_id, l.address, l.city, l.state
                     FROM deals d
                     JOIN listings l ON l.id = d.listing_id
                     JOIN users seller ON seller.id = l.user_id
                     JOIN users realtor ON realtor.id = d.realtor_id
                     WHERE d.id = $1`, [rows[0].id]
                );
                if (info.length) {
                    const { seller_email, seller_name, realtor_first, realtor_last, realtor_id, address, city, state } = info[0];
                    const addr = [address, city, state].filter(Boolean).join(', ');
                    const realtorName = `${realtor_first || ''} ${realtor_last || ''}`.trim();
                    emailService.sendReviewRequestEmail(seller_email, seller_name, realtor_id, realtorName, addr).catch(() => {});
                }
            } catch(e) { console.error('Post-close review email error:', e.message); }
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Update deal error:', err);
        res.status(500).json({ error: 'Failed to update deal' });
    }
});

app.get('/api/admin/deals', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT d.*, l.address, l.city, l.state, l.price AS list_price,
                    u.first_name AS realtor_first, u.last_name AS realtor_last, u.email AS realtor_email,
                    s.first_name AS seller_first, s.last_name AS seller_last
             FROM deals d
             JOIN listings l ON l.id = d.listing_id
             JOIN users u ON u.id = d.realtor_id
             JOIN users s ON s.id = l.user_id
             ORDER BY d.updated_at DESC LIMIT 500`
        );
        res.json(rows);
    } catch (err) {
        console.error('Admin deals error:', err);
        res.status(500).json({ error: 'Failed to fetch deals' });
    }
});

app.get('/api/admin/realtor-coverage', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT zip_code,
                   LEFT(zip_code, 3) AS zip3,
                   COUNT(*)::int AS count,
                   array_agg(first_name || ' ' || last_name ORDER BY first_name) AS names,
                   (SELECT state_code FROM city_pages WHERE zip = u.zip_code LIMIT 1) AS state_code
            FROM users u
            WHERE user_type = 'realtor'
              AND zip_code IS NOT NULL
              AND zip_code ~ '^[0-9]{5}$'
            GROUP BY zip_code
            ORDER BY count DESC, zip_code
        `);
        res.json(rows);
    } catch (err) {
        console.error('realtor-coverage error:', err);
        res.status(500).json({ error: 'Failed to load coverage data' });
    }
});

app.get('/api/admin/referral-stats', requireAdmin, async (req, res) => {
    try {
        const [totals, topEarners] = await Promise.all([
            pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE referral_credits_cents > 0) AS users_with_credits,
                    SUM(referral_credits_cents)                        AS outstanding_cents,
                    COUNT(*) FILTER (WHERE referral_code IS NOT NULL)  AS users_with_code
                FROM users WHERE user_type = 'realtor'
            `),
            pool.query(`
                SELECT u.id, u.first_name, u.last_name, u.email, u.referral_credits_cents,
                       COUNT(r.id) AS referral_count
                FROM users u
                LEFT JOIN users r ON r.referred_by = u.id
                WHERE u.user_type = 'realtor'
                GROUP BY u.id
                HAVING u.referral_credits_cents > 0 OR COUNT(r.id) > 0
                ORDER BY COUNT(r.id) DESC, u.referral_credits_cents DESC
                LIMIT 50
            `)
        ]);
        res.json({
            outstanding_cents: parseInt(totals.rows[0].outstanding_cents) || 0,
            users_with_credits: parseInt(totals.rows[0].users_with_credits) || 0,
            users_with_code: parseInt(totals.rows[0].users_with_code) || 0,
            top_earners: topEarners.rows,
        });
    } catch (err) {
        console.error('Referral stats error:', err);
        res.status(500).json({ error: 'Failed to fetch referral stats' });
    }
});

// Auto-create deal when proposal is accepted (if not already one)
async function maybeCreateDealOnAccept(listingId, realtorId, proposalId) {
    try {
        const existing = await pool.query(`SELECT id FROM deals WHERE proposal_id = $1`, [proposalId]);
        if (!existing.rows.length) {
            await pool.query(
                `INSERT INTO deals (listing_id, realtor_id, proposal_id) VALUES ($1, $2, $3)`,
                [listingId, realtorId, proposalId]
            );
        }
    } catch (e) { console.error('Auto-create deal error:', e.message); }
}

// ===== PROPOSAL DOCUMENT ATTACHMENTS =====

app.post('/api/proposals/:id/attachments', auth.requireAuth, uploadLimiter, uploadDoc.single('file'), async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        const proposalId = parseInt(req.params.id);
        const { rows } = await pool.query(
            `SELECT id FROM proposals WHERE id = $1 AND realtor_id = $2`,
            [proposalId, req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Proposal not found' });
        const result = await uploadToCloudinaryDoc(req.file.buffer, req.file.mimetype);
        const url = result.secure_url;
        const name = req.file.originalname || 'attachment';
        const attachment = JSON.stringify({ url, name });
        const { rows: updated } = await pool.query(
            `UPDATE proposals SET attachments = array_append(COALESCE(attachments, '{}'), $1)
             WHERE id = $2 RETURNING attachments`,
            [attachment, proposalId]
        );
        res.json({ attachments: updated[0].attachments });
    } catch (err) {
        console.error('Proposal attachment upload error:', err);
        res.status(500).json({ error: 'Failed to upload attachment' });
    }
});

app.delete('/api/proposals/:id/attachments/:idx', auth.requireAuth, async (req, res) => {
    try {
        if (req.user.user_type !== 'realtor') return res.status(403).json({ error: 'Realtors only' });
        const proposalId = parseInt(req.params.id);
        const idx = parseInt(req.params.idx);
        const { rows } = await pool.query(
            `SELECT attachments FROM proposals WHERE id = $1 AND realtor_id = $2`,
            [proposalId, req.session.userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Proposal not found' });
        const attachments = (rows[0].attachments || []).filter((_, i) => i !== idx);
        await pool.query(`UPDATE proposals SET attachments = $1 WHERE id = $2`, [attachments, proposalId]);
        res.json({ attachments });
    } catch (err) {
        console.error('Delete attachment error:', err);
        res.status(500).json({ error: 'Failed to delete attachment' });
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
        // Check users table first, then companies
        const { rows } = await pool.query(
            `SELECT stripe_customer_id FROM users WHERE id=$1 AND stripe_customer_id IS NOT NULL
             UNION
             SELECT stripe_customer_id FROM companies WHERE owner_user_id=$1 AND stripe_customer_id IS NOT NULL
             LIMIT 1`,
            [req.session.userId]
        );
        if (!rows.length) {
            return res.status(400).json({ error: 'No active subscription found. Please subscribe first.' });
        }
        const base = process.env.FRONTEND_URL || 'https://www.realtorfinder.net';
        const session = await stripe.billingPortal.sessions.create({
            customer: rows[0].stripe_customer_id,
            return_url: `${base}/dashboard/realtor`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Billing portal error:', err);
        res.status(500).json({ error: 'Failed to open billing portal' });
    }
});

// ===== ADMIN BILLING PORTAL (open Stripe portal for any user) =====
app.post('/api/admin/users/:id/billing-portal', auth.requireAuth, requireAdmin, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        const { rows } = await pool.query(
            `SELECT stripe_customer_id FROM users WHERE id=$1
             UNION
             SELECT stripe_customer_id FROM companies WHERE owner_user_id=$1 AND stripe_customer_id IS NOT NULL
             LIMIT 1`,
            [targetId]
        );
        if (!rows.length || !rows[0].stripe_customer_id) {
            return res.status(400).json({ error: 'No Stripe customer found for this user.' });
        }
        const base = process.env.FRONTEND_URL || 'https://www.realtorfinder.net';
        const session = await stripe.billingPortal.sessions.create({
            customer: rows[0].stripe_customer_id,
            return_url: `${base}/admin`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error('Admin billing portal error:', err);
        res.status(500).json({ error: 'Failed to open billing portal' });
    }
});

// ===== ADMIN BLOG CRUD =====

app.get('/api/admin/blog', requireAdmin, async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, slug, title, excerpt, author, category, published_at, read_time_minutes, is_published
         FROM blog_posts ORDER BY published_at DESC`
    );
    res.json(rows);
});

app.post('/api/admin/blog', requireAdmin, async (req, res) => {
    try {
        const { slug, title, excerpt, author, category, state_code, city_slug, published_at, read_time_minutes, content, is_published } = req.body;
        if (!slug || !title || !content) return res.status(400).json({ error: 'slug, title, and content are required' });
        const { rows } = await pool.query(
            `INSERT INTO blog_posts (slug, title, excerpt, author, category, state_code, city_slug, published_at, read_time_minutes, content, is_published)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [slug, title, excerpt || null, author || 'RealtorFinder Editorial Team',
             category || null, state_code || null, city_slug || null,
             published_at || new Date(), read_time_minutes || 5, content, is_published !== false]
        );
        res.json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A post with this slug already exists' });
        res.status(500).json({ error: 'Failed to create post' });
    }
});

app.put('/api/admin/blog/:id', requireAdmin, async (req, res) => {
    try {
        const { title, excerpt, author, category, state_code, city_slug, published_at, read_time_minutes, content, is_published } = req.body;
        const { rows } = await pool.query(
            `UPDATE blog_posts SET title=COALESCE($1,title), excerpt=COALESCE($2,excerpt),
             author=COALESCE($3,author), category=COALESCE($4,category), state_code=COALESCE($5,state_code),
             city_slug=COALESCE($6,city_slug), published_at=COALESCE($7,published_at),
             read_time_minutes=COALESCE($8,read_time_minutes), content=COALESCE($9,content),
             is_published=COALESCE($10,is_published), updated_at=NOW()
             WHERE id=$11 RETURNING *`,
            [title, excerpt, author, category, state_code, city_slug, published_at, read_time_minutes, content, is_published, req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Post not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update post' });
    }
});

app.delete('/api/admin/blog/:id', requireAdmin, async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM blog_posts WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true });
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
                pool.query(`SELECT AVG(rating)::numeric(3,1) AS avg FROM realtor_reviews WHERE realtor_id=$1`, [m.id]),
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
            `SELECT l.id, l.address, l.city, l.state, l.zip, l.price,
                    l.property_type, l.bedrooms, l.bathrooms, l.sqft,
                    l.description, l.image_urls, l.share_token
             FROM listings l
             WHERE l.share_token = $1 AND l.status != 'inactive' AND l.deleted_at IS NULL`,
            [req.params.token]
        );
        if (!rows.length) return res.redirect('/');
        const l = rows[0];
        pool.query(`UPDATE listings SET share_views = COALESCE(share_views, 0) + 1 WHERE id = $1`, [l.id]).catch(() => {});
        const base = (process.env.FRONTEND_URL || 'https://realtorfinder.net').replace(/\/$/, '');
        // he() is defined at module scope
        const title = `${he(l.address)}${l.city ? ', ' + he(l.city) : ''} — RealtorFinder`;
        const priceStr = l.price ? '$' + Number(l.price).toLocaleString() : null;
        const desc = [priceStr, l.bedrooms ? l.bedrooms + ' bed' : null, l.bathrooms ? l.bathrooms + ' bath' : null, l.sqft ? Number(l.sqft).toLocaleString() + ' sqft' : null].filter(Boolean).join(' · ');
        const img = Array.isArray(l.image_urls) && l.image_urls[0] ? l.image_urls[0] : `${base}/og-default.png`;
        const shareUrl = `${base}/s/${l.share_token}`;
        const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${he(desc)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${he(desc)}">
<meta property="og:image" content="${he(img)}">
<meta property="og:url" content="${he(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600;700;900&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#f8fafc;color:#0A2540;min-height:100vh}
.nav{background:#0A2540;padding:1rem 2rem;display:flex;align-items:center;justify-content:space-between}
.nav-logo{color:white;font-family:'Crimson Pro',serif;font-size:1.5rem;font-weight:700;text-decoration:none}
.nav-cta{background:#FF6B35;color:white;padding:0.5rem 1.25rem;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.9rem}
.hero-img{width:100%;max-height:480px;object-fit:cover;display:block}
.hero-img-placeholder{width:100%;height:300px;background:linear-gradient(135deg,#0A2540,#1a3a6b);display:flex;align-items:center;justify-content:center;font-size:4rem}
.container{max-width:760px;margin:0 auto;padding:2rem 1.5rem}
.address{font-family:'Crimson Pro',serif;font-size:2rem;font-weight:700;margin-bottom:0.5rem;line-height:1.2}
.location{color:#6b7280;font-size:1rem;margin-bottom:1.5rem}
.price{font-size:1.75rem;font-weight:700;color:#FF6B35;margin-bottom:1.5rem;font-family:'Crimson Pro',serif}
.details{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1.5rem}
.detail{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:0.75rem 1.25rem;text-align:center}
.detail-val{font-size:1.25rem;font-weight:700;color:#0A2540;display:block}
.detail-lbl{font-size:0.8rem;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em}
.desc{color:#374151;line-height:1.75;margin-bottom:2rem;font-size:0.975rem}
.cta-card{background:#0A2540;border-radius:16px;padding:2rem;text-align:center;margin-bottom:2rem}
.cta-card h2{font-family:'Crimson Pro',serif;font-size:1.75rem;font-weight:700;color:white;margin-bottom:0.75rem}
.cta-card p{color:#93c5fd;margin-bottom:1.5rem;font-size:0.95rem}
.cta-btn{display:inline-block;background:#FF6B35;color:white;padding:0.9rem 2rem;border-radius:10px;font-weight:700;font-size:1rem;text-decoration:none;margin-bottom:0.75rem}
.cta-sub{color:#93c5fd;font-size:0.85rem}
.footer{text-align:center;padding:2rem;color:#9ca3af;font-size:0.85rem}
.footer a{color:#9ca3af}
@media(max-width:600px){.address{font-size:1.5rem}.details{gap:0.75rem}}
</style></head><body>
<nav class="nav">
  <a href="/" class="nav-logo">RealtorFinder</a>
  <a href="/login?tab=signup&type=seller" class="nav-cta">List My Home Free</a>
</nav>
${Array.isArray(l.image_urls) && l.image_urls[0]
    ? `<img class="hero-img" src="${he(l.image_urls[0])}" alt="${he(l.address)}" loading="lazy">`
    : `<div class="hero-img-placeholder">🏡</div>`}
<div class="container">
  <div class="address">${he(l.address) || 'Property Listing'}</div>
  <div class="location">${[l.city, l.state, l.zip].filter(Boolean).map(he).join(', ')}</div>
  ${l.price ? `<div class="price">$${Number(l.price).toLocaleString()}</div>` : ''}
  <div class="details">
    ${l.bedrooms ? `<div class="detail"><span class="detail-val">${he(l.bedrooms)}</span><span class="detail-lbl">Beds</span></div>` : ''}
    ${l.bathrooms ? `<div class="detail"><span class="detail-val">${he(l.bathrooms)}</span><span class="detail-lbl">Baths</span></div>` : ''}
    ${l.sqft ? `<div class="detail"><span class="detail-val">${Number(l.sqft).toLocaleString()}</span><span class="detail-lbl">Sq ft</span></div>` : ''}
    ${l.property_type ? `<div class="detail"><span class="detail-val">${he(l.property_type)}</span><span class="detail-lbl">Type</span></div>` : ''}
  </div>
  ${l.description ? `<div class="desc">${he(l.description)}</div>` : ''}
  <div class="cta-card">
    <h2>Are you looking to sell your home?</h2>
    <p>Post your home for free on RealtorFinder and let top local realtors compete for your listing — no obligation.</p>
    <a href="/login?tab=signup&type=seller" class="cta-btn">List My Home Free →</a><br>
    <span class="cta-sub">Free to list · No commitment · Cancel anytime</span>
  </div>
  <a href="/listing/${l.id}" style="display:block;text-align:center;color:#6b7280;font-size:0.9rem;margin-bottom:2rem;">View full listing details →</a>
</div>
<div class="footer"><p>Shared via <a href="/">RealtorFinder</a> — where sellers post free and realtors compete</p></div>
</body></html>`;
        res.send(html);
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

// Waitlist unsubscribe
app.get('/waitlist/unsubscribe', async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.send(`<!DOCTYPE html><html><head><title>Unsubscribe — RealtorFinder</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;"><h2>Unsubscribe from Waitlist</h2><p>If you joined our waitlist and want to be removed, email us at <a href="mailto:privacy@realtorfinder.net">privacy@realtorfinder.net</a>.</p></body></html>`);
    }
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM waitlist WHERE unsubscribe_token = $1`,
            [token]
        );
        if (!rowCount) {
            return res.send(`<!DOCTYPE html><html><head><title>Unsubscribed — RealtorFinder</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;"><h2>Already Removed</h2><p>This email address was not found on our waitlist, or has already been removed.</p><p><a href="/">Return home</a></p></body></html>`);
        }
        res.send(`<!DOCTYPE html><html><head><title>Unsubscribed — RealtorFinder</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;"><h2>You've been removed</h2><p>You've been successfully removed from the RealtorFinder waitlist. You won't receive any more emails from us.</p><p><a href="/">Return home</a></p></body></html>`);
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

// Pretty slug URL — resolve to numeric id and redirect
app.get('/agent/:slug', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id FROM users WHERE profile_slug = $1 AND user_type = 'realtor' LIMIT 1`,
            [req.params.slug]
        );
        if (!rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
        res.redirect(301, `/realtor/${rows[0].id}`);
    } catch (err) {
        res.redirect('/realtor-directory');
    }
});

// Public platform stats (waitlist count + realtor count)
app.get('/api/stats/public', async (req, res) => {
    try {
        const [wl, rl] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS count FROM waitlist`),
            pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE user_type = 'realtor' AND is_active IS NOT FALSE`)
        ]);
        res.json({ waitlistCount: wl.rows[0].count, realtorCount: rl.rows[0].count });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
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
app.get('/login', async (req, res) => {
    if (req.session && req.session.userId) {
        // Re-check approval from DB — session value goes stale if admin approves while user is logged in
        try {
            const { rows } = await pool.query(`SELECT is_approved, user_type FROM users WHERE id = $1`, [req.session.userId]);
            if (rows.length) {
                req.session.isApproved = rows[0].is_approved;
                req.session.userType = rows[0].user_type;
            }
        } catch (_) {}
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

app.get('/find-agent', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'find-agent.html'));
});

app.get('/sellers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sellers.html'));
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
        res.cookie('ab_variant', variant, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
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

// SEO: Realtor city landing pages — /realtors/tampa-fl, /realtors/austin-tx, etc.
app.get('/realtors/:citystate', async (req, res, next) => {
    const slug = req.params.citystate;
    // Must match pattern: word(s)-with-hyphens-XX (last 2 chars are state code)
    const match = slug.match(/^(.+)-([a-z]{2})$/);
    if (!match) return next();
    const stateCode = match[2].toUpperCase();
    const citySlug = match[1];
    const cityName = citySlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    try {
        // Get realtors in this city/state
        const { rows: realtors } = await pool.query(
            `SELECT id, first_name, last_name, company_name, subscription_plan, license_verified,
                    years_experience, bio, zip_code, profile_photo,
                    (SELECT ROUND(AVG(rating)::numeric, 1) FROM realtor_reviews WHERE realtor_id = users.id) as avg_rating,
                    (SELECT COUNT(*) FROM realtor_reviews WHERE realtor_id = users.id) as review_count,
                    (SELECT COUNT(*) FROM proposals WHERE realtor_id = users.id AND status = 'accepted') as wins
             FROM users
             WHERE user_type = 'realtor'
               AND is_approved = true
               AND is_active IS NOT FALSE
               AND (
                   service_areas ILIKE $1
                   OR zip_code IN (SELECT zip FROM zip_codes WHERE city ILIKE $2 AND state_code = $3 LIMIT 20)
               )
             ORDER BY
                 CASE WHEN subscription_plan IN ('professional','firm') THEN 0 ELSE 1 END,
                 wins DESC NULLS LAST,
                 avg_rating DESC NULLS LAST
             LIMIT 30`,
            [`%${cityName}%`, cityName, stateCode]
        );

        // Get active listing count for this area
        const { rows: listingCount } = await pool.query(
            `SELECT COUNT(*) as cnt FROM listings WHERE status = 'active' AND deleted_at IS NULL AND (city ILIKE $1 OR state ILIKE $2)`,
            [cityName, stateCode]
        );
        const activeListings = parseInt(listingCount[0]?.cnt || 0);

        const realtorCards = realtors.map(r => {
            const initials = ((r.first_name || '')[0] || '') + ((r.last_name || '')[0] || '');
            const name = he(`${r.first_name || ''} ${r.last_name || ''}`.trim());
            const isFeatured = ['professional', 'firm'].includes(r.subscription_plan);
            const stars = r.avg_rating ? '★'.repeat(Math.round(parseFloat(r.avg_rating))) + '☆'.repeat(5 - Math.round(parseFloat(r.avg_rating))) : '';
            const bioText = r.bio ? he(r.bio.slice(0, 100)) + (r.bio.length > 100 ? '…' : '') : '';
            return `
            <a href="/realtor/${r.id}" class="agent-card">
                <div class="agent-avatar">${r.profile_photo ? `<img src="${he(r.profile_photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : he(initials.toUpperCase())}</div>
                <div class="agent-info">
                    <div class="agent-name">${name}${isFeatured ? ' <span class="featured-badge">⭐ Featured</span>' : ''}</div>
                    ${r.company_name ? `<div class="agent-co">${he(r.company_name)}</div>` : ''}
                    ${r.avg_rating && r.review_count > 0 ? `<div class="agent-rating"><span style="color:#F59E0B;">${stars}</span> ${parseFloat(r.avg_rating).toFixed(1)} (${r.review_count})</div>` : ''}
                    ${r.years_experience ? `<div class="agent-meta">${he(r.years_experience)} yrs experience${r.wins > 0 ? ` · ${r.wins} listings won` : ''}</div>` : (r.wins > 0 ? `<div class="agent-meta">${r.wins} listings won</div>` : '')}
                    ${r.bio ? `<div class="agent-bio">${bioText}</div>` : ''}
                </div>
                <div class="agent-cta">View Profile →</div>
            </a>`;
        }).join('');

        const emptyState = realtors.length === 0 ? `
            <div style="text-align:center;padding:4rem 2rem;color:#6B7280;">
                <div style="font-size:3rem;margin-bottom:1rem;">🏡</div>
                <h3 style="font-size:1.4rem;font-weight:700;color:#0A2540;margin-bottom:0.5rem;">No agents listed yet in ${cityName}, ${stateCode}</h3>
                <p style="margin-bottom:2rem;">Be the first to set up your profile in this market.</p>
                <a href="/login?tab=signup&type=realtor" style="background:#FF6B35;color:white;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.95rem;">Join as a Realtor →</a>
            </div>` : '';

        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Top Realtors in ${cityName}, ${stateCode} | RealtorFinder</title>
<meta name="description" content="Find and compare top real estate agents in ${cityName}, ${stateCode}. Sellers list free, realtors compete for your listing on RealtorFinder.">
<link rel="canonical" href="https://www.realtorfinder.net/realtors/${slug}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@600;700;900&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>
<style>
:root{--primary:#0A2540;--accent:#FF6B35;--soft-bg:#F8F6F3;--border:#E5E1DB;--muted:#6B7280;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'DM Sans',sans-serif;background:var(--soft-bg);color:var(--primary);}
nav{background:var(--primary);padding:0 2rem;display:flex;align-items:center;justify-content:space-between;height:64px;position:sticky;top:0;z-index:100;}
.nav-logo{font-family:'Crimson Pro',serif;font-size:1.6rem;font-weight:900;color:white;text-decoration:none;}
.nav-logo span{color:var(--accent);}
.nav-links{display:flex;gap:1.5rem;align-items:center;}
.nav-links a{color:rgba(255,255,255,0.8);text-decoration:none;font-size:0.9rem;}
.nav-links a:hover{color:white;}
.nav-cta{background:var(--accent);color:white!important;padding:8px 18px;border-radius:8px;font-weight:600!important;}
.hero{background:var(--primary);color:white;padding:4rem 2rem 3rem;text-align:center;}
.hero-label{font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--accent);margin-bottom:0.75rem;}
.hero h1{font-family:'Crimson Pro',serif;font-size:clamp(2rem,4vw,3rem);font-weight:900;margin-bottom:1rem;line-height:1.1;}
.hero p{color:rgba(255,255,255,0.7);font-size:1.05rem;max-width:520px;margin:0 auto 1.75rem;}
.hero-stats{display:flex;gap:2rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem;}
.hero-stat{text-align:center;}
.hero-stat-val{font-family:'Crimson Pro',serif;font-size:2rem;font-weight:900;color:white;}
.hero-stat-label{font-size:0.8rem;color:rgba(255,255,255,0.55);margin-top:0.1rem;}
.content{max-width:900px;margin:0 auto;padding:3rem 2rem 5rem;}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem;}
.section-header h2{font-family:'Crimson Pro',serif;font-size:1.75rem;font-weight:900;}
.agent-card{display:grid;grid-template-columns:56px 1fr auto;gap:1.25rem;align-items:center;background:white;border:1px solid var(--border);border-radius:16px;padding:1.25rem 1.5rem;margin-bottom:1rem;text-decoration:none;color:var(--primary);transition:box-shadow 0.2s,transform 0.2s;}
.agent-card:hover{box-shadow:0 4px 24px rgba(0,0,0,0.08);transform:translateY(-1px);}
.agent-avatar{width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#1a4a7a);display:flex;align-items:center;justify-content:center;font-family:'Crimson Pro',serif;font-size:1.3rem;font-weight:900;color:white;flex-shrink:0;overflow:hidden;}
.agent-name{font-weight:700;font-size:1rem;margin-bottom:0.15rem;}
.featured-badge{background:#FFF0EB;color:var(--accent);font-size:0.72rem;padding:2px 8px;border-radius:20px;font-weight:600;margin-left:6px;}
.agent-co{font-size:0.85rem;color:var(--muted);}
.agent-rating{font-size:0.85rem;color:var(--muted);margin-top:0.2rem;}
.agent-meta{font-size:0.8rem;color:var(--muted);margin-top:0.15rem;}
.agent-bio{font-size:0.85rem;color:#555;margin-top:0.3rem;line-height:1.5;}
.agent-cta{font-size:0.85rem;font-weight:600;color:var(--accent);white-space:nowrap;padding-left:0.5rem;}
.cta-box{background:var(--accent);color:white;border-radius:16px;padding:2.5rem;text-align:center;margin-top:3rem;}
.cta-box h2{font-family:'Crimson Pro',serif;font-size:1.75rem;font-weight:900;margin-bottom:0.75rem;}
.cta-box p{opacity:0.9;margin-bottom:1.5rem;}
.cta-btn{background:white;color:var(--accent);padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;display:inline-block;font-size:0.95rem;}
.breadcrumb{font-size:0.85rem;color:rgba(255,255,255,0.55);margin-bottom:1.25rem;}
.breadcrumb a{color:rgba(255,255,255,0.6);text-decoration:none;}
.breadcrumb a:hover{color:white;}
footer{background:var(--primary);color:rgba(255,255,255,0.5);text-align:center;padding:2rem;font-size:0.875rem;}
footer a{color:rgba(255,255,255,0.6);text-decoration:none;margin:0 0.75rem;}
footer a:hover{color:white;}
@media(max-width:640px){.agent-card{grid-template-columns:48px 1fr;}.agent-cta{display:none;}.nav-links{display:none;}}
</style>
</head>
<body>
<nav>
  <a href="/" class="nav-logo">Realtor<span>Finder</span></a>
  <div class="nav-links">
    <a href="/sellers">For Sellers</a>
    <a href="/realtors">For Realtors</a>
    <a href="/pricing">Pricing</a>
    <a href="/login?tab=signup" class="nav-cta">Get Started</a>
  </div>
</nav>
<div class="hero">
  <div class="breadcrumb"><a href="/">Home</a> › <a href="/locations">Markets</a> › ${cityName}, ${stateCode}</div>
  <div class="hero-label">Local Agents</div>
  <h1>Top Realtors in ${cityName}, ${stateCode}</h1>
  <p>Verified agents serving ${cityName} and surrounding areas. List your home free and let them compete for your listing.</p>
  ${realtors.length > 0 || activeListings > 0 ? `
  <div class="hero-stats">
    ${realtors.length > 0 ? `<div class="hero-stat"><div class="hero-stat-val">${realtors.length}</div><div class="hero-stat-label">Active agents</div></div>` : ''}
    ${activeListings > 0 ? `<div class="hero-stat"><div class="hero-stat-val">${activeListings}</div><div class="hero-stat-label">Active listings</div></div>` : ''}
  </div>` : ''}
</div>
<div class="content">
  ${realtors.length > 0 ? `
  <div class="section-header">
    <h2>Agents in ${cityName}, ${stateCode}</h2>
    <a href="/login?tab=signup" style="background:var(--accent);color:white;padding:8px 18px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.9rem;">List My Home Free →</a>
  </div>
  ${realtorCards}` : emptyState}
  <div class="cta-box">
    <h2>Sell your home in ${cityName}</h2>
    <p>Post your listing free and receive competing proposals from local agents. Compare commissions and credentials before you choose.</p>
    <a href="/login?tab=signup" class="cta-btn">List My Home Free →</a>
  </div>
</div>
<footer>
  <p>&copy; 2026 RealtorFinder.net &nbsp;·&nbsp;
    <a href="/">Home</a><a href="/sellers">For Sellers</a><a href="/realtors">For Realtors</a><a href="/pricing">Pricing</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a>
  </p>
</footer>
</body>
</html>`);
    } catch(err) {
        console.error('City realtor page error:', err.message);
        next();
    }
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
app.get('/fair-housing', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'fair-housing.html'));
});
app.get('/features', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'features.html'));
});
app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});
app.get('/about-sellers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about-sellers.html'));
});

// ── Blog Seed ─────────────────────────────────────────────────────────────────

async function seedBlogPosts() {
    try {
        const { rows } = await pool.query(`SELECT COUNT(*) FROM blog_posts`);
        if (parseInt(rows[0].count) > 0) return;
        const posts = [
            {
                slug: 'how-to-find-the-best-real-estate-agent-to-sell-your-home',
                title: 'How to Find the Best Real Estate Agent to Sell Your Home',
                excerpt: 'Choosing the right listing agent can mean thousands of dollars in your pocket. Here\'s exactly what to look for — and what most sellers miss.',
                category: 'Seller Guides',
                read_time_minutes: 7,
                content: `<p>Selling your home is one of the largest financial transactions you'll ever make. The listing agent you hire will negotiate on your behalf, market your property, and guide you through a complex process — so choosing the right one matters more than most sellers realize.</p>

<h2>1. Interview at Least Three Agents</h2>
<p>Most sellers hire the first agent they meet. That's a mistake. Interview at least three agents, and ask each the same questions so you can compare answers directly. Pay attention not just to what they say, but how they say it — confidence, market knowledge, and honesty about your home's realistic price are all signals.</p>

<h2>2. Ask for a Comparative Market Analysis (CMA)</h2>
<p>Any serious listing agent should provide a free CMA — a detailed analysis of what similar homes have sold for in your neighborhood over the last 90 days. If an agent prices your home significantly higher than the comps to "win" your listing, that's a red flag. Overpriced listings sit on the market and eventually sell for less than if they'd been priced correctly from the start.</p>

<h2>3. Understand Their Marketing Plan</h2>
<p>Professional photography is table stakes. Ask what else they do: Do they use video or 3D tours? Do they run paid advertising on Zillow, social media, or Google? How many active buyers are in their network? The best agents treat each listing as a marketing campaign, not just an MLS entry.</p>

<h2>4. Check Actual Sales Data, Not Just Reviews</h2>
<p>Anyone can collect five-star reviews from friends. What matters is verifiable production: How many homes did this agent sell in the last 12 months? What was the average days-on-market? What was the average sale price vs. list price ratio? Agents with strong numbers are proud to share them.</p>

<h2>5. Understand the Commission Structure</h2>
<p>Following the August 2024 NAR settlement, commission structures are more negotiable than ever. Listing agent commissions typically range from 2–3%. Some discount brokers charge less but provide less service. Ask exactly what you're getting at each price point and make sure the agreement is in writing before you sign anything.</p>

<h2>6. Use a Platform Where Agents Compete for Your Business</h2>
<p>The traditional model has sellers calling agents one by one. Reverse marketplaces like RealtorFinder flip the dynamic: you post your home details once and qualified agents in your area send you their proposals — commission rates, marketing plans, and credentials — so you can compare side by side. It's free for sellers and dramatically reduces the time it takes to find the right agent.</p>

<h2>Bottom Line</h2>
<p>The best real estate agent for your home is the one who can demonstrate a consistent track record, has a concrete marketing plan, prices your home based on data not flattery, and communicates clearly. Take your time, ask hard questions, and don't be afraid to walk away if something feels off.</p>`
            },
            {
                slug: 'what-to-look-for-in-a-buyers-agent',
                title: "What to Look for in a Buyer's Agent: A Complete Guide",
                excerpt: "A good buyer's agent can save you tens of thousands of dollars and months of stress. Here's how to find one who actually works for you.",
                category: "Buyer Guides",
                read_time_minutes: 6,
                content: `<p>In a competitive housing market, a great buyer's agent isn't a luxury — it's a strategic advantage. They know about listings before they hit Zillow, can write winning offers, and will tell you when a deal isn't worth pursuing. Here's what to look for.</p>

<h2>Local Market Expertise</h2>
<p>Real estate is hyper-local. An agent who dominates in one suburb may have limited knowledge in the next town over. Ask how many buyers they've represented in your specific target area in the last year. Look for someone who can tell you which neighborhoods are appreciating, where the schools are rated highest, and which streets to avoid — without looking anything up.</p>

<h2>Responsiveness and Availability</h2>
<p>Good homes in popular markets sell in days or even hours. You need an agent who will get you into a showing the same day it lists and can submit an offer quickly when you're ready. Ask them directly: "If I call you at 7pm on a Tuesday because I want to see a house, what happens?" Their answer tells you a lot.</p>

<h2>Strong Negotiation Track Record</h2>
<p>In a hot market, winning an offer isn't just about price — it's about terms. An experienced agent knows which sellers care about a quick close vs. a leaseback, when to include an escalation clause, and how to make your offer stand out without overpaying. Ask for examples of deals where their negotiation strategy made a real difference.</p>

<h2>Fiduciary Duty</h2>
<p>Your buyer's agent is legally obligated to act in your best interest. That means they should tell you when a home is overpriced, flag red flags in an inspection report, and advise you to walk away from a bad deal — even if it means they don't earn a commission. If an agent is pushing you to make an offer you're not comfortable with, that's a warning sign.</p>

<h2>Understanding the New Commission Rules</h2>
<p>Following the August 2024 NAR settlement, buyer's agent compensation is no longer automatically built into seller offers through the MLS. Before you start touring homes, you'll sign a buyer representation agreement that specifies your agent's compensation. This can be structured different ways — a flat fee, a percentage, or a rate that the seller may or may not agree to cover. Discuss this clearly upfront so there are no surprises at closing.</p>

<h2>How to Find One</h2>
<p>Platforms like RealtorFinder let you post your buyer criteria — budget, location, home type — and receive competing proposals from licensed buyer's agents in your area. You can compare their experience, approach, and proposed compensation before committing to any interviews. It's free for buyers and takes 5 minutes.</p>`
            },
            {
                slug: 'how-real-estate-commissions-work-2024',
                title: 'How Real Estate Agent Commissions Work in 2024 (After the NAR Settlement)',
                excerpt: 'The August 2024 NAR settlement changed how agent commissions work. Here\'s exactly what changed, what it means for buyers and sellers, and how to navigate the new rules.',
                category: 'Market Insights',
                read_time_minutes: 8,
                content: `<p>The real estate industry went through its biggest structural change in decades in August 2024, when a landmark settlement with the National Association of Realtors took effect. If you're buying or selling a home, here's what you need to know.</p>

<h2>What Was the Old System?</h2>
<p>Under the old model, home sellers typically paid a combined commission of 5–6% at closing — split between the listing agent and the buyer's agent. The buyer's agent commission was advertised in the MLS, effectively requiring all sellers to offer buyer-agent compensation as a condition of listing. Critics argued this made commissions artificially high and non-negotiable.</p>

<h2>What Changed in August 2024?</h2>
<p>Following the settlement, MLS platforms can no longer advertise or require sellers to offer buyer-agent compensation. Key changes:</p>
<ul>
<li><strong>Buyer representation agreements are now required</strong> before a buyer's agent can show homes. This written agreement must specify exactly how the agent will be compensated.</li>
<li><strong>Buyer's agent compensation is now negotiated separately</strong> between the buyer and their agent — not bundled into the seller's MLS listing.</li>
<li><strong>Sellers can still offer to cover buyer-agent fees</strong> as a concession, but it must be negotiated as part of the offer, not listed in the MLS.</li>
</ul>

<h2>What Does This Mean for Sellers?</h2>
<p>You now have more flexibility on what you pay. You can offer to cover the buyer's agent fee as part of negotiations, or you can leave it entirely to the buyer. Many sellers still choose to offer buyer-agent compensation because it broadens the pool of potential buyers who can afford to purchase. Your listing agent should walk you through the tradeoffs for your specific market and price point.</p>

<h2>What Does This Mean for Buyers?</h2>
<p>Before touring homes, you'll need to sign a buyer representation agreement. This document specifies how your agent gets paid — typically 2–3% of the purchase price. In practice, many sellers still offer to cover this cost, but you should be prepared in case they don't. Discuss compensation structure clearly with any buyer's agent before you begin your search.</p>

<h2>How to Navigate the New Rules</h2>
<p>The best approach is to treat agent compensation the same way you treat any other negotiation: with information and options. Comparing proposals from multiple agents — including their proposed compensation structures — is now more important than ever. Platforms like RealtorFinder make this easy by letting you receive competing proposals from agents so you can compare terms side by side.</p>`
            },
            {
                slug: 'questions-to-ask-before-hiring-a-listing-agent',
                title: '12 Questions to Ask Before Hiring a Listing Agent',
                excerpt: "Most sellers don't ask nearly enough questions before signing a listing agreement. These 12 questions will separate the great agents from the average ones.",
                category: 'Seller Guides',
                read_time_minutes: 5,
                content: `<p>Signing a listing agreement is a significant commitment — typically 3 to 6 months exclusive with one agent. Before you sign, get answers to these 12 questions.</p>

<h2>1. How many homes have you sold in this ZIP code in the last 12 months?</h2>
<p>Local expertise is everything. An agent who has sold 10+ homes in your specific neighborhood will know the comps, the buyer pool, and the local quirks better than anyone.</p>

<h2>2. What's your average days-on-market?</h2>
<p>A low days-on-market number combined with a high sale-to-list-price ratio is the gold standard. Ask for both figures for their listings in the last year.</p>

<h2>3. What is your list-to-sale price ratio?</h2>
<p>Strong agents consistently sell homes at or above asking price. Anything above 98% in a normal market is solid. Below 95% is a red flag.</p>

<h2>4. What's your marketing plan for my home?</h2>
<p>The answer should go well beyond "we'll list it on the MLS." Look for professional photography, video tours, social media campaigns, email blasts to active buyers, and open house strategy.</p>

<h2>5. Who takes the listing photos?</h2>
<p>Professional real estate photography is non-negotiable in today's market. If an agent plans to use their phone camera, that tells you something about their standards.</p>

<h2>6. How will you price my home?</h2>
<p>You want a data-driven answer: recent comparable sales, current competition, market trend direction. Be cautious of agents who quote a number without showing you the data behind it.</p>

<h2>7. What's your commission and what does it include?</h2>
<p>Get a complete breakdown in writing. What services are included? What happens if you find your own buyer? What are the terms if you need to cancel?</p>

<h2>8. How will you communicate with me?</h2>
<p>Weekly updates minimum. Ask what channel they use (email, text, phone) and how quickly they respond. Poor communication is the #1 complaint sellers have about their agents.</p>

<h2>9. Will you personally handle my listing or hand it off?</h2>
<p>Some top-producing agents assign your listing to a junior team member. Know upfront who your actual point of contact will be.</p>

<h2>10. What will you tell me that I don't want to hear?</h2>
<p>Great agents give honest advice even when it's uncomfortable — whether that's a price reduction, a staging issue, or walking away from a deal. Ask for an example from a past client.</p>

<h2>11. Do you have references I can speak with directly?</h2>
<p>Any agent worth hiring should be able to give you 3–4 recent seller references. Call them.</p>

<h2>12. Why should I list with you over the other agents I'm considering?</h2>
<p>This final question cuts through the pitch. A confident, data-backed answer is a good sign. Vague generalities are not.</p>`
            },
            {
                slug: 'how-to-negotiate-real-estate-agent-commission',
                title: 'How to Negotiate Your Real Estate Agent Commission Rate',
                excerpt: "Commission rates are more negotiable than most sellers realize — especially in 2024. Here's how to have the conversation and what to expect.",
                category: 'Seller Guides',
                read_time_minutes: 5,
                content: `<p>Real estate commission rates have long been presented as standard and non-negotiable. They're not. Here's how to negotiate effectively without sacrificing service quality.</p>

<h2>Understand the Current Rate Landscape</h2>
<p>Listing agent commissions typically range from 2% to 3% of the sale price. Following the 2024 NAR settlement, buyer-agent compensation is now negotiated separately. Total transaction costs for sellers vary significantly depending on what you offer buyer agents and what you negotiate with your listing agent.</p>

<h2>Leverage Your Home's Advantages</h2>
<p>Agents are more likely to negotiate on high-value homes (the dollar value of their commission is already high), homes in fast-moving markets (less marketing effort required), and situations where you're also buying through the same agent (a two-transaction relationship). Know your leverage points before you sit down to talk.</p>

<h2>Compare Multiple Proposals</h2>
<p>The most effective negotiating tool is simply having competing offers. When agents know they're being compared against others, commission rates naturally compress and service levels rise. This is exactly what RealtorFinder is designed for — post your home details and let agents send you proposals with their actual rates and marketing plans.</p>

<h2>Ask About Tiered Commission Structures</h2>
<p>Some agents will offer a base commission with a bonus if the home sells above a target price. This aligns incentives — the agent earns more by pushing for a higher price. It's worth proposing if you're confident in your home's value.</p>

<h2>Understand What You're Trading</h2>
<p>A lower commission sometimes means reduced services: fewer marketing dollars, less agent time, or a junior team member handling your listing. Before you accept a lower rate, get specific commitments in writing about exactly what will be included. A great agent at a fair commission will outperform a mediocre agent at a discount rate every time.</p>

<h2>The Bottom Line</h2>
<p>Negotiating is normal and expected. Professional agents negotiate for a living — they won't be offended if you ask. The goal isn't the lowest possible commission; it's the best net proceeds from your sale, which means finding an agent who delivers enough value to justify their fee.</p>`
            },
            {
                slug: 'best-time-to-sell-your-house',
                title: 'When Is the Best Time to Sell Your House?',
                excerpt: "Timing your sale can mean the difference of thousands of dollars. The data on what month, season, and market conditions favor sellers — and when to wait.",
                category: 'Market Insights',
                read_time_minutes: 6,
                content: `<p>Timing a home sale perfectly is impossible — but data can tell you when conditions historically favor sellers and help you make an informed decision.</p>

<h2>The Short Answer: Late Spring</h2>
<p>Nationally, homes listed in late April through mid-June sell fastest and closest to (or above) list price. Buyers are more active, competition among sellers is still manageable, and families motivated by the school calendar want to close before summer. Homes listed in May specifically have historically sold for 1–3% more than the annual average.</p>

<h2>But Local Markets Vary Significantly</h2>
<p>National averages mean little for your specific situation. In warm-weather markets like Florida or Arizona, winter is often peak season as snowbirds and retirees look to buy. In college towns, the market moves with the academic calendar. Ask a local agent for month-by-month data on your specific ZIP code — that's what actually matters.</p>

<h2>Interest Rates and Buyer Demand</h2>
<p>The best season matters less when interest rates are high enough to sideline buyers. When rates are elevated, buyer pools shrink regardless of the calendar. Conversely, when rates drop, demand spikes across all seasons. Watch rate trends: a significant drop in the weeks before you plan to list can meaningfully change your sale outcome.</p>

<h2>Your Personal Timeline Matters More Than Timing</h2>
<p>Here's the honest truth: trying to time the market perfectly is often a losing game. Sellers who wait for ideal conditions sometimes wait too long, or sell into a worse market than if they'd acted sooner. If you need to sell — or genuinely want to — the best time is usually when you're ready, with the right agent and the right price.</p>

<h2>What You Can Control</h2>
<p>You can't control the market, but you can control your preparation. Homes that are staged, professionally photographed, competitively priced, and well-marketed sell faster and for more money in any season. Getting those elements right will have more impact than listing in April vs. September.</p>

<h2>How to Prepare Regardless of Timing</h2>
<p>Start by getting your home assessed — what needs repair, what staging changes would help, what price range is realistic based on comps. Then find a strong listing agent early so they can guide your preparation. Platforms like RealtorFinder let you receive proposals from multiple qualified agents at once, making it easy to find the right fit before you're ready to list.</p>`
            }
        ];

        for (const p of posts) {
            await pool.query(
                `INSERT INTO blog_posts (slug, title, excerpt, author, category, read_time_minutes, content, is_published, published_at)
                 VALUES ($1,$2,$3,'RealtorFinder Editorial Team',$4,$5,$6,TRUE,NOW())
                 ON CONFLICT (slug) DO NOTHING`,
                [p.slug, p.title, p.excerpt, p.category, p.read_time_minutes, p.content]
            );
        }
        console.log('✅ Blog posts seeded');
    } catch (err) {
        console.error('Blog seed error (non-fatal):', err.message);
    }
}

// ── Blog ─────────────────────────────────────────────────────────────────────

const BLOG_CATEGORIES = ['How It Works', 'Seller Guides', 'Market Reports', 'Realtor Tips'];

function blogNav(activePath) {
    return `<nav style="position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(248,249,250,0.97);backdrop-filter:blur(10px);border-bottom:1px solid #e5e7eb;height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 5%;">
        <a href="/" style="font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:900;color:#0A2540;text-decoration:none;">Realtor<span style="color:#FF6B35;">Finder</span></a>
        <div style="display:flex;align-items:center;gap:2rem;">
            <a href="/blog" style="color:#0A2540;text-decoration:none;font-weight:500;font-size:0.95rem;">Blog</a>
            <a href="/sellers" style="color:#0A2540;text-decoration:none;font-weight:500;font-size:0.95rem;">For Sellers</a>
            <a href="/realtors" style="color:#0A2540;text-decoration:none;font-weight:500;font-size:0.95rem;">For Realtors</a>
            <a href="/login?tab=signup&type=seller" style="background:#FF6B35;color:#fff;padding:10px 22px;border-radius:50px;font-weight:600;text-decoration:none;font-size:0.9rem;">List Free</a>
        </div>
    </nav>`;
}

function blogHead({ title, desc, canonical, type = 'article' }) {
    const base = (process.env.FRONTEND_URL || 'https://www.realtorfinder.net').replace(/\/$/, '');
    return `<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | RealtorFinder</title>
    <meta name="description" content="${desc}">
    <link rel="canonical" href="${canonical}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${desc}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:type" content="${type}">
    <meta property="og:site_name" content="RealtorFinder">
    <meta property="og:image" content="${base}/og-default.png">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>
    <style>
        :root{--primary:#0A2540;--accent:#FF6B35;--border:#e5e7eb;--soft-bg:#f8f9fa;}
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:'Work Sans',sans-serif;color:var(--primary);background:#fff;}
        a{color:var(--accent);}
        footer{background:var(--primary);color:rgba(255,255,255,0.6);padding:32px 5%;text-align:center;font-size:0.84rem;}
        footer a{color:rgba(255,255,255,0.6);margin:0 8px;text-decoration:none;}
        @media(max-width:768px){nav div{gap:1rem;} nav div a:not(:last-child){display:none;}}
    </style>
</head>`;
}

// Blog index
app.get('/blog', async (req, res) => {
    const base = (process.env.FRONTEND_URL || 'https://www.realtorfinder.net').replace(/\/$/, '');
    const category = req.query.category || null;
    let posts = [];
    try { posts = await db.getBlogPosts({ limit: 50, category }); } catch (e) {}

    const categoryTabs = ['All', ...BLOG_CATEGORIES].map(c => {
        const active = (!category && c === 'All') || category === c;
        const href = c === 'All' ? '/blog' : `/blog?category=${encodeURIComponent(c)}`;
        return `<a href="${href}" style="padding:8px 18px;border-radius:50px;font-size:0.88rem;font-weight:600;text-decoration:none;background:${active ? 'var(--accent)' : '#f3f4f6'};color:${active ? '#fff' : 'var(--primary)'};">${c}</a>`;
    }).join('');

    const cards = posts.map(p => {
        const date = new Date(p.published_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
        return `<a href="/blog/${p.slug}" style="display:block;background:#fff;border:1px solid var(--border);border-radius:16px;padding:28px;text-decoration:none;color:inherit;transition:box-shadow 0.2s,transform 0.2s;" onmouseover="this.style.boxShadow='0 8px 24px rgba(0,0,0,0.1)';this.style.transform='translateY(-3px)'" onmouseout="this.style.boxShadow='';this.style.transform=''">
            ${p.category ? `<div style="display:inline-block;background:#fff3ee;color:var(--accent);font-size:0.75rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;padding:4px 12px;border-radius:50px;margin-bottom:14px;">${p.category}</div>` : ''}
            <h2 style="font-family:'Playfair Display',serif;font-size:1.25rem;font-weight:700;line-height:1.4;margin-bottom:10px;">${p.title}</h2>
            <p style="color:#6b7280;font-size:0.92rem;line-height:1.6;margin-bottom:16px;">${p.excerpt || ''}</p>
            <div style="font-size:0.82rem;color:#9ca3af;">${date} &nbsp;·&nbsp; ${p.read_time_minutes} min read</div>
        </a>`;
    }).join('');

    const empty = posts.length === 0 ? '<p style="color:#6b7280;text-align:center;padding:60px 0;">No articles yet — check back soon.</p>' : '';

    res.send(`<!DOCTYPE html><html lang="en">
${blogHead({ title: 'Real Estate Market Insights & Guides', desc: 'Expert guides, market reports, and insights for home sellers and real estate agents. RealtorFinder helps you make smarter decisions.', canonical: `${base}/blog`, type: 'website' })}
<body>
${blogNav('/blog')}
<div style="padding-top:68px;">
    <div style="background:linear-gradient(135deg,var(--primary) 0%,#0d3a5c 100%);color:#fff;padding:80px 5% 60px;text-align:center;">
        <p style="font-size:0.8rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:var(--accent);margin-bottom:12px;">RealtorFinder Blog</p>
        <h1 style="font-family:'Playfair Display',serif;font-size:clamp(2rem,4vw,3rem);font-weight:900;margin-bottom:16px;">Market Insights &amp; Seller Guides</h1>
        <p style="font-size:1.1rem;opacity:0.8;max-width:560px;margin:0 auto;">Real estate advice, market reports, and guides to help you sell smarter and find the right agent.</p>
    </div>
    <div style="max-width:1100px;margin:0 auto;padding:48px 5%;">
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:40px;">${categoryTabs}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:24px;">${cards}${empty}</div>
    </div>
</div>
<footer><p>© ${new Date().getFullYear()} RealtorFinder &nbsp;·&nbsp; <a href="/">Home</a><a href="/sellers">For Sellers</a><a href="/realtors">For Realtors</a><a href="/blog">Blog</a><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></p></footer>
</body></html>`);
});

// Blog post
app.get('/blog/:slug', async (req, res) => {
    const base = (process.env.FRONTEND_URL || 'https://www.realtorfinder.net').replace(/\/$/, '');
    let post;
    try { post = await db.getBlogPost(req.params.slug); } catch (e) {}
    if (!post) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));

    let related = [];
    try { related = await db.getBlogPosts({ limit: 3, category: post.category }); } catch (e) {}
    related = related.filter(p => p.slug !== post.slug).slice(0, 3);

    const date = new Date(post.published_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const schemaOrg = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: post.title, description: post.excerpt, datePublished: post.published_at, author: { '@type': 'Organization', name: 'RealtorFinder' }, publisher: { '@type': 'Organization', name: 'RealtorFinder', url: base } });

    const relatedCards = related.map(p => `
        <a href="/blog/${p.slug}" style="display:block;background:#f8f9fa;border-radius:12px;padding:20px;text-decoration:none;color:inherit;">
            ${p.category ? `<div style="font-size:0.72rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">${p.category}</div>` : ''}
            <div style="font-family:'Playfair Display',serif;font-size:1rem;font-weight:700;line-height:1.4;">${p.title}</div>
            <div style="font-size:0.8rem;color:#9ca3af;margin-top:8px;">${p.read_time_minutes} min read</div>
        </a>`).join('');

    res.send(`<!DOCTYPE html><html lang="en">
${blogHead({ title: post.title, desc: post.excerpt || post.title, canonical: `${base}/blog/${post.slug}` })}
<head><script type="application/ld+json">${schemaOrg}</script></head>
<body>
${blogNav(`/blog/${post.slug}`)}
<div style="padding-top:68px;">
    <div style="max-width:780px;margin:0 auto;padding:56px 5% 80px;">
        <div style="margin-bottom:32px;">
            <a href="/blog" style="color:#6b7280;font-size:0.88rem;text-decoration:none;">← All articles</a>
        </div>
        ${post.category ? `<div style="display:inline-block;background:#fff3ee;color:var(--accent);font-size:0.75rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;padding:4px 12px;border-radius:50px;margin-bottom:20px;">${post.category}</div>` : ''}
        <h1 style="font-family:'Playfair Display',serif;font-size:clamp(1.8rem,3.5vw,2.6rem);font-weight:900;line-height:1.25;margin-bottom:20px;">${post.title}</h1>
        <div style="display:flex;align-items:center;gap:16px;color:#9ca3af;font-size:0.87rem;margin-bottom:40px;padding-bottom:32px;border-bottom:1px solid var(--border);">
            <span>${post.author}</span>
            <span>·</span>
            <span>${date}</span>
            <span>·</span>
            <span>${post.read_time_minutes} min read</span>
        </div>
        <div style="font-size:1.05rem;line-height:1.8;color:#1f2937;" class="blog-content">${post.content}</div>
        <div style="margin-top:56px;padding:32px;background:#f8f9fa;border-radius:16px;text-align:center;">
            <p style="font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:700;margin-bottom:12px;">Ready to sell smarter?</p>
            <p style="color:#6b7280;margin-bottom:24px;">List your home free and let licensed realtors compete for your listing.</p>
            <a href="/login?tab=signup&type=seller" style="display:inline-block;background:var(--accent);color:#fff;padding:14px 32px;border-radius:50px;font-weight:600;text-decoration:none;font-size:1rem;">List Your Home Free</a>
        </div>
        ${related.length ? `<div style="margin-top:56px;"><h3 style="font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:700;margin-bottom:20px;">More articles</h3><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;">${relatedCards}</div></div>` : ''}
    </div>
</div>
<style>
    .blog-content h2{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:700;margin:2em 0 0.8em;}
    .blog-content h3{font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:700;margin:1.6em 0 0.6em;}
    .blog-content p{margin-bottom:1.2em;}
    .blog-content ul,ol{margin:0 0 1.2em 1.5em;}
    .blog-content li{margin-bottom:0.4em;}
    .blog-content a{color:var(--accent);}
</style>
<footer><p>© ${new Date().getFullYear()} RealtorFinder &nbsp;·&nbsp; <a href="/">Home</a><a href="/sellers">For Sellers</a><a href="/realtors">For Realtors</a><a href="/blog">Blog</a><a href="/contact">Contact</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></p></footer>
</body></html>`);
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

app.get('/admin-waitlist', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-waitlist.html'));
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
// 404 catch-all — must be before the error handler
app.use((req, res) => {
    if (req.accepts('html')) {
        return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    }
    res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Shared sleep helper for staggering bulk email sends
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Listing expiry job — runs every 24 hours
async function runListingExpiryJob() {
    try {
        // Warn listings 3 days before expiry (uses expires_at when set, else created_at + 90 days)
        const toWarn = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.created_at, l.expires_at,
                    u.email, u.first_name
             FROM listings l JOIN users u ON u.id = l.user_id
             WHERE l.status IN ('active','pending')
               AND l.deleted_at IS NULL
               AND l.expiry_warning_sent = FALSE
               AND COALESCE(l.expires_at, l.created_at + INTERVAL '90 days') <= NOW() + INTERVAL '7 days'
               AND COALESCE(l.expires_at, l.created_at + INTERVAL '90 days') > NOW()
               AND NOT EXISTS (SELECT 1 FROM offers WHERE listing_id = l.id AND status = 'accepted')`
        );
        for (const l of toWarn.rows) {
            await emailService.sendListingExpiryWarning(l.email, l.first_name, l).catch(() => {});
            await pool.query(`UPDATE listings SET expiry_warning_sent = TRUE WHERE id = $1`, [l.id]);
            await sleep(300);
        }

        // Archive listings past their expiry
        const toArchive = await pool.query(
            `SELECT l.id, l.address, l.city, l.state, l.created_at, l.expires_at,
                    u.email, u.first_name
             FROM listings l JOIN users u ON u.id = l.user_id
             WHERE l.status IN ('active','pending')
               AND l.deleted_at IS NULL
               AND COALESCE(l.expires_at, l.created_at + INTERVAL '90 days') <= NOW()
               AND NOT EXISTS (SELECT 1 FROM offers WHERE listing_id = l.id AND status = 'accepted')`
        );
        for (const l of toArchive.rows) {
            await pool.query(`UPDATE listings SET status = 'expired' WHERE id = $1`, [l.id]);
            await emailService.sendListingExpired(l.email, l.first_name, l).catch(() => {});
            await sleep(300);
        }

        if (toWarn.rows.length || toArchive.rows.length) {
            console.log(`📋 Expiry job: warned ${toWarn.rows.length}, archived ${toArchive.rows.length}`);
        }
    } catch(err) {
        console.error('Listing expiry job error:', err.message);
    }
}
_schemaMigrations.push(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_unsubscribed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE`,
    `ALTER TABLE lead_purchases ADD COLUMN IF NOT EXISTS listing_id INTEGER REFERENCES listings(id)`,
    `ALTER TABLE lead_purchases ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE lead_purchases ALTER COLUMN buyer_request_id DROP NOT NULL`,
    `DO $$ BEGIN ALTER TABLE lead_purchases ADD CONSTRAINT lead_purchases_realtor_listing UNIQUE(realtor_id, listing_id); EXCEPTION WHEN others THEN NULL; END $$`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_credits_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS seller_viewed_at TIMESTAMPTZ`
);

_schemaMigrations.push(
    `CREATE TABLE IF NOT EXISTS realtor_reviews (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER REFERENCES users(id),
        seller_id INTEGER REFERENCES users(id),
        listing_id INTEGER REFERENCES listings(id),
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        body TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(seller_id, listing_id)
    )`,
    `CREATE TABLE IF NOT EXISTS saved_searches (
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
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_credits INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_founding_member BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS founding_credit_applied BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium_profile BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_profile_expires TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_banner_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_video_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS re_engagement_sent_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_slug TEXT UNIQUE`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS nurture_sent BOOLEAN DEFAULT FALSE`
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
        // Realtors only send after approval; sellers/buyers send based on signup date
        const baseWhere = `u.is_active IS NOT FALSE AND u.email_unsubscribed IS NOT TRUE
            AND (u.user_type != 'realtor' OR u.is_approved = TRUE)`;

        // Step 1: 1+ day after signup, no step 1 sent yet
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
            await sleep(300);
        }

        // Step 2: 3+ days after signup, step 1 sent
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
            await sleep(300);
        }

        // Step 3: 7+ days after signup, step 2 sent
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
            await sleep(300);
        }

        const total = step1Users.length + step2Users.length + step3Users.length;
        if (total) console.log(`Drip job: sent ${total} emails`);
    } catch(e) { console.error('Drip job error:', e.message); }
}

// Run every 6 hours

async function runListingAlertJob() {
    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const { rows: searches } = await pool.query(
            `SELECT ss.*, u.email, u.first_name, u.unsubscribe_token
             FROM saved_searches ss
             JOIN users u ON u.id = ss.user_id
             WHERE u.is_active IS NOT FALSE AND u.email_unsubscribed IS NOT TRUE`
        );
        let sent = 0;
        for (const s of searches) {
            try {
                const conditions = [`l.status = 'active'`, `l.deleted_at IS NULL`, `l.created_at >= $1`];
                const params = [since];
                let pi = 2;
                if (s.city) { conditions.push(`LOWER(l.city) = LOWER($${pi++})`); params.push(s.city); }
                if (s.zip)  { conditions.push(`l.zip = $${pi++}`); params.push(s.zip); }
                if (s.type) { conditions.push(`l.property_type = $${pi++}`); params.push(s.type); }
                if (s.min_price) { conditions.push(`l.price >= $${pi++}`); params.push(parseFloat(s.min_price)); }
                if (s.max_price) { conditions.push(`l.price <= $${pi++}`); params.push(parseFloat(s.max_price)); }
                if (s.min_beds)  { conditions.push(`l.bedrooms >= $${pi++}`); params.push(parseInt(s.min_beds)); }
                const { rows: matches } = await pool.query(
                    `SELECT id, address, city, state, price, bedrooms, bathrooms FROM listings l
                     WHERE ${conditions.join(' AND ')} LIMIT 5`, params
                );
                if (matches.length) {
                    await emailService.sendListingAlert(s.email, s.first_name, s.label || 'Your saved search', matches);
                    sent++;
                    await sleep(300);
                }
            } catch(e) { console.error('Listing alert error:', e.message); }
        }
        if (sent) console.log(`Listing alert job: sent ${sent} emails`);
    } catch(e) { console.error('Listing alert job error:', e.message); }
}

async function runWeeklyDigestJob() {
    const now = new Date();
    if (now.getDay() !== 0) return; // Sunday only
    try {
        const { rows: realtors } = await pool.query(
            `SELECT id, email, first_name, service_areas, unsubscribe_token
             FROM users
             WHERE user_type = 'realtor'
               AND is_active IS NOT FALSE
               AND is_approved = TRUE
               AND email_unsubscribed IS NOT TRUE
               AND notif_weekly_digest IS NOT FALSE`
        );
        for (const r of realtors) {
            try {
                const token = r.unsubscribe_token || await ensureUnsubscribeToken(r.id);
                const serviceTerms = (r.service_areas || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
                let newListings = [], newListingCount = 0;
                if (serviceTerms.length) {
                    const conds = serviceTerms.map((_,i) => `(LOWER(l.city) LIKE LOWER($${i+1}) OR l.zip = $${i+1})`);
                    const params = serviceTerms.map(t => `%${t}%`);
                    const { rows } = await pool.query(
                        `SELECT l.id, l.address, l.city, l.state, l.price, l.bedrooms, l.bathrooms
                         FROM listings l
                         WHERE l.status='active' AND l.deleted_at IS NULL
                           AND l.created_at >= NOW() - INTERVAL '7 days'
                           AND (${conds.join(' OR ')})
                         LIMIT 10`, params
                    );
                    newListings = rows;
                    newListingCount = rows.length;
                }
                const [viewsRow, winsRow] = await Promise.all([
                    pool.query(`SELECT COUNT(*) AS cnt FROM profile_views WHERE realtor_id=$1 AND viewed_at >= NOW()-INTERVAL '7 days'`, [r.id]),
                    pool.query(`SELECT COUNT(*) AS cnt FROM proposals WHERE realtor_id=$1 AND status='accepted' AND updated_at >= NOW()-INTERVAL '7 days'`, [r.id]),
                ]);
                await emailService.sendWeeklyDigest(r.email, r.first_name, {
                    newListings, newListingCount,
                    profileViews7d: parseInt(viewsRow.rows[0].cnt),
                    proposalsWon: parseInt(winsRow.rows[0].cnt),
                    serviceAreas: (r.service_areas || '').split(',').slice(0,3).join(', ') || '—',
                }, token);
                await sleep(300);
            } catch(e) { console.error(`Weekly digest error for ${r.email}:`, e.message); }
        }
        console.log(`Weekly digest job: sent to ${realtors.length} realtors`);
    } catch(e) { console.error('Weekly digest job error:', e.message); }
}
// Check every hour; actually sends only on Sundays

// Seller engagement reminder job — nudges sellers who have unreviewed proposals 5+ days old
async function runEngagementReminderJob() {
    try {
        const { rows } = await pool.query(
            `SELECT DISTINCT l.id, l.address, l.city, l.state,
                    u.email, u.first_name, u.id as seller_id,
                    COUNT(p.id) AS proposal_count
             FROM listings l
             JOIN users u ON u.id = l.user_id
             JOIN proposals p ON p.listing_id = l.id
             WHERE l.status IN ('active','pending')
               AND l.deleted_at IS NULL
               AND p.status = 'pending'
               AND p.created_at <= NOW() - INTERVAL '5 days'
               AND NOT EXISTS (
                   SELECT 1 FROM proposals p2
                   WHERE p2.listing_id = l.id
                     AND p2.status IN ('accepted','declined')
               )
               AND NOT EXISTS (
                   SELECT 1 FROM notifications n
                   WHERE n.user_id = u.id
                     AND n.type = 'engagement_reminder'
                     AND n.body LIKE '%' || l.address || '%'
                     AND n.created_at >= NOW() - INTERVAL '7 days'
               )
             GROUP BY l.id, l.address, l.city, l.state, u.email, u.first_name, u.id`
        );
        for (const row of rows) {
            emailService.sendProposalNudge && emailService.sendProposalNudge(
                row.email, row.first_name, row.address, parseInt(row.proposal_count)
            ).catch(() => {});
            pool.query(
                `INSERT INTO notifications (user_id, type, title, body, link)
                 VALUES ($1, 'engagement_reminder', 'You have proposals waiting!', $2, '/dashboard/seller')`,
                [row.seller_id, `${row.address} — ${row.proposal_count} proposal(s) waiting for review`]
            ).catch(() => {});
        }
        if (rows.length > 0) console.log(`📬 Engagement: nudged ${rows.length} sellers`);
    } catch(err) {
        console.error('Engagement reminder job error:', err.message);
    }
}
_schemaMigrations.push(
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS review_request_sent BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_new_proposal BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_messages BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS attachments TEXT[] DEFAULT '{}'`,
    `CREATE TABLE IF NOT EXISTS realtor_showing_requests (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        proposed_slots JSONB NOT NULL DEFAULT '[]',
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        confirmed_slot TEXT,
        responded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        listing_id INTEGER NOT NULL REFERENCES listings(id),
        realtor_id INTEGER NOT NULL REFERENCES users(id),
        proposal_id INTEGER REFERENCES proposals(id),
        status TEXT NOT NULL DEFAULT 'active',
        sale_price NUMERIC(12,2),
        close_date DATE,
        notes TEXT,
        referral_fee_due NUMERIC(10,2),
        referral_fee_paid BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_weekly_digest BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_listing_alerts BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_engagement_reminders BOOLEAN NOT NULL DEFAULT TRUE`,
    // Expand waitlist user_type to include 'buyer'
    `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'waitlist_user_type_check') THEN
            ALTER TABLE waitlist DROP CONSTRAINT waitlist_user_type_check;
            ALTER TABLE waitlist ADD CONSTRAINT waitlist_user_type_check CHECK (user_type IN ('seller','realtor','buyer'));
        END IF;
     END $$`,
    `CREATE TABLE IF NOT EXISTS proposal_templates (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`
);

// Missing tables discovered during audit — add here so existing DBs are patched automatically
_schemaMigrations.push(
    `CREATE TABLE IF NOT EXISTS saved_listings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, listing_id)
    )`,
    `CREATE TABLE IF NOT EXISTS zip_codes (
        zip VARCHAR(10) PRIMARY KEY,
        city VARCHAR(100),
        state_code VARCHAR(2),
        latitude NUMERIC(9,6),
        longitude NUMERIC(9,6)
    )`,
    `CREATE TABLE IF NOT EXISTS city_leads (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20),
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        city_slug VARCHAR(100),
        city_name VARCHAR(100),
        state_code VARCHAR(2),
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS admin_notes (
        id SERIAL PRIMARY KEY,
        resource_type VARCHAR(50),
        resource_id INTEGER,
        admin_user_id INTEGER REFERENCES users(id),
        body TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS lead_matches (
        id SERIAL PRIMARY KEY,
        realtor_id INTEGER REFERENCES users(id),
        city_lead_id INTEGER REFERENCES city_leads(id),
        status VARCHAR(50) DEFAULT 'new',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS realtor_prospects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        source VARCHAR(100),
        city_slug VARCHAR(100),
        status VARCHAR(50) DEFAULT 'new',
        converted_user_id INTEGER REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS city_pages (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(100) UNIQUE NOT NULL,
        city_name VARCHAR(100),
        state_code VARCHAR(2),
        custom_headline TEXT,
        custom_description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS company_locations (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(50),
        zip VARCHAR(10),
        latitude NUMERIC(9,6),
        longitude NUMERIC(9,6),
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`
);

_schemaMigrations.push(
    `CREATE TABLE IF NOT EXISTS blog_posts (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(200) UNIQUE NOT NULL,
        title TEXT NOT NULL,
        excerpt TEXT,
        author VARCHAR(100) DEFAULT 'RealtorFinder Editorial Team',
        category VARCHAR(100),
        state_code VARCHAR(2),
        city_slug VARCHAR(100),
        published_at TIMESTAMPTZ DEFAULT NOW(),
        read_time_minutes INTEGER DEFAULT 5,
        content TEXT,
        is_published BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
);

// Review request job — emails sellers to review their accepted realtor 3 days after acceptance
async function runReviewRequestJob() {
    try {
        const { rows } = await pool.query(
            `SELECT p.id, p.listing_id, p.realtor_id,
                    l.address, l.city, l.state,
                    u.email as seller_email, u.first_name as seller_first,
                    r.first_name as realtor_first, r.last_name as realtor_last
             FROM proposals p
             JOIN listings l ON l.id = p.listing_id
             JOIN users u ON u.id = l.user_id
             JOIN users r ON r.id = p.realtor_id
             WHERE p.status = 'accepted'
               AND p.review_request_sent IS NOT TRUE
               AND p.updated_at <= NOW() - INTERVAL '3 days'`
        );
        for (const row of rows) {
            const addr = [row.address, row.city, row.state].filter(Boolean).join(', ');
            const realtorName = `${row.realtor_first || ''} ${row.realtor_last || ''}`.trim();
            await emailService.sendReviewRequestEmail(
                row.seller_email, row.seller_first,
                row.realtor_id, realtorName, addr
            ).catch(() => {});
            await pool.query(`UPDATE proposals SET review_request_sent = TRUE WHERE id = $1`, [row.id]);
        }
        if (rows.length > 0) console.log(`📧 Review requests: sent ${rows.length}`);
    } catch(err) {
        console.error('Review request job error:', err.message);
    }
}

// Re-engagement job — emails realtors/sellers inactive for 14+ days
async function runReEngagementJob() {
    try {
        const { rows } = await pool.query(
            `SELECT id, email, first_name, user_type FROM users
             WHERE is_active = TRUE
               AND email_unsubscribed IS NOT TRUE
               AND (last_login_at IS NULL OR last_login_at < NOW() - INTERVAL '14 days')
               AND (re_engagement_sent_at IS NULL OR re_engagement_sent_at < NOW() - INTERVAL '30 days')
               AND created_at < NOW() - INTERVAL '7 days'
             LIMIT 50`
        );
        for (const user of rows) {
            try {
                await emailService.sendReEngagementEmail(user.email, user.first_name, user.user_type);
                await pool.query(`UPDATE users SET re_engagement_sent_at = NOW() WHERE id = $1`, [user.id]);
                await sleep(300);
            } catch (e) { /* non-critical per user */ }
        }
        if (rows.length > 0) console.log(`📧 Re-engagement: sent to ${rows.length} users`);
    } catch (err) {
        console.error('Re-engagement job error:', err.message);
    }
}

// Seller performance digest job — weekly summary for sellers with active listings
async function runSellerDigestJob() {
    const now = new Date();
    // Only run on Mondays
    if (now.getDay() !== 1) return;
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.email, u.first_name,
                    COUNT(DISTINCT l.id) AS listing_count,
                    COUNT(DISTINCT p.id) AS proposal_count,
                    COUNT(DISTINCT lp.id) AS lead_count
             FROM users u
             JOIN listings l ON l.user_id = u.id AND l.status = 'active'
             LEFT JOIN proposals p ON p.listing_id = l.id AND p.created_at > NOW() - INTERVAL '7 days'
             LEFT JOIN lead_purchases lp ON lp.listing_id = l.id AND lp.created_at > NOW() - INTERVAL '7 days'
             WHERE u.user_type = 'seller' AND u.is_active = TRUE AND u.email_unsubscribed IS NOT TRUE
             GROUP BY u.id, u.email, u.first_name
             HAVING COUNT(DISTINCT l.id) > 0`
        );
        for (const seller of rows) {
            try {
                await emailService.sendListingPerformanceDigest(
                    seller.email, seller.first_name,
                    parseInt(seller.listing_count),
                    parseInt(seller.proposal_count),
                    parseInt(seller.lead_count)
                );
                await sleep(300);
            } catch (e) { /* non-critical per user */ }
        }
        if (rows.length > 0) console.log(`📧 Seller digest: sent to ${rows.length} sellers`);
    } catch (err) {
        console.error('Seller digest job error:', err.message);
    }
}
// Waitlist nurture — one follow-up email to waitlist-only users at day 7
async function runWaitlistNurtureJob() {
    try {
        const { rows } = await pool.query(`
            SELECT w.email, w.user_type
            FROM waitlist w
            WHERE w.nurture_sent = FALSE
              AND w.created_at < NOW() - INTERVAL '7 days'
              AND NOT EXISTS (
                  SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(w.email)
              )
            LIMIT 50
        `);
        for (const w of rows) {
            try {
                await emailService.sendWaitlistNurture(w.email, w.user_type);
                await pool.query(`UPDATE waitlist SET nurture_sent = TRUE WHERE email = $1`, [w.email]);
                await new Promise(r => setTimeout(r, 300));
            } catch(e) { console.error('Waitlist nurture error:', e.message); }
        }
        if (rows.length) console.log(`Waitlist nurture: sent ${rows.length} emails`);
    } catch(e) { console.error('Waitlist nurture job error:', e.message); }
}

_schemaMigrations.push(
    `ALTER TABLE buyer_requests ADD COLUMN IF NOT EXISTS selected_realtor_id INTEGER REFERENCES users(id)`
);

_schemaMigrations.push(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent_at TIMESTAMPTZ`,
    `ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT UNIQUE`
);

// Backfill profile_slug for any realtors created before the column was added
async function backfillProfileSlugs() {
    try {
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name FROM users WHERE user_type = 'realtor' AND profile_slug IS NULL`
        );
        for (const u of rows) {
            const slug = `${u.first_name}-${u.last_name}-${u.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
            await pool.query(`UPDATE users SET profile_slug = $1 WHERE id = $2`, [slug, u.id])
                .catch(() => {}); // ignore conflicts
        }
        if (rows.length) console.log(`✅ Backfilled profile slugs for ${rows.length} realtors`);
    } catch (err) {
        console.error('Profile slug backfill error:', err.message);
    }
}

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
    await backfillProfileSlugs();
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

        // Seed blog posts if table is empty
        await seedBlogPosts();

        // Schedule background jobs — run after migrations so tables exist
        runListingExpiryJob();
        setInterval(runListingExpiryJob, 24 * 60 * 60 * 1000).unref();
        runDripEmailJob();
        setInterval(runDripEmailJob, 6 * 60 * 60 * 1000).unref();
        runWaitlistNurtureJob();
        setInterval(runWaitlistNurtureJob, 6 * 60 * 60 * 1000).unref();
        runListingAlertJob();
        setInterval(runListingAlertJob, 24 * 60 * 60 * 1000).unref();
        runWeeklyDigestJob();
        setInterval(runWeeklyDigestJob, 60 * 60 * 1000).unref();
        runEngagementReminderJob();
        setInterval(runEngagementReminderJob, 24 * 60 * 60 * 1000).unref();
        runReviewRequestJob();
        setInterval(runReviewRequestJob, 12 * 60 * 60 * 1000).unref();
        runReEngagementJob();
        setInterval(runReEngagementJob, 24 * 60 * 60 * 1000).unref();
        runSellerDigestJob();
        setInterval(runSellerDigestJob, 24 * 60 * 60 * 1000).unref();
    });
}
startServer().catch(err => {
    console.error('Server startup failed:', err);
    process.exit(1);
});
