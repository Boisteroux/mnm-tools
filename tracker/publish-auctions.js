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
const isPriced = (l) => l.priceCopper != null;
// Priced listings ARE the price history item pages read (30-day high/low/avg), so keep
// a long window of them; no-price "availability" posts are ephemeral (the live ticker
// that used them is retired) so keep only a brief window.
const PRICED_MS = (+process.env.MNM_PRICED_HOURS || 720) * 3600 * 1000; // 30 days
const avCut = Date.now() - RECENT_MS, prCut = Date.now() - PRICED_MS;
rows = rows.filter((l) => { if (!l.lastSeen) return true; const t = new Date(l.lastSeen).getTime(); return t >= (isPriced(l) ? prCut : avCut); });
// Collapse re-listings: a seller re-posting the same item at different prices
// created several rows (looked like duplicates). Keep ONE per (server, player,
// item) — the priced one seen most recently, i.e. their current ask.
const best = new Map();
for (const l of rows) {
  const k = key(l), cur = best.get(k);
  if (!cur) { best.set(k, l); continue; }
  // Keep the priced/most-recent post, but carry the combined sighting count so
  // "most seen" reflects every time this seller's item was read, not just the kept row.
  const total = (cur.count || 1) + (l.count || 1);
  const pick = isPriced(l) !== isPriced(cur) ? (isPriced(l) ? l : cur)
    : (String(l.lastSeen || '') >= String(cur.lastSeen || '') ? l : cur);
  pick.count = total;
  best.set(k, pick);
}
rows = [...best.values()].sort((a, b) => {
  if (isPriced(a) !== isPriced(b)) return isPriced(a) ? -1 : 1;             // priced first
  return String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''));  // then newest
});
const perServer = {};
rows = rows.filter((l) => isPriced(l) || (perServer[l.server] = (perServer[l.server] || 0) + 1) <= MAX_PER_SERVER);

// Normalize a priced listing to a per-unit price so different quantities compare
// fairly. "each"/"ea" in the raw means the price is already per-unit; otherwise a
// qty ("x4") or "stack" (20 units) means the price is the whole-lot total.
const STACK = 20; // a stack = 20 units for tradeable materials (confirmed with Zak)
const COIN = { p: 1e6, pp: 1e6, plat: 1e6, platinum: 1e6, g: 1e4, gp: 1e4, gold: 1e4, s: 1e2, sp: 1e2, silver: 1e2, c: 1, cp: 1, copper: 1 };
// The price stated right before "each" (e.g. "1.5g each") — read straight from the
// raw so compound posts like "1.5g each or 90g for all" don't get the two prices
// summed together (a quirk of the coin parser).
function eachPrice(raw) {
  const m = raw.match(/([\d.]+)\s*(pp|platinum|plat|gp|gold|sp|silver|cp|copper|p|g|s|c)\s*(?:ea|each)\b/);
  return m && COIN[m[2]] != null ? Math.round(parseFloat(m[1]) * COIN[m[2]]) : null;
}
// Scope qualifier detection to THIS item's segment of a multi-item post: in
// "[A] 15s a stack [B] 5g" the "a stack" belongs to A, not B. Single-item posts
// (or when the item can't be located in the raw) use the whole message.
function itemScope(rawStr, item) {
  const lc = String(rawStr || '').toLowerCase();
  if ((lc.match(/\[/g) || []).length <= 1) return lc.replace(/\[[^\]]*\]/g, ' ');
  const key = '[' + String(item).toLowerCase() + ']';
  const i = lc.indexOf(key);
  if (i < 0) return lc.replace(/\[[^\]]*\]/g, ' ');
  const start = i + key.length, next = lc.indexOf('[', start);
  return lc.slice(start, next < 0 ? lc.length : next); // after this item's bracket, up to the next item
}
function normalize(l) {
  const price = l.priceCopper;
  if (price == null) return { unit: null, total: null, perStack: false };
  const qty = l.qty && l.qty > 1 ? l.qty : 1;
  const raw = itemScope(l.raw, l.item);
  const each = /\b(?:ea|each)\b|\/\s*ea\b/.test(raw);                                     // explicit per-unit
  const stack = /\bstacks?\b|\bstk\b|[/\s]st\b/.test(raw);                                // "a stack" / "stk" / "40s/st" = a 20-unit lot
  const takeAll = /\btake all\b|\ball for\b|\bfor all\b|\bthe lot\b/.test(raw);           // explicit whole-lot total
  const priceThenQty = /\d+(?:\.\d+)?\s*(?:pp|p|plat|platinum|gp|g|gold|sp|s|silver|cp|c|copper)\s*x\s*\d+/.test(raw); // "1.1g x28" = per-unit
  // A stack price ("30g a stack") is per 20 units — unless it also says "each"
  // (then the price is already per-unit). This is the confirmed "stack = 20" rule.
  if (stack && !each) return { unit: Math.round(price / STACK), total: price, perStack: true };
  if (each || priceThenQty) {
    const u = (each && eachPrice(raw)) || price; // prefer the price read right before "each"
    return { unit: u, total: qty > 1 ? u * qty : u, perStack: false };
  }
  return { unit: Math.round(price / qty), total: price, perStack: false };                // default: price is the whole lot
}

