-- migration-add-stripe-idempotency.sql
-- Creates the table that deduplicates Stripe webhook event deliveries.
-- Run after migration-stripe.sql.

CREATE TABLE IF NOT EXISTS processed_stripe_events (
    event_id    TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prune entries older than 30 days in a periodic job (or manually):
--   DELETE FROM processed_stripe_events WHERE created_at < NOW() - INTERVAL '30 days';
CREATE INDEX IF NOT EXISTS idx_pse_created ON processed_stripe_events(created_at);
