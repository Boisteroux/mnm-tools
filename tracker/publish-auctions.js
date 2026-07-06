// Aggregate the local auction capture (POC data folder) into a site-ready file,
// mnmdb/auctions.json, that the Auction House page reads. Run this to publish the
// latest prices; committing mnmdb/auctions.json deploys it (GitHub Pages).
//
//   MNM_DATA=<poc folder> node tracker/publish-auctions.js
// (Later this can be wired into the app's Publish flow or an always-on collector.)

const fs = require('fs');
const path = require('path');

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
const MAX_PER_SERVER = +process.env.MNM_MAX_PER_SERVER || 500;
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
// 3. keep only recent (still on the market), newest first, capped per server — so the page never balloons
const cutoff = Date.now() - RECENT_MS;
rows = rows.filter((l) => !l.lastSeen || new Date(l.lastSeen).getTime() >= cutoff)
  .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
const perServer = {};
rows = rows.filter((l) => (perServer[l.server] = (perServer[l.server] || 0) + 1) <= MAX_PER_SERVER);

const listings = rows.map((l) => ({
  server: l.server, intent: l.intent || null, item: l.item,
  price: l.priceCopper != null ? l.priceCopper : null, priceStr: l.price || null,
  player: l.player, seen: l.firstSeen, qty: l.qty || undefined,
  assumed: l.assumed || undefined, matched: wikiNames.has(l.item.toLowerCase()),
}));

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
    class: v.class || null, race: v.race || null, tradeskills: v.tradeskills || [], zones: v.zones || [], from: (v.from || []).slice(0, 4), vendor: v.vendor ?? null,
  };
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), listings, requests, stats }));
const kb = Math.round(fs.statSync(OUT).size / 1024);
const trashed = discarded.filter((d) => d.status === 'trashed').length, review = discarded.filter((d) => d.status === 'review').length;
console.log(`wrote mnmdb/auctions.json — ${listings.length} listings (recent, capped ${MAX_PER_SERVER}/server), ${requests.length} requests, ${Object.keys(stats).length} stats (${kb} KB); discarded.json: ${trashed} trashed + ${review} to review`);
