// One-time (incremental) upgrade: backfill FULL stats onto every item in wiki.json
// (AC, STR/STA/AGI/DEX/INT/WIS/CHA, HP/mana/regens/haste, resistances, MAGIC/LORE/
// NO DROP flags) so item pages show the complete card and Advanced Search can filter
// on any stat. Re-fetches each item's wiki page and merges the full ItemBox parse.
//
//   node tracker/upgrade-item-stats.js
// Incremental: items already carrying statsV are skipped, so re-runs are cheap.

const fs = require('fs');
const path = require('path');
const W = require('./enrich-wiki.js');
const { parseFullStats } = require('./enrich-auction-stats.js');

const WIKI = path.join(__dirname, '..', 'mnmdb', 'wiki.json');
const STATS_V = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const w = JSON.parse(fs.readFileSync(WIKI, 'utf8'));
  const items = w.items || {};
  const todo = Object.keys(items).filter((k) => items[k].hasPage !== false && items[k].statsV !== STATS_V);
  console.log(`items with a page to upgrade: ${todo.length}`);
  let done = 0;
  for (let i = 0; i < todo.length; i += 45) {
    const batch = todo.slice(i, i + 45);
    process.stdout.write(`  ${i + batch.length}/${todo.length}\r`);
    let texts; try { texts = await W.fetchWikitext(batch); } catch (e) { console.error('\nbatch failed:', e.message); continue; }
    for (const k of batch) {
      const wt = texts[k];
      const full = wt && parseFullStats(wt);
      const it = items[k];
      if (!full) { it.statsV = STATS_V; continue; } // mark checked so we don't refetch
      Object.assign(it, {
        flags: full.flags, handed: full.handed, ac: full.ac, stats: full.stats,
        hp: full.hp, mana: full.mana, hpRegen: full.hpRegen, manaRegen: full.manaRegen, haste: full.haste,
        resists: full.resists, instr: full.instr, statsV: STATS_V,
      });
      // Refresh the core fields from the full parser (it reads both legacy + modern ItemBox).
      if (full.slot) it.slot = full.slot;
      if (full.dmg != null) it.dmg = full.dmg;
      if (full.delay != null) it.delay = full.delay;
      if (full.skill) it.skill = full.skill;
      if (full.weight != null) it.weight = full.weight;
      if (full.size) it.size = full.size;
      if (full.class) it.class = full.class;
      if (full.race) it.race = full.race;
      done++;
    }
    await sleep(300);
  }
  fs.writeFileSync(WIKI, JSON.stringify(w, null, 2));
  console.log(`\nupgraded ${done} items with full stats`);
})();
