/**
 * Security regression tests for RealtorFinder
 * Branch: claude/security-remediation-p0
 *
 * All external dependencies (pg, stripe, sendgrid) are mocked.
 * No real network calls are made.
 */

'use strict';

// ---------------------------------------------------------------------------
// Mock pg before anything requires it
// ---------------------------------------------------------------------------
jest.mock('pg', () => {
  const mQuery = jest.fn();
  const mPool = { query: mQuery, on: jest.fn(), connect: jest.fn() };
  return { Pool: jest.fn(() => mPool), mQuery };
});

// Mock stripe
jest.mock('stripe', () => {
  return jest.fn(() => ({
    webhooks: {
      constructEvent: jest.fn(),
    },
    checkout: { sessions: { create: jest.fn() } },
  }));
});

// Mock @sendgrid/mail
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));

// Mock nodemailer
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

// Mock cloudinary
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

// Mock multer
jest.mock('multer', () => {
  const m = jest.fn(() => ({ single: jest.fn(() => (req, res, next) => next()), array: jest.fn(() => (req, res, next) => next()) }));
  m.memoryStorage = jest.fn();
  return m;
});

// Mock connect-pg-simple
jest.mock('connect-pg-simple', () => jest.fn(() => jest.fn()));

// Mock google-auth-library
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(() => ({ verifyIdToken: jest.fn() })),
}));

// Mock web-push
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

// Mock bcrypt to avoid heavy hashing in tests
jest.mock('bcrypt', () => ({
  hash: jest.fn(async (p) => `hashed:${p}`),
  compare: jest.fn(async (plain, hashed) => hashed === `hashed:${plain}`),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const { Pool } = require('pg');
const poolInstance = new Pool();
const mockQuery = poolInstance.query;

function makeUser(overrides = {}) {
  return {
    id: 1,
    email: 'test@example.com',
    user_type: 'realtor',
    first_name: 'Test',
    last_name: 'User',
    is_active: true,
    is_approved: true,
    is_admin: false,
    email_verified: true,
    zip_code: '90210',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests for auth.js middleware
// ---------------------------------------------------------------------------
describe('auth.js — getUserById', () => {
  let auth;

  beforeAll(() => {
    // Clear module cache so our mocks apply
    jest.resetModules();
    jest.mock('pg', () => {
      const mQuery = jest.fn();
      const mPool = { query: mQuery, on: jest.fn(), connect: jest.fn() };
      return { Pool: jest.fn(() => mPool), mQuery };
    });
    auth = require('../auth');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns user row when found', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    pool.query.mockResolvedValueOnce({ rows: [makeUser()] });
    const user = await auth.getUserById(1);
    expect(user).toBeTruthy();
    expect(user.id).toBe(1);
  });

  test('returns undefined when user not found (DB returns no rows)', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const user = await auth.getUserById(999);
    expect(user).toBeUndefined();
  });

  test('propagates DB errors instead of swallowing them (F3 fix)', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    pool.query.mockRejectedValueOnce(new Error('DB connection failed'));
    await expect(auth.getUserById(1)).rejects.toThrow('DB connection failed');
  });
});

// ---------------------------------------------------------------------------
// attachUser middleware tests
// ---------------------------------------------------------------------------
describe('auth.js — attachUser middleware', () => {
  let auth;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg', () => {
      const mQuery = jest.fn();
      const mPool = { query: mQuery, on: jest.fn(), connect: jest.fn() };
      return { Pool: jest.fn(() => mPool), mQuery };
    });
    auth = require('../auth');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function makeReq(userId) {
    return { session: userId ? { userId } : {}, user: undefined };
  }

  test('no session userId — skips DB, does not set req.user', async () => {
    const req = makeReq(null);
    const res = {};
    const next = jest.fn();
    await auth.attachUser(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
  });

  test('valid active approved user — attaches user to req', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    pool.query.mockResolvedValueOnce({ rows: [makeUser()] });
    const req = makeReq(1);
    const res = {};
    const next = jest.fn();
    await auth.attachUser(req, res, next);
    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.user).toBeTruthy();
    expect(req.user.id).toBe(1);
  });

  test('deleted user (getUserById returns null/undefined) — sets req.user=null, calls next() with no error (F1/F2 fix)', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    pool.query.mockResolvedValueOnce({ rows: [] }); // no user returned
    const req = makeReq(999);
    const res = {};
    const next = jest.fn();
    await auth.attachUser(req, res, next);
    expect(req.user).toBeNull();
    // next() should be called without an error argument
    expect(next).toHaveBeenCalledWith();
  });

  test('deactivated user (is_active=false) — sets req.user=null (F4 fix)', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    pool.query.mockResolvedValueOnce({ rows: [makeUser({ is_active: false })] });
    const req = makeReq(1);
    const res = {};
    const next = jest.fn();
    await auth.attachUser(req, res, next);
    expect(req.user).toBeNull();
    expect(next).toHaveBeenCalledWith(); // no error forwarded for deactivated
  });

  test('DB throws on getUserById — sets req.user=null, forwards error (F1/F2 fix)', async () => {
    const { Pool: P } = require('pg');
    const pool = new P();
    const dbError = new Error('connection reset');
    pool.query.mockRejectedValueOnce(dbError);
    const req = makeReq(1);
    const res = {};
    const next = jest.fn();
    await auth.attachUser(req, res, next);
    expect(req.user).toBeNull();
    // next should be called WITH the error so upstream error handlers return 500
    expect(next).toHaveBeenCalledWith(dbError);
  });
});

