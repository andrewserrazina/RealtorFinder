# 🚀 HomeDirect Deployment Checklist

Use this checklist to deploy your HomeDirect platform step-by-step.

## ✅ Pre-Deployment Checklist

### 1. Code Preparation
- [ ] All files uploaded to GitHub repository
- [ ] .gitignore includes .env and node_modules
- [ ] package.json has correct start script
- [ ] README.md is complete and helpful

### 2. Testing Locally
- [ ] Application runs without errors locally
- [ ] Can create listings successfully  
- [ ] Can submit offers successfully
- [ ] Database queries work correctly
- [ ] Email notifications working (test mode)

### 3. Environment Setup
- [ ] .env.example file created with all variables
- [ ] Database schema (database.sql) is finalized
- [ ] Email service decided (Gmail/SendGrid/SES)

## 🎯 Deployment: Render (Recommended)

### Step 1: Create Accounts
- [ ] Render account created at https://render.com
- [ ] GitHub repository created and code pushed
- [ ] GitHub connected to Render

### Step 2: Database Setup
- [ ] PostgreSQL database created on Render
- [ ] Database URL copied (Internal Database URL)
- [ ] Database schema imported via PSQL or Shell
- [ ] Test data inserted (optional)
- [ ] Database connection tested

### Step 3: Web Service Setup
- [ ] Web Service created and linked to GitHub repo
- [ ] Build command set: `npm install`
- [ ] Start command set: `npm start`
- [ ] Environment variables added:
  - [ ] NODE_ENV=production
  - [ ] DATABASE_URL=(from Step 2)
  - [ ] EMAIL_HOST
  - [ ] EMAIL_PORT
  - [ ] EMAIL_USER
  - [ ] EMAIL_PASSWORD
  - [ ] EMAIL_FROM

### Step 4: Email Configuration
- [ ] Gmail 2FA enabled (if using Gmail)
- [ ] App password generated
- [ ] Test email sent successfully
- [ ] Email notifications working

### Step 5: Testing Production
- [ ] Site loads at Render URL
- [ ] Can create new listing
- [ ] Listing appears in browse section
- [ ] Can submit offer on listing
- [ ] Homeowner receives email notification
- [ ] Realtor receives confirmation email
- [ ] Database persists data after server restart

### Step 6: Custom Domain (Optional)
- [ ] Domain purchased
- [ ] Domain added in Render settings
- [ ] DNS records updated
- [ ] SSL certificate auto-provisioned
- [ ] Site accessible via custom domain

## 📋 Post-Deployment Checklist

### Monitoring
- [ ] Bookmark Render dashboard
- [ ] Enable email alerts for downtime
- [ ] Setup UptimeRobot (free monitoring)
- [ ] Test site from different devices
- [ ] Test site from different networks

### Security
- [ ] All environment variables secure
- [ ] No secrets in code
- [ ] HTTPS enabled
- [ ] CORS properly configured
- [ ] Database backups enabled

### Documentation
- [ ] README.md updated with live URL
- [ ] Team members have access to Render
- [ ] Database credentials stored securely
- [ ] Email credentials stored securely

### Performance
- [ ] Site loads in < 3 seconds
- [ ] Images optimized (when added)
- [ ] Database queries optimized
- [ ] No console errors

## 🔍 Troubleshooting Guide

### Issue: Site won't load
**Check:**
- [ ] Deployment logs in Render
- [ ] All environment variables set
- [ ] Start command is correct
- [ ] Port is using process.env.PORT

**Fix:**
1. Go to Render Dashboard → Logs
2. Look for error messages
3. Common issue: DATABASE_URL not set

### Issue: Database connection failed
**Check:**
- [ ] DATABASE_URL is correct
- [ ] Database service is running
- [ ] Schema was imported

**Fix:**
1. Verify Internal Database URL
2. Test connection from Render Shell
3. Re-import schema if needed

### Issue: Emails not sending
**Check:**
- [ ] EMAIL_* variables are set
- [ ] Gmail app password (not regular password)
- [ ] SMTP settings correct

**Fix:**
1. Check server logs for email errors
2. Verify app password
3. Test with different email provider

### Issue: Forms not submitting
**Check:**
- [ ] Browser console for errors
- [ ] Network tab for API calls
- [ ] CORS errors

**Fix:**
1. Check server logs
2. Verify API endpoints in app.js
3. Test API with curl

## 📊 Go-Live Checklist

### 24 Hours Before Launch
- [ ] Final testing on staging
- [ ] Database backed up
- [ ] Team briefed on launch
- [ ] Support plan ready

### Launch Day
- [ ] Monitor dashboard actively
- [ ] Test all critical flows
- [ ] Watch error logs
- [ ] Have rollback plan ready

### Post-Launch (First Week)
- [ ] Daily log reviews
- [ ] User feedback collection
- [ ] Performance monitoring
- [ ] Bug fixing prioritization

## 🎉 Success Criteria

Your deployment is successful when:
- [x] Site accessible at public URL
- [x] All features working correctly
- [x] Emails being delivered
- [x] Data persisting in database
- [x] No critical errors in logs
- [x] Mobile responsive
- [x] SSL certificate active
- [x] Monitoring in place

## 📞 Getting Help

If stuck:
1. Check DEPLOYMENT.md for detailed guides
2. Review server logs carefully
3. Search error messages online
4. Check Render documentation
5. Open GitHub issue

## 🚀 Next Steps After Deployment

### Week 1
- [ ] Monitor usage and performance
- [ ] Fix any bugs found
- [ ] Gather user feedback
- [ ] Plan improvements

### Month 1
- [ ] Add image uploads
- [ ] Implement user authentication
- [ ] Add search/filter features
- [ ] Improve email templates

### Future
- [ ] Add payment processing
- [ ] Build mobile app
- [ ] Add analytics
- [ ] Scale infrastructure

---

## ⏱️ Estimated Timeline

- **Render Setup**: 15-30 minutes
- **Database Import**: 5 minutes
- **Testing**: 15-30 minutes
- **Domain Setup**: 15 minutes (optional)
- **Total**: 1-2 hours for first deployment

## 💡 Pro Tips

1. **Always test locally first** - Fix bugs before deploying
2. **Keep .env secure** - Never commit to Git
3. **Monitor logs daily** - Catch issues early
4. **Backup database** - Before major changes
5. **Use staging environment** - Test in production-like setting
6. **Document everything** - Future you will thank you

---

**Ready to deploy?** Start with Step 1! 🎯
