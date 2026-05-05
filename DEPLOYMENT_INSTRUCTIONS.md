# Deployment Instructions for RealtorFinder Landing Pages

## What Changed

✅ Added two new landing pages:
- `/` (root) → `public/landing.html` - Seller landing page
- `/realtors` → `public/realtors.html` - Realtor landing page
- `/app` → `public/index.html` - Your existing application

✅ Added waitlist API endpoint:
- `POST /api/waitlist` - Collects emails from both pages

## Files to Update

### 1. Replace `server.js` with the new version
The updated server includes:
- Routes for the new landing pages
- Waitlist API endpoint
- All your existing API routes

**Location:** `server-updated.js` (rename this to `server.js`)

### 2. Add new HTML files to `public/` folder
- `public/landing.html` - Seller landing page
- `public/realtors.html` - Realtor landing page

## Step-by-Step Deployment

### Option A: Via GitHub (Recommended)

1. **Copy the updated files to your local repo:**
   ```bash
   # Copy the new landing pages
   cp landing.html YOUR_REPO/public/
   cp realtors.html YOUR_REPO/public/
   
   # Replace server.js
   cp server-updated.js YOUR_REPO/server.js
   ```

2. **Commit and push:**
   ```bash
   git add .
   git commit -m "Add pre-launch landing pages and waitlist"
   git push origin main
   ```

3. **Render auto-deploys** from your GitHub repo - done!

### Option B: Manual Upload to Render

1. In Render dashboard → Your service → "Manual Deploy"
2. Upload the updated files
3. Trigger deploy

## Testing After Deployment

1. Visit your Render URL:
   - `https://your-app.onrender.com/` - Should show seller landing page
   - `https://your-app.onrender.com/realtors` - Should show realtor page
   - `https://your-app.onrender.com/app` - Should show your original app

2. Test email signup:
   - Enter an email on either landing page
   - Check Render logs for: `📧 Waitlist signup: email@example.com (seller)`

## Email Collection Setup

Currently emails are just logged. To actually save them:

### Option 1: Save to Database (Recommended)

Add a waitlist table:
```sql
CREATE TABLE waitlist (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    user_type VARCHAR(20) NOT NULL, -- 'seller' or 'realtor'
    created_at TIMESTAMP DEFAULT NOW()
);
```

Update the `/api/waitlist` endpoint in server.js (line ~230):
```javascript
await db.pool.query(
    'INSERT INTO waitlist (email, user_type) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [email, type]
);
```

### Option 2: Connect to Email Service

Replace the API endpoint with Mailchimp, ConvertKit, etc. See `EMAIL_INTEGRATION.md` for details.

## Custom Domain

Once deployed, point `realtorfinder.net` to your Render app:

1. Render Dashboard → Your service → Settings → Custom Domains
2. Add `realtorfinder.net`
3. Add DNS records at your domain registrar

## Rollback Plan

If something breaks:
1. In Render dashboard → Deployments
2. Click on previous successful deployment
3. Click "Redeploy"

## Current URL Structure

After deployment:
- `/` - Seller waitlist page (NEW)
- `/realtors` - Realtor waitlist page (NEW)
- `/app` - Your existing application
- `/api/*` - All your existing API routes

## Questions?

The server logs will show:
- `🏠 RealtorFinder server running on port 3000`
- `📧 Waitlist signup: ...` when someone signs up
