-- Add Stripe billing columns to companies table
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_companies_stripe_customer ON companies(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_companies_stripe_sub ON companies(stripe_subscription_id);
