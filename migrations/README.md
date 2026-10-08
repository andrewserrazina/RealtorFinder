# Database Migrations

## Apply Order

Run scripts in this exact order against a fresh database or an existing one being upgraded.

| # | File | Description |
|---|------|-------------|
| 0 | `../database.sql` | Base schema (tables: listings, offers, …) |
| 1 | `../auth-schema.sql` | Users table + auth columns |
| 2 | `../migration-companies.sql` | Companies table |
| 3 | `../migration-stripe.sql` | Stripe billing columns on companies/users |
| 4 | `../migration-features.sql` | Feature flags / plan-gated columns |
| 5 | `../migration-launch.sql` | Phone, license, bio, is_admin, is_active, soft-delete |
| 6 | `../migration-views.sql` | view_count on listings |
| 7 | `../migration-reviews-saved.sql` | Reviews + saved listings tables |
| 8 | `../migration-buyers.sql` | Buyer request tables |
| 9 | `../migration-crm.sql` | CRM / contacts tables |
| 10 | `../migration-waitlist.sql` | Waitlist table |
| 11 | `../migration-blog.sql` | Blog posts table |
| 12 | `../migration-cities.sql` | City pages table |
| 13 | `../migration-city-leads.sql` | City-level lead tracking |
| 14 | `../migration-add-missing-columns.sql` | Backfill missing columns on existing tables |
| 15 | `../migration-add-geocoding.sql` | lat/lng geocoding columns |
| 16 | `../migration-zestimate.sql` | Zestimate / valuation columns |
| 17 | `../migration-add-stripe-idempotency.sql` | `processed_stripe_events` dedup table |

> **Note:** All migration scripts are idempotent (`IF NOT EXISTS`, `IF NOT EXISTS` indexes). Running
> them more than once is safe.

## Production Preflight

Before applying to production:

1. Take a full database backup (`pg_dump`).
2. Apply each file in order: `psql $DATABASE_URL -f <file>`
3. Verify the key tables exist after each step:
   ```sql
   SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
   ```
4. After step 17, confirm the idempotency table:
   ```sql
   SELECT COUNT(*) FROM processed_stripe_events;
   ```
5. Restart the application server so it picks up the new table (the server returns 503
   on the Stripe webhook endpoint until this migration is applied).

## Rollback Notes

- Most `ALTER TABLE … ADD COLUMN IF NOT EXISTS` operations can be rolled back with
  `ALTER TABLE … DROP COLUMN IF EXISTS <column>`.
- Dropping `processed_stripe_events` is safe; the server falls back to 503 responses
  on webhook delivery, which causes Stripe to queue and retry all events.
- `migration-launch.sql` adds `is_active` (default TRUE) and `is_admin` (default FALSE)
  — dropping these columns requires a code deploy that removes references first.
