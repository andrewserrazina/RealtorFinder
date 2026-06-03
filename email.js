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
function emailWrap(accentBar, bodyHtml, unsubscribeUrl = null) {
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
            ${unsubscribeUrl ? `<p style="color:#bbb;font-size:11px;margin:6px 0 0;"><a href="${unsubscribeUrl}" style="color:#bbb;text-decoration:underline;">Unsubscribe from marketing emails</a></p>` : ''}
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

    // ─── Drip Email Sequences (Pre-Launch) ───────────────────────────────────────
    // These are warm waitlist drips. Replace with live-platform drips after August 2026 launch.

    // Seller drip: Step 1 — sent 1 day after signup
    async sendSellerDrip1(email, name, unsubscribeToken) {
        const body = `
            ${h1('The Way People Sell Homes Is About to Change')}
            ${p(`Hi ${name}, thanks for joining the RealtorFinder waitlist. We wanted to share a little about why we're building this — because we think it matters.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">The Problem We're Solving</div>
                <p style="font-size:14px;line-height:1.8;opacity:0.9;margin:0;">Right now, if you want to sell your home, you either cold-call agents, rely on referrals from friends, or get bombarded with unsolicited outreach from agents who bought your information. None of that feels right. You're making one of the biggest financial decisions of your life — you deserve to be the one in control.</p>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">How RealtorFinder Flips the Script</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">On RealtorFinder, you post your home. Agents come to you — with their commission rates, marketing plans, and a personal pitch for why they're the right fit. You compare them side by side, message the ones you like, and choose on your terms. No pressure. No cold calls.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">It's Completely Free for Sellers</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Listing your home on RealtorFinder costs nothing. We charge agents for access — not sellers. That means we're fully incentivized to bring you the best possible proposals, not the highest-paying advertisers.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">You're Already Ahead</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">By joining the waitlist now, you'll be among the first sellers on the platform when we launch in August 2026. That means more agent competition for your listing — and better proposals for you.</p>
                </div>
            </div>
            ${p("We'll keep you posted as we get closer to launch. In the meantime, if you have questions or want to share feedback, just reply to this email — we read every one.")}
            ${btn(`${BASE_URL}/sellers`, 'Learn More About RealtorFinder')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'The way people sell homes is about to change', html: emailWrap('For Sellers', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Seller drip 1', error); }
    },

    // Seller drip: Step 2 — sent 3 days after signup
    async sendSellerDrip2(email, name, unsubscribeToken) {
        const body = `
            ${h1('What Selling on RealtorFinder Will Look Like')}
            ${p(`Hi ${name}, we're getting close to our August 2026 launch, and we wanted to give you a preview of exactly what the experience will look like for sellers.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Post Your Listing in Minutes</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Add your address, a description, photos, and your ideal timeline. That's it. Your listing goes live on the platform and verified, local agents can immediately start submitting proposals. No sign-in required for agents to see your home — but you stay anonymous until you choose to connect.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Your Proposals Inbox</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Every agent who wants to represent your listing submits a formal proposal — their commission rate, marketing strategy, timeline estimate, and a personal note to you. You see all of them in one inbox, sorted by recency or commission rate. No phone tag. No pressure to decide on the spot.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Message Any Agent, Free</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Before accepting, you can message any agent directly from your dashboard to ask questions, request references, or get more detail on their marketing plan. You're in control of the conversation from start to finish.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Accept When You're Ready</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">When you find the right agent, accept their proposal. They'll receive your contact information immediately and reach out to begin the listing process. If the relationship doesn't feel right, you can explore other proposals at any time.</p>
                </div>
            </div>
            ${p("This is how selling a home should feel — you in the driver's seat, with qualified agents competing for your business.")}
            ${btn(`${BASE_URL}/sellers`, 'See Everything RealtorFinder Offers Sellers')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'What selling on RealtorFinder will look like', html: emailWrap('For Sellers', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Seller drip 2', error); }
    },

    // Seller drip: Step 3 — sent 7 days after signup
    async sendSellerDrip3(email, name, unsubscribeToken) {
        const body = `
            ${h1('We\'re Launching August 2026 — Here\'s What to Expect')}
            ${p(`Hi ${name}, we're in the final stretch before our August 2026 launch and wanted to share a quick update on where things stand — and what happens for you on day one.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">What Happens at Launch</div>
                <div style="font-size:14px;line-height:2;opacity:0.9;">
                    &bull; &nbsp;Your account activates and you can post your listing immediately<br>
                    &bull; &nbsp;Hundreds of pre-registered agents gain access on day one<br>
                    &bull; &nbsp;Proposals can start coming in within hours of your listing going live<br>
                    &bull; &nbsp;Messaging, comparisons, and acceptances all work from day one
                </div>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Early Sellers Get More Competition</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Agents are hungry for listings at launch. Being an early seller means your listing will see more agent competition — which means more proposals, more options, and a better outcome for you.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Spread the Word</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Know someone thinking about selling? Send them to RealtorFinder.com to join the waitlist. More sellers at launch means more realtors compete — which is good for everyone on the seller side.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Questions Before Launch?</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Just reply to this email. We're a small, founder-led team and we personally read every message. Your feedback is shaping the platform you'll use in August — it genuinely matters to us.</p>
                </div>
            </div>
            ${p("Thank you for being part of this early on. We can't wait to show you what we've built.")}
            ${btn(`${BASE_URL}/sellers`, 'Learn More About RealtorFinder')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'RealtorFinder launches August 2026 — here\'s what to expect', html: emailWrap('For Sellers', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Seller drip 3', error); }
    },

    // Realtor drip: Step 1 — sent 1 day after signup
    async sendRealtorDrip1(email, name, unsubscribeToken) {
        const body = `
            ${h1('The Lead Generation Model Is Broken. We\'re Fixing It.')}
            ${p(`Hi ${name}, thanks for joining the RealtorFinder waitlist. Before we tell you what we're building, we want to acknowledge something most platforms won't say out loud.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">The Problem With How Leads Work Today</div>
                <p style="font-size:14px;line-height:1.8;opacity:0.9;margin:0;">Lead aggregators charge hundreds — sometimes thousands — per month for names that get sold to five other agents at the same time. Cold calls, mass emails, and bought lists have trained sellers to ignore agent outreach entirely. The people who benefit most from the current model are the platforms, not the agents.</p>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">What We're Building Instead</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">RealtorFinder inverts the model. Sellers post their homes on our platform, and agents submit proposals directly to those sellers. Every lead is a real person who has already raised their hand and said "I want to sell." You're not cold-calling — you're competing on merit.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">No Per-Lead Fees</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Your subscription gives you unlimited access to every seller listing in your service areas. We don't charge you more when a seller accepts your proposal. We don't auction the same lead to multiple agents. You subscribe once and compete on an even playing field.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">You Win Based on Your Pitch, Not Your Budget</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Sellers read every proposal. They compare commission rates, cover notes, and agent profiles. The best agents — not the highest spenders — win listings on RealtorFinder. That's the whole point.</p>
                </div>
            </div>
            ${p("We're launching in August 2026. As a waitlist member, you'll get early access and founding member benefits. More on that in the next few days.")}
            ${btn(`${BASE_URL}/realtors`, 'See Everything RealtorFinder Offers Realtors')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'The lead generation model is broken. We\'re fixing it.', html: emailWrap('For Realtors', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Realtor drip 1', error); }
    },

    // Realtor drip: Step 2 — sent 3 days after signup
    async sendRealtorDrip2(email, name, unsubscribeToken) {
        const body = `
            ${h1('What You\'ll Be Able to Do on RealtorFinder at Launch')}
            ${p(`Hi ${name}, we wanted to give you a concrete preview of what RealtorFinder will look like when we open the doors in August 2026.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Browse Motivated Seller Listings</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Your dashboard shows every active seller listing in your service areas — filter by price range, property type, timeline, and more. Every listing is from a real seller who posted intentionally. No cold leads. No phantom inventory.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Submit Proposals That Stand Out</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Click into any listing and submit a proposal — your commission rate, a marketing plan overview, timeline estimate, and a personal cover note. Save proposal templates to make it faster without sacrificing quality. The sellers who accept proposals overwhelmingly cite personalization as the deciding factor.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Respond to Buyer Requests</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Beyond seller listings, buyers can post requests describing what they're looking for — budget, target areas, property type, timeline. You receive alerts when a buyer request matches your service areas and can respond directly. It's motivated buyer pipeline, delivered to you.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">A Profile That Works for You</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Your public RealtorFinder profile includes your photo, bio, service areas, verified license badge, past sale reviews, and — for Professional and Firm subscribers — a banner image and video introduction. Sellers research agents before accepting. Your profile is your pitch before you've said a word.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Proposal Analytics</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">See which proposals are being viewed, which sellers have messaged you back, and how your acceptance rate compares over time. Use it to sharpen your pitches and win more listings.</p>
                </div>
            </div>
            ${p("Every one of these features will be live at launch. We're building them right now — and your feedback has already shaped several of them.")}
            ${btn(`${BASE_URL}/realtors`, 'Preview the Full Platform')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'What you\'ll be able to do on RealtorFinder at launch', html: emailWrap('For Realtors', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Realtor drip 2', error); }
    },

    // Realtor drip: Step 3 — sent 7 days after signup
    async sendRealtorDrip3(email, name, unsubscribeToken) {
        const body = `
            ${h1('Your Founding Member Spot — and What It Means at Launch')}
            ${p(`Hi ${name}, we're now a week out from when you joined the waitlist. We wanted to make sure you know exactly what your founding member status gets you when we launch in August 2026.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:16px;">Founding Realtor Benefits</div>
                <div style="font-size:14px;line-height:2.2;opacity:0.9;">
                    <div style="margin-bottom:10px;"><span style="background:#FF6B35;color:white;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;margin-right:8px;">FREE</span> 2 full months of Professional plan — applied automatically at launch</div>
                    <div style="margin-bottom:10px;"><span style="background:#FF6B35;color:white;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;margin-right:8px;">BADGE</span> Permanent "Founding Realtor" badge on your public profile</div>
                    <div style="margin-bottom:10px;"><span style="background:#FF6B35;color:white;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;margin-right:8px;">EARLY</span> Priority access before general public — you'll be set up before the flood of sign-ups</div>
                    <div><span style="background:#FF6B35;color:white;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;margin-right:8px;">RATE</span> Introductory pricing locked in for as long as you stay subscribed</div>
                </div>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Why Two Months of Professional?</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Professional includes unlimited proposals, buyer request responses, priority placement in seller search results, banner image, video intro, and advanced analytics. We want you to experience the full platform — not just the baseline. Two months free gives you enough time to win your first few listings and see the ROI clearly.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Earn More Credits by Referring</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Every realtor you refer who joins the waitlist earns you additional platform credits at launch — redeemable against your subscription or lead credits. The more you spread the word, the more runway you have on day one.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">We Launch August 2026</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">You'll receive an email the moment your account is ready to activate. Until then, your spot is held, your founding status is locked in, and we're building the best version of this platform we can — for you.</p>
                </div>
            </div>
            ${p("Questions? Just reply. We're a small team and we're reachable.")}
            ${btn(`${BASE_URL}/waitlist`, 'Check Your Waitlist Status & Referrals')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'Your founding member benefits at launch', html: emailWrap('For Realtors', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Realtor drip 3', error); }
    },

    // Buyer drip: Step 1 — sent 1 day after signup
    async sendBuyerDrip1(email, name, unsubscribeToken) {
        const body = `
            ${h1('A Smarter Way to Find a Home — and an Agent')}
            ${p(`Hi ${name}, thanks for joining the RealtorFinder waitlist. We're building something that we think will make the home buying process feel a lot less stressful — and we wanted to share the thinking behind it.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">Why Buying a Home Feels So Overwhelming</div>
                <p style="font-size:14px;line-height:1.8;opacity:0.9;margin:0;">Finding a home involves navigating listings from a dozen different sites, fielding cold calls from agents who got your number somehow, and trying to figure out who to trust — all while making one of the biggest financial decisions of your life. It shouldn't be this hard.</p>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Real Seller Listings, No Phantom Data</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Every listing on RealtorFinder is posted directly by a real seller. No stale data pulled from public records. No phantom listings recycled from other platforms. When you see a home on RealtorFinder, that seller is actively looking for an agent right now.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Verified Agents Only</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Every agent on RealtorFinder has been approved and verified by our team. No anonymous listings. No unvetted contacts. You can browse agent profiles, read real reviews from past sellers, and see their license verification status before you ever respond to one.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Free for Buyers, Always</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">We charge agents for access to the platform — not buyers. Using RealtorFinder as a buyer will always be completely free. We're on your side.</p>
                </div>
            </div>
            ${p("We launch in August 2026 — and you'll be among the first buyers to access the platform. We'll keep you updated as we get closer.")}
            ${btn(`${BASE_URL}/buyers`, 'Learn More About RealtorFinder for Buyers')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'A smarter way to find a home — and an agent', html: emailWrap('For Buyers', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Buyer drip 1', error); }
    },

    // Buyer drip: Step 2 — sent 3 days after signup
    async sendBuyerDrip2(email, name, unsubscribeToken) {
        const body = `
            ${h1('The Feature That Changes Everything for Buyers')}
            ${p(`Hi ${name}, we want to tell you about one of the features we're most excited about for buyers at launch — buyer requests.`)}
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;">
                <div style="font-family:Georgia,serif;font-size:20px;font-weight:900;margin-bottom:12px;">What Are Buyer Requests?</div>
                <p style="font-size:14px;line-height:1.8;opacity:0.9;margin:0;">Instead of you hunting for agents, you post what you're looking for — your budget, target areas, property type, and timeline — and licensed buyer's agents who specialize in exactly that reach out to you. You get introductions from qualified agents who actually want your business. You choose who to respond to. No cold calls. No pressure.</p>
            </div>
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">How It Works at Launch</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Post your criteria in under 2 minutes. Agents in your target areas see your request and can send you a brief introduction — who they are, why they're a good fit, their experience in your target neighborhoods. You review at your own pace and connect with the ones that feel right.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Search Listings While You Wait</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">While your buyer request is live, you can also browse seller listings directly. Every home on the platform is from a motivated seller — filter by location, price range, bedrooms, property type, and more. Find a home you love and your matched agent can move fast.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Compare Agents Side by Side</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Every agent profile includes their bio, service areas, years of experience, verified license badge, and reviews from past clients. You can compare two agents side by side before deciding who to work with. No guessing. No relying on referrals from people who haven't bought a home in 10 years.</p>
                </div>
            </div>
            ${p("This is what buying a home should feel like. We can't wait to show you in August.")}
            ${btn(`${BASE_URL}/buyers`, 'See What\'s Coming for Buyers')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'The feature that changes everything for buyers', html: emailWrap('For Buyers', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
        } catch (error) { logSendgridError('Buyer drip 2', error); }
    },

    // Buyer drip: Step 3 — sent 7 days after signup
    async sendBuyerDrip3(email, name, unsubscribeToken) {
        const body = `
            ${h1('August 2026 — What Buyers Get on Day One')}
            ${p(`Hi ${name}, we're a week into your waitlist journey and we wanted to give you a full picture of what's waiting for you when RealtorFinder launches in August 2026.`)}
            <div style="background:#F8F6F3;border-radius:12px;padding:24px 28px;margin:24px 0;border:1px solid #E5E1DB;">
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Instant Access to Seller Listings</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">The moment you log in, you'll see real seller listings from motivated homeowners in your area. Browse by price, bedrooms, location, or property type. Save searches and get notified when new listings match your criteria.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">Post a Buyer Request in 2 Minutes</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Tell us what you're looking for and let agents come to you. Your request goes live to all verified agents in your target areas immediately. Expect introductions within 24 hours of launch.</p>
                </div>
                <div style="margin-bottom:20px;">
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">A Searchable Realtor Directory</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Search all verified agents by location, specialty, and rating. Read reviews from real sellers, check license verification, and view full profiles before you ever reach out. Know exactly who you're talking to.</p>
                </div>
                <div>
                    <div style="font-size:15px;font-weight:700;color:#0A2540;margin-bottom:6px;">All of It, Free for Buyers</div>
                    <p style="color:#444;font-size:14px;line-height:1.7;margin:0;">Listings, buyer requests, agent search, messaging — all free for buyers, forever. RealtorFinder makes money from agents, not from people trying to buy a home.</p>
                </div>
            </div>
            <div style="background:linear-gradient(135deg,#0A2540,#0d3659);border-radius:12px;padding:28px 32px;margin:24px 0;color:white;text-align:center;">
                <div style="font-family:Georgia,serif;font-size:18px;font-weight:900;margin-bottom:10px;">Know someone looking to buy or sell?</div>
                <p style="font-size:14px;line-height:1.7;opacity:0.9;margin:0 0 16px;">Send them to RealtorFinder.com to join the waitlist. The more people who sign up early, the stronger our launch — and the more options you'll have from day one.</p>
            </div>
            ${p("We'll send you one final email the week before launch with everything you need to hit the ground running. Thank you for being here early.")}
            ${btn(`${BASE_URL}/buyers`, 'Learn More About RealtorFinder')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: email, subject: 'August 2026 — what buyers get on day one', html: emailWrap('For Buyers', body, unsubscribeToken ? `${BASE_URL}/unsubscribe/${unsubscribeToken}` : null) });
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

    async sendProposalViewed(realtorEmail, realtorName, listingAddress) {
        const body = `
            ${h1('A Seller Viewed Your Proposal 👀')}
            ${p(`Hi ${realtorName}, a seller just viewed your proposal on <strong>${listingAddress}</strong>.`)}
            ${p(`They may be comparing proposals right now — make sure your cover note stands out.`)}
            ${btn(`${BASE_URL}/dashboard`, 'View My Proposals')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: realtorEmail, subject: `A seller viewed your proposal on ${listingAddress}`, html: emailWrap('For Realtors', body) });
        } catch (err) { logSendgridError('Proposal viewed email', err); }
    },

    // ─── Showing Request Emails ───────────────────────────────────────────────

    async sendShowingRequest(recipientEmail, recipientName, buyerName, listingAddress, date, time, message) {
        const body = `
            ${h1('New Showing Request 🏠')}
            ${p(`Hi ${recipientName}, a showing has been requested for <strong>${listingAddress}</strong>.`)}
            ${infoBox([
                ['Buyer', buyerName],
                ['Date', date],
                ['Time', time],
                ['Message', message || '(none)']
            ])}
            ${btn(`${BASE_URL}/dashboard/seller`, 'View Showing Requests')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: recipientEmail, subject: `Showing Request — ${listingAddress}`, html: emailWrap('Showing Request', body) });
        } catch (error) { logSendgridError('Showing request email', error); }
    },

    async sendShowingConfirmed(buyerEmail, buyerName, listingAddress, date, time) {
        const body = `
            ${h1('Your Showing is Confirmed! ✅')}
            ${p(`Hi ${buyerName}, great news — your showing request has been confirmed.`)}
            ${infoBox([
                ['Property', listingAddress],
                ['Date', date],
                ['Time', time],
                ['Status', 'Confirmed']
            ])}
            ${btn(`${BASE_URL}/dashboard/buyer`, 'View My Showings')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: buyerEmail, subject: `Showing Confirmed — ${listingAddress}`, html: emailWrap('Confirmed', body) });
        } catch (error) { logSendgridError('Showing confirmed email', error); }
    },

    async sendShowingCancelled(recipientEmail, recipientName, listingAddress, date, time) {
        const body = `
            ${h1('Showing Cancelled')}
            ${p(`Hi ${recipientName}, a showing has been cancelled.`)}
            ${infoBox([
                ['Property', listingAddress],
                ['Date', date],
                ['Time', time],
                ['Status', 'Cancelled']
            ])}
            ${btn(`${BASE_URL}/dashboard/seller`, 'View Your Dashboard')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: recipientEmail, subject: `Showing Cancelled — ${listingAddress}`, html: emailWrap('Cancelled', body) });
        } catch (error) { logSendgridError('Showing cancelled email', error); }
    },

    async sendCounterOffer(toEmail, realtorName, listingAddress, counterPct, message) {
        const body = emailWrap('Counter-Offer',
            h1('Counter-Offer Received') +
            p(`Hi ${realtorName}, the seller has countered your proposal on <strong>${listingAddress}</strong>.`) +
            infoBox([
                ['Requested commission', `${counterPct}%`],
                ...(message ? [['Seller note', message]] : []),
            ]) +
            p('Log in to accept or decline this counter-offer.') +
            btn(`${BASE_URL}/dashboard/realtor`, 'Respond to Counter-Offer')
        );
        return await send({ to: toEmail, subject: `Counter-offer on ${listingAddress}`, html: body });
    },

    async sendWeeklyDigest(toEmail, firstName, data, unsubToken) {
        // data: { newListings, proposalsWon, profileViews7d, serviceAreas }
        const unsubUrl = `${BASE_URL}/unsubscribe?token=${unsubToken}`;
        const listingItems = (data.newListings || []).slice(0, 5).map(l =>
            `<li style="margin-bottom:8px;"><a href="${BASE_URL}/listings/${l.id}" style="color:#FF6B35;font-weight:600;">${l.address}, ${l.city}, ${l.state}</a> — ${l.bedrooms}bd/${l.bathrooms}ba · $${Number(l.price).toLocaleString()}</li>`
        ).join('');
        const body = emailWrap('Weekly Digest',
            h1(`Your Weekly Market Digest`) +
            p(`Hi ${firstName}, here's what happened in your markets this week.`) +
            infoBox([
                ['New listings in your area', String(data.newListingCount || 0)],
                ['Profile views (7 days)', String(data.profileViews7d || 0)],
                ['Proposals won this week', String(data.proposalsWon || 0)],
                ['Service areas', (data.serviceAreas || '—')],
            ]) +
            (listingItems ? `<div style="margin:24px 0;"><div style="font-weight:700;font-size:1rem;margin-bottom:12px;color:#0A2540;">New listings this week:</div><ul style="padding-left:20px;color:#444;">${listingItems}</ul></div>` : '') +
            btn(`${BASE_URL}/dashboard/realtor`, 'Browse New Listings'),
            unsubUrl
        );
        return await send({ to: toEmail, subject: `Your weekly RealtorFinder digest — ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`, html: body });
    },

    async sendReferralSignup(referrerEmail, referrerName, newMemberName, referralCount) {
        const tierLabel = referralCount >= 10 ? 'Ambassador' : referralCount >= 5 ? 'Top Referrer' : referralCount >= 3 ? 'Connector' : 'Rising Star';
        const nextTier = referralCount < 1 ? { name: 'Rising Star', at: 1 } : referralCount < 3 ? { name: 'Connector', at: 3 } : referralCount < 5 ? { name: 'Top Referrer', at: 5 } : referralCount < 10 ? { name: 'Ambassador', at: 10 } : null;
        const body = `
            ${h1('You got a referral!')}
            ${p(`Hi ${referrerName}, <strong>${newMemberName}</strong> just joined RealtorFinder using your referral link. You now have <strong>${referralCount} referral${referralCount !== 1 ? 's' : ''}</strong>.`)}
            ${nextTier ? infoBox([['Your tier', tierLabel], ['Next tier', nextTier.name], ['Referrals needed', String(nextTier.at - referralCount) + ' more']]) : infoBox([['Your tier', tierLabel], ['Status', 'Maximum tier reached — Ambassador!']])}
            ${btn(`${BASE_URL}/dashboard/realtor`, 'View Referrals')}
            ${divider()}
            <p style="color:#999;font-size:13px;margin:0;">The RealtorFinder Team</p>
        `;
        try {
            await send({ to: referrerEmail, subject: `${newMemberName} joined via your referral link!`, html: emailWrap('Referral', body) });
        } catch (error) { logSendgridError('Referral signup email', error); }
    },

    async sendPaymentFailed(toEmail, firstName, invoiceUrl) {
        const body = emailWrap('#e53e3e',
            h1('Payment Failed') +
            p(`Hi ${firstName}, we couldn't process your RealtorFinder subscription payment.`) +
            p('Your account will remain active during a short grace period, but please update your payment method to avoid losing access.') +
            (invoiceUrl ? btn(invoiceUrl, 'Update Payment Method') : btn('https://www.realtorfinder.net/dashboard/realtor', 'Go to Dashboard'))
        );
        return await send({ to: toEmail, subject: 'Action required: RealtorFinder payment failed', html: body });
    },

    async sendSubscriptionCancelled(toEmail, firstName) {
        const body = emailWrap('#0A2540',
            h1('Subscription Ended') +
            p(`Hi ${firstName}, your RealtorFinder subscription has ended and your access to premium features has been paused.`) +
            p('You can resubscribe at any time to restore full access to all listings, buyer requests, and realtor tools.') +
            btn('https://www.realtorfinder.net/pricing', 'Resubscribe')
        );
        return await send({ to: toEmail, subject: 'Your RealtorFinder subscription has ended', html: body });
    },

    async sendProposalNudge(sellerEmail, sellerName, listingAddress, proposalCount) {
        const plural = proposalCount !== 1;
        const body = `
<div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:#0A2540;padding:2rem;text-align:center;">
    <h1 style="font-family:serif;color:white;margin:0;font-size:1.6rem;">Proposals are waiting for you</h1>
  </div>
  <div style="padding:2rem;">
    <p style="font-size:1rem;color:#444;">Hi ${sellerName},</p>
    <p style="font-size:1rem;color:#444;margin:1rem 0;">You have <strong>${proposalCount} realtor proposal${plural ? 's' : ''}</strong> waiting on your listing at <strong>${listingAddress}</strong>.</p>
    <p style="color:#666;">Don't leave agents waiting — the sooner you review, the faster you can get your home sold.</p>
    <div style="text-align:center;margin:2rem 0;">
      <a href="https://www.realtorfinder.net/dashboard/seller" style="background:#FF6B35;color:white;padding:14px 32px;border-radius:8px;font-weight:700;text-decoration:none;display:inline-block;font-size:1rem;">Review Proposals →</a>
    </div>
    <p style="font-size:0.85rem;color:#999;text-align:center;">You can compare commissions, read notes, and accept or counter any proposal directly in your dashboard.</p>
  </div>
</div>`;
        return await send({
            to: sellerEmail,
            subject: `You have ${proposalCount} proposal${plural ? 's' : ''} waiting — ${listingAddress}`,
            html: body,
        });
    },

    async sendCampaignEmail(toEmail, firstName, subject, message, ctaLabel, ctaUrl) {
        assertEmailConfig();
        const ctaBlock = ctaLabel && ctaUrl
            ? `<div style="text-align:center;margin:2rem 0;"><a href="${ctaUrl}" style="background:#FF6B35;color:white;padding:14px 32px;border-radius:8px;font-weight:700;text-decoration:none;display:inline-block;font-size:1rem;">${ctaLabel}</a></div>`
            : '';
        const body = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:#0A2540;padding:1.5rem 2rem;">
    <p style="color:white;font-size:1.4rem;font-weight:700;margin:0;font-family:'Crimson Pro',Georgia,serif;">RealtorFinder</p>
  </div>
  <div style="padding:2rem;">
    <p style="font-size:1rem;color:#444;">Hi ${firstName || 'there'},</p>
    <div style="font-size:1rem;color:#444;margin:1rem 0;line-height:1.75;">${message.replace(/\n/g, '<br>')}</div>
    ${ctaBlock}
    <p style="font-size:0.8rem;color:#aaa;text-align:center;margin-top:2rem;">You received this because you have an account on RealtorFinder. <a href="${BASE_URL}/unsubscribe" style="color:#aaa;">Unsubscribe</a></p>
  </div>
</div>`;
        return await send({ to: toEmail, subject, html: body });
    },

    async sendFollowUpEmail(sellerEmail, sellerName, realtorName, listingAddress, message) {
        assertEmailConfig();
        const body = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:#0A2540;padding:1.5rem 2rem;">
    <p style="color:white;font-size:1.4rem;font-weight:700;margin:0;font-family:'Crimson Pro',Georgia,serif;">RealtorFinder</p>
  </div>
  <div style="padding:2rem;">
    <p style="font-size:1rem;color:#444;">Hi ${sellerName || 'there'},</p>
    <p style="font-size:1rem;color:#444;margin:1rem 0;">You have a follow-up message from <strong>${realtorName}</strong> regarding your listing at <strong>${listingAddress}</strong>:</p>
    <div style="background:#f8f9fa;border-left:4px solid #FF6B35;padding:1rem 1.25rem;border-radius:0 8px 8px 0;margin:1.5rem 0;">
      <p style="color:#1a1a1a;font-size:0.975rem;line-height:1.7;margin:0;">${message.replace(/\n/g, '<br>')}</p>
    </div>
    <div style="text-align:center;margin:2rem 0;">
      <a href="${BASE_URL}/dashboard/seller" style="background:#FF6B35;color:white;padding:14px 32px;border-radius:8px;font-weight:700;text-decoration:none;display:inline-block;font-size:1rem;">View Proposal →</a>
    </div>
    <p style="font-size:0.85rem;color:#999;text-align:center;">You can respond directly in your seller dashboard.</p>
  </div>
</div>`;
        return await send({
            to: sellerEmail,
            subject: `Follow-up from ${realtorName} — ${listingAddress}`,
            html: body,
        });
    },

    async sendReEngagementEmail(toEmail, firstName, userType) {
        const roleLabel = userType === 'realtor' ? 'realtor' : userType === 'seller' ? 'home seller' : 'buyer';
        const ctaUrl = userType === 'realtor' ? `${BASE_URL}/dashboard/realtor` : userType === 'seller' ? `${BASE_URL}/dashboard/seller` : `${BASE_URL}/app`;
        const ctaLabel = userType === 'realtor' ? 'View Your Dashboard' : userType === 'seller' ? 'Check Your Listings' : 'Browse Listings';
        const body = `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(10,37,64,0.10);">
  <div style="background:#0A2540;padding:32px 40px 20px;">
    <h1 style="color:#fff;font-size:1.5rem;margin:0;">We miss you, ${firstName}!</h1>
    <p style="color:#A0AEC0;margin:8px 0 0;font-size:0.95rem;">Your RealtorFinder account is waiting</p>
  </div>
  <div style="padding:32px 40px;">
    <p style="color:#2D3748;font-size:1rem;line-height:1.6;">It's been a while since you logged in as a ${roleLabel}. There may be new activity waiting for you — don't miss out!</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${ctaUrl}" style="background:#FF6B35;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem;">${ctaLabel}</a>
    </div>
    <p style="color:#718096;font-size:0.9rem;">If you have questions or need help, reply to this email anytime.</p>
  </div>
  <div style="background:#F7FAFC;padding:16px 40px;text-align:center;">
    <p style="color:#A0AEC0;font-size:0.8rem;margin:0;">© ${new Date().getFullYear()} RealtorFinder · <a href="${BASE_URL}/unsubscribe" style="color:#A0AEC0;">Unsubscribe</a></p>
  </div>
</div>`;
        return await send({ to: toEmail, subject: `We miss you, ${firstName} — come back to RealtorFinder`, html: body });
    },

    async sendListingPerformanceDigest(toEmail, firstName, listingCount, proposalCount, leadCount) {
        const body = `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(10,37,64,0.10);">
  <div style="background:#0A2540;padding:32px 40px 20px;">
    <h1 style="color:#fff;font-size:1.5rem;margin:0;">Your Weekly Listing Summary</h1>
    <p style="color:#A0AEC0;margin:8px 0 0;font-size:0.95rem;">Here's how your listings performed this week</p>
  </div>
  <div style="padding:32px 40px;">
    <p style="color:#2D3748;font-size:1rem;">Hi ${firstName}, here's a quick look at your activity over the past 7 days:</p>
    <table style="width:100%;border-collapse:collapse;margin:24px 0;">
      <tr style="background:#F7FAFC;">
        <td style="padding:14px 16px;color:#2D3748;font-weight:600;border-radius:8px 0 0 8px;">Active Listings</td>
        <td style="padding:14px 16px;text-align:right;font-size:1.4rem;font-weight:700;color:#0A2540;border-radius:0 8px 8px 0;">${listingCount}</td>
      </tr>
      <tr>
        <td style="padding:14px 16px;color:#2D3748;font-weight:600;">New Proposals</td>
        <td style="padding:14px 16px;text-align:right;font-size:1.4rem;font-weight:700;color:#FF6B35;">${proposalCount}</td>
      </tr>
      <tr style="background:#F7FAFC;">
        <td style="padding:14px 16px;color:#2D3748;font-weight:600;border-radius:8px 0 0 8px;">Realtor Leads</td>
        <td style="padding:14px 16px;text-align:right;font-size:1.4rem;font-weight:700;color:#0A2540;border-radius:0 8px 8px 0;">${leadCount}</td>
      </tr>
    </table>
    <div style="text-align:center;margin:24px 0;">
      <a href="${BASE_URL}/dashboard/seller" style="background:#FF6B35;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem;">View Your Dashboard</a>
    </div>
  </div>
  <div style="background:#F7FAFC;padding:16px 40px;text-align:center;">
    <p style="color:#A0AEC0;font-size:0.8rem;margin:0;">© ${new Date().getFullYear()} RealtorFinder · <a href="${BASE_URL}/unsubscribe" style="color:#A0AEC0;">Unsubscribe</a></p>
  </div>
</div>`;
        return await send({ to: toEmail, subject: `Your weekly RealtorFinder summary, ${firstName}`, html: body });
    },
};

module.exports = emailService;
