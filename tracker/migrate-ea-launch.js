// One-off, run on the capture box with mnm-capture STOPPED: split the capture state at
// the Early Access launch.
//
//   - Everything first seen before launch (beta PvP/PvE) moves out of the live state
//     into <data>/archive-beta-2026/, untouched, so it can never be published as live.
//   - Everything since launch was read from the stream's single Trem panel but saved
//     under the old "PvE" label (the capture still had the two-panel beta layout), so
//     it is relabelled Trem and re-keyed. Player names read between launch and the crop
//     fix lost their first few letters; they stay as read — prices and items are right.
//
//   systemctl stop mnm-capture
//   MNM_DATA=/opt/mnm-tools/auction-data node tracker/migrate-ea-launch.js
//   systemctl start mnm-capture
//
// Safe to re-run: a second pass finds nothing left to move or relabel.

const fs = require('fs');
const path = require('path');

const EA_LAUNCH = '2026-10-09T00:00:00.000Z';
const LIVE = 'Trem';
const DATA = process.env.MNM_DATA;
if (!DATA) { console.error('set MNM_DATA to the capture data folder'); process.exit(1); }
const ARC = path.join(DATA, 'archive-beta-2026');
fs.mkdirSync(ARC, { recursive: true });

const first = (e) => e.firstSeen || e.lastSeen || '';
const lower = (a) => a.join('|').toLowerCase();
// Signature builders — must match capture-auctions.js.
const reSig = {
  'listings.json': (l) => lower([l.server, l.player, l.intent || '', l.item, l.priceCopper == null ? 'na' : l.priceCopper]),
  'requests.json': (r) => lower(['req', r.server, r.player, r.text]),
  'lowconf.json': null, // keyed by `key`, rebuilt below
};

for (const f of ['listings.json', 'requests.json', 'lowconf.json']) {
  const file = path.join(DATA, f);
  let rows; try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log(`${f}: not found, skipped`); continue; }
  const beta = rows.filter((e) => first(e) < EA_LAUNCH);
  const live = rows.filter((e) => first(e) >= EA_LAUNCH);
  let relabelled = 0;
  const out = new Map();
  for (const e of live) {
    if (e.server !== LIVE) { e.server = LIVE; relabelled++; }
    if (reSig[f]) e.sig = reSig[f](e); else e.key = (e.server + '|' + e.text).toLowerCase();
    const k = e.sig || e.key, cur = out.get(k);
    if (!cur) { out.set(k, e); continue; }
    // Two rows collapsing onto one key: keep the earlier first-sighting, add the counts.
    cur.count = (cur.count || 1) + (e.count || 1);
    if (first(e) < first(cur)) cur.firstSeen = e.firstSeen;
    if ((e.lastSeen || '') > (cur.lastSeen || '')) cur.lastSeen = e.lastSeen;
  }
  if (beta.length) {
    // Append to any archive from an earlier run rather than overwrite it.
    let prev = []; try { prev = JSON.parse(fs.readFileSync(path.join(ARC, f), 'utf8')); } catch {}
    fs.writeFileSync(path.join(ARC, f), JSON.stringify(prev.concat(beta), null, 2));
  }
  fs.writeFileSync(file, JSON.stringify([...out.values()], null, 2));
  console.log(`${f}: ${beta.length} beta rows archived · ${out.size} live rows kept (${relabelled} relabelled ${LIVE})`);
}
