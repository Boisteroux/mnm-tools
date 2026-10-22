-- Play-data contributions from the MnM Map desktop app (opt-in automatic sharing).
--   npx wrangler d1 execute mnmdb --remote --file=migrate-contributions.sql
--
-- One contributor per app install. Anonymous installs prove who they are with a
-- secret token (only its hash is stored); signing in with Discord in the app links a
-- Discord id, and trusted/admin Discord users skip the approval queue.
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
