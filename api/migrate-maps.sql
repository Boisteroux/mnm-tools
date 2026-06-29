-- Community-submitted zone maps. The image bytes live in R2 (bucket mnmdb-maps,
-- keyed by r2_key); this table is the metadata + moderation state. Run once:
--   npx wrangler d1 execute mnmdb --remote --file=migrate-maps.sql
CREATE TABLE IF NOT EXISTS maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  zone        TEXT NOT NULL,
  r2_key      TEXT NOT NULL,                       -- object key in the R2 bucket
  label       TEXT,                                -- optional name ("Dungeon level 2", "Labeled")
  mime        TEXT NOT NULL,                       -- image/jpeg | image/png | image/webp
  width       INTEGER,                             -- natural pixel size (client-reported)
  height      INTEGER,
  submitter   TEXT,                                -- display name for credit
  discord_id  TEXT,                                -- the verified submitter
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maps_zone_status ON maps(zone, status);
