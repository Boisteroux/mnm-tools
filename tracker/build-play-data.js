// Build the site's two play-data files from the game's ledgers, split by era:
//
//   mnmdb/data-ea.json — Early Access (servers that aren't beta*). Rebuilt every run;
//                        this is the same file the app's Publish button writes.
//   mnmdb/data.json    — closed beta, FROZEN. Only written with --freeze-beta, which
//                        pools the last full publish from the previous dev machine
//                        (archive/beta-2026/play-data-2026-07-16.json — those ledgers
//                        never came over) with the beta ledgers that are on this one.
//
//   node tracker/build-play-data.js                 (Early Access only)
//   node tracker/build-play-data.js --freeze-beta   (one-off, also rewrites data.json)

const fs = require('fs');
const path = require('path');
const L = require('./ledger-parser.js');

const ROOT = path.join(__dirname, '..');
const out = (f) => path.join(ROOT, 'mnmdb', f);

// Resource → gather skill, so harvest nodes split herbs/fish out (mirrors main.js).
function harvestSkillOpts() {
  try {
    const w = JSON.parse(fs.readFileSync(out('wiki.json'), 'utf8'));
    const map = {};
    for (const [n, it] of Object.entries(w.items || {})) if (it && it.harvestedBy) map[n] = it.harvestedBy;
    return { skillOf: (n) => map[n] || null };
  } catch { return {}; }
}

// Turn a published dataset back into something mergeAggs can pool. Raw counts survive
// publishing (corpses, drops, prices, pulls); per-zone counts don't — only the zone
// ORDER does — so zones get descending placeholder weights that keep that order.
function aggFromDataset(d) {
  const items = {};
  for (const it of d.items || []) {
    const sources = {}; for (const s of it.droppedBy || []) sources[s.mob] = s.drops || 1;
    const prices = {}; for (const p of it.prices || []) prices[p.copper] = p.count;
    const zones = {}; (it.zones || []).forEach((z, i, a) => { zones[z] = a.length - i; });
    items[it.name] = { name: it.name, id: it.gameId || '', sources, prices, zones };
  }
  return { mobs: d.mobs || {}, items, harvest: d.harvest || {}, harvestZones: {}, harvestNodes: d.harvestNodes || [], events: d.events || 0, fileCount: d.ledgerFiles || 0 };
}

const files = L.findLedgerFiles();
const byEra = { beta: [], 'early-access': [] };
for (const f of files) byEra[L.ledgerEra(f)].push(f);
const servers = (list) => [...new Set(list.map((f) => L.ledgerServer(f)))].sort();
const opts = harvestSkillOpts();

const ea = L.parseLedgers(byEra['early-access'], opts);
const eaData = L.buildDataset(ea, { era: 'early-access', servers: servers(byEra['early-access']), contributors: [] });
fs.writeFileSync(out('data-ea.json'), JSON.stringify(eaData, null, 2));
console.log(`data-ea.json — ${ea.events} events · ${eaData.items.length} items · ${Object.keys(ea.mobs).length} mobs · servers: ${eaData.servers.join(', ') || 'none'}`);

if (process.argv.includes('--freeze-beta')) {
  const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'archive', 'beta-2026', 'play-data-2026-07-16.json'), 'utf8'));
  const here = L.parseLedgers(byEra.beta, opts);
  const beta = L.mergeAggs([aggFromDataset(prev), here]);
  const betaData = L.buildDataset(beta, { era: 'beta', frozen: true, servers: servers(byEra.beta), contributors: prev.contributors || [] });
  fs.writeFileSync(out('data.json'), JSON.stringify(betaData, null, 2));
  console.log(`data.json (beta, frozen) — ${prev.events} + ${here.events} = ${beta.events} events · ${betaData.items.length} items · ${Object.keys(beta.mobs).length} mobs`);
}
