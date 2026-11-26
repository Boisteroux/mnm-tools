// Re-name zones in published play data without rebuilding it: raw game codes such as
// "Sungreetstrand" or "Deepdunes" become "Sungreet Strand" / "Caves of Irem", using
// the same zoneName() the ledger parser uses. Counts are untouched (two spellings of
// one zone are added together), so it's safe on the frozen beta set (data.json),
// whose source ledgers aren't all on this machine any more.
//
//   node tracker/fix-zone-names.js mnmdb/data.json [mnmdb/data-ea.json ...]

const fs = require('fs');
const { zoneName } = require('./ledger-parser.js');

const uniq = (a) => [...new Set(a)];

function fixDataset(d) {
  for (const m of Object.values(d.mobs || {})) {
    const z = {};
    for (const [k, v] of Object.entries(m.zones || {})) { const n = zoneName(k); z[n] = (z[n] || 0) + v; }
    m.zones = z;
  }
  for (const it of d.items || []) it.zones = uniq((it.zones || []).map(zoneName));
  for (const n of d.harvestNodes || []) {
    n.name = String(n.name).replace(/ - (.+)$/, (m, z) => ' - ' + zoneName(z));
    n.zones = uniq((n.zones || []).map(zoneName));
  }
  return d;
}

for (const file of process.argv.slice(2)) {
  const before = fs.readFileSync(file, 'utf8');
  const after = JSON.stringify(fixDataset(JSON.parse(before)), null, 2);
  if (after === before.replace(/\r\n/g, '\n').trimEnd()) { console.log(file + ': already clean'); continue; }
  fs.writeFileSync(file, after);
  console.log(file + ': zone names fixed');
}
