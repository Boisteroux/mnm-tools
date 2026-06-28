-- Adds the columns "Sign in with Discord" needs. Safe to run once on the existing DB:
--   npx wrangler d1 execute mnmdb --remote --file=migrate-discord.sql
ALTER TABLE submissions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;  -- 1 = submitted by a signed-in Discord user
ALTER TABLE submissions ADD COLUMN discord_id TEXT;                      -- the verified Discord user id
