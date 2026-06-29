-- Phase 2: a marker belongs to a specific map. 'official' = the curated maps.json map
-- for the zone (the only map that existed when older markers were placed, so they all
-- backfill to it). Community maps use their numeric maps.id as a string. Run once:
--   npx wrangler d1 execute mnmdb --remote --file=migrate-map-id.sql
ALTER TABLE submissions ADD COLUMN map_id TEXT NOT NULL DEFAULT 'official';
