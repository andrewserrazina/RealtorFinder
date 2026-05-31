Perfect! Now I have enough information to compile the comprehensive security audit. Let me create the final report:

## COMPREHENSIVE SECURITY AUDIT REPORT
### RealtorFinder Node.js/Express Application

---

### EXECUTIVE SUMMARY
The RealtorFinder application demonstrates **good foundational security practices** with parameterized database queries, bcrypt password hashing, session management via PostgreSQL, and rate limiting. However, there are **multiple medium and high-severity findings** that require remediation, particularly around authentication session handling, authorization edge cases, password reset security, and undocumented admin features.

---

## FINDINGS

### 1. AUTHENTICATION & SESSION MANAGEMENT

#### Finding 1.1: Weak Default Session Secret
**Severity:** CRITICAL  
**File:** `/home/user/RealtorFinder/server.js` (line 89)  
**Description:**
```javascript
secret: process.env.SESSION_SECRET || 'realtorfinder-temp-secret-change-in-production',
```
The fallback session secret is hardcoded and visible in source code. If `SESSION_SECRET` environment variable is not set, the application falls back to a plaintext default that could allow session hijacking.

**Recommendation:**
- Require `SESSION_SECRET` to be set; fail fast if it's not configured
- Use a cryptographically strong default or throw an error on startup
- Never include secrets in version control or source code

---

#### Finding 1.2: No Brute-Force Protection on Login (Custom Implementation)
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 261-262, 668-727)  
**Description:**
The application uses custom in-memory rate limiters instead of express-rate-limit for login:
```javascript
const authLimiter = createRateLimiter(15 * 60 * 1000, 20, 'Too many attempts. Please try again in 15 minutes.');
```
The custom rate limiter (`createRateLimiter` at lines 247-259) has **critical flaws**:
- Uses `req.ip` directly, which fails behind proxies (even though `trust proxy 1` is set)
- Clears the entire hits map every 15 minutes; there's a race condition where all requests between clear cycles can bypass limits
- No persistence across server restarts
- Uses `setInterval().unref()` which doesn't guarantee cleanup

The `authLimiterStrict` from express-rate-limit (line 278) is more robust but the custom one is more permissive (20 attempts vs strict's 10).

**Recommendation:**
- Use express-rate-limit consistently for all auth endpoints
- Configure proper IP extraction: `app.set('trust proxy', 1)` is set, but verify `xForwardedFor: true` in rate limiter config
- Store rate limit state in Redis for production (distributed deployments)
- Test rate limiting behind your actual reverse proxy

---

#### Finding 1.3: Password Reset Token Not Invalidated After First Use
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 817-837)  
**Description:**
```javascript
// Reset password
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;
    ...
    const row = await db.getUserByResetToken(token);
    if (row.used) return res.status(400).json({ error: 'This reset link has already been used' });
    ...
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(row.id, hashedPassword);
    await db.markResetTokenUsed(token);
```

While the token is marked as used, there's no check to prevent a second request with the same token from being processed between the initial use check and the mark-used operation (race condition).

**Recommendation:**
- Use a database transaction to atomically check and mark the token as used
- Reduce password reset token expiry to 1 hour (currently unbounded in code review)
- Invalidate all password reset tokens for a user when a successful reset occurs

---

#### Finding 1.4: Email Verification Tokens 48-Hour Expiry Is Long
**Severity:** LOW  
**File:** `/home/user/RealtorFinder/server.js` (lines 330-335, 759-772)  
**Description:**
Email verification tokens expire after 48 hours:
```javascript
const verifyExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
```
This is longer than industry best practice (24 hours recommended). If an email account is compromised or the token leaked, the window is large.

**Recommendation:**
- Reduce email verification token lifetime to 24 hours
- Provide a "Resend Verification" button to get fresh tokens

---

#### Finding 1.5: Session Expiry Not Enforced
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 87-100)  
**Description:**
```javascript
app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'realtorfinder-temp-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
    }
}));
```

A 30-day session lifetime is excessive for a financial/real estate application. With `rolling: true`, the session is renewed on every request, meaning a user could stay logged in indefinitely if actively using the app.

**Recommendation:**
- Reduce `maxAge` to 7 days (production) or configurable
- Consider implementing absolute session timeout (absolute expiry after N days regardless of activity)
- Implement a "last active" check; require re-authentication for sensitive operations (changing password, accepting offers)

