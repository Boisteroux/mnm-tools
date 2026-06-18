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

// Decode a name field that may be base64, or an unresolved "ref_*" reference,
// or (in old ledger formats) garbled binary. Returns '' for anything that isn't
// clean readable text, so bad data is dropped instead of shown as gibberish.
function decodeName(s) {
  if (!s || /^ref_/.test(s)) return '';
  const t = b64(s);
  if (!t || t.includes('�')) return '';
  return t;
}
const isClean = (s) => !!s && !s.includes('�');

// Newer ledger entries prefix loot/vendor/harvest names with a numeric id, e.g.
// "6642399|Encrusted Calafreyan Spear". Strip the leading "<id>|" so item keys
// stay clean and merge with older, un-prefixed names for the same item.
const cleanItemName = (s) => (s || '').replace(/^\s*\d+\s*\|\s*/, '').trim();

// Coin in M&M is base-100: 100 copper = 1 silver, 100 silver = 1 gold,
// 100 gold = 1 platinum. So 1p = 1,000,000c, 1g = 10,000c, 1s = 100c.
const PLAT = 1000000, GOLD = 10000, SILVER = 100;

// "0 platinum 0 gold 0 silver 12 copper" -> total copper.
function priceToCopper(str) {
  const v = { platinum: 0, gold: 0, silver: 0, copper: 0 };
  const re = /(\d+)\s*(platinum|gold|silver|copper)/gi;
  let m;
  while ((m = re.exec(str))) v[m[2].toLowerCase()] = parseInt(m[1], 10);
  return v.platinum * PLAT + v.gold * GOLD + v.silver * SILVER + v.copper;
}

// Internal zone names -> display names (extend as new zones appear)
const ZONE_NAMES = {
  evergrove: 'Evershade Weald',
  nightharbor: 'Night Harbor',
  shadeddunes: 'Shaded Dunes',
  wyrmsbanetomb: 'Tomb of the Last Wyrmsbane',
};
const zoneName = (z) => ZONE_NAMES[z] || (z ? z.charAt(0).toUpperCase() + z.slice(1) : '');

// Kill coin field d12 = "plat,gold,silver,copper" (base64) -> total copper
function coinFromD12(s) {
  const t = b64(s);
  const p = t.split(',').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return 0;
  return p[0] * PLAT + p[1] * GOLD + p[2] * SILVER + p[3];
}

function copperToString(c) {
  const p = Math.floor(c / PLAT); c %= PLAT;
  const g = Math.floor(c / GOLD); c %= GOLD;
  const s = Math.floor(c / SILVER); const cp = c % SILVER;
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
  const harvestZones = {}; // resourceName -> { zone: count } (where it's gathered)
  let events = 0;

  const mob = (name) => (mobs[name] = mobs[name] || { kills: 0, drops: {}, zones: {}, coin: 0, corpses: 0 });
  // Items are keyed by display NAME so loot and vendor records of the same item
  // merge into one entry (vendor sales omit the d05 id, which used to duplicate them).
  const item = (name) => (items[name] = items[name] || { name, id: '', sources: {}, prices: {}, zones: {} });
  const bump = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };

  // The game only writes a KILL event (act_14) for some mobs, but logs every LOOT
  // (act_13). So loots ÷ kills is unreliable. Instead we cluster a mob's loot
  // events by time into "corpses" and use that as the drop-rate denominator —
  // it tracks kill counts closely where both exist, and works where kills don't.
  const lootLog = {}; // mobName -> [{ t, item }]

  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const ev of data.c01 || []) {
      events++;
      let p = {};
      try { p = JSON.parse(ev.f03 || '{}'); } catch {}

      const zRaw = b64((ev.f05 || '').replace(/^zone_/, ''));
      const zone = zRaw && !zRaw.includes('�') ? zoneName(zRaw) : '';

      if (ev.f01 === 'act_14') {
        // KILL — a corpse was created. New format stores the mob in d13 (base64);
        // skip old-format entries where it's only an unresolved ref or a sentence.
        let name = decodeName(p.d13);
        if (!name) {
          const alt = decodeName((ev.f02 || '').replace(/^name_/, ''));
          if (alt && alt.length <= 40 && !/[,]|corpse|copper|split/i.test(alt)) name = alt;
        }
        if (name) {
          const M = mob(name);
          M.kills++;
          bump(M.zones, zone);
          M.coin += coinFromD12(p.d12);
        }
      } else if (ev.f01 === 'act_13') {
        // LOOT — item taken off a mob. Recorded with a timestamp so we can group
        // loots into corpses afterwards (drop rate = corpses-with-item ÷ corpses).
        const source = decodeName(p.d02);
        const name = cleanItemName(p.d04);
        if (!isClean(name)) continue;
        const it = item(name);
        if (p.d05 && !it.id) it.id = p.d05;
        bump(it.zones, zone);
        if (source) {
          it.sources[source] = (it.sources[source] || 0) + 1;
          const M = mob(source);            // ensure the mob exists even with no kill event
          bump(M.zones, zone);              // loots carry the zone; kills may be absent
          const t = Date.parse(ev.f04) || 0;
          (lootLog[source] = lootLog[source] || []).push({ t, item: name });
        }
      } else if (ev.f01 === 'act_24') {
        // VENDOR SALE — records the price received (but not which vendor)
        const name = cleanItemName(p.d04 || ev.f02);
        if (!isClean(name)) continue;
        const qty = p.d01 || 1;
        const per = Math.max(1, Math.round(priceToCopper(b64(p.d03)) / qty));
        const it = item(name);
        if (p.d05 && !it.id) it.id = p.d05;
        it.prices[per] = (it.prices[per] || 0) + 1;
      } else if (ev.f01 === 'act_27') {
        // HARVEST — gathering node (record where it was gathered)
        const res = cleanItemName(p.d04);
        if (isClean(res)) {
          harvest[res] = (harvest[res] || 0) + 1;
          if (zone) bump((harvestZones[res] = harvestZones[res] || {}), zone);
        }
      }
    }
  }

  // Cluster each mob's loot events into corpses: loots more than CORPSE_GAP_MS
  // apart belong to different corpses. drops[item] becomes the number of corpses
  // that contained that item (counted once per corpse), and corpses is the count.
  const CORPSE_GAP_MS = 10000;
  for (const [mobName, log] of Object.entries(lootLog)) {
    log.sort((a, b) => a.t - b.t);
    const M = mob(mobName);
    const presence = {};
    let corpses = 0, last = -Infinity, cur = null;
    for (const e of log) {
      if (e.t - last > CORPSE_GAP_MS) { corpses++; cur = new Set(); }
      last = e.t;
      if (!cur.has(e.item)) { cur.add(e.item); presence[e.item] = (presence[e.item] || 0) + 1; }
    }
    M.corpses = corpses;
    M.drops = presence;
  }

  return { mobs, items, harvest, harvestZones, events, fileCount: files.length };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Shape the raw aggregate into per-item records ready for display / export.
