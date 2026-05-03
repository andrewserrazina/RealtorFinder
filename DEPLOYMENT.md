# HomeDirect - Deployment Guide

## Quick Start Options

### Option 1: Deploy to Render (Recommended - FREE tier available)
### Option 2: Deploy to Railway
### Option 3: Deploy to Heroku
### Option 4: Deploy to Your Own Server

---

## Option 1: Deploy to Render (EASIEST - Recommended for Beginners)

### Step 1: Prepare Your Code

1. Create a new GitHub repository
2. Upload all your HomeDirect files to the repository:
   - server-production.js (rename to server.js)
   - db.js
   - email.js
   - package.json
   - database.sql
   - public/ folder (with index.html and app.js)

### Step 2: Create Render Account

1. Go to https://render.com and sign up (free)
2. Connect your GitHub account

### Step 3: Create PostgreSQL Database

1. In Render Dashboard, click "New +" → "PostgreSQL"
2. Fill in:
   - Name: homedirect-db
   - Region: Choose closest to you
   - Plan: Free tier
3. Click "Create Database"
4. **IMPORTANT**: Copy the "Internal Database URL" - you'll need this!

### Step 4: Initialize Database

1. In your database dashboard, click "Connect" → "PSQL Command"
2. Run this command locally:
   ```bash
   psql <paste-the-connection-string-here>
   ```
3. Copy and paste the contents of database.sql
4. Press Enter to execute

Alternative: Use the Render Shell:
- Click "Shell" tab in database dashboard
- Paste database.sql contents
- Execute

### Step 5: Deploy Web Service

1. Click "New +" → "Web Service"
2. Connect your GitHub repository
3. Fill in:
   - **Name**: homedirect
   - **Region**: Same as database
   - **Branch**: main
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

4. Add Environment Variables (click "Advanced" → "Add Environment Variable"):
   ```
   NODE_ENV=production
   DATABASE_URL=<paste-internal-database-url-from-step-3>
   EMAIL_HOST=smtp.gmail.com
   EMAIL_PORT=587
   EMAIL_USER=your-gmail@gmail.com
   EMAIL_PASSWORD=your-app-password
   EMAIL_FROM=HomeDirect <noreply@homedirect.com>
   ```

5. Click "Create Web Service"

### Step 6: Configure Gmail for Email Notifications

1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification
3. Go to App Passwords: https://myaccount.google.com/apppasswords
4. Generate password for "Mail"
5. Copy the 16-character password
6. Add to Render environment variables as EMAIL_PASSWORD

### Step 7: Test Your Deployment

