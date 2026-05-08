// email.js - Email notification service using SendGrid HTTP API
const sgMail = require('@sendgrid/mail');
require('dotenv').config();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY && SENDGRID_API_KEY.startsWith('SG.')) {
    sgMail.setApiKey(SENDGRID_API_KEY);
} else {
    console.warn('⚠️ SENDGRID_API_KEY missing or invalid. Email sending is disabled.');
}

const FROM = process.env.EMAIL_FROM;

function assertEmailConfig() {
    if (!SENDGRID_API_KEY || !SENDGRID_API_KEY.startsWith('SG.')) {
        throw new Error('SENDGRID_API_KEY is missing/invalid');
    }
    if (!FROM || !FROM.includes('@')) {
        throw new Error('EMAIL_FROM is missing/invalid');
    }
}

const emailService = {
    // Send waitlist confirmation
    async sendWaitlistConfirmation(email) {
        assertEmailConfig();
        const msg = {
            to: email,
            from: FROM,
            subject: `You're on the RealtorFinder Waitlist! 🎉`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">Welcome to RealtorFinder!</h1>
                    <p>Hi there,</p>
                    <p>Thanks for joining our waitlist! You're among the first to know about our upcoming launch.</p>
                    
                    <div style="background: linear-gradient(135deg, #FF6B35 0%, #0A2540 100%); padding: 30px; border-radius: 10px; margin: 30px 0; color: white;">
                        <h2 style="color: white; margin-top: 0;">🚀 Launching Q2 2026</h2>
                        <p style="font-size: 16px;">As an early member, you'll get:</p>
                        <ul style="font-size: 15px; line-height: 1.8;">
                            <li>Early access before the public launch</li>
                            <li>Free listings when we go live</li>
                            <li>Updates as we get closer to launch</li>
                        </ul>
                    </div>
                    
                    <p>Have questions? Just reply to this email—we'd love to hear from you!</p>
                    
                    <div style="background: #f8f6f3; padding: 20px; border-radius: 10px; margin-top: 30px;">
                        <p style="margin: 0; color: #666; font-size: 14px;">
                            <strong>RealtorFinder</strong><br>
                            The reverse marketplace where sellers list once and agents compete for their business.
                        </p>
                    </div>
                    
                    <p style="color: #999; font-size: 12px; margin-top: 30px;">
                        You're receiving this email because you signed up for the RealtorFinder waitlist at realtorfinder.net
                    </p>
                </div>
            `
        };

        await sgMail.send(msg);
        console.log(`✅ Waitlist confirmation email sent to ${email}`);
    },

    // Send listing confirmation to homeowner
    async sendListingConfirmation(listing) {
        assertEmailConfig();
        const msg = {
            to: listing.owner_email,
            from: FROM,
            subject: 'Your Property is Now Listed on RealtorFinder',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">🏠 Your Listing is Live!</h1>
                    <p>Hi ${listing.owner_name},</p>
                    <p>Great news! Your property has been successfully listed on RealtorFinder.</p>
                    
                    <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h2 style="color: #0A2540; margin-top: 0;">${listing.address}</h2>
                        <p><strong>Price:</strong> ${listing.price}</p>
                        <p><strong>Type:</strong> ${listing.property_type}</p>
                        <p><strong>Beds/Baths:</strong> ${listing.bedrooms} bd / ${listing.bathrooms} ba</p>
                    </div>
                    
                    <p>Qualified realtors can now submit offer packages. We'll notify you immediately when you receive an offer.</p>
                    
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                        Best regards,<br>
                        The RealtorFinder Team
                    </p>
                </div>
            `
        };

        try {
            await sgMail.send(msg);
            console.log(`✅ Listing confirmation email sent to ${listing.owner_email}`);
        } catch (error) {
            console.error('❌ Error sending listing confirmation email:', error);
        }
    },

    // Send offer notification to homeowner
    async sendOfferNotification(listing, offer) {
        assertEmailConfig();
        const msg = {
            to: listing.owner_email,
            from: FROM,
            subject: `New Offer Package Received for ${listing.address}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">📬 New Offer Package!</h1>
                    <p>Hi ${listing.owner_name},</p>
                    <p>You've received a new offer package for your property at <strong>${listing.address}</strong>.</p>
                    
                    <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h2 style="color: #0A2540; margin-top: 0;">${offer.realtor_name}</h2>
                        <p><strong>Brokerage:</strong> ${offer.brokerage}</p>
                        <p><strong>Email:</strong> ${offer.realtor_email}</p>
                        <p><strong>Phone:</strong> ${offer.realtor_phone}</p>
                        ${offer.commission ? `<p><strong>Commission Rate:</strong> ${offer.commission}%</p>` : ''}
                    </div>
                    
                    <div style="background: #fff; border: 1px solid #ddd; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h3 style="margin-top: 0;">Offer Details:</h3>
                        <p style="white-space: pre-wrap;">${offer.offer_details}</p>
                    </div>
                    
                    <p>Review this offer and reach out to ${offer.realtor_name} directly if you're interested.</p>
                    
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                        Best regards,<br>
                        The RealtorFinder Team
                    </p>
                </div>
            `
        };

        try {
            await sgMail.send(msg);
            console.log(`✅ Offer notification email sent to ${listing.owner_email}`);
        } catch (error) {
            console.error('❌ Error sending offer notification email:', error);
        }
    },

    // Send offer confirmation to realtor
    async sendOfferConfirmation(listing, offer) {
        assertEmailConfig();
        const msg = {
            to: offer.realtor_email,
            from: FROM,
            subject: `Your Offer Package for ${listing.address} Has Been Submitted`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">✅ Offer Package Submitted</h1>
                    <p>Hi ${offer.realtor_name},</p>
                    <p>Your offer package has been successfully submitted for <strong>${listing.address}</strong>.</p>
                    
                    <div style="background: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
                        <h2 style="color: #0A2540; margin-top: 0;">${listing.address}</h2>
                        <p><strong>Owner:</strong> ${listing.owner_name}</p>
                        <p><strong>Price:</strong> ${listing.price}</p>
                        <p><strong>Type:</strong> ${listing.property_type}</p>
                    </div>
                    
                    <p>The homeowner will review your package and contact you directly if interested.</p>
                    
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                        Best regards,<br>
                        The RealtorFinder Team
                    </p>
                </div>
            `
        };

        try {
            await sgMail.send(msg);
            console.log(`✅ Offer confirmation email sent to ${offer.realtor_email}`);
        } catch (error) {
            console.error('❌ Error sending offer confirmation email:', error);
        }
    }
};

module.exports = emailService;
