// email.js - Branded email service using SendGrid
const sgMail = require('@sendgrid/mail');
require('dotenv').config();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM;
const BASE_URL = process.env.FRONTEND_URL || 'https://realtorfinder.net';

console.log('🔧 Email Service Initialization:');
console.log('   SENDGRID_API_KEY exists:', !!SENDGRID_API_KEY);
console.log('   SENDGRID_API_KEY starts with SG.:', SENDGRID_API_KEY?.startsWith('SG.'));
console.log('   EMAIL_FROM:', FROM);

if (SENDGRID_API_KEY && SENDGRID_API_KEY.startsWith('SG.')) {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log('✅ SendGrid API key configured');
} else {
    console.warn('⚠️ SENDGRID_API_KEY missing or invalid. Email sending is disabled.');
}

function assertEmailConfig() {
    if (!SENDGRID_API_KEY || !SENDGRID_API_KEY.startsWith('SG.')) throw new Error('SENDGRID_API_KEY is missing/invalid');
    if (!FROM || !FROM.includes('@')) throw new Error('EMAIL_FROM/SENDGRID_FROM_EMAIL is missing/invalid');
}

function logSendgridError(context, error) {
    const statusCode = error?.code || error?.response?.statusCode;
    const responseBody = error?.response?.body;
    console.error(`❌ ${context} failed:`, { message: error?.message, statusCode, responseBody });
}

async function send(msg) {
    assertEmailConfig();
    const [response] = await sgMail.send({ from: FROM, ...msg });
    console.log(`📬 Email sent to ${msg.to} — status ${response?.statusCode}`);
    return response;
}

// ─── Base branded template ───────────────────────────────────────────────────
function emailWrap(accentBar, bodyHtml) {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8F6F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F6F3;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#0A2540 0%,#0d3659 100%);padding:36px 48px;text-align:center;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:900;color:white;letter-spacing:-1px;">
              Realtor<span style="color:#FF6B35;">Finder</span>
            </div>
            <div style="color:rgba(255,255,255,0.55);font-size:11px;margin-top:6px;letter-spacing:2px;text-transform:uppercase;">The Reverse Real Estate Marketplace</div>
            ${accentBar ? `<div style="display:inline-block;background:#FF6B35;color:white;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px;margin-top:12px;letter-spacing:1px;text-transform:uppercase;">${accentBar}</div>` : ''}
          </td>
        </tr>
        <!-- Body -->
        <tr><td style="padding:48px;">${bodyHtml}</td></tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F8F6F3;padding:28px 48px;border-top:1px solid #E5E1DB;text-align:center;">
            <p style="color:#999;font-size:12px;margin:0 0 6px;line-height:1.6;">
              © 2026 RealtorFinder.net &nbsp;·&nbsp;
              <a href="${BASE_URL}/privacy" style="color:#FF6B35;text-decoration:none;">Privacy Policy</a> &nbsp;·&nbsp;
              <a href="${BASE_URL}/terms" style="color:#FF6B35;text-decoration:none;">Terms of Service</a>
            </p>
            <p style="color:#bbb;font-size:11px;margin:0;">You're receiving this because you have an account at realtorfinder.net</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function btn(href, label) {
    return `<div style="text-align:center;margin:32px 0;">
      <a href="${href}" style="background:#FF6B35;color:white;padding:16px 36px;border-radius:50px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;letter-spacing:-0.3px;">${label}</a>
    </div>`;
}

function h1(text) {
    return `<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:900;color:#0A2540;margin:0 0 16px;letter-spacing:-0.5px;">${text}</h1>`;
}

function p(text) {
    return `<p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 16px;">${text}</p>`;
}

function infoBox(rows) {
    const cells = rows.map(([label, value]) =>
        `<tr><td style="padding:10px 16px;font-size:13px;color:#666;font-weight:600;border-bottom:1px solid #f0ece7;white-space:nowrap;">${label}</td>
             <td style="padding:10px 16px;font-size:14px;color:#0A2540;font-weight:500;border-bottom:1px solid #f0ece7;">${value}</td></tr>`
    ).join('');
    return `<table style="width:100%;border-radius:10px;border:1px solid #E5E1DB;overflow:hidden;margin:24px 0;">${cells}</table>`;
}

function divider() {
    return `<div style="height:1px;background:#E5E1DB;margin:28px 0;"></div>`;
}

// ─── Waitlist Emails (3 separate branded versions) ───────────────────────────

