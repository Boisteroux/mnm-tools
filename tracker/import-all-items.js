// Full item import — pull EVERY item page from the M&M wiki into wiki.json, not
// just the ones players have looted/traded/auctioned. "Item page" = any page that
// transcludes Template:ItemBox. Incremental: only fetches titles missing from
// wiki.json, so re-runs are cheap. Adds full stats (statsV 4) + sources +
// tradeskills + soldBy/harvestedBy + icon, flagged wikiOnly/fromImport.
//
//   node tracker/import-all-items.js          (import + write wiki.json)
//   node tracker/import-all-items.js --dry     (report the gap only, no write)

const fs = require('fs');
const path = require('path');
const https = require('https');
const W = require('./enrich-wiki.js');
const { parseFullStats } = require('./enrich-auction-stats.js');

const WIKI = path.join(__dirname, '..', 'mnmdb', 'wiki.json');
const API = 'https://monstersandmemories.miraheze.org/w/api.php';
const STATS_V = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const apiGet = (params) => new Promise((res, rej) => {
  const url = API + '?' + new URLSearchParams(Object.assign({ format: 'json' }, params));
  https.get(url, { headers: { 'User-Agent': 'mnm-tools-import/1.0' } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

// Every page (namespace 0) that transcludes Template:ItemBox = every item.
async function allItemTitles() {
  const out = []; let cont = null, calls = 0;
  do {
    const j = await apiGet(Object.assign({ action: 'query', list: 'embeddedin', eititle: 'Template:ItemBox', einamespace: '0', eilimit: '500' }, cont ? { eicontinue: cont } : {}));
    (j.query && j.query.embeddedin || []).forEach((x) => out.push(x.title));
    cont = j.continue && j.continue.eicontinue;
    await sleep(200);
  } while (cont && ++calls < 40);
  return out;
}

// Drop null / empty / empty-object fields so wiki.json stays lean.
function prune(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}

// Build the full wiki.json entry for one item from its wikitext.
function entryFromWikitext(wt) {
  const box = W.parseItemBox(wt);
  if (!box) return null; // not a real item page (redirect / doc)
  const full = parseFullStats(wt) || {};
  const src = W.parseSources(wt);
  const cats = W.parseCategories(wt);
  const ts = W.parseTradeskills(wt);
  const soldBy = W.parseSoldBy(wt);
  const harvestedBy = W.parseHarvestedBy(wt);
  return prune(Object.assign(
    { hasPage: true, wikiOnly: true, fromImport: true, statsV: STATS_V },
    {
      iconId: full.iconId || box.iconId || null,
      slot: full.slot || box.slot || null, handed: full.handed || null,
      dmg: full.dmg ?? box.dmg ?? null, delay: full.delay ?? box.delay ?? null, skill: full.skill || box.skill || null,
      weight: full.weight ?? box.weight ?? null, size: full.size || box.size || null,
      class: full.class || box.class || null, race: full.race || box.race || null,
      flags: full.flags, ac: full.ac, stats: full.stats, hp: full.hp, mana: full.mana,
      hpRegen: full.hpRegen, manaRegen: full.manaRegen, haste: full.haste,
      resists: full.resists, instr: full.instr, container: full.container, effect: full.effect,
    },
    src.zones.length ? { wikiZones: src.zones } : {},
    src.from.length ? { from: src.from } : {},
    cats.length ? { categories: cats } : {},
    ts.length ? { tradeskills: ts } : {},
    soldBy ? { soldBy } : {},
    harvestedBy ? { harvestedBy } : {}
  ));
}

(async () => {
  const dry = process.argv.includes('--dry');
  const wiki = JSON.parse(fs.readFileSync(WIKI, 'utf8'));
  wiki.items = wiki.items || {};
  const haveLower = new Set(Object.keys(wiki.items).map((n) => n.toLowerCase()));

  console.log('Listing every ItemBox page on the wiki…');
  const titles = await allItemTitles();
  const missing = titles.filter((t) => !haveLower.has(t.toLowerCase()));
  console.log(`Wiki item pages: ${titles.length} · already have: ${titles.length - missing.length} · missing: ${missing.length}`);
  if (dry) { console.log('(dry run — nothing written)'); return; }
  if (!missing.length) { console.log('Nothing to import.'); return; }

  const added = {};
  for (let i = 0; i < missing.length; i += 45) {
    const batch = missing.slice(i, i + 45);
    process.stdout.write(`  fetching ${Math.min(i + 45, missing.length)}/${missing.length}\r`);
    let texts; try { texts = await W.fetchWikitext(batch); } catch (e) { console.error('\n  batch failed:', e.message); continue; }
    for (const title of batch) {
      const wt = texts[title]; if (!wt) continue;
      const entry = entryFromWikitext(wt);
      if (entry) added[title] = entry;
    }
    await sleep(300);
  }
  console.log(`\nParsed ${Object.keys(added).length} new item entries.`);

  // Resolve icons for the ones with an iconId (batched).
  const iconIds = [...new Set(Object.values(added).map((e) => e.iconId).filter(Boolean))];
  console.log(`Resolving ${iconIds.length} icons…`);
  for (let i = 0; i < iconIds.length; i += 50) {
    const batch = iconIds.slice(i, i + 50);
    try {
      const urls = await W.fetchImageUrls(batch.map((id) => 'File:' + id + '.png'));
      for (const e of Object.values(added)) if (e.iconId && urls['File:' + e.iconId + '.png']) e.icon = urls['File:' + e.iconId + '.png'];
    } catch (e) { console.error('  icon batch failed:', e.message); }
    await sleep(250);
  }

  Object.assign(wiki.items, added);
  wiki.generatedAt = new Date().toISOString();
  fs.writeFileSync(WIKI, JSON.stringify(wiki, null, 2));
  const kb = Math.round(fs.statSync(WIKI).size / 1024);
  console.log(`Wrote ${Object.keys(added).length} items to wiki.json (now ${Object.keys(wiki.items).length} entries, ${kb} KB).`);
})().catch((e) => { console.error(e); process.exit(1); });
