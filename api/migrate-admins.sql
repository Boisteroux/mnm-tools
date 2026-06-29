-- Per-user admins: named Discord people who can moderate + edit/delete/move ANY
-- marker, without sharing the ADMIN_TOKEN. The token holder stays "super-admin"
-- (the only one who can promote/demote). Run once:
--   npx wrangler d1 execute mnmdb --remote --file=migrate-admins.sql
CREATE TABLE IF NOT EXISTS admins (
  discord_id TEXT PRIMARY KEY,                        -- a full admin (moderation + edit anyone)
  name       TEXT,                                    -- last-seen display name (for the UI)
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