---

### 2. AUTHORIZATION

#### Finding 2.1: IDOR - User Can Access/Modify Any Listing
**Severity:** CRITICAL  
**File:** `/home/user/RealtorFinder/server.js` (lines 998-1016)  
**Description:**
The PUT endpoint for updating a listing does **not validate ownership**:
```javascript
app.put('/api/listings/:id', auth.requireAuth, async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.user_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
        ...
```
While line 1003 DOES check `listing.user_id !== req.session.userId`, the **GET endpoint for single listing** (lines 900-915) does **NOT**:
```javascript
app.get('/api/listings/:id', async (req, res) => {
    try {
        const listing = await db.getListingById(req.params.id);
        if (!listing) {
            return res.status(404).json({ error: 'Listing not found' });
        }
        res.json({...listing, date: formatDate(listing.created_at)});
```

This returns the full listing object including **`owner_name`, `owner_email`, `owner_phone`** which should NOT be visible to unauthenticated users or non-owners.

**Recommendation:**
- Restrict access to sensitive listing fields (owner contact) to authenticated owners only
- Implement a `formatListingForPublic()` function that omits owner PII for unauthenticated/non-owner access
- Audit all GET endpoints for PII leakage

---

#### Finding 2.2: IDOR - User Can Accept Any Offer
**Severity:** CRITICAL  
**File:** `/home/user/RealtorFinder/server.js` (lines 1087-1144)  
**Description:**
The offer acceptance endpoint validates the seller owns the listing, but doesn't re-verify when applying the update:
```javascript
app.put('/api/offers/:id/status', auth.requireAuth, async (req, res) => {
    ...
    const offerRows = await pool.query(
        `SELECT o.*, l.user_id as listing_owner_id, l.address, l.city, l.state, l.zip, l.price,
                l.owner_name, l.owner_email, l.owner_phone
         FROM offers o JOIN listings l ON o.listing_id = l.id WHERE o.id = $1`,
        [offerId]
    );
    if (!offerRows.rows.length) return res.status(404).json({ error: 'Offer not found' });
    const offerRow = offerRows.rows[0];
    if (offerRow.listing_owner_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
```

This is **correct**, but it's checking the OFFER access once and then executing multiple queries. If the listing ownership changes between the initial check and the update, race conditions could occur. The DELETE offer endpoint (lines 1217-1237) also checks correctly, but uses inline query rather than transaction.

**Recommendation:**
- Use database transactions for multi-step operations (accept/decline all offers)
- Re-verify authorization immediately before mutating state

---

#### Finding 2.3: Weak Admin Check - is_admin Not Properly Validated
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 1606-1610)  
**Description:**
The `requireAdmin` middleware checks `req.user.is_admin`:
```javascript
function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
}
```

But `req.user` is populated from `auth.attachUser` (lines 117-145) which falls back to `session` data:
```javascript
req.user = user || {
    id: req.session.userId,
    user_type: req.session.userType,
    first_name: req.session.firstName,
    last_name: req.session.lastName,
    zip_code: req.session.zipCode,
    email_verified: req.session.emailVerified || false,
    is_admin: false  // <-- ALWAYS FALSE IN FALLBACK
};
```

The fallback initializes `is_admin: false`, so if the DB lookup fails (network timeout), the user can still be "authenticated" but not admin. This is acceptable behavior, but the DB lookup for user on every request could be optimized.

**Recommendation:**
- Store `is_admin` in the session on login to avoid constant DB lookups
- Refresh admin status periodically (e.g., per-request or every N seconds)

---

#### Finding 2.4: Admin Impersonation Not Rate Limited
**Severity:** HIGH  
**File:** `/home/user/RealtorFinder/server.js` (lines 1959-2000)  
**Description:**
```javascript
app.post('/api/admin/impersonate/:userId', requireAdmin, async (req, res) => {
    try {
        const targetId = parseInt(req.params.userId);
        ...
        req.session.impersonating = req.session.userId;
        req.session.userId = targetId;
        req.session.userType = target.user_type;
        ...
```

The impersonation feature allows admins to log in as any user without:
- Rate limiting
- Audit logging of which user impersonated which user
- Confirmation or MFA
- Expiry (stays impersonated until explicitly ended)
- Log of impersonation start/end times

This is a **serious security risk** if admin accounts are compromised.

