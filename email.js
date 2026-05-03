// email.js - Email notification service
const nodemailer = require('nodemailer');
require('dotenv').config();

// Create transporter based on environment
const createTransporter = () => {
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
    } else {
        // Gmail or generic SMTP configuration
        return nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: process.env.EMAIL_PORT,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD
            }
        });
    }
};

const transporter = createTransporter();

// Email templates

const emailService = {
    // Send listing confirmation to homeowner
    async sendListingConfirmation(listing) {
        const mailOptions = {
            from: process.env.EMAIL_FROM,
            to: listing.owner_email,
            subject: 'Your Property is Now Listed on HomeDirect',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #0A2540;">🏠 Your Listing is Live!</h1>
                    <p>Hi ${listing.owner_name},</p>
                    <p>Great news! Your property has been successfully listed on HomeDirect.</p>
                    
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
                        The HomeDirect Team
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
                        The HomeDirect Team
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
                        The HomeDirect Team
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
