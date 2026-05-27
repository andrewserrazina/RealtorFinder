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
                `SELECT id, email, password_hash, user_type, first_name, last_name, zip_code,
                        email_verified, is_admin, is_active
                 FROM users WHERE email = $1`,
                [email]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const user = result.rows[0];

            if (user.is_active === false) {
                return null; // Deactivated account
            }

            const isValid = await bcrypt.compare(password, user.password_hash);

            if (!isValid) {
                return null;
            }

            return {
                id: user.id,
                email: user.email,
                userType: user.user_type,
                firstName: user.first_name,
                lastName: user.last_name,
                zipCode: user.zip_code,
                emailVerified: user.email_verified,
                isAdmin: user.is_admin || false
            };
        } catch (error) {
            throw error;
        }
    },

    // Get user by ID
    async getUserById(userId) {
        try {
            const result = await pool.query(
                `SELECT id, email, user_type, first_name, last_name, zip_code,
                        email_verified, is_admin, is_active,
                        phone, license_number, bio, years_experience, service_areas,
                        created_at
                 FROM users WHERE id = $1`,
                [userId]
            );
            return result.rows[0];
        } catch {
            // Fallback for environments where migration-launch.sql hasn't run yet
            const result = await pool.query(
                `SELECT id, email, user_type, first_name, last_name, zip_code,
                        email_verified, created_at
                 FROM users WHERE id = $1`,
                [userId]
            );
            return result.rows[0];
        }
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
                // Fall back to session data if DB lookup fails or returns nothing
                req.user = user || {
                    id: req.session.userId,
                    user_type: req.session.userType,
                    first_name: req.session.firstName,
                    last_name: req.session.lastName,
                    zip_code: req.session.zipCode,
                    email_verified: req.session.emailVerified || false,
                    is_admin: false
                };
            } catch (error) {
                console.error('Error attaching user:', error);
                req.user = {
                    id: req.session.userId,
                    user_type: req.session.userType,
                    first_name: req.session.firstName,
                    last_name: req.session.lastName,
                    zip_code: req.session.zipCode,
                    email_verified: req.session.emailVerified || false,
                    is_admin: false
                };
            }
        }
        next();
    }
};

module.exports = auth;
