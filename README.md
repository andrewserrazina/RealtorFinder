# 🏠 HomeDirect - Real Estate Listing Platform

A modern web platform connecting homeowners directly with realtors. Homeowners list their properties, and qualified realtors submit competitive offer packages.

## ✨ Features

### For Homeowners
- ✅ Free property listings
- ✅ Detailed property forms (address, price, bedrooms, bathrooms, sqft)
- ✅ Receive multiple offer packages from realtors
- ✅ Email notifications when offers are received
- ✅ Direct contact with interested realtors

### For Realtors
- ✅ Browse available properties
- ✅ Submit detailed offer packages
- ✅ Showcase marketing plans and credentials
- ✅ Direct communication with homeowners
- ✅ Email confirmations

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- PostgreSQL 14+
- Gmail account (for email notifications)

### Local Development

1. **Clone and Install**
   ```bash
   git clone <your-repo>
   cd homedirect
   npm install
   ```

2. **Setup Database**
   ```bash
   # Create database
   createdb homedirect
   
   # Import schema
   psql homedirect < database.sql
   ```

3. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Run Development Server**
   ```bash
   npm run dev
   ```

5. **Open Browser**
   ```
   http://localhost:3000
   ```

## 📁 Project Structure

```
homedirect/
├── server.js              # Basic server (in-memory)
├── server-production.js   # Production server (database)
├── db.js                  # Database queries
├── email.js               # Email notifications
├── database.sql           # PostgreSQL schema
├── package.json           # Dependencies
├── .env.example           # Environment template
├── public/
│   ├── index.html         # Main frontend
│   └── app.js            # Frontend API integration
└── DEPLOYMENT.md         # Deployment guide
```

## 🔧 Configuration

### Environment Variables

Create a `.env` file with:

```env
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/homedirect

# Email Configuration
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-specific-password
EMAIL_FROM=HomeDirect <noreply@homedirect.com>
```

## 📧 Email Setup

### Gmail (Development/Testing)
1. Enable 2-Factor Authentication
2. Generate App Password: https://myaccount.google.com/apppasswords
3. Use app password in EMAIL_PASSWORD

### SendGrid (Production - Recommended)
1. Sign up at https://sendgrid.com
2. Create API key
3. Set SENDGRID_API_KEY in .env

## 🗄️ Database Schema

### Tables
- **listings** - Property listings with owner info
- **offers** - Realtor offer packages
- **users** - User accounts (for future auth)

See `database.sql` for complete schema.

## 🌐 API Endpoints

### Listings
- `GET /api/listings` - Get all active listings
- `GET /api/listings/:id` - Get single listing
- `POST /api/listings` - Create new listing
- `GET /api/listings/:id/offers` - Get offers for listing

### Offers
- `POST /api/listings/:id/offers` - Submit offer package

### Health
- `GET /api/health` - Server health check

## 🚢 Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment instructions.

**Quick Deploy Options:**
- ✅ Render (Recommended - FREE tier)
- ✅ Railway (Easy setup)
- ✅ Heroku
- ✅ Custom VPS

## 🔐 Security Considerations

### Current Status (MVP)
- ✅ Input validation
- ✅ SQL injection protection (parameterized queries)
- ✅ CORS configured
- ⚠️ No authentication (listings are public)
- ⚠️ No authorization (anyone can view offers)

### For Production
Add these features:
- [ ] User authentication (JWT)
- [ ] Email verification
- [ ] Rate limiting
- [ ] HTTPS/SSL
- [ ] CSRF protection
- [ ] Input sanitization
- [ ] File upload validation
- [ ] Password hashing

## 📈 Future Enhancements

### Phase 2 - Essential Features
- [ ] User authentication & dashboards
- [ ] Image uploads (Cloudinary/S3)
- [ ] Search & filters
- [ ] Listing status management
- [ ] Offer acceptance/rejection

### Phase 3 - Advanced Features
- [ ] Payment processing for premium listings
- [ ] Messaging system
- [ ] Calendar integration for showings
- [ ] Document uploads
- [ ] Analytics dashboard

### Phase 4 - Scale Features
- [ ] Mobile app (React Native)
- [ ] Multi-language support
- [ ] Advanced search (map view, radius)
- [ ] AI-powered property valuations
- [ ] Integration with MLS databases

## 🧪 Testing

### Manual Testing Checklist
- [ ] Create a listing
- [ ] View listing in browse page
- [ ] Submit offer package
- [ ] Receive email notifications
- [ ] Test on mobile devices
- [ ] Test form validation

### Future: Automated Testing
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

## 📊 Monitoring

### Production Monitoring
- Server logs (Render/Railway dashboard)
- Database metrics
- Email delivery status
- Error tracking (Sentry - recommended)
- Uptime monitoring (UptimeRobot - free)

## 💰 Cost Breakdown

### Free Tier (Start Here)
- Hosting: FREE (Render/Railway)
- Database: FREE
- Email: FREE (Gmail - 500/day)
- **Total: $0/month**

### Production Tier
- Hosting: $7/month
- Database: $7/month
- Email: $15/month (SendGrid)
- Domain: $12/year
- **Total: ~$30/month**

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open Pull Request

## 📝 License

MIT License - feel free to use for commercial projects

## 🆘 Support & Troubleshooting

### Common Issues

**Database won't connect**
- Check DATABASE_URL format
- Ensure PostgreSQL is running
- Verify database exists

**Emails not sending**
- Verify email credentials
- Check app password (not regular password)
- Review server logs for errors

**Form submission fails**
- Check browser console for errors
- Verify API endpoints
- Check CORS settings

**Site loads but looks broken**
- Ensure public/index.html is in place
- Check browser console
- Verify static files are being served

## 📞 Contact

Questions or need help deploying?
- Open an issue on GitHub
- Check DEPLOYMENT.md for detailed guides

---

## 🎯 Getting Started Checklist

- [ ] Clone repository
- [ ] Install dependencies (`npm install`)
- [ ] Setup PostgreSQL database
- [ ] Import database schema (`database.sql`)
- [ ] Configure `.env` file
- [ ] Start development server (`npm run dev`)
- [ ] Test locally
- [ ] Deploy to Render/Railway
- [ ] Configure custom domain (optional)
- [ ] Setup email notifications
- [ ] Add SSL certificate
- [ ] Monitor and maintain

**Ready to launch!** 🚀
