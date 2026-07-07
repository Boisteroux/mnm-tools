// Aggregate the local auction capture (POC data folder) into a site-ready file,
// mnmdb/auctions.json, that the Auction House page reads. Run this to publish the
// latest prices; committing mnmdb/auctions.json deploys it (GitHub Pages).
//
//   MNM_DATA=<poc folder> node tracker/publish-auctions.js
// (Later this can be wired into the app's Publish flow or an always-on collector.)

const fs = require('fs');
const path = require('path');
const { copperToStr } = require('./parse-auctions.js');

const DATA = process.env.MNM_DATA || 'C:\\Users\\zacha\\Desktop\\mnm-auction-poc';
const OUT = path.join(__dirname, '..', 'mnmdb', 'auctions.json');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };

// Which items exist in the site DB (wiki.json) right now — decides which listings
// link to an item page. Re-checked here so newly-enriched items link up.
let wikiNames = new Set();
let wikiByLc = {}; // lowercase name → full wiki entry (for container/stats overlay)
try {
  const wi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'wiki.json'), 'utf8')).items || {};
  for (const [n, e] of Object.entries(wi)) wikiByLc[n.toLowerCase()] = e;
  wikiNames = new Set(Object.keys(wikiByLc));
} catch {}

const L = read('listings.json', []);
const Q = read('requests.json', []);
const S = read('stats.json', {});

const cleanName = (s) => String(s || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$/g, '').replace(/\s+/g, ' ').trim();
const isJunk = (n) => !n || n.length < 2 || /\\/.test(n) || /^w\s*t\s*[sbt]$/i.test(n) || /^(wtb|wts|wtt)$/i.test(n);
const RECENT_MS = (+process.env.MNM_RECENT_HOURS || 48) * 3600 * 1000; // only publish still-active listings
// Per-server safety cap on the published file. Priced listings are never cut (see
// the priced-first sort below), so this only trims the oldest no-price availability
// posts. The page itself shows ~250; the rest are here so search can reach them.
const MAX_PER_SERVER = +process.env.MNM_MAX_PER_SERVER || 800;
const key = (l) => (l.server + '|' + l.player + '|' + l.item).toLowerCase();

// Everything trashed or flagged is recorded to discarded.json for review + rule-building.
const discarded = [];
let rows = L.map((l) => Object.assign({}, l, { item: cleanName(l.item) }));
// 1. trash junk item names (OCR'd "WTB"/"\WTB" — usually service requests, not items)
rows = rows.filter((l) => { if (!isJunk(l.item)) return true; discarded.push({ status: 'trashed', reason: 'junk item name', server: l.server, player: l.player, item: l.item, raw: l.raw || '' }); return false; });
// 2. drop a "?" listing when the same player+item also has a resolved-intent listing (OCR dupe)
const realKeys = new Set(rows.filter((l) => l.intent).map(key));
rows = rows.filter((l) => { if (l.intent || !realKeys.has(key(l))) return true; discarded.push({ status: 'trashed', reason: 'duplicate of a resolved listing', server: l.server, player: l.player, item: l.item, raw: l.raw || '' }); return false; });
// flag the still-unresolved "?" (kept, but needs a human — intent could not be read)
for (const l of rows) if (!l.intent) discarded.push({ status: 'review', reason: 'intent not read', server: l.server, player: l.player, item: l.item, raw: l.raw || '' });
// 3. keep only recent (still on the market). Priced listings sort first so the
//    per-server cap only ever trims the oldest no-price posts — every priced
//    listing within the window is published (and therefore searchable).
const cutoff = Date.now() - RECENT_MS;
const isPriced = (l) => l.priceCopper != null;
rows = rows.filter((l) => !l.lastSeen || new Date(l.lastSeen).getTime() >= cutoff)
  .sort((a, b) => {
    if (isPriced(a) !== isPriced(b)) return isPriced(a) ? -1 : 1;             // priced first
    return String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''));  // then newest
  });
