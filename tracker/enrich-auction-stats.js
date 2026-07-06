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
  // Legacy items (esp. crafting materials) pack their stats into an item_stats blob
  // ("Weight: 0.1<br>Size: Small") instead of per-field params — read both.
  const blob = (p.item_stats || '').replace(/<br\s*\/?>/gi, '\n');
  const grab = (rx) => { const x = blob.match(rx); return x ? x[1].trim() : null; };
  const numF = (modern, rx) => { let v = num(modern); if (v == null) v = num(grab(rx)); return v; };
  const strF = (modern, rx) => (modern && String(modern).trim()) ? String(modern).trim() : grab(rx);
  const pick = (map) => { const o = {}; for (const [label, key] of Object.entries(map)) { let n = num(p[key]); if (n == null) n = num(grab(new RegExp('\\b' + label + ':?\\s*([+-]?[0-9.]+)', 'i'))); if (n != null && n !== 0) o[label] = n; } return o; };
  const flag = (name, param) => on(p[param]) || new RegExp('\\b' + name.replace(/ /g, '\\s*') + '\\b', 'i').test(blob);
  const flags = [];
  if (flag('MAGIC', 'magic')) flags.push('MAGIC');
  if (flag('LORE', 'lore')) flags.push('LORE');
  if (flag('UNIQUE', 'unique')) flags.push('UNIQUE');
  if (flag('NO DROP', 'nodrop')) flags.push('NO DROP');
  if (flag('NO RENT', 'norent')) flags.push('NO RENT');
  // Containers (bags): capacity (slots) + max item size held. Two ItemBox formats:
  // "container = 8, MEDIUM, 0," (combined) OR cont_capacity + cont_max_size (split).
  let capacity = null, maxSize = null, wtRed = null;
  if (p.cont_capacity || p.cont_max_size) {
    capacity = num(p.cont_capacity); maxSize = (p.cont_max_size || '').toUpperCase().trim() || null; wtRed = num(p.cont_weight_reduction);
  } else if (p.container && p.container.trim()) {
    const parts = p.container.split(',').map((x) => x.trim());
    capacity = num(parts[0]); maxSize = (parts[1] || '').toUpperCase() || null; wtRed = num(parts[2]);
  }
  const container = (capacity != null || maxSize) ? { capacity, maxSize, weightReduction: wtRed || null } : null;
  return {
    iconId: p.icon_id || null,
    container,
    flags,
    slot: strF(p.slot, /Slot:\s*([^\n<]+)/i), handed: p.handed || null,
    dmg: numF(p.dmg, /(?:Weapon\s*)?DMG:\s*([\d.]+)/i), delay: numF(p.delay, /(?:ATK\s*)?Delay:\s*([\d.]+)/i), skill: strF(p.skill, /Skill:\s*([A-Za-z ]{2,})/i),
    ac: numF(p.ac, /\bAC:\s*([\d.]+)/i),
    stats: pick(STAT_KEYS),
    hp: numF(p.hp, /\bHP:\s*([+-]?[\d.]+)/i), mana: numF(p.mana, /\bMana:\s*([+-]?[\d.]+)/i), hpRegen: num(p.hp_regen), manaRegen: num(p.mana_regen), haste: num(p.haste),
    resists: pick(RESIST_KEYS),
    instr: pick(INSTR_KEYS),
    weight: numF(p.weight, /Weight:\s*([\d.]+)/i), size: (strF(p.size, /Size:\s*([A-Za-z ]+)/i) || '').toUpperCase().trim() || null,
    class: strF(p.class, /Class:\s*([^\n<]+)/i), race: strF(p.race, /Race:\s*([^\n<]+)/i),
  };
}

async function buildStats() {
  let listings = [];
  try { listings = JSON.parse(fs.readFileSync(path.join(DATA, 'listings.json'), 'utf8')); } catch { return { total: 0 }; }
  const names = [...new Set(listings.map((l) => l.item).filter(Boolean))];

  const statsPath = path.join(DATA, 'stats.json');
  let stats = {}; try { stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')); } catch {}

  // Fetch anything not yet parsed at the current schema version (v bump re-fetches all).
  const V = 3;
  const toFetch = names.filter((n) => ((stats[n.toLowerCase()] || {}).v || 0) < V);
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
    if (!full) { stats[n.toLowerCase()] = { name: hit || n, full: true, v: V, hasPage: false }; continue; }
    const src = W.parseSources(texts[hit]);
    const soldBy = W.parseSoldBy(texts[hit]);
    const tradeskills = W.parseTradeskills(texts[hit]);
    fetched[n.toLowerCase()] = Object.assign({ name: hit, full: true, v: V, hasPage: true }, full,
      { tradeskills, zones: src.zones, from: (src.from || []).slice(0, 6), vendor: (soldBy && soldBy.base != null) ? soldBy.base : null });
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
