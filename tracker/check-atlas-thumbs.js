// Check the MnM Atlas previews the site uses (ATLAS_MAPS in mnmdb/app.js): every card's
// /mini/ still should load, and every map the Atlas draws should be on our list.
// The Atlas renames or removes marked spots now and then, which kills a still.
//
//   node tracker/check-atlas-thumbs.js      (exit 1 when something needs fixing)

const fs = require('fs');
const path = require('path');

const ATLAS = 'https://www.mnmatlas.com/';
const src = fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'app.js'), 'utf8');
const block = (src.match(/const ATLAS_MAPS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const entries = [...block.matchAll(/(['"])((?:(?!\1).)+)\1:\s*\['([a-z0-9-]+)',\s*'([a-z0-9-]+)'\]/g)].map((m) => ({ zone: m[2], id: m[3], spot: m[4] }));
const world = (src.match(/const ATLAS_WORLD_THUMB = '([^']+)'/) || [])[1];

const ok = async (url) => { try { const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'mnm-tools atlas-thumb check' } }); return r.ok; } catch { return false; } };

(async () => {
  let bad = 0;
  if (world && !(await ok(ATLAS + world))) { bad++; console.log(`DEAD  World map card: ${world}`); }
  for (const e of entries) {
    if (await ok(ATLAS + 'mini/' + e.id + '/' + e.spot + '.webp')) continue;
    bad++;
    // Suggest a replacement: the first spot on that map whose still loads.
    let suggestion = '';
    try {
      const j = await (await fetch(ATLAS + 'data/' + e.id + '/markers.json')).json();
      for (const m of (Array.isArray(j) ? j : j.markers || []).slice(0, 25)) {
        if (await ok(ATLAS + 'mini/' + e.id + '/' + m.id + '.webp')) { suggestion = ` — try '${m.id}' (${m.name})`; break; }
      }
    } catch {}
    console.log(`DEAD  ${e.zone}: ${e.id}/${e.spot}${suggestion}`);
  }
  let missing = [];
  try {
    const maps = (await (await fetch(ATLAS + 'data/maps.json')).json()).maps || [];
    const have = new Set(entries.map((e) => e.id).concat(world ? ['world'] : []));
    missing = maps.filter((m) => !have.has(m.id)).map((m) => `${m.title} (${m.id})`);
  } catch {}
  for (const m of missing) console.log(`NEW   the Atlas draws ${m}, which the site doesn't use yet`);
  console.log(`${entries.length + (world ? 1 : 0)} previews checked: ${bad} dead, ${missing.length} Atlas maps not on our list.`);
  process.exit(bad || missing.length ? 1 : 0);
})();
