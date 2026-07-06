// Build a stats lookup for every item seen in the auction POC, so the dashboard can
// show item stats on hover. Known items come straight from mnmdb/wiki.json; items not
// in the DB yet are fetched from the wiki (reusing enrich-wiki's parsers), same engine
// as the trade-orphan enrichment. Writes stats.json into the POC data folder.
//
//   one-shot:  MNM_DATA=... node tracker/enrich-auction-stats.js
//   loop:      MNM_STATS_LOOP=1 MNM_HOURS=12 node tracker/enrich-auction-stats.js
// Incremental: only fetches items not already in stats.json, so loop runs are cheap.

const fs = require('fs');
const path = require('path');
const W = require('./enrich-wiki.js');

const DATA = process.env.MNM_DATA || 'C:\\Users\\zacha\\Desktop\\mnm-auction-poc';
const WIKI = path.join(__dirname, '..', 'mnmdb', 'wiki.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Trim a wiki record to just what the hover popover shows.
const slim = (w, name) => ({
  name,
  hasPage: w.hasPage !== false,
  icon: w.icon || null,
  iconId: w.iconId || null,
  slot: w.slot || null,
  weight: w.weight != null ? w.weight : null,
  size: w.size || null,
  class: w.class || null,
  race: w.race || null,
  dmg: w.dmg != null ? w.dmg : null,
  delay: w.delay != null ? w.delay : null,
  skill: w.skill || null,
  zones: w.wikiZones || w.zones || [],
  from: (w.from || []).slice(0, 6),
  vendor: (w.soldBy && w.soldBy.base != null) ? w.soldBy.base : null,
});

async function buildStats() {
  const wiki = JSON.parse(fs.readFileSync(WIKI, 'utf8')).items || {};
  const wl = new Map(Object.keys(wiki).map((n) => [n.toLowerCase(), n]));
  let listings = [];
  try { listings = JSON.parse(fs.readFileSync(path.join(DATA, 'listings.json'), 'utf8')); } catch { return { total: 0 }; }
  const names = [...new Set(listings.map((l) => l.item).filter(Boolean))];

  const statsPath = path.join(DATA, 'stats.json');
  let stats = {}; try { stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')); } catch {}

  const toFetch = [];
  for (const n of names) {
    const lc = n.toLowerCase();
    const k = wl.get(lc);
    if (k) stats[lc] = slim(wiki[k], k);      // known → refresh from wiki.json (cheap)
    else if (!stats[lc]) toFetch.push(n);      // unknown + not fetched before → fetch
  }

  let fetched = 0;
  if (toFetch.length) {
    const cand = new Map(toFetch.map((n) => [n, [...new Set([n, W.titleCaseName(n)])]]));
    const allc = [...new Set([].concat(...cand.values()))];
    const texts = {};
    for (let i = 0; i < allc.length; i += 45) {
      try { Object.assign(texts, await W.fetchWikitext(allc.slice(i, i + 45))); } catch (e) { console.error('fetch batch failed:', e.message); }
      await sleep(350);
    }
    const lc = new Map(Object.keys(texts).map((k) => [k.toLowerCase(), k]));
    const rawFetched = {};
    for (const n of toFetch) {
      let hit = null;
      for (const c of cand.get(n)) { const k = lc.get(c.toLowerCase()); if (k) { hit = k; break; } }
      if (!hit) { stats[n.toLowerCase()] = slim({ hasPage: false }, n); continue; } // no wiki page — mark so we don't refetch
      const box = W.parseItemBox(texts[hit]);
      if (!box) { stats[n.toLowerCase()] = slim({ hasPage: false }, hit); continue; }
      const src = W.parseSources(texts[hit]);
      const soldBy = W.parseSoldBy(texts[hit]);
      rawFetched[n.toLowerCase()] = Object.assign({ name: hit, hasPage: true }, box, { wikiZones: src.zones, from: src.from, soldBy });
    }
    // resolve icons for the freshly fetched
    const iconIds = [...new Set(Object.values(rawFetched).map((e) => e.iconId).filter(Boolean))];
    if (iconIds.length) {
      try { const urls = await W.fetchImageUrls(iconIds.map((id) => 'File:' + id + '.png')); for (const e of Object.values(rawFetched)) if (e.iconId) e.icon = urls['File:' + e.iconId + '.png'] || null; } catch (e) { console.error('icon fetch failed:', e.message); }
    }
    for (const [k, e] of Object.entries(rawFetched)) { stats[k] = slim(e, e.name); fetched++; }
  }

  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  const withStats = Object.values(stats).filter((s) => s.hasPage && (s.slot || s.weight != null || s.class || s.dmg != null)).length;
  console.log(`[${new Date().toISOString()}] stats.json: ${Object.keys(stats).length} items (${names.length} in listings), ${fetched} newly fetched, ${withStats} with real stats`);
  return { total: Object.keys(stats).length, fetched };
}

module.exports = { buildStats };

if (require.main === module) {
  const LOOP = !!process.env.MNM_STATS_LOOP;
  const INTERVAL = (+process.env.MNM_STATS_INTERVAL || 900) * 1000; // 15 min
  const DEADLINE = Date.now() + (+process.env.MNM_HOURS || 12) * 3600 * 1000;
  const tick = () => buildStats().catch((e) => console.error('buildStats error:', e.message)).finally(() => {
    if (LOOP && Date.now() < DEADLINE) setTimeout(tick, INTERVAL);
  });
  tick();
}
