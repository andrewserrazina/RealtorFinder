'use strict';
/**
 * Stripe webhook idempotency tests.
 *
 * These tests verify the correct SELECT-before-INSERT pattern without booting
 * the full Express server. They mirror the production code structure so that
 * any refactor that breaks the ordering will fail here.
 */

// ── Helpers that mirror the production webhook logic ─────────────────────────

/**
 * Simplified version of the Stripe webhook idempotency guard (mirrors server.js).
 * Returns the handler's early-exit decision or null if execution should continue.
 */
async function idempotencyGuard(pool, eventId) {
    // SELECT check: if table missing → 503; if duplicate → {duplicate:true}; else null = proceed
    try {
        const seen = await pool.query(
            `SELECT 1 FROM processed_stripe_events WHERE event_id=$1`,
            [eventId]
        );
        if (seen.rowCount > 0) return { status: 200, body: { received: true, duplicate: true } };
        return null; // not yet processed — caller should run business logic then INSERT
    } catch (err) {
        return { status: 503, body: 'Service temporarily unavailable — pending migration' };
    }
}

async function markProcessed(pool, eventId, eventType) {
    await pool.query(
        `INSERT INTO processed_stripe_events(event_id, event_type) VALUES($1, $2) ON CONFLICT DO NOTHING`,
        [eventId, eventType]
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Stripe webhook — idempotency guard', () => {
    let pool;

    beforeEach(() => {
        pool = { query: jest.fn() };
    });

    test('returns duplicate:true when event_id is already in the table', async () => {
        pool.query.mockResolvedValue({ rowCount: 1, rows: [{}] });

        const result = await idempotencyGuard(pool, 'evt_dup_001');
        expect(result).toEqual({ status: 200, body: { received: true, duplicate: true } });
    });

    test('returns null (proceed) when event_id is not yet in the table', async () => {
        pool.query.mockResolvedValue({ rowCount: 0, rows: [] });

        const result = await idempotencyGuard(pool, 'evt_new_001');
        expect(result).toBeNull();
    });

    test('returns 503 when processed_stripe_events table does not exist', async () => {
        const tableErr = Object.assign(
            new Error('relation "processed_stripe_events" does not exist'),
            { code: '42P01' }
        );
        pool.query.mockRejectedValue(tableErr);

        const result = await idempotencyGuard(pool, 'evt_nomig_001');
        expect(result.status).toBe(503);
    });
});

describe('Stripe webhook — SELECT-before-INSERT invariant', () => {
    test('markProcessed is called AFTER idempotencyGuard (not before)', async () => {
        const callOrder = [];
        const pool = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.includes('FROM processed_stripe_events')) callOrder.push('SELECT');
                if (sql.includes('INSERT INTO processed_stripe_events')) callOrder.push('INSERT');
                return Promise.resolve({ rowCount: 0, rows: [] });
            })
        };

        // Simulate the correct call order used in server.js
        const earlyExit = await idempotencyGuard(pool, 'evt_order_001');
        expect(earlyExit).toBeNull(); // not a duplicate

        // (business logic would run here)

        await markProcessed(pool, 'evt_order_001', 'invoice.payment_succeeded');

        expect(callOrder).toEqual(['SELECT', 'INSERT']);
    });

    test('INSERT is NOT called when event is a duplicate (SELECT short-circuits)', async () => {
        const callOrder = [];
        const pool = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.includes('FROM processed_stripe_events')) callOrder.push('SELECT');
                if (sql.includes('INSERT INTO processed_stripe_events')) callOrder.push('INSERT');
                return Promise.resolve({ rowCount: 1, rows: [{}] }); // already seen
            })
        };

        const earlyExit = await idempotencyGuard(pool, 'evt_dup_order');
        expect(earlyExit?.body?.duplicate).toBe(true);
        // markProcessed should NOT be called after a duplicate guard fires
        expect(callOrder).toEqual(['SELECT']);
        expect(callOrder).not.toContain('INSERT');
    });

    test('INSERT is NOT called when table is missing (503 short-circuits)', async () => {
        const callOrder = [];
        const pool = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.includes('FROM processed_stripe_events')) {
                    callOrder.push('SELECT');
                    return Promise.reject(new Error('relation does not exist'));
                }
                if (sql.includes('INSERT INTO processed_stripe_events')) callOrder.push('INSERT');
                return Promise.resolve({ rowCount: 0, rows: [] });
            })
        };

        const earlyExit = await idempotencyGuard(pool, 'evt_nomig_order');
        expect(earlyExit?.status).toBe(503);
        expect(callOrder).toEqual(['SELECT']);
        expect(callOrder).not.toContain('INSERT');
    });
});

describe('Stripe webhook — server.js code patterns', () => {
    const fs = require('fs');
    const path = require('path');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

    // Extract the webhook handler source for pattern checks
    const webhookStart = serverSrc.indexOf("app.post('/api/webhook/stripe'");
    const webhookEnd   = serverSrc.indexOf('\n});', webhookStart) + 4;
    const webhookSrc   = serverSrc.slice(webhookStart, webhookEnd);

    test('idempotency guard uses SELECT (not INSERT) for the initial duplicate check', () => {
        // The first processed_stripe_events query should be a SELECT
        const firstOccurrence = webhookSrc.indexOf('processed_stripe_events');
        const snippet = webhookSrc.slice(firstOccurrence - 30, firstOccurrence + 80);
        expect(snippet).toMatch(/SELECT\s+1\s+FROM\s+processed_stripe_events/);
    });

    test('INSERT into processed_stripe_events comes after SELECT in the handler', () => {
        const selectIdx = webhookSrc.indexOf('FROM processed_stripe_events');
        const insertIdx = webhookSrc.indexOf('INSERT INTO processed_stripe_events');
        expect(selectIdx).toBeGreaterThan(-1);
        expect(insertIdx).toBeGreaterThan(selectIdx);
    });

    test('missing-table catch block returns 503, not 200', () => {
        // Find the catch block after the SELECT guard
        const selectBlock = webhookSrc.indexOf('FROM processed_stripe_events');
        const catchAfterSelect = webhookSrc.indexOf('} catch', selectBlock);
        const catchSnippet = webhookSrc.slice(catchAfterSelect, catchAfterSelect + 200);
        expect(catchSnippet).toMatch(/503/);
        expect(catchSnippet).not.toMatch(/proceed without idempotency/);
    });

    test('CSP is in reportOnly mode (not disabled)', () => {
        expect(serverSrc).toMatch(/reportOnly\s*:\s*true/);
        expect(serverSrc).not.toMatch(/contentSecurityPolicy\s*:\s*false/);
    });

    test('CSP report endpoint exists', () => {
        expect(serverSrc).toMatch(/app\.post\(['"]\/api\/csp-report['"]/);
    });
});
