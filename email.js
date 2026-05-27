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
    }
};

module.exports = emailService;