// Harvested resources become first-class entries too, so everything has a page.
function buildItemReport(agg) {
  const items = Object.values(agg.items).map((it) => {
    const droppedBy = Object.keys(it.sources).map((mobName) => {
      const M = agg.mobs[mobName] || {};
      const corpses = M.corpses || 0;
      const drops = (M.drops && M.drops[it.name]) || 0; // corpses that held this item
      return { mob: mobName, drops, corpses, rate: corpses ? drops / corpses : null };
    }).sort((a, b) => (b.rate || 0) - (a.rate || 0));

    const prices = Object.entries(it.prices)
      .map(([copper, count]) => ({ copper: +copper, count }))
      .sort((a, b) => a.copper - b.copper);

    // Zones = where it was looted AND where it was harvested
    const zoneCounts = {};
    for (const [z, c] of Object.entries(it.zones || {})) zoneCounts[z] = (zoneCounts[z] || 0) + c;
    for (const [z, c] of Object.entries(agg.harvestZones[it.name] || {})) zoneCounts[z] = (zoneCounts[z] || 0) + c;
    const zones = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1]).map(([z]) => z);

    return { id: it.id || slug(it.name), name: it.name, droppedBy, prices, harvested: agg.harvest[it.name] || 0, zones };
  })
  // Drop empty entries that have no drops, no prices, and no harvest
  .filter((i) => i.droppedBy.length || i.prices.length || i.harvested);

  // Add resource-only entries (gathered but never looted/sold) so they get pages
  const have = new Set(items.map((i) => i.name));
  for (const [res, count] of Object.entries(agg.harvest)) {
    if (have.has(res)) continue;
    const zones = Object.entries(agg.harvestZones[res] || {}).sort((a, b) => b[1] - a[1]).map(([z]) => z);
    items.push({ id: slug(res), name: res, droppedBy: [], prices: [], harvested: count, zones });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------
// Session Replay — group the raw ledger into play sessions and recap each one.
// ---------------------------------------------------------------

// A play "session" is a run of activity with no gap longer than this. About
// 30 minutes with nothing logged (kill / loot / harvest / sale) is treated as
// the player having logged off, so the next activity starts a new session.
const SESSION_GAP_MS = 30 * 60 * 1000;

// Pull a flat, chronological stream of meaningful events out of the ledger,
// split it into sessions on idle gaps, and summarise each. Sessions are
// returned most-recent-first so the UI can open on "your last session".
// opts.limit caps how many recent sessions are returned (nothing is stored —
// this is built fresh from the ledger each call).
function buildSessions(files, opts = {}) {
  const gap = opts.gapMs || SESSION_GAP_MS;
  const evs = [];
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const ev of data.c01 || []) {
      const t = Date.parse(ev.f04);
      if (!t) continue;
      let p = {};
      try { p = JSON.parse(ev.f03 || '{}'); } catch {}
      const zRaw = b64((ev.f05 || '').replace(/^zone_/, ''));
      const zone = zRaw && !zRaw.includes('�') ? zoneName(zRaw) : '';

      if (ev.f01 === 'act_14') {            // kill
        let name = decodeName(p.d13);
        if (!name) {
          const alt = decodeName((ev.f02 || '').replace(/^name_/, ''));
          if (alt && alt.length <= 40 && !/[,]|corpse|copper|split/i.test(alt)) name = alt;
        }
        if (name) evs.push({ t, zone, kind: 'kill', name, coin: coinFromD12(p.d12) });
      } else if (ev.f01 === 'act_13') {     // loot
        const name = cleanItemName(p.d04);
        if (isClean(name)) evs.push({ t, zone, kind: 'loot', name, source: decodeName(p.d02) });
      } else if (ev.f01 === 'act_24') {     // vendor sale
        const name = cleanItemName(p.d04 || ev.f02);
        if (isClean(name)) evs.push({ t, zone, kind: 'sale', name, coin: priceToCopper(b64(p.d03)) });
      } else if (ev.f01 === 'act_27') {     // harvest
        const res = cleanItemName(p.d04);
        if (isClean(res)) evs.push({ t, zone, kind: 'harvest', name: res });
      }
    }
  }
  evs.sort((a, b) => a.t - b.t);

  const sessions = [];
  let cur = null;
  for (const e of evs) {
    if (!cur || e.t - cur.end > gap) { cur = { start: e.t, end: e.t, events: [] }; sessions.push(cur); }
    cur.events.push(e);
    cur.end = e.t;
  }
  const now = Date.now();
  const summaries = sessions.map(summarizeSession);
  // The most recent session is still "live" if its last event is within the gap.
  summaries.forEach((s) => { s.active = now - s.end < gap; });
  summaries.reverse(); // most-recent first
  return opts.limit ? summaries.slice(0, opts.limit) : summaries;
}

