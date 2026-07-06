// Build a FULL item-stats lookup for every item seen in the auction POC, so the
// dashboard can show the complete item card on hover (flags, AC, stat bonuses, HP,
// resistances, weight/size, class, race, weapon dmg/delay, sources). Fetches each
// item's ItemBox from the wiki (reusing enrich-wiki's fetch + parsers) and parses
// every field. Writes stats.json into the POC data folder.
//
//   one-shot:  MNM_DATA=... node tracker/enrich-auction-stats.js
//   loop:      MNM_STATS_LOOP=1 MNM_HOURS=12 node tracker/enrich-auction-stats.js
// Incremental: only items not already marked `full` are fetched, so loops are cheap.

const fs = require('fs');
const path = require('path');
const W = require('./enrich-wiki.js');

const DATA = process.env.MNM_DATA || 'C:\\Users\\zacha\\Desktop\\mnm-auction-poc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/\+/g, '')); return isNaN(n) ? null : n; };
const on = (v) => !!(v && String(v).trim() && !/^(false|no|0)$/i.test(String(v).trim()));

const STAT_KEYS = { STR: 'str', STA: 'sta', AGI: 'agi', DEX: 'dex', INT: 'int', WIS: 'wis', CHA: 'cha' };
const RESIST_KEYS = { MR: 'mr', FR: 'fr', CR: 'cr', PR: 'pr', DR: 'dr', CORR: 'cor', ER: 'er', HR: 'hr' };
const INSTR_KEYS = { Brass: 'brass', Perc: 'percussion', Sing: 'singing', String: 'stringed', Wind: 'wind' };

// Parse the full ItemBox into a rich stat object. Handles the modern per-field
// ItemBox (ac=, str=, hp=, magic=…) used across the wiki.
function parseFullStats(wt) {
  const m = wt.match(/\{\{\s*ItemBox([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const p = W.templateParams(m[1]);
  const pick = (map) => { const o = {}; for (const [label, key] of Object.entries(map)) { const n = num(p[key]); if (n != null && n !== 0) o[label] = n; } return o; };
  const flags = [];
  if (on(p.magic)) flags.push('MAGIC');
  if (on(p.lore)) flags.push('LORE');
  if (on(p.unique)) flags.push('UNIQUE');
  if (on(p.nodrop)) flags.push('NO DROP');
  if (on(p.norent)) flags.push('NO RENT');
  return {
    iconId: p.icon_id || null,
    flags,
    slot: p.slot || null, handed: p.handed || null,
    dmg: num(p.dmg), delay: num(p.delay), skill: p.skill || null,
    ac: num(p.ac),
    stats: pick(STAT_KEYS),
    hp: num(p.hp), mana: num(p.mana), hpRegen: num(p.hp_regen), manaRegen: num(p.mana_regen), haste: num(p.haste),
    resists: pick(RESIST_KEYS),
    instr: pick(INSTR_KEYS),
    weight: num(p.weight), size: (p.size || '').toUpperCase() || null,
    class: p.class || null, race: p.race || null,
  };
}

async function buildStats() {
  let listings = [];
  try { listings = JSON.parse(fs.readFileSync(path.join(DATA, 'listings.json'), 'utf8')); } catch { return { total: 0 }; }
  const names = [...new Set(listings.map((l) => l.item).filter(Boolean))];

  const statsPath = path.join(DATA, 'stats.json');
  let stats = {}; try { stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')); } catch {}

  // Fetch anything we haven't fully parsed yet (upgrades old partial entries too).
  const toFetch = names.filter((n) => !(stats[n.toLowerCase()] && stats[n.toLowerCase()].full));
  if (!toFetch.length) { console.log(`[${new Date().toISOString()}] stats up to date (${Object.keys(stats).length} items)`); return { total: Object.keys(stats).length, fetched: 0 }; }

  const cand = new Map(toFetch.map((n) => [n, [...new Set([n, W.titleCaseName(n)])]]));
  const allc = [...new Set([].concat(...cand.values()))];
  const texts = {};
  for (let i = 0; i < allc.length; i += 45) {
    try { Object.assign(texts, await W.fetchWikitext(allc.slice(i, i + 45))); } catch (e) { console.error('fetch batch failed:', e.message); }
    await sleep(350);
  }
  const lc = new Map(Object.keys(texts).map((k) => [k.toLowerCase(), k]));

  const fetched = {};
  for (const n of toFetch) {
    let hit = null;
    for (const c of cand.get(n)) { const k = lc.get(c.toLowerCase()); if (k) { hit = k; break; } }
    const full = hit ? parseFullStats(texts[hit]) : null;
    if (!full) { stats[n.toLowerCase()] = { name: hit || n, full: true, hasPage: false }; continue; }
    const src = W.parseSources(texts[hit]);
    const soldBy = W.parseSoldBy(texts[hit]);
    fetched[n.toLowerCase()] = Object.assign({ name: hit, full: true, hasPage: true }, full,
      { zones: src.zones, from: (src.from || []).slice(0, 6), vendor: (soldBy && soldBy.base != null) ? soldBy.base : null });
  }

  // Resolve icons for the freshly fetched, then drop the internal iconId.
  const iconIds = [...new Set(Object.values(fetched).map((e) => e.iconId).filter(Boolean))];
  if (iconIds.length) {
    try { const urls = await W.fetchImageUrls(iconIds.map((id) => 'File:' + id + '.png')); for (const e of Object.values(fetched)) if (e.iconId) e.icon = urls['File:' + e.iconId + '.png'] || null; } catch (e) { console.error('icon fetch failed:', e.message); }
  }
  for (const e of Object.values(fetched)) delete e.iconId;
  Object.assign(stats, fetched);

  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  const withStats = Object.values(stats).filter((s) => s.hasPage && (s.slot || s.ac != null || Object.keys(s.stats || {}).length || s.dmg != null)).length;
  console.log(`[${new Date().toISOString()}] stats.json: ${Object.keys(stats).length} items, ${Object.keys(fetched).length} fetched this pass, ${withStats} with full stats`);
  return { total: Object.keys(stats).length, fetched: Object.keys(fetched).length };
}

module.exports = { buildStats, parseFullStats };

if (require.main === module) {
  const LOOP = !!process.env.MNM_STATS_LOOP;
  const INTERVAL = (+process.env.MNM_STATS_INTERVAL || 900) * 1000;
  const DEADLINE = Date.now() + (+process.env.MNM_HOURS || 12) * 3600 * 1000;
  const tick = () => buildStats().catch((e) => console.error('buildStats error:', e.message)).finally(() => {
    if (LOOP && Date.now() < DEADLINE) setTimeout(tick, INTERVAL);
  });
  tick();
}
