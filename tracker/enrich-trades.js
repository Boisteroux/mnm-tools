// ---------------------------------------------------------------
// Trade-item enrichment — makes sure every item you've logged a buy/sell for
// (mnmdb/trades.json) has an entry in mnmdb/wiki.json, pulling its stats/icon
// from the M&M wiki. Trade-only items (never looted) are otherwise invisible to
// the wiki scraper, which seeds from data.json (looted/vendored) items only.
//
// This is the INCREMENTAL path: it only fetches the handful of traded items not
// already in wiki.json, so it's cheap enough to run on a schedule or after every
// publish. A full `node tracker/enrich-wiki.js` also picks trades up now (it
// seeds from trades.json too), but re-scrapes everything.
//
// Run:  node tracker/enrich-trades.js          (enrich + write wiki.json)
//       node tracker/enrich-trades.js --dry     (report only, no write)
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const W = require('./enrich-wiki.js');

const WIKI = path.join(__dirname, '..', 'mnmdb', 'wiki.json');
const TRADES = path.join(__dirname, '..', 'mnmdb', 'trades.json');
const AUCTIONS = path.join(__dirname, '..', 'mnmdb', 'auctions.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the same wiki.json entry shape enrich-wiki.js writes, from one page's wikitext.
function entryFromWikitext(wt) {
  const box = W.parseItemBox(wt);
  if (!box) return null; // no ItemBox = not a real item page (NPC / list / redirect target)
  const src = W.parseSources(wt);
  const cats = W.parseCategories(wt);
  const ts = W.parseTradeskills(wt);
  const soldBy = W.parseSoldBy(wt);
  const harvestedBy = W.parseHarvestedBy(wt);
  return Object.assign(
    { hasPage: true, wikiOnly: true, fromTrade: true }, box,
    src.zones.length ? { wikiZones: src.zones } : {},
    src.from.length ? { from: src.from } : {},
    cats.length ? { categories: cats } : {},
    ts.length ? { tradeskills: ts } : {},
    soldBy ? { soldBy } : {},
    harvestedBy ? { harvestedBy } : {}
  );
}

async function enrichTrades({ write = true } = {}) {
  const wiki = JSON.parse(fs.readFileSync(WIKI, 'utf8'));
  wiki.items = wiki.items || {};
  const trades = (JSON.parse(fs.readFileSync(TRADES, 'utf8')).trades) || [];
  // Also enrich items seen in the auction feed (mnmdb/auctions.json), so market
  // items that were never looted/traded still get wiki pages + stats.
  let auctionItems = [];
  try { auctionItems = ((JSON.parse(fs.readFileSync(AUCTIONS, 'utf8')).listings) || []).map((l) => l.item); } catch {}
  const wanted = [...new Set([...trades.map((t) => t.item), ...auctionItems])];

  const haveLower = new Set(Object.keys(wiki.items).map((n) => n.toLowerCase()));
  // Two kinds of work:
  //  1. traded items with NO wiki entry yet          → fetch + add (full entry or stub)
  //  2. existing trade STUBS (fromTrade, no page yet) → re-check the wiki and upgrade
  //     to a full entry if a page has since been created (self-healing).
  const missing = wanted.filter((n) => n && !haveLower.has(n.toLowerCase()));
  const stubKeys = Object.keys(wiki.items)
    .filter((k) => wiki.items[k] && wiki.items[k].fromTrade && wiki.items[k].hasPage === false);

  if (!missing.length && !stubKeys.length) {
    console.log('All traded items already have full wiki entries — nothing to do.');
    return { added: [], upgraded: [], stubs: [], noPage: [] };
  }
  if (missing.length) console.log(`Traded items missing a wiki entry: ${missing.length}`);
  if (stubKeys.length) console.log(`Existing stubs to re-check for a new wiki page: ${stubKeys.length}`);

  // Fetch candidates. New items try raw + title-cased (fixes casual casing);
  // stubs are already keyed under a proper title, so just re-fetch that.
  const candByItem = new Map();
  for (const n of missing) candByItem.set(n, [...new Set([n, W.titleCaseName(n)])]);
  for (const k of stubKeys) candByItem.set(k, [k]);
  const allCands = [...new Set([].concat(...candByItem.values()))];

  // Fetch wikitext for every candidate (batched — fetchWikitext handles ~45/call).
  const texts = {};
  for (let i = 0; i < allCands.length; i += 45) {
    const batch = allCands.slice(i, i + 45);
    try { Object.assign(texts, await W.fetchWikitext(batch)); } catch (e) { console.error('fetch batch failed:', e.message); }
    await sleep(350);
  }
  // Case-insensitive lookup of a resolved page for a given asked-name.
  const textKeyLower = new Map(Object.keys(texts).map((k) => [k.toLowerCase(), k]));
  const resolve = (item) => { for (const c of candByItem.get(item)) { const k = textKeyLower.get(c.toLowerCase()); if (k) return k; } return null; };

  const added = {}, addedNames = [], upgraded = [], stubs = [], noPage = [];

  // 1. New traded items — full entry if the wiki has a page, else a stub.
  for (const item of missing) {
    const hitKey = resolve(item);
    const entry = hitKey ? entryFromWikitext(texts[hitKey]) : null;
    if (entry) {
      added[hitKey] = entry;          // key under the real wiki title casing
      addedNames.push(`${item}${hitKey !== item ? ` → ${hitKey}` : ''}`);
    } else {
      // No usable wiki page — create a minimal stub so the item still gets a page
      // (its trade price shows), flagged so it's easy to find + fix later.
      const title = hitKey || W.titleCaseName(item);
      added[title] = { hasPage: false, wikiOnly: true, fromTrade: true };
      stubs.push(title);
      if (!hitKey) noPage.push(title);
    }
  }

  // 2. Re-check existing stubs; upgrade any whose wiki page now exists.
  for (const key of stubKeys) {
    const hitKey = resolve(key);
    const entry = hitKey ? entryFromWikitext(texts[hitKey]) : null;
    if (!entry) continue;             // still no page — leave the stub as-is
    added[hitKey] = entry;
    if (hitKey !== key) delete wiki.items[key]; // page has different casing — drop the old stub
    upgraded.push(`${key}${hitKey !== key ? ` → ${hitKey}` : ''}`);
  }

  // Resolve icons for the ones that have an iconId.
  const iconIds = [...new Set(Object.values(added).map((e) => e.iconId).filter(Boolean))];
  if (iconIds.length) {
    try {
      const urls = await W.fetchImageUrls(iconIds.map((id) => 'File:' + id + '.png'));
      for (const e of Object.values(added)) if (e.iconId) e.icon = urls['File:' + e.iconId + '.png'] || null;
    } catch (e) { console.error('icon fetch failed:', e.message); }
  }

  const changed = Object.keys(added).length > 0;
  if (addedNames.length) console.log(`\n  ✓ enriched from wiki (${addedNames.length}): ${addedNames.join(', ')}`);
  if (upgraded.length) console.log(`  ⬆ stubs upgraded — wiki page now exists (${upgraded.length}): ${upgraded.join(', ')}`);
  if (stubs.length) console.log(`  • new stub entries, no wiki page (${stubs.length}): ${stubs.join(', ')}`);
  if (!changed) console.log('  Re-checked stubs — still no wiki pages. Nothing to write.');

  if (write && changed) {
    Object.assign(wiki.items, added);
    wiki.generatedAt = new Date().toISOString();
    fs.writeFileSync(WIKI, JSON.stringify(wiki, null, 2));
    console.log(`\nWrote ${Object.keys(added).length} entr${Object.keys(added).length === 1 ? 'y' : 'ies'} to ${path.relative(process.cwd(), WIKI)}.`);
  } else if (!write) {
    console.log('\n(dry run — wiki.json not written)');
  }
  return { added: addedNames, upgraded, stubs, noPage };
}

module.exports = { enrichTrades };

if (require.main === module) {
  enrichTrades({ write: !process.argv.includes('--dry') })
    .catch((e) => { console.error(e); process.exit(1); });
}
