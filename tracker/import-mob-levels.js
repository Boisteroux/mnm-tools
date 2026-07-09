// Scrape wiki levels for every mob that DROPS an item, so the "max drop level"
// filter (Advanced Search + Best-in-Slot) has data to work with. The main
// enrich-wiki.js scrape only fetches mobs you've personally fought (ds.mobs), so
// the hundreds of droppers listed on item pages have no level. This fills that gap
// into a compact mnmdb/mob-levels-wiki.json — { "mob name": level } — which the
// site merges on top of the ledger mobs and the manual estimates.
//
//   node tracker/import-mob-levels.js            (full run)
//   MNM_SAMPLE=40 node tracker/import-mob-levels.js   (quick hit-rate check)

const fs = require('fs');
const path = require('path');
const { fetchWikitext } = require('./enrich-wiki.js');

const WIKI = path.join(__dirname, '..', 'mnmdb', 'wiki.json');
const OUT = path.join(__dirname, '..', 'mnmdb', 'mob-levels-wiki.json');
const SAMPLE = +process.env.MNM_SAMPLE || 0;

// First integer in a wiki level string ("3 - 10", "5 to 8", "10") — the lowest
// level the mob can be, matching the "farmable from a mob at/below L" filter.
function levelOf(wikitext) {
  const m = wikitext.match(/\{\{\s*Namedmobpage([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const lm = m[1].match(/\|\s*level\s*=\s*([^\n|]+)/i);
  if (!lm) return null;
  const n = parseInt(lm[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function run() {
  const wiki = JSON.parse(fs.readFileSync(WIKI, 'utf8'));
  const items = wiki.items || {}, mobs = wiki.mobs || {};

  // Start from any levels the main scrape already captured (ledger mobs).
  const out = {};
  for (const [n, m] of Object.entries(mobs)) { const l = parseInt(m && m.level, 10); if (Number.isFinite(l)) out[n.toLowerCase()] = l; }
  const seeded = Object.keys(out).length;

  // Every distinct dropper named on an item page that we don't already have a level for.
  const need = new Set();
  for (const e of Object.values(items)) for (const f of (e.from || [])) if (out[String(f).toLowerCase()] == null) need.add(f);
  let titles = [...need];
  if (SAMPLE) titles = titles.slice(0, SAMPLE);
  console.log(`seeded ${seeded} levels from wiki.mobs · fetching ${titles.length} droppers${SAMPLE ? ' (sample)' : ''}…`);

  let found = 0;
  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    process.stdout.write(`  ${i + 1}-${i + batch.length}/${titles.length}\r`);
    let texts; try { texts = await fetchWikitext(batch); } catch (e) { console.error('\nbatch failed:', e.message); continue; }
    for (const [title, txt] of Object.entries(texts)) {
      const l = levelOf(txt || '');
      if (l != null) { out[title.toLowerCase()] = l; found++; }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\n+${found} dropper levels found · ${Object.keys(out).length} total → mnmdb/mob-levels-wiki.json (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

run();
