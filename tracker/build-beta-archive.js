// One-off: archive every auction listing published before Early Access and boil it
// down to a per-item "beta price" the site can show as a reference.
//
// Early Access launched 2026-10-09 and replaced beta's PvP/PvE pair with a fresh set
// of servers, so beta prices are history, not live data. mnmdb/auctions.json only ever
// held a rolling window, so the full record lives in its git history: this walks every
// committed version, unions the listings seen before launch, and writes
//   archive/beta-2026/auctions-listings.json  — the raw union (not deployed)
//   mnmdb/auctions-beta.json                  — per-item low/high/avg per market
//
//   node tracker/build-beta-archive.js        (run from the repo root; needs git)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EA_LAUNCH = '2026-10-09T00:00:00.000Z'; // first Early Access auction lines were read 19:59Z that day
const ROOT = path.join(__dirname, '..');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const commits = git(['log', '--format=%H', '--', 'mnmdb/auctions.json']).split(/\r?\n/).filter(Boolean);
const union = new Map();
let read = 0;
for (const h of commits) {
  let j; try { j = JSON.parse(git(['show', h + ':mnmdb/auctions.json'])); } catch { continue; }
  read++;
  for (const l of (j.listings || [])) {
    if (!l.item || !l.seen || l.seen >= EA_LAUNCH) continue;
    // One entry per seller's ask (server, player, item, price). The published `seen`
    // moved between versions, so it can't be part of the key — track its range instead.
    const k = [l.server, l.player, l.intent || '', l.item, l.price == null ? 'na' : l.price].join('|').toLowerCase();
    const cur = union.get(k);
    if (!cur) { union.set(k, Object.assign({}, l, { lastSeen: l.seen })); continue; }
    if (l.seen < cur.seen) cur.seen = l.seen;
    if (l.seen > cur.lastSeen) cur.lastSeen = l.seen;
    if ((l.count || 1) > (cur.count || 1)) cur.count = l.count;
  }
}
const listings = [...union.values()].sort((a, b) => String(a.seen).localeCompare(String(b.seen)));

// Same outlier fence the site uses (trimOutliers in mnmdb/app.js), so a beta price reads
// the way the live one would have.
function trimOutliers(prices) {
  if (prices.length < 4) return prices.slice();
  const s = prices.slice().sort((a, b) => a - b);
  const q = (p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  if (iqr === 0) return prices.slice();
  return prices.filter((p) => p >= q1 - 3 * iqr && p <= q3 + 3 * iqr);
}

const byItem = {};
for (const l of listings) {
  if (l.price == null || l.intent === 'buy') continue; // sell-side asks only, like tradeStats
  const unit = l.unit != null ? l.unit : l.price;
  if (!(unit > 0)) continue;
  const e = byItem[l.item.toLowerCase()] = byItem[l.item.toLowerCase()] || { name: l.item, markets: {} };
  (e.markets[l.server] = e.markets[l.server] || []).push(unit);
}
const items = {};
for (const [k, e] of Object.entries(byItem)) {
  const out = { name: e.name };
  for (const [srv, prices] of Object.entries(e.markets)) {
    const p = trimOutliers(prices).sort((a, b) => a - b);
    const mid = p.length % 2 ? p[(p.length - 1) / 2] : Math.round((p[p.length / 2 - 1] + p[p.length / 2]) / 2);
    // `mid` (median) is the headline: beta ranges are wide, and a mean chases the top end.
    out[srv] = { n: p.length, low: p[0], high: p[p.length - 1], mid, avg: Math.round(p.reduce((s, x) => s + x, 0) / p.length) };
  }
  items[k] = out;
}

const from = listings.length ? listings[0].seen : null, to = listings.length ? listings[listings.length - 1].seen : null;
const arcDir = path.join(ROOT, 'archive', 'beta-2026');
fs.mkdirSync(arcDir, { recursive: true });
fs.writeFileSync(path.join(arcDir, 'auctions-listings.json'), JSON.stringify({ note: 'Every auction listing published to mnm-db.com before Early Access (2026-10-09), unioned from the git history of mnmdb/auctions.json.', from, to, listings }));
fs.writeFileSync(path.join(ROOT, 'mnmdb', 'auctions-beta.json'), JSON.stringify({ note: 'Beta-era (pre Early Access) sell prices per item, per market. Reference only.', from, to, items }));
const priced = listings.filter((l) => l.price != null).length;
console.log(`read ${read}/${commits.length} versions · ${listings.length} beta listings (${priced} priced) ${from} → ${to} · ${Object.keys(items).length} items with a beta price`);