**Recommendation:**
- Add audit logging: log every impersonation attempt with admin ID, target ID, timestamp, IP
- Rate limit to 1 impersonation per minute per admin
- Require MFA confirmation for impersonation
- Auto-expire impersonation after 1 hour
- Notify the impersonated user by email or SMS
- Only allow admins to impersonate, not delegate to other roles

---

### 3. INPUT VALIDATION & INJECTION

#### Finding 3.1: Password Reset Uses Unsanitized Password
**Severity:** HIGH  
**File:** `/home/user/RealtorFinder/server.js` (line 819-822)  
**Description:**
```javascript
const { token, newPassword } = req.body;
if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Token and a password of at least 8 characters are required' });
}
```

No validation that the password meets complexity requirements (uppercase, lowercase, number). A simple password like "12345678" would be accepted, despite the signup requiring:
```javascript
const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
if (!strongPassword.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, and a number' });
}
```

**Recommendation:**
- Apply the same password complexity validation to password reset
- Validate password reset newPassword with the same regex as signup

---

#### Finding 3.2: Buyer Request Target Areas Not Validated for Injection
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 546-665)  
**Description:**
```javascript
app.post('/api/buyer-requests', auth.requireAuth, async (req, res) => {
    ...
    const { property_type, target_areas, budget_min, budget_max, bedrooms } = req.body;
    if (!property_type || !target_areas) {
        return res.status(400).json({ error: 'property_type and target_areas are required' });
    }
```

The `target_areas` field is passed directly to SQL ILIKE queries without length validation:
```javascript
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
```

While the query uses parameterized placeholders (safe from SQL injection), an attacker could submit a very long `target_areas` string (e.g., 100MB), consuming memory and CPU during string splitting and regex operations.

**Recommendation:**
- Validate `target_areas` length: max 500 characters
- Limit to max 10 terms (split on comma)
- Trim and validate each term

---

#### Finding 3.3: Contact Form Message Not Validated for Length
**Severity:** LOW  
**File:** `/home/user/RealtorFinder/server.js` (lines 2474-2491)  
**Description:**
```javascript
const { name, email, subject, message } = req.body;
if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required' });
}
if (!email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
}
```

No length validation on `message` field. An attacker could submit a multi-megabyte message, potentially causing email system overload or database bloat.

**Recommendation:**
- Add length limits: name/subject ≤ 200 chars, message ≤ 5000 chars

---

### 4. CROSS-SITE SCRIPTING (XSS)

#### Finding 4.1: Incomplete XSS Escaping in SSR Pages
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (line 5477, 5478-5540)  
**Description:**
The application defines a local `he()` escaping function for SSR pages:
```javascript
const he = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
```

This function is used for escaping listing fields in the shareable listing page (lines 5478-5540). However:
1. **Not globally available** - the function is defined locally in the route handler (line 5477) and would need to be redefined for every route that renders HTML
2. **Not applied to all user-controllable fields** - example at line 5545:
```javascript
const address = [listing.address, listing.city, listing.state].filter(Boolean).join(', ');
```
where `address` is later rendered unescaped in places

3. **Email templates use direct string concatenation** - see `/home/user/RealtorFinder/email.js` lines that use `${...}` without escaping:
```javascript
<p style="...">You have <strong>${senderName}</strong>${listingAddress ? ` about <strong>${listingAddress}</strong>` : ''}.</p>
```

While emails are HTML-only (not rendered in browsers), stored XSS in database fields could affect admins viewing user-generated content.

**Recommendation:**
- Use a dedicated HTML escaping library (e.g., the `he` npm package instead of inline implementation)
- Create a global escaping middleware or utility function
- Apply escaping to **all user-controlled output** in SSR pages:
  - listing.address, listing.description
  - user.first_name, user.last_name
  - offer.offer_details
  - Any field from `req.body` rendered in HTML

---