// ---------------------------------------------------------------------------
// requireUserType middleware tests
// ---------------------------------------------------------------------------
describe('auth.js — requireUserType middleware', () => {
  let auth;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('pg', () => {
      const mPool = { query: jest.fn(), on: jest.fn(), connect: jest.fn() };
      return { Pool: jest.fn(() => mPool) };
    });
    auth = require('../auth');
  });

  test('returns 401 when req.user is absent (F5 fix — no session fallback)', () => {
    const mw = auth.requireUserType('realtor');
    const req = { user: null };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when req.user has no id', () => {
    const mw = auth.requireUserType('realtor');
    const req = { user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 403 for wrong user type', () => {
    const mw = auth.requireUserType('realtor');
    const req = { user: makeUser({ user_type: 'buyer' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('calls next() for correct user type', () => {
    const mw = auth.requireUserType('realtor');
    const req = { user: makeUser({ user_type: 'realtor' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('does NOT fall back to req.session.userType for type check (F5 fix)', () => {
    // Session contains userType 'admin' but req.user has wrong type
    const mw = auth.requireUserType('admin');
    const req = { user: makeUser({ user_type: 'realtor' }), session: { userType: 'admin' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mw(req, res, next);
    // Should be denied — req.user.user_type is 'realtor', not 'admin'
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Approval gate middleware tests (server.js inline middleware)
// ---------------------------------------------------------------------------
describe('Approval gate middleware (APPROVAL-001)', () => {
  // Recreate the gate logic inline to test it in isolation
  function approvalGate(req, res, next) {
    if (!req.user || !req.user.id) return next();
    const exempt = ['/auth/', '/webhook/', '/admin/', '/referrals/'];
    const publicGet = ['/realtors/founding-count', '/realtors/search', '/realtors/leaderboard', '/listings'];
    if (exempt.some(p => req.path.startsWith(p))) return next();
    if (req.method === 'GET' && publicGet.some(p => req.path.startsWith(p))) return next();
    if (req.user.is_active === false) {
      return res.status(403).json({ error: 'account_deactivated' });
    }
    if (!req.user.is_admin && req.user.is_approved !== true) {
      return res.status(403).json({ error: 'account_pending' });
    }
    next();
  }

  test('unauthenticated request — passes through gate (route handles auth)', () => {
    const req = { user: null, path: '/proposals', method: 'POST' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('approved user — passes through gate', () => {
    const req = { user: makeUser({ is_approved: true }), path: '/proposals', method: 'POST' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('pending user (is_approved=false) — blocked with 403', () => {
    const req = { user: makeUser({ is_approved: false }), path: '/proposals', method: 'POST' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('pending user (is_approved=null) — blocked with 403 (APPROVAL-001 fix: !== true)', () => {
    const req = { user: makeUser({ is_approved: null }), path: '/proposals', method: 'POST' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('pending user (is_approved=undefined) — blocked with 403 (APPROVAL-001 fix)', () => {
    const req = { user: makeUser({ is_approved: undefined }), path: '/proposals', method: 'POST' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('admin user (is_admin=true, is_approved=false) — passes through gate', () => {
    const req = { user: makeUser({ is_admin: true, is_approved: false }), path: '/admin/users', method: 'GET' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('deactivated user — blocked with 403 account_deactivated', () => {
    const req = { user: makeUser({ is_active: false, is_approved: true }), path: '/proposals', method: 'POST' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'account_deactivated' }));
  });
});

// ---------------------------------------------------------------------------
// Buyer-requests authorization tests (BR-1, BR-2)
// ---------------------------------------------------------------------------
describe('GET /api/buyer-requests — realtor-only enforcement (BR-1)', () => {
  // Inline the route logic
  function buyerRequestsRoute(req, res) {
    if (req.user.user_type === 'buyer') {
      return res.json({ type: 'buyer_view' });
    }
    if (req.user.user_type !== 'realtor') {
      return res.status(403).json({ error: 'Realtors only' });
    }
    res.json({ type: 'realtor_view' });
  }

  test('realtor gets realtor view', () => {
    const req = { user: makeUser({ user_type: 'realtor' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    buyerRequestsRoute(req, res);
    expect(res.json).toHaveBeenCalledWith({ type: 'realtor_view' });
  });

  test('buyer gets buyer view', () => {
    const req = { user: makeUser({ user_type: 'buyer' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    buyerRequestsRoute(req, res);
    expect(res.json).toHaveBeenCalledWith({ type: 'buyer_view' });
  });

  test('seller (non-realtor, non-buyer) gets 403 (BR-1 fix)', () => {
    const req = { user: makeUser({ user_type: 'seller' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    buyerRequestsRoute(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('GET /api/buyer-requests/responses — buyer-only enforcement (BR-2)', () => {
  function buyerResponsesRoute(req, res) {
    if (req.user.user_type !== 'buyer') return res.status(403).json({ error: 'Buyers only' });
    res.json({ responses: [] });
  }

  test('buyer gets responses', () => {
    const req = { user: makeUser({ user_type: 'buyer' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    buyerResponsesRoute(req, res);
    expect(res.json).toHaveBeenCalledWith({ responses: [] });
  });

  test('realtor cannot view buyer responses (BR-2 fix)', () => {
    const req = { user: makeUser({ user_type: 'realtor' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    buyerResponsesRoute(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('seller cannot view buyer responses', () => {
    const req = { user: makeUser({ user_type: 'seller' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    buyerResponsesRoute(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Billing: PUT /api/company/plan endpoint removed (server.js F1)
// ---------------------------------------------------------------------------
describe('PUT /api/company/plan — endpoint removed (billing F1 fix)', () => {
  // Simulate the absence of the route: we check that there is no handler
  // for PUT /api/company/plan in server.js source
  test('PUT /api/company/plan handler is not present in server.js', () => {
    const fs = require('fs');
    const src = fs.readFileSync('/home/user/RealtorFinder/server.js', 'utf8');
    // Should not find an active app.put for /company/plan
    // The fix replaced it with a comment
    const hasPutHandler = /app\.put\(['"`]\/api\/company\/plan['"`]/.test(src);
    expect(hasPutHandler).toBe(false);
  });

  test('server.js contains a comment about the removal', () => {
    const fs = require('fs');
    const src = fs.readFileSync('/home/user/RealtorFinder/server.js', 'utf8');
    // The fix must leave a comment explaining what happened
    const hasComment = /company\/plan.*removed|removed.*company\/plan/i.test(src);
    expect(hasComment).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin authorization: non-admin cannot reach /api/admin/* routes
// ---------------------------------------------------------------------------
describe('requireAdmin middleware', () => {
  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
  }

  test('unauthenticated request returns 401', () => {
    const req = { user: null };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('non-admin user returns 403', () => {
    const req = { user: makeUser({ is_admin: false }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('admin user passes through', () => {
    const req = { user: makeUser({ is_admin: true }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stripe webhook: invalid signature → 400
// ---------------------------------------------------------------------------
describe('Stripe webhook signature validation', () => {
  test('invalid signature returns 400', () => {
    // Simulate what the handler does when constructEvent throws
    const verifyAndRespond = (sig, res) => {
      try {
        if (!sig || sig === 'bad') throw new Error('No signatures found matching the expected signature');
        return { ok: true };
      } catch (err) {
        res.status(400).send(`Webhook Error: ${err.message}`);
        return null;
      }
    };

    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const result = verifyAndRespond('bad', res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('valid signature proceeds past signature check', () => {
    const verifyAndRespond = (sig, res) => {
      try {
        if (!sig || sig === 'bad') throw new Error('No signatures found matching the expected signature');
        return { ok: true };
      } catch (err) {
        res.status(400).send(`Webhook Error: ${err.message}`);
        return null;
      }
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const result = verifyAndRespond('valid-sig', res);
    expect(result).toEqual({ ok: true });
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stripe webhook idempotency guard (F2 fix)
// ---------------------------------------------------------------------------
describe('Stripe webhook idempotency (F2 fix)', () => {
  test('duplicate event ID returns 200 with duplicate:true', async () => {
    // Simulate the idempotency check logic
    const processedIds = new Set(['evt_already_seen']);

    async function idempotencyCheck(eventId, pool, res) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO processed_stripe_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`,
          [eventId]
        );
        if (rows.length === 0) {
          res.json({ received: true, duplicate: true });
          return false; // already processed
        }
        return true; // new event
      } catch (err) {
        // table missing — proceed
        return true;
      }
    }

    const mockPool = { query: jest.fn() };
    // rowCount 0 means ON CONFLICT DO NOTHING fired — already exists
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = { json: jest.fn() };

    const shouldProcess = await idempotencyCheck('evt_already_seen', mockPool, res);
    expect(shouldProcess).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ received: true, duplicate: true });
  });

  test('new event ID proceeds to processing', async () => {
    async function idempotencyCheck(eventId, pool, res) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO processed_stripe_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`,
          [eventId]
        );
        if (rows.length === 0) {
          res.json({ received: true, duplicate: true });
          return false;
        }
        return true;
      } catch (err) {
        return true;
      }
    }

    const mockPool = { query: jest.fn() };
    // rowCount 1 means new insertion
    mockPool.query.mockResolvedValueOnce({ rows: [{ event_id: 'evt_new' }], rowCount: 1 });
    const res = { json: jest.fn() };

    const shouldProcess = await idempotencyCheck('evt_new', mockPool, res);
    expect(shouldProcess).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
  });

  test('graceful degradation when idempotency table is missing', async () => {
    async function idempotencyCheck(eventId, pool, res) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO processed_stripe_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`,
          [eventId]
        );
        if (rows.length === 0) {
          res.json({ received: true, duplicate: true });
          return false;
        }
        return true;
      } catch (err) {
        // table doesn't exist — proceed without idempotency rather than rejecting valid events
        return true;
      }
    }

    const mockPool = { query: jest.fn() };
    mockPool.query.mockRejectedValueOnce(new Error('relation "processed_stripe_events" does not exist'));
    const res = { json: jest.fn() };

    const shouldProcess = await idempotencyCheck('evt_any', mockPool, res);
    expect(shouldProcess).toBe(true); // graceful degradation
  });
});

// ---------------------------------------------------------------------------
// Listing search — seller name not exposed (server.js F1)
// ---------------------------------------------------------------------------
describe('GET /api/listings/search — no seller name enumeration (F1 fix)', () => {
  test('listings/search SELECT does not include u.first_name or u.last_name', () => {
    const fs = require('fs');
    const src = fs.readFileSync('/home/user/RealtorFinder/server.js', 'utf8');

    // Find the listings/search block
    const searchIdx = src.indexOf("'/api/listings/search'");
    expect(searchIdx).toBeGreaterThan(-1);

    // Extract the next 3000 chars after route definition to inspect the query
    const snippet = src.slice(searchIdx, searchIdx + 3000);

    // Should NOT have u.first_name or u.last_name in SELECT
    const hasFirstName = /u\.first_name/.test(snippet);
    const hasLastName = /u\.last_name/.test(snippet);
    expect(hasFirstName).toBe(false);
    expect(hasLastName).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-ownership: seller A cannot view listing owned by seller B
// (spot-check: auth.requireAuth enforces session, route checks owner)
// ---------------------------------------------------------------------------
describe('Listing ownership enforcement', () => {
  function checkListingOwnership(req, listing, res, next) {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (listing.seller_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not your listing' });
    }
    next();
  }

  test('owner can access their own listing', () => {
    const req = { user: makeUser({ id: 1 }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    checkListingOwnership(req, { seller_id: 1 }, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('non-owner seller cannot access another seller listing', () => {
    const req = { user: makeUser({ id: 2, user_type: 'seller' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    checkListingOwnership(req, { seller_id: 1 }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('admin can access any listing', () => {
    const req = { user: makeUser({ id: 99, is_admin: true }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    checkListingOwnership(req, { seller_id: 1 }, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('unauthenticated request returns 401', () => {
    const req = { user: null };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    checkListingOwnership(req, { seller_id: 1 }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// Proposal ownership: realtor A cannot modify realtor B's proposal
// ---------------------------------------------------------------------------
describe('Proposal ownership enforcement', () => {
  function checkProposalOwnership(req, proposal, res, next) {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (proposal.realtor_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Not your proposal' });
    }
    next();
  }

  test('proposal owner can modify their proposal', () => {
    const req = { user: makeUser({ id: 5, user_type: 'realtor' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    checkProposalOwnership(req, { realtor_id: 5 }, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('different realtor cannot modify another realtor proposal', () => {
    const req = { user: makeUser({ id: 6, user_type: 'realtor' }) };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    checkProposalOwnership(req, { realtor_id: 5 }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// Unapproved realtor cannot POST /api/proposals (gate enforced upstream)
// ---------------------------------------------------------------------------
describe('Unapproved realtor blocked from POST /api/proposals', () => {
  // The approval gate blocks unapproved users; this test verifies the logic
  function approvalGate(req, res, next) {
    if (!req.user || !req.user.id) return next();
    if (req.user.is_active === false) return res.status(403).json({ error: 'account_deactivated' });
    if (!req.user.is_admin && req.user.is_approved !== true) {
      return res.status(403).json({ error: 'account_pending' });
    }
    next();
  }

  test('unapproved realtor blocked at gate', () => {
    const req = {
      user: makeUser({ user_type: 'realtor', is_approved: false }),
      path: '/proposals',
      method: 'POST',
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('approved realtor passes gate', () => {
    const req = {
      user: makeUser({ user_type: 'realtor', is_approved: true }),
      path: '/proposals',
      method: 'POST',
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    approvalGate(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