function summarizeSession(s) {
  const kills = {}, loot = {}, harvest = {}, sales = {};
  let killCoin = 0, saleCoin = 0;

  // Break the session into zone segments. A blank/garbled zone carries the last
  // known zone forward so a momentary gap doesn't fragment the timeline.
  const segs = [];
  let seg = null, lastZone = '';
  for (const e of s.events) {
    const z = e.zone || lastZone || 'Unknown';
    if (e.zone) lastZone = e.zone;
    if (!seg || seg.zone !== z) {
      seg = { zone: z, start: e.t, end: e.t, kills: 0, loot: 0, harvest: 0, sales: 0, coin: 0 };
      segs.push(seg);
    }
    seg.end = e.t;
    if (e.kind === 'kill') { kills[e.name] = (kills[e.name] || 0) + 1; killCoin += e.coin; seg.kills++; seg.coin += e.coin; }
    else if (e.kind === 'loot') { loot[e.name] = (loot[e.name] || 0) + 1; seg.loot++; }
    else if (e.kind === 'harvest') { harvest[e.name] = (harvest[e.name] || 0) + 1; seg.harvest++; }
    else if (e.kind === 'sale') { sales[e.name] = (sales[e.name] || 0) + 1; saleCoin += e.coin; seg.sales++; seg.coin += e.coin; }
  }

  // Coalesce neighbouring segments of the same zone (e.g. a brief unknown blip).
  const merged = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && last.zone === g.zone) {
      last.end = g.end; last.kills += g.kills; last.loot += g.loot;
      last.harvest += g.harvest; last.sales += g.sales; last.coin += g.coin;
    } else merged.push({ ...g });
  }

  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
  const zoneMs = {};
  for (const g of merged) zoneMs[g.zone] = (zoneMs[g.zone] || 0) + (g.end - g.start);

  return {
    start: s.start, end: s.end, durationMs: s.end - s.start,
    counts: { kills: sum(kills), loot: sum(loot), harvest: sum(harvest), sales: sum(sales) },
    coin: { fromKills: killCoin, fromSales: saleCoin, total: killCoin + saleCoin },
    topKills: top(kills), topLoot: top(loot), topHarvest: top(harvest), topSales: top(sales),
    zones: Object.entries(zoneMs).sort((a, b) => b[1] - a[1]).map(([zone, ms]) => ({ zone, ms })),
    segments: merged,
  };
}

module.exports = {
  GAME_BASE, b64, priceToCopper, copperToString,
  findLedgerFiles, parseLedgers, buildItemReport,
  buildSessions, SESSION_GAP_MS,
};