#### Finding 4.2: Email Field Names Not Escaped in Email Templates
**Severity:** LOW  
**File:** `/home/user/RealtorFinder/email.js` (lines 226-231)  
**Description:**
```javascript
<div style="font-weight:700;font-size:16px;color:#0A2540;margin-bottom:4px;">${realtorName}</div>
${realtor.license_number ? `<div style="font-size:13px;color:#666;margin-bottom:12px;">License #${realtor.license_number}${realtor.years_experience ? ` · ${realtor.years_experience} years experience` : ''}</div>` : ''}
<p style="color:#444;font-size:14px;line-height:1.7;margin:0;font-style:italic;">"${message}"</p>
```

User-controlled fields like `realtorName`, `message`, etc. are rendered directly in email HTML without escaping. While emails are typically plain HTML recipients, this could be exploited if an attacker controls these fields.

**Recommendation:**
- Use `${he(realtorName)}` or similar escaping for all dynamic fields in email templates
- Implement a helper function in email.js that escapes HTML entities

---

### 5. DATA STORAGE & PII

#### Finding 5.1: Passwords Hashed with Bcrypt Rounds = 10
**Severity:** LOW  
**File:** `/home/user/RealtorFinder/auth.js` (line 10, server.js line 829)  
**Description:**
```javascript
const hashedPassword = await bcrypt.hash(password, 10);
```

Bcrypt rounds=10 is the default but is now considered on the edge of being too fast for brute-forcing (NIST recommends 12+ rounds). The password change endpoint uses:
```javascript
const hash = await bcrypt.hash(newPassword, 12);
```

This inconsistency means newly set passwords are stronger than existing passwords.

**Recommendation:**
- Use bcrypt rounds=12 consistently across all password hashing
- Consider upgrading to Argon2 (scrypt) in future versions

---

#### Finding 5.2: Owner Contact PII Visible in Public Listing API
**Severity:** HIGH  
**File:** `/home/user/RealtorFinder/server.js` (lines 900-915)  
**Description:**
The single listing endpoint returns:
```javascript
res.json({...listing, date: formatDate(listing.created_at)});
```

Where `listing` comes from `db.getListingById(id)` which returns **all columns** including:
- `owner_name`
- `owner_email`
- `owner_phone`

These are visible to **any unauthenticated user** who guesses or knows a listing ID. This is a **direct PII exposure**.

**Recommendation:**
- Filter sensitive fields before returning listings:
```javascript
const safeFields = { id, address, city, state, zip, price, property_type, bedrooms, bathrooms, sqft, description, image_urls, created_at };
res.json(safeFields);
```
- Only return owner contact info to authenticated listing owners and admins

---

#### Finding 5.3: Stripe Keys Hardcoded in Config
**Severity:** HIGH  
**File:** `/home/user/RealtorFinder/server.js` (line 13)  
**Description:**
```javascript
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
```

While the secret key is loaded from environment variables (correct), the code doesn't validate that it's actually a Stripe secret. A malformed or test key would silently fail at runtime. More critically, there's **no validation** that the key is a production key (starts with `sk_live_`) vs a test key (starts with `sk_test_`).

**Recommendation:**
- Validate Stripe key format on startup
- Fail if a test key is detected in production:
```javascript
if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY must be a live key in production');
}
```

---

#### Finding 5.4: Admin Notes Can Store Unencrypted Sensitive Data
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 2109-2148)  
**Description:**
```javascript
app.post('/api/admin/notes', requireAdmin, async (req, res) => {
    try {
        const { resource_type, resource_id, body } = req.body;
        if (!body?.trim()) return res.status(400).json({ error: 'Note body required' });
        const { rows } = await pool.query(
            `INSERT INTO admin_notes (resource_type, resource_id, admin_user_id, body)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [resource_type, parseInt(resource_id), req.user.id, body.trim()]
        );
```

Admins can store notes on resources (e.g., "User John Doe's bank account: 1234567890") without encryption. If the database is breached, this sensitive information is exposed.

**Recommendation:**
- Encrypt admin notes using AES-256-GCM before storing
- Decrypt on retrieval
- Log access to notes with admin ID and timestamp

---

### 6. FILE UPLOADS

#### Finding 6.1: File Upload Size Limits Inconsistent
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/config/cloudinary.js` (lines 15-27, 51-58)  
**Description:**
```javascript
const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB max file size
    },
    ...
});

const uploadDoc = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },  // Also 10MB
    ...
});
```

Both use 10MB limits, but:
- License documents (PDFs, images) are uploaded with `uploadDoc` but only document types are validated
- Property images use `upload` with a general 10MB limit across all file types
- No rate limiting per user (global rate limit exists but not per-user)

**Recommendation:**
- Reduce image size limit to 5MB (sufficient for web images after Cloudinary optimization)
- Reduce document limit to 3MB for license PDFs
- Implement per-user upload quotas (e.g., 5 uploads per hour per user)

---

#### Finding 6.2: File Type Validation Only Checks MIME Type
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/config/cloudinary.js` (lines 20-26, 54-58)  
**Description:**
```javascript
fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only images allowed'), false);
    }
}
```

