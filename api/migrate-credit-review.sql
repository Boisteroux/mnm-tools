-- A credit name typed under "Other" in MnM Map waits for an admin's OK before it
-- appears on the site (1 = waiting). Names that are one of the player's own
-- characters, or from trusted Discord users, are 0.
--   npx wrangler d1 execute mnmdb --remote --file=migrate-credit-review.sql
ALTER TABLE contributors ADD COLUMN credit_review INTEGER NOT NULL DEFAULT 0;