1. Wait for deployment to complete (~5 minutes)
2. Click the URL provided (e.g., https://homedirect.onrender.com)
3. Test creating a listing
4. Test submitting an offer
5. Check that emails are being sent

### Done! 🎉

Your site is now live at: https://homedirect.onrender.com

---

## Option 2: Deploy to Railway

### Step 1: Prepare Repository
- Same as Render Option 1 - Step 1

### Step 2: Create Railway Account
1. Go to https://railway.app
2. Sign up with GitHub

### Step 3: Create New Project
1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Choose your repository

### Step 4: Add PostgreSQL
1. Click "+ New"
2. Select "Database" → "PostgreSQL"
3. Railway automatically creates DATABASE_URL

### Step 5: Initialize Database
1. Click on PostgreSQL service
2. Go to "Data" tab
3. Click "Query" and paste database.sql contents
4. Execute

### Step 6: Configure Environment Variables
1. Click on your web service
2. Go to "Variables" tab
3. Add the same variables as Render (except DATABASE_URL - already set)

### Step 7: Deploy
- Railway automatically deploys
- Get your URL from the "Settings" tab

---

## Option 3: Manual VPS Deployment (DigitalOcean, Linode, AWS EC2)

### Prerequisites
- Ubuntu 22.04 server
- Domain name (optional but recommended)
- SSH access

### Step 1: Setup Server

```bash
# SSH into your server
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Install PostgreSQL
apt install -y postgresql postgresql-contrib

# Install Nginx (web server)
apt install -y nginx

# Install PM2 (process manager)
npm install -g pm2
```

### Step 2: Setup PostgreSQL

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE homedirect;
CREATE USER homedirect_user WITH ENCRYPTED PASSWORD 'your-secure-password';
GRANT ALL PRIVILEGES ON DATABASE homedirect TO homedirect_user;
\q

# Import schema
sudo -u postgres psql homedirect < /path/to/database.sql
```

### Step 3: Deploy Application

```bash
# Create app directory
mkdir -p /var/www/homedirect
cd /var/www/homedirect

# Clone your repository or upload files
git clone https://github.com/yourusername/homedirect.git .

# Install dependencies
npm install

# Create .env file
nano .env
# Paste your environment variables, then Ctrl+X, Y, Enter
```

### Step 4: Setup PM2

```bash
# Start application
pm2 start server.js --name homedirect

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Run the command it outputs
```

### Step 5: Configure Nginx

```bash
# Create Nginx configuration
nano /etc/nginx/sites-available/homedirect
```

Paste this configuration:

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable site
ln -s /etc/nginx/sites-available/homedirect /etc/nginx/sites-enabled/

# Test configuration
nginx -t

# Restart Nginx
systemctl restart nginx
```

### Step 6: Setup SSL with Let's Encrypt (Optional but Recommended)

```bash
# Install Certbot
apt install -y certbot python3-certbot-nginx

# Get SSL certificate
certbot --nginx -d your-domain.com -d www.your-domain.com

# Certbot automatically configures Nginx for HTTPS
```

### Step 7: Setup Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

---

## Email Configuration Options

### Option 1: Gmail (Good for Testing)
- Free
- Easy setup
- Limited to 500 emails/day
- See Step 6 in Render deployment

### Option 2: SendGrid (Recommended for Production)
1. Sign up at https://sendgrid.com (100 emails/day free)
2. Create API key
3. Add to environment variables:
   ```
   SENDGRID_API_KEY=your-api-key
   ```

### Option 3: AWS SES (Best for Scale)
1. Sign up for AWS
2. Verify domain in SES
3. Add credentials to environment variables

---

## Custom Domain Setup

### Using Render
1. Go to Settings → Custom Domains
2. Add your domain
3. Update DNS records at your domain registrar

### Using Railway
1. Go to Settings → Domains
2. Add custom domain
3. Configure DNS

---

## Monitoring & Maintenance

### View Logs (Render)
- Dashboard → Logs tab

### View Logs (Railway)
- Click service → Observability → Logs

### View Logs (VPS with PM2)
```bash
pm2 logs homedirect
```

### Database Backups (Important!)

#### Render
- Automatic daily backups on paid plans
- Manual: Database → Backups tab

#### Railway  
- Automatic backups
- Manual: Database service → Backups

#### VPS
```bash
# Manual backup
pg_dump homedirect > backup-$(date +%Y%m%d).sql

# Setup automated daily backups
crontab -e
# Add: 0 2 * * * pg_dump homedirect > /backups/homedirect-$(date +\%Y\%m\%d).sql
```

---

## Troubleshooting

### Site won't load
1. Check deployment logs
2. Verify all environment variables are set
3. Ensure DATABASE_URL is correct
4. Check if port is correct (some platforms require process.env.PORT)

### Emails not sending
1. Verify EMAIL_* environment variables
2. Check Gmail app password is correct
3. Look for errors in server logs
4. Test with a simple console.log in email.js

### Database connection errors
1. Verify DATABASE_URL format
2. Check if database is running
3. Ensure database was initialized with schema
4. Check firewall rules

### Form submissions failing
1. Check browser console for errors
2. Verify API endpoints in app.js
3. Check CORS settings in server.js
4. Test API directly with curl or Postman

---

## Next Steps

1. **Add Image Uploads**: Integrate Cloudinary or AWS S3
2. **Add Authentication**: Protect homeowner dashboards
3. **Add Payment Processing**: Integrate Stripe for premium listings
4. **Analytics**: Add Google Analytics
5. **SEO**: Add meta tags and sitemap
6. **Mobile App**: Build with React Native

---

## Support

Need help? Common issues:
- Database connection → Double-check DATABASE_URL
- Email not working → Verify app password
- Site loading but broken → Check browser console errors

---

## Cost Estimates

### Free Tier (Perfect for Starting)
- Render: FREE (750 hrs/month)
- Railway: FREE ($5 credit/month)
- Database: FREE (Render/Railway)
- **Total: $0/month**

### Production (Recommended)
- Render Web Service: $7/month
- Render PostgreSQL: $7/month
- SendGrid: FREE (100 emails/day) or $15/month (40K emails)
- Domain: $12/year
- **Total: ~$15-30/month**

### Enterprise Scale
- VPS: $20-100/month
- Managed Database: $15-50/month
- Email Service: $50-200/month
- CDN: $20-100/month
- **Total: $100-500/month**
