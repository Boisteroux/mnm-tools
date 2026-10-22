-- Community submissions (markers first; the `type` column lets prices/drops reuse this later).
CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL DEFAULT 'marker',
  zone        TEXT NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  category    TEXT NOT NULL,
  label       TEXT NOT NULL,
  map_id      TEXT NOT NULL DEFAULT 'official',        -- which map this marker is on ('official' = maps.json, else a maps.id)
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

-- Community-submitted zone maps (image bytes in R2 bucket mnmdb-maps, keyed by r2_key).
CREATE TABLE IF NOT EXISTS maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  zone        TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  label       TEXT,
  mime        TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  submitter   TEXT,
  discord_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maps_zone_status ON maps(zone, status);

-- Play-data contributions from the desktop app (see migrate-contributions.sql).
CREATE TABLE IF NOT EXISTS contributors (
  id           TEXT PRIMARY KEY,                     -- random id the app is given at sign-up
  token_hash   TEXT NOT NULL,                        -- sha256 of the install's secret
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  discord_id   TEXT,
  discord_name TEXT,
  credit_name  TEXT,                                 -- set only when the player opts in to credit
  ip_hash      TEXT,                                 -- hashed, for sign-up rate-limiting only
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_contributors_status ON contributors(status);
CREATE INDEX IF NOT EXISTS idx_contributors_ip ON contributors(ip_hash, created_at);

-- The latest rolled-up play data from each contributor (an upload replaces the last
-- one, so re-sharing never double-counts). `data` is the ledger aggregate as JSON.
CREATE TABLE IF NOT EXISTS contributions (
  contributor_id TEXT PRIMARY KEY,
  characters     TEXT,                               -- JSON array, for the moderation view
  servers        TEXT,                               -- JSON array of game servers
  events         INTEGER NOT NULL DEFAULT 0,
  kills          INTEGER NOT NULL DEFAULT 0,
  items          INTEGER NOT NULL DEFAULT 0,
  data           TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