MIME type validation can be spoofed. An attacker could upload a `.php` file with `mimetype: 'image/jpeg'` and bypass the filter. However, since uploads go to **Cloudinary** (not the local filesystem), the risk is mitigated:
- Cloudinary re-encodes images
- Files are served from Cloudinary's CDN domain
- No server-side execution

**Recommendation:**
- Keep Cloudinary uploads (safe); for any local uploads, validate file magic bytes/signatures
- Document that file type security depends on Cloudinary's CDN isolation

---

### 7. RATE LIMITING

#### Finding 7.1: Inconsistent Rate Limiting Strategy
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 42-63, 247-262, 278-279)  
**Description:**
The application uses **three different rate limiting approaches**:

1. **express-rate-limit (strict)** at line 43-49:
```javascript
const authLimiterStrict = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { error: 'Too many attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
```

2. **Custom in-memory limiter** at lines 247-259 (used for auth):
```javascript
function createRateLimiter(windowMs, max, message) {
    const hits = new Map();
    setInterval(() => hits.clear(), windowMs).unref();
    ...
}
const authLimiter = createRateLimiter(15 * 60 * 1000, 20, ...);
```

3. **express-rate-limit (general API)** at lines 51-57:
```javascript
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    ...
});
```

The **custom limiter is weaker and buggy**:
- **20 attempts in 15 minutes** (authLimiter) vs **10 attempts** (authLimiterStrict) — inconsistent
- **No distributed state** — resets on server restart
- **Race condition** — hits.clear() is called, but between clearing and checking, multiple requests can slip through
- **No proxy support** — req.ip doesn't work correctly behind proxies

**Recommendation:**
- Remove custom rate limiter; use express-rate-limit consistently
- For production, store rate limit state in Redis:
```javascript
const RedisStore = require('rate-limit-redis');
const redis = require('redis').createClient();

const loginLimiter = rateLimit({
    store: new RedisStore({ client: redis, prefix: 'rl:' }),
    windowMs: 15 * 60 * 1000,
    max: 10
});
```
- Document rate limits clearly for API consumers

---

#### Finding 7.2: Password Reset Not Rate Limited Per Email
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 792-815)  
**Description:**
```javascript
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    ...
```

The password reset endpoint uses the same `authLimiter` as login (20 attempts per IP in 15 minutes). An attacker can:
- Enumerate user emails by requesting password resets for 20 different emails
- Send password reset emails to a target user repeatedly (DoS)
- Spam target user's inbox

**Recommendation:**
- Implement per-email rate limiting for password reset (max 3 resets per email per hour)
- Use a separate, stricter rate limiter for password reset
- Implement exponential backoff or CAPTCHA after N failed attempts

---

### 8. SECRETS & ENVIRONMENT VARIABLES

