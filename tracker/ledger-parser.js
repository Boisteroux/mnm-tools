// ---------------------------------------------------------------
// Ledger parser — turns Monsters & Memories' on-disk Ledger files
// into structured drop / kill / vendor data.
//
// Pure Node (no Electron), so it can be unit-tested standalone and
// required by the Electron main process.
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const GAME_BASE = path.join(
  process.env.USERPROFILE || '',
  'AppData', 'LocalLow', 'Niche Worlds Cult', 'Monsters and Memories'
);

// Many ledger string fields are base64 (not encryption) — mob/zone/player names
function b64(s) {
  if (!s) return '';
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return s; }
}

// "0 platinum 0 gold 0 silver 12 copper" -> total copper.
// Coin: 1 plat = 10 gold = 100 silver = 1000 copper.
function priceToCopper(str) {
  const v = { platinum: 0, gold: 0, silver: 0, copper: 0 };
  const re = /(\d+)\s*(platinum|gold|silver|copper)/gi;
  let m;
  while ((m = re.exec(str))) v[m[2].toLowerCase()] = parseInt(m[1], 10);
  return v.platinum * 1000 + v.gold * 100 + v.silver * 10 + v.copper;
}

function copperToString(c) {
  const p = Math.floor(c / 1000); c %= 1000;
  const g = Math.floor(c / 100); c %= 100;
  const s = Math.floor(c / 10); const cp = c % 10;
  return [p && p + 'p', g && g + 'g', s && s + 's', cp && cp + 'c'].filter(Boolean).join(' ') || '0c';
}

// Recursively find every ledger file under the game folder. Match by FILE NAME
// (<Character>_Character_<date>.json / _Social_) rather than requiring a Ledger/
// subfolder — some characters store the file directly in their own folder.
function findLedgerFiles(base = GAME_BASE) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /_(Character|Social)_[\d-]+\.json$/i.test(e.name)) out.push(p);
    }
  })(base);
  return out;
}

// Aggregate a list of ledger files into mobs / items / harvest tables
function parseLedgers(files) {
  const mobs = {};     // mobName -> { kills, drops: { itemName: count } }
  const items = {};    // itemId  -> { name, sources: { mob: count }, prices: { copperPerUnit: count } }
  const harvest = {};  // resourceName -> count
  let events = 0;

  const mob = (name) => (mobs[name] = mobs[name] || { kills: 0, drops: {} });
  const item = (id, name) => (items[id] = items[id] || { name, sources: {}, prices: {} });

  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const ev of data.c01 || []) {
      events++;
      let p = {};
      try { p = JSON.parse(ev.f03 || '{}'); } catch {}

      if (ev.f01 === 'act_14') {
        // KILL — a corpse was created
        const name = b64(p.d13) || b64((ev.f02 || '').replace(/^name_/, ''));
        if (name) mob(name).kills++;
      } else if (ev.f01 === 'act_13') {
        // LOOT — item taken off a mob
        const source = b64(p.d02);
        const name = p.d04 || '';
        const id = p.d05 || name;
        if (!name) continue;
        const it = item(id, name);
        if (source) {
          it.sources[source] = (it.sources[source] || 0) + 1;
          mob(source).drops[name] = (mob(source).drops[name] || 0) + 1;
        }
      } else if (ev.f01 === 'act_24') {
        // VENDOR SALE — records the price received (but not which vendor)
        const name = p.d04 || ev.f02 || '';
        const id = p.d05 || name;
        if (!name) continue;
        const qty = p.d01 || 1;
        const per = Math.max(1, Math.round(priceToCopper(b64(p.d03)) / qty));
        const it = item(id, name);
        it.prices[per] = (it.prices[per] || 0) + 1;
      } else if (ev.f01 === 'act_27') {
        // HARVEST — gathering node
        const res = p.d04 || '';
        if (res) harvest[res] = (harvest[res] || 0) + 1;
      }
    }
  }

  return { mobs, items, harvest, events, fileCount: files.length };
}

// Shape the raw aggregate into per-item records ready for display / export
function buildItemReport(agg) {
  return Object.entries(agg.items).map(([id, it]) => {
    const droppedBy = Object.entries(it.sources).map(([mobName, drops]) => {
      const kills = (agg.mobs[mobName] && agg.mobs[mobName].kills) || 0;
      return { mob: mobName, drops, kills, rate: kills ? drops / kills : null };
    }).sort((a, b) => (b.rate || 0) - (a.rate || 0));

    const prices = Object.entries(it.prices)
      .map(([copper, count]) => ({ copper: +copper, count }))
      .sort((a, b) => a.copper - b.copper);

    return { id, name: it.name, droppedBy, prices };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  GAME_BASE, b64, priceToCopper, copperToString,
  findLedgerFiles, parseLedgers, buildItemReport,
};
