-- Community submissions (markers first; the `type` column lets prices/drops reuse this later).
CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL DEFAULT 'marker',
  zone        TEXT NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  category    TEXT NOT NULL,
  label       TEXT NOT NULL,
  submitter   TEXT,                                   -- optional "name for credit"
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  ip_hash     TEXT,                                   -- hashed, for rate-limiting only (never the raw IP)
  verified    INTEGER NOT NULL DEFAULT 0,             -- 1 = submitted by a signed-in Discord user
  discord_id  TEXT                                    -- the verified Discord user id
);
CREATE INDEX IF NOT EXISTS idx_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_ip_recent ON submissions(ip_hash, created_at);

-- Self-service trusted contributors (their submissions auto-approve).
CREATE TABLE IF NOT EXISTS trusted (
  discord_id TEXT PRIMARY KEY,
  name       TEXT,
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user admins (moderate + edit/delete/move ANY marker). The ADMIN_TOKEN holder
-- is the "super-admin" and the only one who can promote/demote these.
CREATE TABLE IF NOT EXISTS admins (
  discord_id TEXT PRIMARY KEY,
  name       TEXT,
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
