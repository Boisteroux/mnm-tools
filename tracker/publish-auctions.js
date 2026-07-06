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

const L = read('listings.json', []);
const Q = read('requests.json', []);
const S = read('stats.json', {});

// Lean listings — drop internal fields (sig, raw, count, lastSeen); keep what the page shows.
const listings = L.map((l) => ({
  server: l.server, intent: l.intent || null, item: l.item,
  price: l.priceCopper != null ? l.priceCopper : null, priceStr: l.price || null,
  player: l.player, seen: l.firstSeen, qty: l.qty || undefined,
  assumed: l.assumed || undefined, matched: l.matched !== false,
}));

const requests = Q.map((q) => ({ server: q.server, player: q.player, plus: q.plus || [], stats: q.stats || [], category: q.category || null, text: q.text || '', seen: q.firstSeen }));

// Full item stats, but only for items that appear in auctions (keeps the file lean).
const names = new Set(L.map((l) => l.item.toLowerCase()));
const stats = {};
for (const [k, v] of Object.entries(S)) {
  if (!names.has(k)) continue;
  stats[k] = {
    name: v.name, hasPage: v.hasPage, icon: v.icon || null, flags: v.flags || [],
    slot: v.slot || null, handed: v.handed || null, dmg: v.dmg ?? null, delay: v.delay ?? null, skill: v.skill || null,
    ac: v.ac ?? null, stats: v.stats || {}, hp: v.hp ?? null, mana: v.mana ?? null, hpRegen: v.hpRegen ?? null, manaRegen: v.manaRegen ?? null, haste: v.haste ?? null,
    resists: v.resists || {}, instr: v.instr || {}, weight: v.weight ?? null, size: v.size || null,
    class: v.class || null, race: v.race || null, tradeskills: v.tradeskills || [], zones: v.zones || [], from: (v.from || []).slice(0, 4), vendor: v.vendor ?? null,
  };
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), listings, requests, stats }));
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`wrote mnmdb/auctions.json — ${listings.length} listings, ${requests.length} requests, ${Object.keys(stats).length} item stats (${kb} KB)`);
