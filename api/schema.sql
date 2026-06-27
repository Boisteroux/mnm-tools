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
  ip_hash     TEXT                                    -- hashed, for rate-limiting only (never the raw IP)
);
CREATE INDEX IF NOT EXISTS idx_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_ip_recent ON submissions(ip_hash, created_at);
