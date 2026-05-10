// server.js - Production-ready Express backend with database
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
require('dotenv').config();
const https = require('https');
const { upload, uploadToCloudinary } = require('./config/cloudinary');

const { db, pool } = require('./db');
const emailService = require('./email');
const auth = require('./auth');

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
        const { email, password, userType, firstName, lastName, zipCode } = req.body;
        
        if (!email || !password || !userType || !firstName || !lastName || !zipCode) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        if (!['seller', 'realtor'].includes(userType)) {
            return res.status(400).json({ error: 'Invalid user type' });
        }
        
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        
        const user = await auth.createUser(email, password, userType, firstName, lastName, zipCode);
        
        // Create session
        req.session.userId = user.id;
        req.session.userType = user.user_type;
        req.session.firstName = user.first_name;
        req.session.lastName = user.last_name;
        req.session.zipCode = user.zip_code;
        
        res.json({
            success: true,
            userId: user.id,
            email: user.email,
            userType: user.user_type,
            firstName: user.first_name,
            lastName: user.last_name,
            zipCode: user.zip_code
        });
    } catch (error) {
        console.error('Signup error:', error);
        if (error.message === 'Email already registered') {
            return res.status(400).json({ error: 'Email already registered' });
        }
        res.status(500).json({ error: 'Failed to create account' });
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
                zipCode: user.zipCode
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
        zipCode: req.user.zip_code
    });
});

// ===== LISTINGS ROUTES =====

// Get all listings
app.get('/api/listings', async (req, res) => {
    try {
        let listings;
        
        // If user is logged in and is a seller, show only their listings
        if (req.user && req.user.user_type === 'seller') {
            listings = await db.getUserListings(req.user.id);
        } else {
            // Realtors and public users see all listings
            listings = await db.getAllListings();
        }
        
        const formattedListings = listings.map(listing => ({
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
            offerCount: listing.offer_count,
            userId: listing.user_id
        }));
        res.json(formattedListings);
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ===== PAGE ROUTES (Must come AFTER API routes, BEFORE static files) =====

// Login page
app.get('/login', (req, res) => {
    // If already logged in, redirect to dashboard
    if (req.session && req.session.userId) {
        const dashboardPath = req.session.userType === 'seller' ? '/dashboard/seller' : '/dashboard/realtor';
        return res.redirect(dashboardPath);
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Seller landing page (homepage)
app.get('/', (req, res) => {
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
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    if (req.session.userType !== 'seller') {
        return res.redirect('/dashboard/realtor');
    }
    res.sendFile(path.join(__dirname, 'public', 'seller-dashboard.html'));
});

// Realtor Dashboard (PROTECTED)
app.get('/dashboard/realtor', (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    if (req.session.userType !== 'realtor') {
        return res.redirect('/dashboard/seller');
    }
    res.sendFile(path.join(__dirname, 'public', 'realtor-dashboard.html'));
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
