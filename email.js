// email.js - Email notification service
const nodemailer = require('nodemailer');
require('dotenv').config();

// Create transporter based on environment
const createTransporter = () => {
    // Check if email is configured
    if (!process.env.EMAIL_FROM) {
        console.log('⚠️  Email not configured - emails will not be sent');
        return null;
    }

    if (process.env.SENDGRID_API_KEY) {
        // SendGrid configuration
        return nodemailer.createTransport({
            host: 'smtp.sendgrid.net',
            port: 587,
            auth: {
                user: 'apikey',
                pass: process.env.SENDGRID_API_KEY
            }
        });
    } else if (process.env.EMAIL_HOST && process.env.EMAIL_USER) {
        // Gmail or generic SMTP configuration
        return nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: process.env.EMAIL_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD
            }
        });
    } else {
        console.log('⚠️  Email credentials not configured - emails will not be sent');
        return null;
    }
};

const transporter = createTransporter();

// Email templates

const emailService = {
    // Send waitlist confirmation
    async sendWaitlistConfirmation(email, userType) {
        if (!transporter) {
            console.log(`📧 Email not configured - would have sent waitlist confirmation to ${email}`);
            return; // Silently skip if email not configured
        }

        const isSeller = userType === 'seller';
        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: email,
            subject: `You're on the RealtorFinder Waitlist! 🎉`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">Welcome to RealtorFinder!</h1>
                    <p>Hi there,</p>
                    <p>Thanks for joining our waitlist! You're among the first to know about our upcoming launch.</p>
                    
                    <div style="background: linear-gradient(135deg, #FF6B35 0%, #0A2540 100%); padding: 30px; border-radius: 10px; margin: 30px 0; color: white;">
                        <h2 style="color: white; margin-top: 0;">🚀 Launching Q2 2026</h2>
                        ${isSeller ? `
                            <p style="font-size: 16px;">As a seller, you'll be able to:</p>
                            <ul style="font-size: 15px; line-height: 1.8;">
                                <li>List your home for free</li>
                                <li>Receive competing proposals from qualified realtors</li>
                                <li>Compare commission rates and marketing strategies</li>
                                <li>Choose the best agent for your needs</li>
                            </ul>
                        ` : `
                            <p style="font-size: 16px;">As a realtor, you'll be able to:</p>
                            <ul style="font-size: 15px; line-height: 1.8;">
                                <li>Access motivated sellers actively seeking representation</li>
                                <li>Submit competitive bids with your rates and strategy</li>
                                <li>Win quality listings without cold calling</li>
                                <li>Build your business with verified performance metrics</li>
                            </ul>
                        `}
                    </div>
                    
                    <p><strong>What happens next?</strong></p>
                    <ul style="line-height: 1.8;">
                        <li>You'll receive early access before the public launch</li>
                        <li>We'll send you updates as we get closer to launch</li>
                        <li>You'll be the first to know when we go live</li>
                    </ul>
                    
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

        try {
            await transporter.sendMail(mailOptions);
            console.log(`✅ Waitlist confirmation email sent to ${email} (${userType})`);
        } catch (error) {
            console.error('❌ Error sending waitlist confirmation email:', error);
            throw error; // Re-throw so the API can handle it
        }
    },

    // Send listing confirmation to homeowner
    async sendListingConfirmation(listing) {
        if (!transporter) {
            console.log(`📧 Email not configured - would have sent listing confirmation to ${listing.owner_email}`);
            return;
        }

        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: listing.owner_email,
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
                    
                    <p>Questions? Reply to this email or contact our support team.</p>
                    
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                        Best regards,<br>
                        The RealtorFinder Team
                    </p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`✅ Listing confirmation email sent to ${listing.owner_email}`);
        } catch (error) {
            console.error('❌ Error sending listing confirmation email:', error);
        }
    },

    // Send offer notification to homeowner
    async sendOfferNotification(listing, offer) {
        if (!transporter) {
            console.log(`📧 Email not configured - would have sent offer notification to ${listing.owner_email}`);
            return;
        }

        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: listing.owner_email,
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
                    
                    <p>Review this offer and reach out to ${offer.realtor_name} directly if you're interested in learning more.</p>
                    
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                        Best regards,<br>
                        The RealtorFinder Team
                    </p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`✅ Offer notification email sent to ${listing.owner_email}`);
        } catch (error) {
            console.error('❌ Error sending offer notification email:', error);
        }
    },

    // Send offer confirmation to realtor
    async sendOfferConfirmation(listing, offer) {
        if (!transporter) {
            console.log(`📧 Email not configured - would have sent offer confirmation to ${offer.realtor_email}`);
            return;
        }

        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: offer.realtor_email,
            subject: `Your Offer Package for ${listing.address} Has Been Submitted`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">✅ Offer Package Submitted</h1>
                    <p>Hi ${offer.realtor_name},</p>
                    <p>Your offer package has been successfully submitted for the property at <strong>${listing.address}</strong>.</p>
                    
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
            await transporter.sendMail(mailOptions);
            console.log(`✅ Offer confirmation email sent to ${offer.realtor_email}`);
        } catch (error) {
            console.error('❌ Error sending offer confirmation email:', error);
        }
    }
};

module.exports = emailService;