const emailService = {

    // Route to correct waitlist template by type
    async sendWaitlistConfirmation(email, userType) {
        if (userType === 'realtor') return this.sendRealtorWaitlistConfirmation(email);
        if (userType === 'buyer') return this.sendBuyerWaitlistConfirmation(email);
        return this.sendSellerWaitlistConfirmation(email);
    },

    // Seller waitlist confirmation
    async sendSellerWaitlistConfirmation(email) {
        const body = `
            ${h1("You're on the Seller Waitlist! 🏠")}
            ${p("Great news — you're among the first sellers to secure a spot on RealtorFinder. When we launch, your listing will get priority placement.")}
            <div style="background:linear-gradient(135deg,#FF6B35,#e85a25);border-radius:12px;padding:28px 32px;margin:28px 0;color:white;">
                <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:0.8;margin-bottom:8px;">Launching Late Q3 2026</div>
                <div style="font-family:Georgia,serif;font-size:22px;font-weight:900;margin-bottom:16px;">How It Works for Sellers</div>
                <div style="font-size:14px;line-height:2;">
                    📋 &nbsp;List your home for <strong>free</strong> — no fees, ever<br>
                    🏆 &nbsp;Licensed realtors compete for your listing<br>
                    📊 &nbsp;Compare commission rates side by side<br>
                    ✅ &nbsp;Choose the best agent on your timeline
                </div>
            </div>
            ${p("As a founding member, you'll get <strong>priority listing placement</strong> at launch and be the first to receive competing agent proposals.")}
            ${divider()}
            ${p(`Questions? Reply to this email — we'd love to hear from you.`)}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team<br><a href="${BASE_URL}" style="color:#FF6B35;text-decoration:none;">realtorfinder.net</a></p>
        `;
        try {
            await send({ to: email, subject: "You're on the RealtorFinder Seller Waitlist! 🏠", html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Seller waitlist email', error); throw error; }
    },

    // Realtor waitlist confirmation
    async sendRealtorWaitlistConfirmation(email) {
        const body = `
            ${h1("You're Registered — Agents Are Competing 🏆")}
            ${p("Welcome to RealtorFinder. You're among the first realtors to secure founding member pricing. When we launch, you'll have exclusive early access to motivated sellers in your market.")}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:28px 0;color:white;">
                <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:0.6;margin-bottom:8px;">The Math Is Simple</div>
                <div style="font-family:Georgia,serif;font-size:22px;font-weight:900;margin-bottom:16px;color:#FF6B35;">Win One Listing = $10,000+</div>
                <div style="font-size:14px;line-height:2;opacity:0.9;">
                    💰 &nbsp;Average commission on $420K home: <strong style="color:#FF6B35;">$10,500</strong><br>
                    📋 &nbsp;Platform access from: <strong style="color:#FF6B35;">$99/mo</strong><br>
                    📞 &nbsp;No cold calling. Sellers come to <em>you</em><br>
                    🔒 &nbsp;Your founding rate is locked at registration
                </div>
            </div>
            ${p("Plans start at $99/month. Founding members lock in their rate — prices increase at public launch.")}
            ${divider()}
            ${p(`Questions about the platform? Reply to this email.`)}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team<br><a href="${BASE_URL}/realtors" style="color:#FF6B35;text-decoration:none;">realtorfinder.net/realtors</a></p>
        `;
        try {
            await send({ to: email, subject: "You're Registered — Founding Realtor Access Secured 🏆", html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Realtor waitlist email', error); throw error; }
    },

    // Buyer waitlist confirmation
    async sendBuyerWaitlistConfirmation(email) {
        const body = `
            ${h1("You're on the Buyer Waitlist! 🔑")}
            ${p("You're in! As a founding buyer member, you'll get priority access when we launch — meaning agents will see your request first.")}
            <div style="background:linear-gradient(135deg,#0A2540,#1a4a7a);border-radius:12px;padding:28px 32px;margin:28px 0;color:white;">
                <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:0.6;margin-bottom:8px;">Launching Late Q3 2026</div>
                <div style="font-family:Georgia,serif;font-size:22px;font-weight:900;margin-bottom:16px;">How It Works for Buyers</div>
                <div style="font-size:14px;line-height:2;opacity:0.9;">
                    🔍 &nbsp;Tell us your budget, area &amp; preferences<br>
                    📬 &nbsp;Licensed buyer's agents send you proposals<br>
                    📊 &nbsp;Compare agents side by side — no pressure<br>
                    🏡 &nbsp;Choose your agent and start house hunting<br>
                    💰 &nbsp;<strong style="color:#FF6B35;">Free for buyers</strong> — agent fee paid by seller
                </div>
            </div>
            ${p("The best part? In most transactions, the buyer's agent commission is <strong>paid by the home seller</strong> — so professional representation costs you nothing.")}
            ${divider()}
            ${p("Reply to this email with any questions about finding a buyer's agent.")}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team<br><a href="${BASE_URL}/buyers" style="color:#FF6B35;text-decoration:none;">realtorfinder.net/buyers</a></p>
        `;
        try {
            await send({ to: email, subject: "You're on the RealtorFinder Buyer Waitlist! 🔑", html: emailWrap('For Buyers', body) });
        } catch (error) { logSendgridError('Buyer waitlist email', error); throw error; }
    },

    // ─── Buyer Request Emails ──────────────────────────────────────────────

    // Confirm buyer's submitted request
    async sendBuyerRequestConfirmation(request) {
        const budget = request.budget_min && request.budget_max
            ? `$${parseInt(request.budget_min).toLocaleString()} – $${parseInt(request.budget_max).toLocaleString()}`
            : request.budget_max ? `Up to $${parseInt(request.budget_max).toLocaleString()}` : 'Flexible';
        const body = `
            ${h1("Your Buyer Request Is Live! 🔍")}
            ${p(`Hi ${request.first_name}, your buyer agent request has been submitted and is now visible to licensed agents in your area.`)}
            ${infoBox([
                ['Budget', budget],
                ['Target Areas', request.target_areas || '—'],
                ['Property Type', request.property_type || 'Any'],
                ['Min. Bedrooms', request.bedrooms_min ? `${request.bedrooms_min}+` : 'Any'],
                ['Timeline', request.timeline || '—']
            ])}
            ${p("Agents will review your request and send you introductions. You'll receive an email each time an agent connects with you — no cold calls, no pressure.")}
            ${btn(`${BASE_URL}/dashboard/buyer`, 'View My Dashboard')}
            ${divider()}
            ${p("Need to update your criteria? Log in to your dashboard at any time.")}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: request.email, subject: 'Your Buyer Agent Request Is Live on RealtorFinder', html: emailWrap('For Buyers', body) });
        } catch (error) { logSendgridError('Buyer request confirmation', error); }
    },

    // Notify buyer that a realtor has connected
    async sendRealtorBuyerLeadEmail(buyerEmail, buyerFirstName, realtor, message) {
        const realtorName = `${realtor.first_name || ''} ${realtor.last_name || ''}`.trim();
        const body = `
            ${h1(`A Buyer's Agent Wants to Help You 👋`)}
            ${p(`Hi ${buyerFirstName}, a licensed buyer's agent has reviewed your request and sent you an introduction.`)}
            <div style="background:#F8F6F3;border-left:4px solid #FF6B35;border-radius:0 10px 10px 0;padding:20px 24px;margin:24px 0;">
                <div style="font-weight:700;font-size:16px;color:#0A2540;margin-bottom:4px;">${realtorName}</div>
                ${realtor.license_number ? `<div style="font-size:13px;color:#666;margin-bottom:12px;">License #${realtor.license_number}${realtor.years_experience ? ` · ${realtor.years_experience} years experience` : ''}</div>` : ''}
                <p style="color:#444;font-size:14px;line-height:1.7;margin:0;font-style:italic;">"${message}"</p>
            </div>
            ${infoBox([
                ['Agent', realtorName],
                ['Email', `<a href="mailto:${realtor.email}" style="color:#FF6B35;text-decoration:none;">${realtor.email}</a>`],
                ...(realtor.phone ? [['Phone', `<a href="tel:${realtor.phone}" style="color:#FF6B35;text-decoration:none;">${realtor.phone}</a>`]] : []),
                ...(realtor.service_areas ? [['Service Areas', realtor.service_areas]] : [])
            ])}
            ${p("Reach out directly to learn more — or visit your dashboard to see all agent responses.")}
            ${btn(`${BASE_URL}/dashboard/buyer`, 'View All Responses')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: buyerEmail, subject: `${realtorName} wants to be your buyer's agent — RealtorFinder`, html: emailWrap('For Buyers', body) });
        } catch (error) { logSendgridError('Realtor buyer lead email', error); }
    },

    // ─── Listing Emails (Sellers) ─────────────────────────────────────────

    async sendListingConfirmation(listing) {
        const body = `
            ${h1("Your Listing Is Live! 🏠")}
            ${p(`Hi ${listing.owner_name}, your property has been listed on RealtorFinder. Licensed realtors can now submit proposals.`)}
            ${infoBox([
                ['Address', listing.address],
                ['Price', listing.price],
                ['Type', listing.property_type],
                ['Beds / Baths', `${listing.bedrooms} bd / ${listing.bathrooms} ba`]
            ])}
            ${p("You'll receive an email the moment a realtor submits a proposal. Review everything at your own pace — no pressure.")}
            ${btn(`${BASE_URL}/dashboard/seller`, 'View My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: listing.owner_email, subject: 'Your Property Is Live on RealtorFinder', html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Listing confirmation', error); }
    },

    async sendOfferNotification(listing, offer) {
        const body = `
            ${h1("New Proposal Received! 📬")}
            ${p(`Hi ${listing.owner_name}, a licensed realtor has submitted a proposal for your property at <strong>${listing.address}</strong>.`)}
            ${infoBox([
                ['Agent', offer.realtor_name],
                ['Brokerage', offer.brokerage],
                ['Email', `<a href="mailto:${offer.realtor_email}" style="color:#FF6B35;text-decoration:none;">${offer.realtor_email}</a>`],
                ['Phone', offer.realtor_phone],
                ...(offer.commission ? [['Commission', `${offer.commission}%`]] : [])
            ])}
            <div style="background:#F8F6F3;border-radius:10px;padding:20px 24px;margin:20px 0;border:1px solid #E5E1DB;">
                <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:8px;">Proposal Details</div>
                <p style="color:#444;font-size:14px;line-height:1.7;margin:0;white-space:pre-wrap;">${offer.offer_details}</p>
            </div>
            ${btn(`${BASE_URL}/dashboard/seller`, 'Review All Proposals')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: listing.owner_email, subject: `New Proposal from ${offer.realtor_name} — ${listing.address}`, html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Offer notification', error); }
    },

    // ─── Offer Emails (Realtors) ──────────────────────────────────────────

    async sendOfferConfirmation(listing, offer) {
        const body = `
            ${h1("Proposal Submitted ✅")}
            ${p(`Hi ${offer.realtor_name}, your proposal has been submitted to the seller at <strong>${listing.address}</strong>. They'll review it and reach out if interested.`)}
            ${infoBox([
                ['Property', listing.address],
                ['Listed Price', listing.price],
                ['Your Commission', offer.commission ? `${offer.commission}%` : 'N/A'],
                ['Submitted', new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })]
            ])}
            ${p("Keep browsing — there are more listings available in your area.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Browse More Listings')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: offer.realtor_email, subject: `Proposal Submitted — ${listing.address}`, html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Offer confirmation', error); }
    },

    async sendOfferAcceptedEmail(offer, listing) {
        const body = `
            ${h1("🏆 You've Been Selected!")}
            ${p(`Congratulations ${offer.realtor_name}! The seller has chosen your proposal for <strong>${listing.address}</strong>.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;text-align:center;">
                <div style="font-size:40px;margin-bottom:8px;">🏆</div>
                <div style="font-family:Georgia,serif;font-size:24px;font-weight:900;">You're the agent!</div>
                <div style="font-size:14px;opacity:0.8;margin-top:8px;">${listing.address}</div>
            </div>
            <p style="font-size:14px;font-weight:700;color:#0A2540;margin:0 0 8px;">Seller Contact Details:</p>
            ${infoBox([
                ['Seller', listing.owner_name],
                ['Email', `<a href="mailto:${listing.owner_email}" style="color:#FF6B35;text-decoration:none;">${listing.owner_email}</a>`],
                ['Phone', `<a href="tel:${listing.owner_phone}" style="color:#FF6B35;text-decoration:none;">${listing.owner_phone}</a>`]
            ])}
            ${p("The seller is expecting you to reach out. Contact them directly to move forward.")}
            ${btn(`mailto:${listing.owner_email}`, 'Contact Seller Now')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: offer.realtor_email, subject: `🏆 You've Been Selected — ${listing.address}`, html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Offer accepted email', error); }
    },

    async sendOfferDeclinedEmail(offer, listing) {
        const body = `
            ${h1("Update on Your Proposal")}
            ${p(`Hi ${offer.realtor_name}, the seller at <strong>${listing.address}</strong> has selected another agent for this listing.`)}
            ${p("Don't be discouraged — sellers choose based on the full picture and competition is healthy. There are plenty of motivated sellers on the platform looking for the right agent.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Browse More Listings')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: offer.realtor_email, subject: `Update on Your Proposal — ${listing.address}`, html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Offer declined email', error); }
    },

    // ─── Auth Emails ──────────────────────────────────────────────────────

    async sendPasswordResetEmail(email, resetUrl) {
        const body = `
            ${h1("Reset Your Password 🔐")}
            ${p("We received a request to reset your RealtorFinder password. Click the button below — this link expires in 1 hour.")}
            ${btn(resetUrl, 'Reset My Password')}
            ${p(`Or copy this link: <a href="${resetUrl}" style="color:#FF6B35;word-break:break-all;">${resetUrl}</a>`)}
            ${divider()}
            ${p("If you didn't request this, you can safely ignore this email.")}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Reset Your RealtorFinder Password', html: emailWrap(null, body) });
        } catch (error) { logSendgridError('Password reset email', error); throw error; }
    },

    async sendEmailVerification(email, verifyUrl) {
        const body = `
            ${h1("Verify Your Email ✉️")}
            ${p("Thanks for joining RealtorFinder! Please verify your email address to unlock all features.")}
            ${btn(verifyUrl, 'Verify My Email')}
            ${p(`Or copy this link: <a href="${verifyUrl}" style="color:#FF6B35;word-break:break-all;">${verifyUrl}</a>`)}
            ${divider()}
            ${p("This link expires in 48 hours.")}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Verify Your RealtorFinder Email', html: emailWrap(null, body) });
        } catch (error) { logSendgridError('Email verification', error); throw error; }
    },

    async sendNewListingAlert(realtor, listing, distanceMiles) {
        const price = listing.price ? '$' + Number(listing.price).toLocaleString() : 'Price not listed';
        const address = [listing.address, listing.city, listing.state].filter(Boolean).join(', ');
        const specs = [
            listing.bedrooms    ? `${listing.bedrooms} bed`  : null,
            listing.bathrooms   ? `${listing.bathrooms} bath` : null,
            listing.sqft        ? `${Number(listing.sqft).toLocaleString()} sqft` : null,
            listing.property_type || null
        ].filter(Boolean).join(' · ');
        const dist = distanceMiles != null ? `~${Math.round(distanceMiles)} miles from your ZIP` : 'In your area';
        const body = `
            ${h1('New Listing Near You 🏠')}
            ${p(`Hi ${realtor.first_name}, a seller just listed their home on RealtorFinder — and it's in your market.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:20px 24px;margin:20px 0;border:1px solid #E5E1DB;">
                <div style="font-size:18px;font-weight:700;color:#0A2540;margin-bottom:4px;">${address}</div>
                <div style="font-size:22px;font-weight:900;color:#FF6B35;font-family:Georgia,serif;margin-bottom:8px;">${price}</div>
                ${specs ? `<div style="color:#6B7280;font-size:14px;margin-bottom:8px;">${specs}</div>` : ''}
                <div style="display:inline-block;background:#E0F2FE;color:#0369a1;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;">📍 ${dist}</div>
            </div>
            ${p("The seller is reviewing proposals now. Submit yours to get in front of a motivated homeowner before other agents do.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Submit a Proposal')}
            ${divider()}
            <p style="color:#999;font-size:12px;margin:0;">You're receiving this because you're a RealtorFinder agent in this market. <a href="${BASE_URL}/dashboard/realtor" style="color:#FF6B35;">Manage preferences</a></p>
        `;
        try {
            await send({ to: realtor.email, subject: `New Listing Near You — ${address}`, html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('New listing alert', error); }
    },

    async sendContactEmail({ name, email, subject, message }) {
        const to = process.env.SENDGRID_FROM_EMAIL || 'hello@realtorfinder.net';
        const body = `
            ${h1('New Contact Form Submission')}
            ${infoBox([
                ['From', `${name} &lt;${email}&gt;`],
                ['Subject', subject],
                ['Email', `<a href="mailto:${email}" style="color:#FF6B35;text-decoration:none;">${email}</a>`]
            ])}
            <p style="font-size:0.8rem;color:#999;text-transform:uppercase;letter-spacing:0.06em;margin:24px 0 8px;">Message</p>
            <div style="background:#F8F6F3;border-radius:10px;padding:20px 24px;border:1px solid #E5E1DB;color:#444;font-size:15px;line-height:1.7;white-space:pre-wrap;">${String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">Reply directly to this email to respond to ${name}.</p>
        `;
        try {
            await send({
                to,
                replyTo: email,
                subject: `[Contact] ${subject} — from ${name}`,
                html: emailWrap('Contact Form', body)
            });
        } catch (error) { logSendgridError('Contact email', error); throw error; }
    },

    async sendSellerWeeklyDigest(seller) {
        const listingCount = parseInt(seller.listing_count) || 0;
        const newOffers = parseInt(seller.new_offers) || 0;
        const totalViews = parseInt(seller.total_views) || 0;
        const body = `
            ${h1(`Your Weekly RealtorFinder Update 📊`)}
            ${p(`Hi ${seller.first_name}, here's what happened with your listing${listingCount !== 1 ? 's' : ''} this week.`)}
            ${infoBox([
                ['Active Listings', String(listingCount)],
                ['New Proposals (7 days)', String(newOffers)],
                ['Total Listing Views', String(totalViews)]
            ])}
            ${newOffers > 0
                ? p(`You received <strong>${newOffers} new proposal${newOffers !== 1 ? 's' : ''}</strong> this week. Log in to review them and take action.`)
                : p(`No new proposals this week — your listing is still active and visible to realtors in your area.`)
            }
            ${btn(`${BASE_URL}/dashboard/seller`, 'View My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team<br>
            <a href="${BASE_URL}/dashboard/seller" style="color:#FF6B35;text-decoration:none;">Manage email preferences</a></p>
        `;
        try {
            await send({ to: seller.email, subject: `Your Weekly RealtorFinder Summary — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`, html: emailWrap('Weekly Update', body) });
        } catch (error) { logSendgridError('Seller weekly digest', error); }
    },

    async sendMessageNotification(recipientEmail, senderName, listingAddress) {
        const body = `
            ${h1("You Have a New Message 💬")}
            ${p(`You have a new message from <strong>${senderName}</strong>${listingAddress ? ` about <strong>${listingAddress}</strong>` : ''}.`)}
            ${p("Log in to your dashboard to read and reply.")}
            ${btn(`${BASE_URL}/dashboard/seller`, 'View My Messages')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: recipientEmail, subject: `New message from ${senderName} — RealtorFinder`, html: emailWrap('New Message', body) });
        } catch (error) { logSendgridError('Message notification', error); }
    },

    async sendListingAlert(userEmail, userName, searchLabel, matchingListings) {
        const listingsHtml = matchingListings.slice(0, 5).map(l => {
            const addr = [l.address, l.city, l.state].filter(Boolean).join(', ');
            const price = l.price ? '$' + Number(l.price).toLocaleString() : '—';
            const specs = [l.bedrooms ? l.bedrooms + ' bd' : null, l.bathrooms ? l.bathrooms + ' ba' : null].filter(Boolean).join(' · ');
            return `<div style="padding:12px 16px;border-bottom:1px solid #f0ece7;">
                <div style="font-weight:700;font-size:14px;color:#0A2540;margin-bottom:2px;">${addr}</div>
                <div style="font-size:18px;font-weight:900;color:#FF6B35;font-family:Georgia,serif;margin-bottom:4px;">${price}</div>
                ${specs ? `<div style="font-size:13px;color:#666;">${specs}</div>` : ''}
            </div>`;
        }).join('');
        const body = `
            ${h1('New Listings Match Your Search 🔍')}
            ${p(`Hi ${userName}, we found ${matchingListings.length} new listing${matchingListings.length !== 1 ? 's' : ''} matching your saved search <strong>"${searchLabel}"</strong>.`)}
            <div style="border:1px solid #E5E1DB;border-radius:10px;overflow:hidden;margin:24px 0;">
                ${listingsHtml}
            </div>
            ${btn(`${BASE_URL}/dashboard/buyer`, 'Browse Listings')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: userEmail, subject: `New listings match "${searchLabel}" — RealtorFinder`, html: emailWrap('Listing Alert', body) });
        } catch (error) { logSendgridError('Listing alert email', error); }
    },

    async sendAnnouncement(userEmail, userName, subject, messageBody) {
        const body = `
            ${h1(subject)}
            ${p(`Hi ${userName},`)}
            <div style="color:#444;font-size:15px;line-height:1.7;white-space:pre-wrap;">${String(messageBody).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team<br><a href="${BASE_URL}" style="color:#FF6B35;text-decoration:none;">realtorfinder.net</a></p>
        `;
        try {
            await send({ to: userEmail, subject, html: emailWrap(null, body) });
        } catch (error) { logSendgridError('Announcement email', error); }
    },

    async sendAccountApprovedEmail(email, firstName, userType) {
        const dashUrl = userType === 'realtor' ? `${BASE_URL}/dashboard/realtor` : `${BASE_URL}/dashboard/seller`;
        const roleLabel = userType === 'realtor' ? 'For Realtors' : 'For Sellers';
        const body = `
            ${h1("Your Account is Approved! 🎉")}
            ${p(`Hi ${firstName}, great news — your RealtorFinder account has been approved and you now have full access to the platform.`)}
            ${userType === 'realtor'
                ? p("Start browsing active listings in your area and submit your first proposal. Sellers are waiting to hear from qualified agents like you.")
                : p("You can now create your listing and start receiving proposals from qualified realtors in your area — completely free.")}
            ${btn(dashUrl, 'Go to My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: "You're approved — welcome to RealtorFinder!", html: emailWrap(roleLabel, body) });
        } catch (error) { logSendgridError('Account approved email', error); }
    },

    async sendListingExpiryWarning(sellerEmail, sellerName, listing) {
        try {
            const body = emailWrap('⚠️ Listing Expiring Soon',
                h1(`Your listing expires in 3 days`) +
                p(`Hi ${sellerName}, your RealtorFinder listing at <strong>${listing.address}, ${listing.city}, ${listing.state}</strong> will be automatically archived in 3 days if no realtor proposal has been accepted.`) +
                infoBox([
                    ['Address', `${listing.address}, ${listing.city}, ${listing.state}`],
                    ['Listed', new Date(listing.created_at).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'})],
                    ['Expires', new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'})],
                ]) +
                p(`To keep your listing active, log in and update your listing — this resets the 90-day clock. Or if you\'ve already found a great realtor, you can mark it as sold.`) +
                btn(`${BASE_URL}/dashboard/seller`, 'View My Listing →')
            );
            return await send({ to: sellerEmail, subject: `Your listing at ${listing.address} expires in 3 days`, html: body });
        } catch(err) { logSendgridError('sendListingExpiryWarning', err); }
    },

    async sendListingExpired(sellerEmail, sellerName, listing) {
        try {
            const body = emailWrap('📦 Listing Archived',
                h1(`Your listing has been archived`) +
                p(`Hi ${sellerName}, your RealtorFinder listing at <strong>${listing.address}, ${listing.city}, ${listing.state}</strong> has been archived after 90 days without an accepted proposal.`) +
                p(`You can relist your home at any time — it\'s always free for sellers.`) +
                btn(`${BASE_URL}/dashboard/seller`, 'Relist My Home →')
            );
            return await send({ to: sellerEmail, subject: `Your listing at ${listing.address} has been archived`, html: body });
        } catch(err) { logSendgridError('sendListingExpired', err); }
    },

    async sendBuyerMatchEmail(realtorEmail, realtorName, request) {
        try {
            const budget = [
                request.budget_min ? '$' + Number(request.budget_min).toLocaleString() : null,
                request.budget_max ? '$' + Number(request.budget_max).toLocaleString() : null,
            ].filter(Boolean).join(' – ') || 'Not specified';
            const body = emailWrap('🏡 New Buyer Match',
                h1(`A buyer is looking in your area`) +
                p(`Hi ${realtorName}, a buyer just submitted a request that matches your service area. Here are their details:`) +
                infoBox([
                    ['Target Areas', request.target_areas || '—'],
                    ['Property Type', request.property_type || 'Any'],
                    ['Budget', budget],
                    ['Min Bedrooms', request.bedrooms_min ? request.bedrooms_min + '+' : 'Any'],
                    ['Timeline', request.timeline || '—'],
                ]) +
                p(`Log in to your RealtorFinder dashboard to view this buyer request and respond directly.`) +
                btn(`${BASE_URL}/dashboard/realtor`, 'View Buyer Request →')
            );
            return await send({ to: realtorEmail, subject: `New buyer looking in ${request.target_areas || 'your area'}`, html: body });
        } catch(err) { logSendgridError('sendBuyerMatchEmail', err); }
    },

    // ─── Proposal Emails ─────────────────────────────────────────────────────

    async sendProposalNotification(sellerEmail, sellerName, listingAddress, realtorName, commissionPct) {
        const body = `
            ${h1('New Proposal Received! 📋')}
            ${p(`Hi ${sellerName}, <strong>${realtorName}</strong> has submitted a structured proposal for your property at <strong>${listingAddress}</strong>.`)}
            ${infoBox([
                ['Realtor', realtorName],
                ['Commission', `${commissionPct}%`],
                ['Property', listingAddress]
            ])}
            ${p('Log in to your seller dashboard to review all proposals — ranked by commission rate to help you find the best deal.')}
            ${btn(`${BASE_URL}/dashboard/seller`, 'Review Proposals')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: sellerEmail, subject: `New proposal from ${realtorName} — ${listingAddress}`, html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Proposal notification', error); }
    },

    async sendProposalAccepted(realtorEmail, realtorName, listingAddress) {
        const body = `
            ${h1('🏆 Your Proposal Was Accepted!')}
            ${p(`Congratulations ${realtorName}! The seller has accepted your proposal for <strong>${listingAddress}</strong>.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;text-align:center;">
                <div style="font-size:40px;margin-bottom:8px;">🏆</div>
                <div style="font-family:Georgia,serif;font-size:24px;font-weight:900;">You got the listing!</div>
                <div style="font-size:14px;opacity:0.8;margin-top:8px;">${listingAddress}</div>
            </div>
            ${p('The seller will be in touch shortly. Log in to your dashboard to see their contact details.')}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'View My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: realtorEmail, subject: `🏆 Proposal Accepted — ${listingAddress}`, html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Proposal accepted email', error); }
    },

    // ─── License Verification Emails ─────────────────────────────────────────

    async sendLicenseApproved(email, name) {
        const body = `
            ${h1('Your License Has Been Verified! ✅')}
            ${p(`Hi ${name}, great news — your real estate license document has been reviewed and verified by the RealtorFinder team.`)}
            <div style="background:linear-gradient(135deg,#d1fae5,#a7f3d0);border-radius:12px;padding:24px 32px;margin:24px 0;text-align:center;">
                <div style="font-size:40px;margin-bottom:8px;">✓</div>
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;color:#065f46;">License Verified</div>
                <div style="font-size:14px;color:#047857;margin-top:8px;">Your profile now displays a Verified License badge</div>
            </div>
            ${p("Your public profile now shows a green Verified License badge, which helps build trust with sellers browsing the platform.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'View My Profile')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'License Verified — RealtorFinder', html: emailWrap('License Verified', body) });
        } catch (error) { logSendgridError('License approved email', error); }
    },

    async sendLicenseRejected(email, name, note) {
        const body = `
            ${h1('Action Required: License Document')}
            ${p(`Hi ${name}, we were unable to verify your license document submission on RealtorFinder.`)}
            ${note ? `<div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:0 10px 10px 0;padding:16px 20px;margin:20px 0;"><div style="font-weight:700;font-size:13px;color:#b91c1c;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Reason</div><p style="color:#444;font-size:14px;margin:0;">${note}</p></div>` : ''}
            ${p("Please upload a clear, valid copy of your real estate license from your dashboard. Make sure the document is readable and shows your name, license number, and expiration date.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Re-upload License Document')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'License Document — Action Required', html: emailWrap('License Review', body) });
        } catch (error) { logSendgridError('License rejected email', error); }
    },

    // ─── Admin Moderation Emails ──────────────────────────────────────────────

    async sendListingRejected(sellerEmail, sellerName, listingAddress, note) {
        const body = `
            ${h1('Update on Your Listing')}
            ${p(`Hi ${sellerName}, your RealtorFinder listing at <strong>${listingAddress}</strong> has been reviewed by our team.`)}
            ${note ? `<div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:0 10px 10px 0;padding:16px 20px;margin:20px 0;"><div style="font-weight:700;font-size:13px;color:#b91c1c;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">Reason</div><p style="color:#444;font-size:14px;margin:0;">${note}</p></div>` : ''}
            ${p("If you have questions, please contact our support team by replying to this email.")}
            ${btn(`${BASE_URL}/dashboard/seller`, 'View My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: sellerEmail, subject: `Update on Your Listing — ${listingAddress}`, html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Listing rejected email', error); }
    },

    // ─── Drip Email Sequences ─────────────────────────────────────────────────

    // Seller drip: Step 1 — sent 1 day after signup
    async sendSellerDrip1(email, name) {
        const body = `
            ${h1('3 Tips to Attract Top Realtors to Your Listing')}
            ${p(`Hi ${name}, welcome to RealtorFinder! To help you get the most out of your listing, here are three things the best sellers do to attract competitive proposals from top realtors.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">1. Write a Clear, Honest Description</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Realtors review dozens of listings. A detailed description — recent upgrades, neighborhood highlights, schools, proximity to amenities — signals that you're a serious seller and helps agents pitch your home confidently.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">2. Price it Realistically</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Realtors know the market. Listings priced in line with recent comparables attract more proposals — and better ones. If you're unsure, let the proposals come in and use them as a data point.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">3. Be Responsive</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Realtors who submit proposals are actively interested. The sellers who respond quickly to agent questions get better follow-up and ultimately better outcomes. Check your dashboard daily.</p>
                </div>
            </div>
            ${p("Your listing is working for you right now. Log in to see the proposals coming in and read each agent's cover note carefully.")}
            ${btn(`${BASE_URL}/dashboard/seller`, 'View My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: '3 tips to attract top realtors to your listing', html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Seller drip 1', error); }
    },

    // Seller drip: Step 2 — sent 3 days after signup
    async sendSellerDrip2(email, name) {
        const body = `
            ${h1('How to Evaluate Realtor Proposals on RealtorFinder')}
            ${p(`Hi ${name}, as proposals come in, you'll want to compare them thoughtfully. Here's what to look for beyond the commission rate.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Commission Rates</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Most listing agents charge 2–3% of the sale price. A lower rate isn't always better — consider what's included. Some agents offer full-service marketing at 2.5%; others at 3% may provide a more hands-on approach.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Cover Notes</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Read each agent's proposal note carefully. The best realtors personalize their pitch — they'll reference your specific home, neighborhood, and local market conditions. Generic notes are a red flag.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Timeline Expectations</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Does the agent's timeline match yours? If you need to sell quickly, look for agents who specialize in fast listings. If you're willing to wait for the right price, an agent with a longer runway strategy may serve you better.</p>
                </div>
            </div>
            ${p("Take your time — there's no rush to accept the first proposal. The right match between seller and agent makes all the difference.")}
            ${btn(`${BASE_URL}/dashboard/seller`, 'Review My Proposals')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'How to evaluate realtor proposals on RealtorFinder', html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Seller drip 2', error); }
    },

    // Seller drip: Step 3 — sent 7 days after signup
    async sendSellerDrip3(email, name) {
        const body = `
            ${h1('Your Listing Is Working for You — Here\'s What\'s Next')}
            ${p(`Hi ${name}, your listing has been live for a week now. Here's a quick guide to the next steps so you're ready when the right proposal comes in.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Messaging Realtors</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">You can message any realtor who has submitted a proposal directly through your dashboard. Ask about their marketing strategy, recent sales in your area, or anything else that matters to you.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Accepting a Proposal</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">When you're ready, click "Accept" on any proposal. The realtor will receive your contact information immediately and will reach out to schedule a consultation and begin the listing process.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">After Acceptance</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Once you've accepted a proposal and sold your home, you can mark your listing as sold from your dashboard. This removes it from the active listings and notifies any remaining agents — keeping the platform clean and professional.</p>
                </div>
            </div>
            ${p("Questions? Just reply to this email — we're here to help you find the right agent.")}
            ${btn(`${BASE_URL}/dashboard/seller`, 'Go to My Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Your listing is working for you — here\'s what\'s next', html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Seller drip 3', error); }
    },

    // Realtor drip: Step 1 — sent 1 day after signup
    async sendRealtorDrip1(email, name) {
        const body = `
            ${h1('How to Win Listings on RealtorFinder')}
            ${p(`Hi ${name}, welcome to RealtorFinder! You now have direct access to motivated sellers who are actively looking for an agent. Here's how to stand out from the competition.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Write a Compelling Proposal</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Sellers read every proposal. The ones that win reference the specific home, neighborhood, and why you — specifically — are the right agent for that listing. Avoid copy-paste pitches. Show you've done your homework.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Set the Right Commission</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Competitive doesn't mean lowest. A 2.5% proposal with a strong pitch often beats a 2% proposal with no context. Be clear about what's included — photography, staging consultations, digital marketing, open houses.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Complete Your Profile First</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Before submitting proposals, make sure your profile is complete. Sellers click through to review your background. A photo, bio, and verified license build trust before you even say a word.</p>
                </div>
            </div>
            ${p("New listings are added daily. Log in to browse what's available in your area and submit your first proposal today.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Browse Active Listings')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'How to win listings on RealtorFinder', html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Realtor drip 1', error); }
    },

    // Realtor drip: Step 2 — sent 3 days after signup
    async sendRealtorDrip2(email, name) {
        const body = `
            ${h1('Your Profile Is Your First Impression')}
            ${p(`Hi ${name}, before a seller reads your proposal, they often check your profile. Here's how to make sure it works in your favor.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Profile Photo</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Profiles with a professional headshot get significantly more clicks. Use a clear, recent photo — not a logo. Sellers are choosing someone to trust with their most valuable asset; a real face matters.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Bio and Service Areas</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Write a 2–3 sentence bio that highlights your experience, specialty, and local market knowledge. Add your service areas — this is how we match you to buyer requests in your territory.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">License Verification</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Upload your license document to get the Verified License badge on your profile. This badge is a strong trust signal — sellers specifically look for it when comparing agents.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Your First Review</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Already worked with a past seller? Ask them to leave a review on your RealtorFinder profile. Verified Sale reviews are prominently displayed and carry significant weight with prospective sellers.</p>
                </div>
            </div>
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Update My Profile')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Your profile is your first impression', html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Realtor drip 2', error); }
    },

    // Realtor drip: Step 3 — sent 7 days after signup
    async sendRealtorDrip3(email, name) {
        const body = `
            ${h1('Buyer Requests — A New Source of Leads')}
            ${p(`Hi ${name}, in addition to seller listings, RealtorFinder has a second source of leads you may not have explored yet: buyer requests.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">What Are Buyer Requests?</div>
                <p style="font-size:14px;line-height:1.8;opacity:0.9;margin:0;">Buyers post what they're looking for — budget, target areas, property type, timeline — and agents respond directly. It's the reverse of the traditional model: instead of prospecting for buyers, motivated buyers come to you.</p>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">How Matching Works</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">When a buyer posts a request in your service areas, you'll receive an email notification and an in-app alert. You can also browse all active requests from your dashboard and filter by location, budget, and property type.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">How to Respond</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Click into any buyer request and submit a brief introduction — who you are, your experience in their target area, and why you'd be a great fit. The buyer reviews all responses and reaches out to the agents they want to connect with.</p>
                </div>
            </div>
            ${p("Buyer requests are a great way to build pipeline when the seller listing market is slow. Check your dashboard now to see what's active in your area.")}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'Browse Buyer Requests')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Buyer requests — a new source of leads', html: emailWrap('For Realtors', body) });
        } catch (error) { logSendgridError('Realtor drip 3', error); }
    },

    // Buyer drip: Step 1 — sent 1 day after signup
    async sendBuyerDrip1(email, name) {
        const body = `
            ${h1('How to Find Your Perfect Home on RealtorFinder')}
            ${p(`Hi ${name}, welcome to RealtorFinder! Here's a quick guide to getting the most out of the platform as you search for your next home.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Browse Listings</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Head to your dashboard to browse active listings from motivated sellers. Every home on RealtorFinder is listed by a real seller — no phantom listings, no stale data.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Use the Map View</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Switch to map view to see listings plotted by location. This is especially useful if you're looking in a specific school district, neighborhood, or within a certain commute radius.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Filter by What Matters</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Narrow down results by number of bedrooms, bathrooms, price range, zip code, and property type. Save your search criteria to get notified when new matching listings come in.</p>
                </div>
            </div>
            ${p("Start with a broad search and narrow from there. The right home is out there — let's find it.")}
            ${btn(`${BASE_URL}/dashboard/buyer`, 'Browse Listings Now')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'How to find your perfect home on RealtorFinder', html: emailWrap('For Buyers', body) });
        } catch (error) { logSendgridError('Buyer drip 1', error); }
    },

    // Buyer drip: Step 2 — sent 3 days after signup
    async sendBuyerDrip2(email, name) {
        const body = `
            ${h1('Post a Buyer Request — Let Realtors Come to You')}
            ${p(`Hi ${name}, did you know you can post a buyer request on RealtorFinder and have licensed agents reach out to you directly? It's one of the most powerful features on the platform — and it's completely free for buyers.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">How Buyer Requests Work</div>
                <div style="font-size:14px;line-height:2;opacity:0.9;">
                    1. &nbsp;Post your criteria — budget, areas, property type, timeline<br>
                    2. &nbsp;Licensed buyer's agents in your target areas see your request<br>
                    3. &nbsp;Agents who specialize in what you need send you introductions<br>
                    4. &nbsp;You review and choose who to connect with — no pressure
                </div>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:8px;">What to Include in Your Request</div>
                <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Be as specific as possible about your budget range, target neighborhoods or zip codes, minimum bedroom/bathroom count, and your timeline (are you ready to move in 30 days, or still in the early research phase?). The more detail you provide, the better the agents who respond will be matched to your needs.</p>
            </div>
            ${p("It takes less than 2 minutes to post a request — and it could save you weeks of searching on your own.")}
            ${btn(`${BASE_URL}/dashboard/buyer`, 'Post a Buyer Request')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Post a buyer request — let realtors come to you', html: emailWrap('For Buyers', body) });
        } catch (error) { logSendgridError('Buyer drip 2', error); }
    },

    // Buyer drip: Step 3 — sent 7 days after signup
    async sendBuyerDrip3(email, name) {
        const body = `
            ${h1('How to Choose the Right Realtor')}
            ${p(`Hi ${name}, whether you're browsing listings or comparing agents who responded to your buyer request, choosing the right realtor is one of the most important decisions in your home purchase. Here's what to look for.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Browse the Realtor Directory</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">RealtorFinder has a searchable directory of all agents on the platform. You can filter by service area and compare profiles side by side before reaching out. Use it to research any agent who contacts you.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">What the Verified License Badge Means</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Agents with a green Verified License badge have had their real estate license document reviewed and confirmed by the RealtorFinder team. Always prefer working with a verified agent — it's a simple but important layer of protection.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">How to Read Reviews</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Reviews marked "Verified Sale" are from real sellers who transacted through the platform. These carry more weight than generic ratings. Look for specifics — how did the agent handle negotiations, communication, and closing-day surprises?</p>
                </div>
            </div>
            ${p("Take your time, compare a few agents, and don't feel pressured to commit before you're comfortable. The right agent will feel like a partner, not a salesperson.")}
            ${btn(`${BASE_URL}/realtors/directory`, 'Browse the Realtor Directory')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'How to choose the right realtor', html: emailWrap('For Buyers', body) });
        } catch (error) { logSendgridError('Buyer drip 3', error); }
    },

    // ─── Review Request Emails ────────────────────────────────────────────────

    async sendReviewRequestEmail(sellerEmail, sellerName, realtorId, realtorName, listingAddress) {
        const reviewUrl = `${BASE_URL}/realtor/${realtorId}?review=1`;
        const body = `
            ${h1('How Was Your Experience? ⭐')}
            ${p(`Hi ${sellerName}, your property at <strong>${listingAddress}</strong> has been marked as sold. Congratulations!`)}
            ${p(`We'd love to hear about your experience working with <strong>${realtorName}</strong>. Your honest review helps other sellers choose the right agent.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px;margin:24px 0;border:1px solid #E5E1DB;text-align:center;">
                <div style="font-size:32px;margin-bottom:12px;">⭐⭐⭐⭐⭐</div>
                <div style="font-size:16px;color:#0A2540;font-weight:600;margin-bottom:8px;">Leave a Review for ${realtorName}</div>
                <div style="font-size:13px;color:#6B7280;">Takes less than 2 minutes</div>
            </div>
            ${btn(reviewUrl, 'Write My Review')}
            ${divider()}
            ${p('Your review will earn a "✓ Verified Sale" badge — showing other sellers this is based on a real transaction.')}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: sellerEmail, subject: `How was working with ${realtorName}? Leave a review`, html: emailWrap('For Sellers', body) });
        } catch (error) { logSendgridError('Review request email', error); }
    },
};

module.exports = emailService;