const listings = rows.map((l) => {
  const { unit, total, perStack } = normalize(l);
  return {
    server: l.server, intent: l.intent || null, item: l.item,
    price: total, unit, priceStr: total != null ? copperToStr(total) : null,
    player: l.player, seen: l.firstSeen, qty: l.qty || undefined, perStack: perStack || undefined,
    count: l.count || 1, // times this listing was read — powers the "most seen" ranking
    assumed: l.assumed || undefined, matched: wikiNames.has(l.item.toLowerCase()),
  };
});

try { fs.writeFileSync(path.join(DATA, 'discarded.json'), JSON.stringify(discarded, null, 2)); } catch {}

const requests = Q.map((q) => ({ server: q.server, player: q.player, plus: q.plus || [], stats: q.stats || [], category: q.category || null, text: q.text || '', seen: q.firstSeen, lastSeen: q.lastSeen || q.firstSeen, count: q.count || 1 }));

// Full item stats for items that appear in auctions, built straight from wiki.json
// (the single source of truth) so auctions.json is self-contained — no separate
// stats scrape needed. Only the auctioned items, to keep the file lean.
const names = new Set(listings.map((l) => l.item.toLowerCase()));
const displayName = {}; for (const l of listings) displayName[l.item.toLowerCase()] = l.item;
const stats = {};
for (const name of names) {
  const v = wikiByLc[name]; if (!v) continue;
  stats[name] = {
    name: displayName[name], hasPage: v.hasPage !== false, icon: v.icon || null, flags: v.flags || [],
    slot: v.slot || null, handed: v.handed || null, dmg: v.dmg ?? null, delay: v.delay ?? null, skill: v.skill || null,
    ac: v.ac ?? null, stats: v.stats || {}, hp: v.hp ?? null, mana: v.mana ?? null, hpRegen: v.hpRegen ?? null, manaRegen: v.manaRegen ?? null, haste: v.haste ?? null,
    resists: v.resists || {}, instr: v.instr || {}, weight: v.weight ?? null, size: v.size || null,
    container: v.container || null, effect: v.effect || null,
    class: v.class || null, race: v.race || null, tradeskills: v.tradeskills || [],
    zones: v.wikiZones || v.zones || [], from: (v.from || []).slice(0, 4), vendor: (v.soldBy && v.soldBy.base) ?? null,
  };
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), listings, requests, stats }));
const kb = Math.round(fs.statSync(OUT).size / 1024);
const trashed = discarded.filter((d) => d.status === 'trashed').length, review = discarded.filter((d) => d.status === 'review').length;
console.log(`wrote mnmdb/auctions.json — ${listings.length} listings (recent, capped ${MAX_PER_SERVER}/server), ${requests.length} requests, ${Object.keys(stats).length} stats (${kb} KB); discarded.json: ${trashed} trashed + ${review} to review`);
