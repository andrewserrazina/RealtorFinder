'use strict';
// Tests for Stripe webhook idempotency behaviour.

// ── Mocks (must be declared before any require) ──────────────────────────────
jest.mock('pg', () => {
    const mQuery = jest.fn();
    const mPool = { query: mQuery, on: jest.fn(), connect: jest.fn() };
    return { Pool: jest.fn(() => mPool), mQuery };
});

jest.mock('stripe', () => {
    const mockInstance = {
        webhooks: { constructEvent: jest.fn() },
        customers: { createBalanceTransaction: jest.fn().mockResolvedValue({}) },
        checkout: { sessions: { create: jest.fn() } }
    };
    return jest.fn(() => mockInstance);
});

jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));
jest.mock('multer', () => {
    const m = jest.fn(() => ({ single: jest.fn(() => (q, r, n) => n()), array: jest.fn(() => (q, r, n) => n()) }));
    m.memoryStorage = jest.fn();
    return m;
});
jest.mock('connect-pg-simple', () =>
    jest.fn(() => jest.fn(() => ({ on: jest.fn() })))
);
jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn(() => ({ verifyIdToken: jest.fn() })) }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('bcrypt', () => ({
    hash: jest.fn(async (p) => `hashed:${p}`),
    compare: jest.fn(async (p, h) => h === `hashed:${p}`)
}));

// Set required env vars before server loads
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost:5432/mock';
process.env.SESSION_SECRET = 'test-secret-64-bytes-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.NODE_ENV = 'test';

const { Pool } = require('pg');
const poolInstance = new Pool();
const mockQuery = poolInstance.query;

const Stripe = require('stripe');
const stripeInstance = Stripe();

const supertest = require('supertest');
const app = require('../server');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(id, type = 'invoice.payment_succeeded') {
    return { id, type, data: { object: { customer: 'cus_test' } } };
}

function rawBody(evt) {
    return Buffer.from(JSON.stringify(evt));
}

function post(body) {
    return supertest(app)
        .post('/api/webhook/stripe')
        .set('stripe-signature', 'sig_mock')
        .set('Content-Type', 'application/json')
        .send(body);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Stripe webhook idempotency', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: pool.on() calls succeed quietly (needed at app init)
        poolInstance.on.mockImplementation(() => {});
    });

    test('duplicate event — returns 200 with duplicate:true', async () => {
        const evt = makeEvent('evt_dup_001');
        stripeInstance.webhooks.constructEvent.mockReturnValue(evt);

        // SELECT returns a row → already seen
        mockQuery.mockResolvedValue({ rowCount: 1, rows: [{}] });

        const res = await post(rawBody(evt));
        expect(res.status).toBe(200);
        expect(res.body.duplicate).toBe(true);
    });

    test('new event — returns 200 with received:true and no duplicate flag', async () => {
        const evt = makeEvent('evt_new_001');
        stripeInstance.webhooks.constructEvent.mockReturnValue(evt);

        // SELECT returns 0 → not yet seen; all other queries succeed
        mockQuery.mockImplementation((sql) => {
            if (typeof sql === 'string' && sql.includes('FROM processed_stripe_events')) {
                return Promise.resolve({ rowCount: 0, rows: [] });
            }
            return Promise.resolve({ rowCount: 1, rows: [] });
        });

        const res = await post(rawBody(evt));
        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.duplicate).toBeUndefined();
    });

    test('new event — INSERT happens AFTER the SELECT (business logic order)', async () => {
        const evt = makeEvent('evt_order_001');
        stripeInstance.webhooks.constructEvent.mockReturnValue(evt);

        const callLog = [];
        mockQuery.mockImplementation((sql) => {
            if (typeof sql === 'string') {
                if (sql.includes('FROM processed_stripe_events')) callLog.push('SELECT');
                if (sql.includes('INSERT INTO processed_stripe_events')) callLog.push('INSERT');
            }
            return Promise.resolve({ rowCount: 0, rows: [] });
        });

        await post(rawBody(evt));

        const selectIdx = callLog.indexOf('SELECT');
        const insertIdx = callLog.indexOf('INSERT');
        expect(selectIdx).toBeGreaterThanOrEqual(0);
        expect(insertIdx).toBeGreaterThan(selectIdx);
    });

    test('missing table — returns 503', async () => {
        const evt = makeEvent('evt_nomigration_001');
        stripeInstance.webhooks.constructEvent.mockReturnValue(evt);

        // SELECT throws relation-does-not-exist
        mockQuery.mockImplementation((sql) => {
            if (typeof sql === 'string' && sql.includes('FROM processed_stripe_events')) {
                return Promise.reject(Object.assign(
                    new Error('relation "processed_stripe_events" does not exist'),
                    { code: '42P01' }
                ));
            }
            return Promise.resolve({ rowCount: 1, rows: [] });
        });

        const res = await post(rawBody(evt));
        expect(res.status).toBe(503);
    });

    test('invalid signature — returns 400', async () => {
        stripeInstance.webhooks.constructEvent.mockImplementation(() => {
            throw new Error('No signatures found matching the expected signature');
        });

        const res = await post(Buffer.from('{}'));
        expect(res.status).toBe(400);
    });
});