const perServer = {};
rows = rows.filter((l) => (perServer[l.server] = (perServer[l.server] || 0) + 1) <= MAX_PER_SERVER);

// Normalize a priced listing to a per-unit price so different quantities compare
// fairly. "each"/"ea" in the raw means the price is already per-unit; otherwise a
// qty ("x4") or "stack" (20 units) means the price is the whole-lot total.
const STACK = 20; // a stack = 20 units for tradeable materials (confirmed with Zak)
function normalize(l) {
  const price = l.priceCopper;
  if (price == null) return { unit: null, total: null };
  const n = l.perStack ? STACK : (l.qty && l.qty > 1 ? l.qty : 1);
  if (n <= 1) return { unit: price, total: price };
  const raw = (l.raw || '').toLowerCase();
  // Decide whether the stated price is already per-unit or a whole-lot total.
  const takeAll = /\btake all\b|\ball for\b|\bfor all\b|\bthe lot\b/.test(raw);          // explicit total
  const each = /\b(?:ea|each)\b|\/\s*ea\b/.test(raw);                                     // explicit per-unit
  const priceThenQty = /\d+(?:\.\d+)?\s*(?:pp|p|plat|platinum|gp|g|gold|sp|s|silver|cp|c|copper)\s*x\s*\d+/.test(raw); // "1.1g x28" = per-unit
  const perUnit = (each || priceThenQty) && !takeAll;
  return perUnit ? { unit: price, total: price * n } : { unit: Math.round(price / n), total: price };
}

const listings = rows.map((l) => {
  const { unit, total } = normalize(l);
  return {
    server: l.server, intent: l.intent || null, item: l.item,
    price: total, unit, priceStr: total != null ? copperToStr(total) : null,
    player: l.player, seen: l.firstSeen, qty: l.qty || undefined, perStack: l.perStack || undefined,
    assumed: l.assumed || undefined, matched: wikiNames.has(l.item.toLowerCase()),
  };
});

try { fs.writeFileSync(path.join(DATA, 'discarded.json'), JSON.stringify(discarded, null, 2)); } catch {}

const requests = Q.map((q) => ({ server: q.server, player: q.player, plus: q.plus || [], stats: q.stats || [], category: q.category || null, text: q.text || '', seen: q.firstSeen }));

// Full item stats, but only for items that appear in auctions (keeps the file lean).
const names = new Set(listings.map((l) => l.item.toLowerCase()));
const stats = {};
for (const [k, v] of Object.entries(S)) {
  if (!names.has(k)) continue;
  stats[k] = {
    name: v.name, hasPage: v.hasPage, icon: v.icon || null, flags: v.flags || [],
    slot: v.slot || null, handed: v.handed || null, dmg: v.dmg ?? null, delay: v.delay ?? null, skill: v.skill || null,
    ac: v.ac ?? null, stats: v.stats || {}, hp: v.hp ?? null, mana: v.mana ?? null, hpRegen: v.hpRegen ?? null, manaRegen: v.manaRegen ?? null, haste: v.haste ?? null,
    resists: v.resists || {}, instr: v.instr || {}, weight: v.weight ?? null, size: v.size || null,
    container: v.container || (wikiByLc[k] && wikiByLc[k].container) || null,
    effect: v.effect || (wikiByLc[k] && wikiByLc[k].effect) || null,
    class: v.class || null, race: v.race || null, tradeskills: v.tradeskills || [], zones: v.zones || [], from: (v.from || []).slice(0, 4), vendor: v.vendor ?? null,
  };
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), listings, requests, stats }));
const kb = Math.round(fs.statSync(OUT).size / 1024);
const trashed = discarded.filter((d) => d.status === 'trashed').length, review = discarded.filter((d) => d.status === 'review').length;
console.log(`wrote mnmdb/auctions.json — ${listings.length} listings (recent, capped ${MAX_PER_SERVER}/server), ${requests.length} requests, ${Object.keys(stats).length} stats (${kb} KB); discarded.json: ${trashed} trashed + ${review} to review`);