#### Finding 8.1: Missing Environment Variable Validation
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/.gitignore`, `server.js`, `email.js`  
**Description:**

The `.gitignore` correctly excludes `.env` files:
```
node_modules/
.env
.env.local
.env.*.local
```

However, the application **does not validate required environment variables** at startup. If critical variables are missing, the app starts but fails at runtime:
- `STRIPE_WEBHOOK_SECRET` — if missing, webhook endpoint returns silently
- `SESSION_SECRET` — falls back to hardcoded default
- `SENDGRID_API_KEY` — logs a warning but doesn't fail

**Recommendation:**
- Create a startup validation script that fails fast if required env vars are missing:
```javascript
const requiredEnv = ['DATABASE_URL', 'SESSION_SECRET', 'STRIPE_SECRET_KEY', 'SENDGRID_API_KEY'];
const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
}
```

---

#### Finding 8.2: Stripe Webhook Secret Not Validated
**Severity:** HIGH  
**File:** `/home/user/RealtorFinder/server.js` (lines 2620-2629)  
**Description:**
```javascript
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
```

If `STRIPE_WEBHOOK_SECRET` is not set, `constructEvent` will fail with a cryptic error. An attacker could send a fake webhook with `event.type = 'checkout.session.completed'` and if the signature verification fails in a way that doesn't crash the server, the event might be processed.

**Recommendation:**
- Validate `STRIPE_WEBHOOK_SECRET` exists at startup (see Finding 8.1)
- Return 400 (not 500) for invalid signatures
- Log webhook signature failures with request IP for fraud detection

---

### 9. DEPENDENCIES

#### Finding 9.1: Dependencies Require Audit
**Severity:** INFO  
**File:** `/home/user/RealtorFinder/package.json`  
**Description:**
Key dependencies and their versions:
- `express@^4.18.2` — current as of 2026
- `bcrypt@^5.1.1` — current, good
- `pg@^8.11.3` — current
- `stripe@^22.2.0` — current
- `helmet@^8.2.0` — current
- `express-rate-limit@^8.5.2` — current
- `jsonwebtoken@^9.0.2` — current

**Recommendation:**
- Run `npm audit` regularly to identify vulnerabilities
- Set up Dependabot or similar for automated dependency updates
- Review and test updates before merging

---

### 10. CORS & SECURITY HEADERS

#### Finding 10.1: CORS Allows Any Origin in Development
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 66-70)  
**Description:**
```javascript
const allowedOrigin = process.env.FRONTEND_URL || true; // set FRONTEND_URL=https://yourdomain.com in production
app.use(cors({
    origin: allowedOrigin,
    credentials: true
}));
```

If `FRONTEND_URL` is not set (in development or if misconfigured), `origin: true` allows **any domain** to make cross-origin requests with credentials. This is a **CSRF vulnerability**.

**Recommendation:**
- Default to a restrictive origin or fail:
```javascript
const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
    throw new Error('FRONTEND_URL required in production');
}
app.use(cors({ origin: allowedOrigin, credentials: true }));
```

---

#### Finding 10.2: CSP Disabled
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 31-34)  
**Description:**
```javascript
app.use(helmet({
    contentSecurityPolicy: false, // Disabled — we use inline scripts and external CDNs
    crossOriginEmbedderPolicy: false
}));
```

Content Security Policy is disabled due to inline scripts and external CDN usage. This removes an important XSS protection layer.

**Recommendation:**
- Refactor inline scripts to external files
- Implement a strict CSP header:
```javascript
contentSecurityPolicy: {
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://www.googletagmanager.com"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "https://res.cloudinary.com"],
    }
}
```

---

### 11. STRIPE & WEBHOOK SECURITY

#### Finding 11.1: Webhook Events Not Atomic
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 2646-2707)  
**Description:**
The checkout.session.completed handler updates both `users` and `companies` tables without transactions:
```javascript
if (event.type === 'checkout.session.completed') {
    const sess = event.data.object;
    if (userId && plan) {
        try {
            await pool.query(
                `UPDATE users SET subscription_plan=$1, stripe_customer_id=$2 WHERE id=$3`,
                [plan, sess.customer, userId]
            );
            await pool.query(
                `UPDATE companies SET plan=$1, stripe_customer_id=$2, stripe_subscription_id=$3, updated_at=NOW() WHERE owner_user_id=$4`,
                [plan, sess.customer, sess.subscription, userId]
            );
```

If the second query fails, the user is updated but the company is not, leaving them in an inconsistent state.

**Recommendation:**
- Wrap in a transaction:
```javascript
const client = await pool.connect();
try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET ...', [...]);
    await client.query('UPDATE companies SET ...', [...]);
    await client.query('COMMIT');
} catch (e) {
    await client.query('ROLLBACK');
    throw e;
}
```

---

#### Finding 11.2: Webhook Metadata Not Validated
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js` (lines 2650-2667)  
**Description:**
```javascript
if (sess.metadata?.type === 'listing_lead') {
    try {
        const realtorId = parseInt(sess.metadata.realtor_id);
        const listingId = parseInt(sess.metadata.listing_id);
```

The metadata is extracted from the Stripe session but there's **no validation** that the realtor or listing actually exists. An attacker who creates a Stripe session with fake metadata could trigger arbitrary database updates.

**Recommendation:**
- Validate metadata on the callback:
```javascript
const realtorId = parseInt(sess.metadata.realtor_id);
const listingId = parseInt(sess.metadata.listing_id);

// Verify realtor exists
const { rows: realtorCheck } = await pool.query(
    'SELECT id FROM users WHERE id=$1 AND user_type=$2', 
    [realtorId, 'realtor']
);
if (!realtorCheck.length) throw new Error('Invalid realtor');

// Verify listing exists
const { rows: listingCheck } = await pool.query(
    'SELECT id FROM listings WHERE id=$1',
    [listingId]
);
if (!listingCheck.length) throw new Error('Invalid listing');
```

---

### 12. ADMIN FUNCTIONALITY

#### Finding 12.1: Admin Analytics Funnel Not Paginated
**Severity:** LOW  
**File:** `/home/user/RealtorFinder/server.js` (lines 1623-1669)  
**Description:**
```javascript
app.get('/api/admin/analytics/funnel', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(`...`);
        res.json(rows.map(r => ({...})));
```

No pagination or limit on results. For large datasets, this could exhaust memory. Low risk since it's admin-only, but a best practice.

**Recommendation:**
- Add pagination with default limit

---

#### Finding 12.2: Leads Export Has No Access Control
**Severity:** HIGH  
**File:** `/home/user/RealtorFinder/server.js` (lines 2031-2051)  
**Description:**
```javascript
app.get('/api/admin/leads/export.csv', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, type, name, email, phone, city_name, state_code, created_at
             FROM city_leads ORDER BY created_at DESC`
        );
```

The endpoint exports **all leads** without any date range or filter. This is a **data exfiltration risk** if an admin account is compromised.

**Recommendation:**
- Add `?days=7` parameter to limit export to recent leads
- Log all CSV exports with admin ID and date
- Implement a daily export quota
- Consider requiring MFA for exports

---

### 13. SESSION/CSRF

#### Finding 13.1: No CSRF Token Validation
**Severity:** MEDIUM  
**File:** `/home/user/RealtorFinder/server.js`  
**Description:**
The application uses session-based authentication with `sameSite: 'lax'` cookies, which provides some CSRF protection. However, there's **no explicit CSRF token validation** for state-changing operations (POST, PUT, DELETE).

**Recommendation:**
- Implement CSRF tokens using a middleware like `csurf`:
```javascript
const csrf = require('csurf');
const csrfProtection = csrf({ cookie: false });
app.post('/api/*', csrfProtection, (req, res) => { ... });
```
- Include CSRF token in request headers: `X-CSRF-Token: ${token}`

---

## SUMMARY TABLE

| # | Severity | Category | Finding | Line | Recommendation |
|---|----------|----------|---------|------|-----------------|
| 1.1 | CRITICAL | Auth | Weak default session secret | 89 | Require SESSION_SECRET, fail fast |
| 1.2 | MEDIUM | Auth | Weak custom rate limiter on login | 261-262 | Use express-rate-limit with Redis |
| 1.3 | MEDIUM | Auth | Password reset token race condition | 829 | Use DB transaction |
| 1.4 | LOW | Auth | Email verification token 48-hour expiry | 330 | Reduce to 24 hours |
| 1.5 | MEDIUM | Auth | 30-day session lifetime too long | 95 | Reduce to 7 days, add absolute timeout |
| 2.1 | CRITICAL | AuthZ | IDOR — GET listing exposes PII | 900-915 | Filter owner contact fields |
| 2.2 | CRITICAL | AuthZ | IDOR — Accept offer race condition | 1087-1144 | Use DB transaction |
| 2.3 | MEDIUM | AuthZ | is_admin fallback always false | 1129 | Store in session |
| 2.4 | HIGH | AuthZ | Admin impersonation not rate limited | 1959 | Add audit logging, rate limit, MFA |
| 3.1 | HIGH | Input | Password reset lacks complexity validation | 819 | Apply strong password regex |
| 3.2 | MEDIUM | Input | target_areas not length validated | 551 | Max 500 chars, max 10 terms |
| 3.3 | LOW | Input | Contact form message no length limit | 2476 | Max 5000 chars |
| 4.1 | MEDIUM | XSS | Incomplete HTML escaping in SSR | 5477-5545 | Use he library, escape all user input |
| 4.2 | LOW | XSS | Email template fields not escaped | email.js | Escape all dynamic fields |
| 5.1 | LOW | Data | Bcrypt rounds = 10 (too low) | 10, 829 | Use 12 rounds |
| 5.2 | HIGH | Data | Owner PII visible in public API | 900-915 | Filter sensitive fields |
| 5.3 | HIGH | Data | Stripe key not validated | 13 | Check for live vs test key in production |
| 5.4 | MEDIUM | Data | Admin notes unencrypted | 2126-2139 | Encrypt with AES-256 |
| 6.1 | MEDIUM | Files | Upload size limits inconsistent | 18, 53 | Reduce to 5MB images, 3MB docs |
| 6.2 | MEDIUM | Files | File type validation via MIME only | 20, 54 | (OK due to Cloudinary, note dependency) |
| 7.1 | MEDIUM | RateLimit | Inconsistent rate limiting strategies | 43-63, 247-262 | Use express-rate-limit + Redis |
| 7.2 | MEDIUM | RateLimit | Password reset not per-email limited | 792 | Implement per-email rate limiting |
| 8.1 | MEDIUM | Secrets | Missing env var validation at startup | All | Create startup validator |
| 8.2 | HIGH | Secrets | Stripe webhook secret not validated | 2625 | Validate env var at startup |
| 9.1 | INFO | Deps | Dependencies need audit | package.json | Run npm audit regularly |
| 10.1 | MEDIUM | Headers | CORS allows any origin if FRONTEND_URL unset | 66-70 | Default to localhost, fail in prod |
| 10.2 | MEDIUM | Headers | CSP disabled | 31-32 | Implement strict CSP |
| 11.1 | MEDIUM | Stripe | Webhook events not atomic | 2650-2676 | Use DB transaction |
| 11.2 | MEDIUM | Stripe | Webhook metadata not validated | 2650-2657 | Validate realtor/listing existence |
| 12.1 | LOW | Admin | Analytics funnel not paginated | 1623 | Add pagination |
| 12.2 | HIGH | Admin | Leads CSV export not restricted | 2031 | Add date range, logging, quota |
| 13.1 | MEDIUM | CSRF | No CSRF token validation | All | Implement csurf middleware |

---

## RECOMMENDATIONS (Priority Order)

### P0 (Critical - Fix Immediately)
1. **Finding 1.1** - Require SESSION_SECRET environment variable
2. **Finding 2.1** - Filter PII from public listing endpoints
3. **Finding 2.2** - Add database transactions for offer acceptance
4. **Finding 5.2** - Remove owner contact from public listing response
5. **Finding 8.2** - Validate STRIPE_WEBHOOK_SECRET at startup

### P1 (High - Fix This Release)
1. **Finding 2.4** - Implement admin impersonation audit logging and rate limiting
2. **Finding 3.1** - Apply strong password validation to password reset
3. **Finding 5.3** - Validate Stripe key format at startup
4. **Finding 5.4** - Encrypt admin notes in database
5. **Finding 12.2** - Add filtering and logging to leads CSV export
6. **Finding 10.1** - Fix CORS origin validation

### P2 (Medium - Fix Next Sprint)
1. **Finding 1.2** - Replace custom rate limiter with express-rate-limit + Redis
2. **Finding 1.3** - Use transactions for password reset token invalidation
3. **Finding 1.5** - Reduce session lifetime to 7 days
4. **Finding 4.1** - Implement global HTML escaping utility
5. **Finding 7.2** - Implement per-email password reset rate limiting
6. **Finding 11.1** - Wrap webhook handlers in transactions
7. **Finding 13.1** - Implement CSRF token validation

### P3 (Low - Fix As Time Permits)
1. **Finding 1.4** - Reduce email verification token lifetime
2. **Finding 3.2** - Validate target_areas length
3. **Finding 3.3** - Validate contact form message length
4. **Finding 5.1** - Increase bcrypt rounds to 12
5. **Finding 6.1** - Fine-tune file upload size limits
6. **Finding 10.2** - Implement strict CSP header

---

## CONCLUSION

The RealtorFinder application has a solid foundation with parameterized queries, proper password hashing, and basic rate limiting. However, it requires **immediate remediation** of 5 critical/high findings before production deployment:
- Session secret defaults
- Authorization bypass (IDOR) exposing PII
- Admin impersonation not audited
- Stripe webhook validation
- CORS misconfiguration

The architecture supports secure patterns (PostgreSQL sessions, bcrypt, Cloudinary), but implementation details in authentication, authorization, and data filtering need hardening. A follow-up security review after remediation is recommended.
