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

    test('invalid Stripe signature returns 400', () => {
        // The handler calls constructEvent and catches errors with a 400 response
        expect(webhookSrc).toMatch(/\.constructEvent\(/);
        expect(webhookSrc).toMatch(/res\.status\(400\)/);
    });

    test('unknown event type results in graceful no-op (no throw, falls through to 200)', () => {
        // After all if/switch branches, the handler should reach the INSERT and return 200
        // Verify there is no throw or error for unrecognised event types
        const insertIdx = webhookSrc.indexOf('INSERT INTO processed_stripe_events');
        const afterInsert = webhookSrc.slice(insertIdx, insertIdx + 200);
        expect(afterInsert).toMatch(/res\.json/);
    });
});

describe('Stripe webhook — rollback on business-logic failure', () => {
    // Simulate the correct production flow:
    //   SELECT → (not duplicate) → run business logic → INSERT
    // When business logic throws the INSERT must NOT have been called.

    async function simulateWebhookFlow(pool, eventId, businessLogic) {
        // Step 1: idempotency check
        const earlyExit = await (async () => {
            try {
                const seen = await pool.query(
                    `SELECT 1 FROM processed_stripe_events WHERE event_id=$1`,
                    [eventId]
                );
                if (seen.rowCount > 0) return { status: 200, body: { received: true, duplicate: true } };
                return null;
            } catch (err) {
                return { status: 503, body: 'Service temporarily unavailable' };
            }
        })();
        if (earlyExit) return earlyExit;

        // Step 2: business logic (may throw)
        await businessLogic();

        // Step 3: mark processed (only reached if business logic succeeded)
        await pool.query(
            `INSERT INTO processed_stripe_events(event_id, event_type) VALUES($1, $2) ON CONFLICT DO NOTHING`,
            [eventId, 'test.event']
        );
        return { status: 200, body: { received: true } };
    }

    test('business logic throws → INSERT not called → event_id NOT persisted', async () => {
        const callOrder = [];
        const pool = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.includes('FROM processed_stripe_events')) {
                    callOrder.push('SELECT');
                    return Promise.resolve({ rowCount: 0, rows: [] }); // not yet seen
                }
                if (sql.includes('INSERT INTO processed_stripe_events')) {
                    callOrder.push('INSERT');
                }
                return Promise.resolve({ rowCount: 0, rows: [] });
            })
        };

        const failingBusinessLogic = () => Promise.reject(new Error('DB transient failure'));

        await expect(simulateWebhookFlow(pool, 'evt_fail_001', failingBusinessLogic))
            .rejects.toThrow('DB transient failure');

        expect(callOrder).toEqual(['SELECT']); // INSERT never ran
        expect(callOrder).not.toContain('INSERT');
    });

    test('successful retry after partial failure → business logic completes, event marked processed', async () => {
        const callOrder = [];
        let attempt = 0;
        const pool = {
            query: jest.fn().mockImplementation((sql) => {
                if (sql.includes('FROM processed_stripe_events')) {
                    callOrder.push('SELECT');
                    return Promise.resolve({ rowCount: 0, rows: [] }); // never seen (INSERT never committed on first attempt)
                }
                if (sql.includes('INSERT INTO processed_stripe_events')) {
                    callOrder.push('INSERT');
                }
                return Promise.resolve({ rowCount: 1, rows: [] });
            })
        };

        // First attempt: business logic fails
        attempt = 1;
        const failingLogic = () => Promise.reject(new Error('transient'));
        await expect(simulateWebhookFlow(pool, 'evt_retry_001', failingLogic)).rejects.toThrow();

        const afterFirstAttempt = [...callOrder];
        expect(afterFirstAttempt).toEqual(['SELECT']); // no INSERT on failed attempt

        // Second attempt: business logic succeeds
        const successLogic = () => Promise.resolve();
        const result = await simulateWebhookFlow(pool, 'evt_retry_001', successLogic);
        expect(result.status).toBe(200);
        expect(callOrder).toEqual(['SELECT', 'SELECT', 'INSERT']); // retry completed
    });

    test('concurrent delivery: second call sees duplicate via SELECT → skips business logic', async () => {
        // After first delivery succeeds, the second concurrent delivery hits the SELECT guard.
        // This tests that ON CONFLICT DO NOTHING plus SELECT-first prevents double-processing.
        const callOrder = [];
        const processedSet = new Set();

        const makePool = () => ({
            query: jest.fn().mockImplementation((sql, params) => {
                if (sql.includes('FROM processed_stripe_events')) {
                    callOrder.push('SELECT');
                    const alreadyProcessed = processedSet.has(params[0]);
                    return Promise.resolve({ rowCount: alreadyProcessed ? 1 : 0, rows: alreadyProcessed ? [{}] : [] });
                }
                if (sql.includes('INSERT INTO processed_stripe_events')) {
                    callOrder.push('INSERT');
                    processedSet.add(params[0]); // simulate committed INSERT
                }
                return Promise.resolve({ rowCount: 1, rows: [] });
            })
        });

        const pool1 = makePool();
        const pool2 = makePool();
        let creditApplied = 0;
        const businessLogic = () => { creditApplied++; return Promise.resolve(); };

        // First delivery succeeds
        await simulateWebhookFlow(pool1, 'evt_concurrent_001', businessLogic);
        expect(creditApplied).toBe(1);

        // Second (concurrent) delivery — table now has the event_id
        const pool3 = makePool(); // shares processedSet
        const result2 = await simulateWebhookFlow(pool3, 'evt_concurrent_001', businessLogic);
        expect(result2.body?.duplicate).toBe(true);
        expect(creditApplied).toBe(1); // business logic NOT called a second time
    });

    test('missing migration on retry: table still missing → 503, not bypass', async () => {
        const pool = {
            query: jest.fn().mockRejectedValue(
                Object.assign(new Error('relation "processed_stripe_events" does not exist'), { code: '42P01' })
            )
        };
        const businessLogic = jest.fn().mockResolvedValue(undefined);

        const result = await simulateWebhookFlow(pool, 'evt_nomig_retry', businessLogic);
        expect(result.status).toBe(503);
        expect(businessLogic).not.toHaveBeenCalled(); // business logic bypassed, not executed
    });
});
