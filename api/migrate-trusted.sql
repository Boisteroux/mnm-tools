-- Self-service trusted-contributor list. Run once:
--   npx wrangler d1 execute mnmdb --remote --file=migrate-trusted.sql
CREATE TABLE IF NOT EXISTS trusted (
  discord_id TEXT PRIMARY KEY,                        -- whose markers auto-approve
  name       TEXT,                                    -- last-seen display name (for the UI)
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
