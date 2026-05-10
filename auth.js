// auth.js - Authentication and session management
const bcrypt = require('bcrypt');
const { pool } = require('./db');

const auth = {
    // Create user account
    async createUser(email, password, userType, firstName, lastName, zipCode) {
        try {
            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);
            
            // Insert user
            const result = await pool.query(
                `INSERT INTO users (email, password_hash, user_type, first_name, last_name, zip_code, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
                 RETURNING id, email, user_type, first_name, last_name, zip_code, created_at`,
                [email, hashedPassword, userType, firstName, lastName, zipCode]
            );
            
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') { // Duplicate email
                throw new Error('Email already registered');
            }
            throw error;
        }
    },

    // Verify login credentials
    async verifyUser(email, password) {
        try {
            const result = await pool.query(
                'SELECT id, email, password_hash, user_type, first_name, last_name, zip_code, email_verified FROM users WHERE email = $1',
                [email]
            );
            
            if (result.rows.length === 0) {
                return null; // User not found
            }
            
            const user = result.rows[0];
            const isValid = await bcrypt.compare(password, user.password_hash);
            
            if (!isValid) {
                return null; // Invalid password
            }
            
            // Return user without password
            return {
                id: user.id,
                email: user.email,
                userType: user.user_type,
                firstName: user.first_name,
                lastName: user.last_name,
                zipCode: user.zip_code,
                emailVerified: user.email_verified
            };
        } catch (error) {
            throw error;
        }
    },

    // Get user by ID
    async getUserById(userId) {
        const result = await pool.query(
            'SELECT id, email, user_type, first_name, last_name, zip_code, email_verified, created_at FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0];
    },

    // Middleware to require authentication
    requireAuth(req, res, next) {
        if (!req.session || !req.session.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        next();
    },

    // Middleware to require specific user type
    requireUserType(userType) {
        return (req, res, next) => {
            if (!req.session || !req.session.userId) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            if (req.session.userType !== userType) {
                return res.status(403).json({ error: 'Unauthorized user type' });
            }
            next();
        };
    },

    // Middleware to attach user to request
    async attachUser(req, res, next) {
        if (req.session && req.session.userId) {
            try {
                const user = await auth.getUserById(req.session.userId);
                req.user = user;
            } catch (error) {
                console.error('Error attaching user:', error);
            }
        }
        next();
    }
};

module.exports = auth;
