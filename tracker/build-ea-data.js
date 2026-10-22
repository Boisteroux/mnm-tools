// Build the site's Early Access play data (mnmdb/data-ea.json) from what players share
// through MnM Map's opt-in "Share with MnMdb" — the approved contributions the API
// holds. Counts are summed across players (mergeAggs) before rates are computed, so
// 200 corpses from four players count like 200 from one.
//
// Run by the VPS's 6-hourly publish (auto-publish-auctions.js), or by hand:
//   MNM_EXPORT_TOKEN=... node tracker/build-ea-data.js
// Leaves data-ea.json alone when nothing has been approved yet, or nothing changed.

const fs = require('fs');
const path = require('path');
const LP = require('./ledger-parser.js');

const API = process.env.MNM_API || 'https://mnmdb-api.boisteroux.workers.dev';
const exportKey = process.env.MNM_EXPORT_TOKEN; // the API's EXPORT_TOKEN, from /etc/mnm-tools.env on the VPS
const OUT = path.join(__dirname, '..', 'mnmdb', 'data-ea.json');

async function main() {
  if (!exportKey) { console.log('build-ea-data: MNM_EXPORT_TOKEN not set — skipped'); return; }
  const r = await fetch(API + '/contrib/export', { headers: { Authorization: 'Bearer ' + exportKey } });
  if (!r.ok) throw new Error('export failed: HTTP ' + r.status);
  const { contributions } = await r.json();
  if (!contributions || !contributions.length) { console.log('build-ea-data: no approved contributions yet — data-ea.json unchanged'); return; }

  const merged = LP.mergeAggs(contributions.map((c) => c.agg));
  const servers = [...new Set(contributions.flatMap((c) => c.servers || []))].sort();
  // Only players who ticked "credit me" are named; everyone else is just counted.
  const contributors = contributions.filter((c) => c.credit).map((c) => ({ character: c.credit, events: c.events || 0 }))
    .sort((a, b) => b.events - a.events);
  const dataset = LP.buildDataset(merged, { era: 'early-access', servers, contributors, contributorCount: contributions.length });

  let before = null; try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  const strip = (d) => JSON.stringify(Object.assign({}, d, { generatedAt: null }));
  if (before && strip(before) === strip(dataset)) { console.log('build-ea-data: no change'); return; }
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2));
  console.log(`build-ea-data: wrote data-ea.json — ${contributions.length} contributor(s), ${merged.events} events, ${dataset.items.length} items, ${Object.keys(merged.mobs).length} mobs`);
}

main().catch((e) => { console.error('build-ea-data:', e.message); process.exit(1); });
