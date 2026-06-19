// ---------------------------------------------------------------
// mnmdb — static front-end for the Monsters & Memories drop/vendor
// dataset produced by the mnm-tools collector. Vanilla JS, no build.
// ---------------------------------------------------------------

let DATA = null;
let nameToId = {};   // item name -> item id (for linking mob drops to item pages)
let itemByName = {}; // item name -> full item record (for vendor-price lookups)
let NODES = {};      // gathering nodes (Copper Vein, …) from the wiki
let VENDORS = [];    // wiki Merchant pages: { name, zone, sells[], buys[] } (vendors.json)
let vendorsSelling = {}; // item name -> [vendor] that stock it (inverted from sells)
let HARVEST_NODES = []; // node-type yield rates from clustered harvests (data.json)
let resNodes = {};      // resource name -> [{ node, pulls, count, rate }]
let NODE_RICH = new Set(); // node base-names that have a "Rich" tier (for the node note)
let nodeDrops = {};        // collapsed node name -> Set of items the wiki says drop there
let harvestWikiNodes = {}; // harvest-cluster name -> Set of wiki node names it represents
let TRADES = {};     // item name (lowercased) -> [{price, side, date}] player trade prices
let RECIPES = [];    // crafting recipes from the wiki tradeskill pages
let recipesByResult = {}; // item name (lowercased) -> [recipe] that produce it
let MAPS = { zones: [], categories: [] }; // curated zone maps for the read-only viewer

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function coin(c) {
  c = Math.round(c);
  // M&M coin is base-100: 100c = 1s, 100s = 1g, 100g = 1p
  const p = Math.floor(c / 1000000); c %= 1000000;
  const g = Math.floor(c / 10000); c %= 10000;
  const s = Math.floor(c / 100); const cp = c % 100;
  return [p && p + 'p', g && g + 'g', s && s + 's', cp && cp + 'c'].filter(Boolean).join(' ') || '0c';
}

const pct = (r) => (r == null ? '—' : Math.round(r * 100) + '%');

function rateCell(rate, drops, total) {
  if (rate == null) return '<span class="sample">' + drops + ' seen</span>';
  const w = Math.min(100, Math.round(rate * 100));
  // Fade rates from thin samples so they read as rough rather than precise.
  const rough = total && total < 10;
  return '<span class="rate' + (rough ? ' rough' : '') + '"' +
    (rough ? ' title="Only ' + total + ' corpses — rough estimate"' : '') + '>' +
    '<span class="bar"><span class="fill" style="width:' + w + '%"></span></span>' +
    '<span class="pct">' + pct(rate) + (rough ? ' ~' : '') + '</span></span> <span class="sample">' + drops + '/' + total + '</span>';
}

const WIKI_BASE = 'https://monstersandmemories.miraheze.org/wiki/';
const wikiUrl = (name) => WIKI_BASE + encodeURIComponent(String(name).replace(/ /g, '_'));

const itemLink = (id, name) => '<a href="#/item/' + encodeURIComponent(id) + '">' + esc(name) + '</a>';
const mobLink = (name) => '<a href="#/mob/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const zoneLink = (name) => '<a href="#/zone/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const nodeLink = (name) => '<a href="#/node/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
// A gathering node (vein / pile / deposit …) as opposed to a mob or other source.
const isNodeName = (s) => /\b(vein|pile|deposit|node|outcrop|bush|patch)\b/i.test(s);
// Rich and regular tiers are indistinguishable in the log and share a loot table,
// so we collapse "Rich Copper Vein" -> "Copper Vein" everywhere.
const collapseNode = (name) => name.replace(/^Rich\s+/i, '');
const tradeskillLink = (name) => '<a href="#/tradeskill/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const vendorLink = (name) => '<a href="#/vendor/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
// A wiki "source" (node/creature/item) — link internally where we can, else to the wiki
const sourceLink = (s) =>
  DATA.mobs[s] ? mobLink(s)
    : NODES[s] ? nodeLink(s)
    : nameToId[s] ? itemLink(nameToId[s], s)
    : '<a href="' + wikiUrl(s) + '" target="_blank" rel="noopener">' + esc(s) + ' ↗</a>';

// Regular-vendor sell price = the BEST (highest) you'd get selling — regular
// vendors pay more than shady ones. Used as the realistic value of an item.
const regularPrice = (it) => (it && it.prices.length ? Math.max.apply(null, it.prices.map((p) => p.copper)) : 0);

// Price a vendor SELLS an item for (you buy it) — the wiki's base price, if known.
const vendorSellPrice = (name) => {
  const it = itemByName[name];
  return it && it.wiki && it.wiki.soldBy && it.wiki.soldBy.base != null ? it.wiki.soldBy.base : null;
};

// Vendors that would BUY this item, matched loosely on their stated buy categories
// (the wiki lists these as freeform groups like "Weapons" or "Animal parts (…)").
function vendorsBuying(it) {
  const w = it.wiki || {};
  const types = w.categories || [];
  // Derive a coarse weapon/armor/ammo kind from the ItemBox slot/dmg so generic
  // buy categories ("Weapons", "Armor") still match where we have the stats.
  const slot = (w.slot || '').toUpperCase();
  const kinds = [];
  if (w.dmg != null || /PRIMARY/.test(slot)) kinds.push('weapon');
  if (/WRIST|NECK|HAND|WAIST|FEET|FACE|BACK|LEG|CHEST|SHOULDER|HEAD|BELT|FINGER|SHIRT|SECONDARY/.test(slot)) kinds.push('armor');
  if (slot.includes('AMMO')) kinds.push('ammo');
  const hay = (types.join(' ') + ' ' + kinds.join(' ') + ' ' + it.name).toLowerCase();
  const out = [];
  for (const v of VENDORS) {
    for (const b of (v.buys || [])) {
      const word = b.toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/s$/, '');
      if (word.length > 2 && hay.includes(word)) { out.push(Object.assign({ matched: b.replace(/\s*\(.*?\)/g, '') }, v)); break; }
    }
  }
  return out;
}

// Drop extreme outliers with an IQR fence so one fat-fingered price can't skew
// the range. Needs >=4 points to judge; below that every price is kept.
function trimOutliers(prices) {
  if (prices.length < 4) return prices.slice();
  const s = prices.slice().sort((a, b) => a - b);
  const q = (p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
  if (iqr === 0) return prices.slice();
  const lo = q1 - 3 * iqr, hi = q3 + 3 * iqr;
  return prices.filter((p) => p >= lo && p <= hi);
}

const mean = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);

// Player trade value — 30-day high/low + 7-day average of SELL-side prices,
// with wild outliers trimmed so the displayed range stays trustworthy.
function tradeStats(name) {
  const list = TRADES[String(name).toLowerCase()];
  if (!list || !list.length) return null;
  const sells = list.filter((t) => t.side === 'sell');
  if (!sells.length) return null;
  const now = Date.now();
  const rawIn = (days) => sells.filter((t) => new Date(t.date).getTime() >= now - days * 864e5).map((t) => t.price);
  const raw30 = rawIn(30);
  const p30 = trimOutliers(raw30), p7 = trimOutliers(rawIn(7)), allP = trimOutliers(sells.map((t) => t.price));
  return {
    n30: p30.length,
    trimmed: raw30.length - p30.length,
    high: p30.length ? Math.max.apply(null, p30) : null,
    low: p30.length ? Math.min.apply(null, p30) : null,
    n7: p7.length,
    avg7: mean(p7),
    allHigh: allP.length ? Math.max.apply(null, allP) : null,
    allLow: allP.length ? Math.min.apply(null, allP) : null,
  };
}

// Best known market value for an item: player trade price when we have it,
// otherwise the regular vendor sell price. { value, source: 'trade'|'vendor'|null }
function itemMarketValue(name) {
  const tv = tradeStats(name);
  if (tv) {
    const v = tv.avg7 != null ? tv.avg7
      : tv.high != null ? Math.round((tv.high + tv.low) / 2)
      : Math.round((tv.allHigh + tv.allLow) / 2);
    if (v > 0) return { value: v, source: 'trade' };
  }
  const it = itemByName[name];
  // The wiki's "Sold by" base price is the authoritative vendor (buy) price.
  const sold = it && it.wiki && it.wiki.soldBy && it.wiki.soldBy.base;
  if (sold > 0) return { value: sold, source: 'vendor' };
  const reg = regularPrice(it);
  if (reg > 0) return { value: reg, source: 'vendor' };
  return { value: 0, source: null };
}

// Crafting economics for one recipe: cost of the mats vs the value of the
// output. "Margin" = output value − mats value = what crafting adds over just
// selling the raw materials. Components without a known price are flagged.
function recipeEconomics(r) {
  let matCost = 0, missing = 0;
  for (const c of r.components) {
    const v = itemMarketValue(c.item).value;
    if (v > 0) matCost += c.qty * v; else missing++;
  }
  const outMv = itemMarketValue(r.result.item);
  const outValue = r.result.qty * outMv.value;
  const margin = outMv.value > 0 ? outValue - matCost : null;
  return { matCost, missing, outValue, haveOutput: outMv.value > 0, margin };
}

// Biggest movers — items whose 7-day average sell price changed most vs the
// previous week. Needs sells in both windows; empty until trade data builds up.
function tradeMovers() {
  const now = Date.now();
  const out = [];
  for (const list of Object.values(TRADES)) {
    const sells = list.filter((t) => t.side === 'sell');
    const win = (a, b) => mean(trimOutliers(
      sells.filter((t) => { const d = new Date(t.date).getTime(); return d >= now - a * 864e5 && d < now - b * 864e5; }).map((t) => t.price)
    ));
    const recent = win(7, 0), prior = win(14, 7);
    if (recent == null || prior == null || prior === 0) continue;
    out.push({ name: list[0].item, recent, pct: (recent - prior) / prior });
  }
  return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 10);
}

// Drop-rate denominator: looted corpses (falls back to kills for old data).
const mobCorpses = (d) => (d.corpses != null ? d.corpses : (d.kills || 0));

// Mob level from wiki enrichment (parses "5" or a "5-7" range), else NaN.
const mobLevel = (d) => { const l = d.wiki && parseInt(d.wiki.level, 10); return Number.isFinite(l) ? l : NaN; };

// Expected value of one kill: coin/kill + Σ(per-corpse drop rate × item price).
function mobValuePerKill(d) {
  const corpses = mobCorpses(d);
  const coinPer = d.kills ? (d.coin || 0) / d.kills : 0;
  let loot = 0;
  if (corpses) for (const [item, n] of Object.entries(d.drops)) loot += (n / corpses) * regularPrice(itemByName[item]);
  return { coin: coinPer, loot, total: coinPer + loot };
}

// ---- Charts (dependency-free: inline SVG + CSS bars) ----

// Palette for stacked-segment charts (sunset theme + a few complementary hues).
const SEG_COLORS = ['#f0922b', '#8bbf5a', '#e0593f', '#c98a3a', '#6fa8c7', '#b07fc9', '#d9b94a', '#7fc9a0'];

// Inline magnitude bar for ranked home tables. `disp` is pre-formatted HTML.
const barCell = (v, max, disp) => {
  const w = max > 0 && v > 0 ? Math.max(3, Math.round((v / max) * 100)) : 0;
  return '<span class="magbar"><span class="track"><span class="fill" style="width:' + w + '%"></span></span>' +
    '<span class="mag-label">' + disp + '</span></span>';
};

// Rarity × value scatter — up = more valuable (log scale), right = rarer.
// Each point links to its item; trade-priced points are tinted differently.
function scatterSvg(points) {
  const W = 360, H = 230, PAD = { l: 22, r: 14, t: 16, b: 26 };
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const axisY = PAD.l, axisX = PAD.t + ph;
  const vals = points.map((p) => p.value);
  const lo = Math.log(Math.min.apply(null, vals)), hi = Math.log(Math.max.apply(null, vals));
  const span = hi - lo || 1;
  const clamp01 = (r) => Math.max(0, Math.min(1, r));
  // Deterministic jitter so items sharing a rate/price don't fully overlap.
  const jit = (s, amp) => { let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) & 255; return ((h / 255) - 0.5) * 2 * amp; };
  const cx = (x) => Math.max(PAD.l, Math.min(W - PAD.r, x));
  const cy = (y) => Math.max(PAD.t, Math.min(axisX, y));
  const dots = points.map((p) => {
    const x = cx(PAD.l + (1 - clamp01(p.rate)) * pw + jit(p.i.name, 4)).toFixed(1);
    const y = cy(PAD.t + (1 - (Math.log(p.value) - lo) / span) * ph + jit(p.i.name + 'y', 4)).toFixed(1);
    const cls = 'pt' + (p.source === 'trade' ? ' trade' : '');
    const tip = esc(p.i.name) + ' — ' + coin(p.value) + ' · ' + Math.round(clamp01(p.rate) * 100) + '% drop';
    return '<a href="#/item/' + encodeURIComponent(p.i.id) + '" aria-label="' + tip + '">' +
      '<circle class="' + cls + '" cx="' + x + '" cy="' + y + '" r="3.6" data-tip="' + tip + '"></circle></a>';
  }).join('');
  const frame =
    '<line class="axis" x1="' + PAD.l + '" y1="' + axisX + '" x2="' + (W - PAD.r) + '" y2="' + axisX + '"/>' +
    '<line class="axis" x1="' + axisY + '" y1="' + PAD.t + '" x2="' + axisY + '" y2="' + axisX + '"/>';
  const guides =
    '<line class="guide" x1="' + (PAD.l + pw / 2) + '" y1="' + PAD.t + '" x2="' + (PAD.l + pw / 2) + '" y2="' + axisX + '"/>' +
    '<line class="guide" x1="' + PAD.l + '" y1="' + (PAD.t + ph / 2) + '" x2="' + (W - PAD.r) + '" y2="' + (PAD.t + ph / 2) + '"/>';
  const labels =
    '<text class="axlabel" x="' + (PAD.l + pw / 2) + '" y="' + (H - 4) + '" text-anchor="middle">common ← drop chance → rare</text>' +
    '<text class="axlabel" transform="rotate(-90 9 ' + (PAD.t + ph / 2) + ')" x="9" y="' + (PAD.t + ph / 2) + '" text-anchor="middle">value →</text>' +
    '<text class="qlabel" x="' + (W - PAD.r - 2) + '" y="' + (PAD.t + 9) + '" text-anchor="end">★ rare &amp; valuable</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Item rarity versus value scatter plot">' +
    guides + frame + labels + dots + '</svg>';
}

// Average price players SELL an item for (WTS trades) — the realistic resale value.
function playerSellValue(name) {
  const arr = TRADES[name.toLowerCase()] || [];
  const sells = arr.filter((t) => t.side === 'sell').map((t) => t.price);
  return sells.length ? sells.reduce((a, b) => a + b, 0) / sells.length : 0;
}

// Arbitrage: items you can buy from a vendor (wiki base price) and resell to
// players for more. Margin = player sell − vendor buy. Empty until enough player
// SELL prices are logged for items that vendors stock.
function flipFinder() {
  const out = [];
  DATA.items.forEach((it) => {
    const base = it.wiki && it.wiki.soldBy && it.wiki.soldBy.base;
    if (base == null || !(base > 0)) return;
    const sell = playerSellValue(it.name);
    if (sell > base) out.push({ it, buy: base, sell, margin: sell - base, pct: (sell - base) / base });
  });
  return out.sort((a, b) => b.margin - a.margin).slice(0, 15);
}

// ---- Views ----

function renderHome() {
  const items = DATA.items;
  const mobs = Object.entries(DATA.mobs);
  const withVendor = items.filter((i) => i.prices.length).length;

  // Most-valuable mobs — by estimated value per kill (coin + loot)
  const valMobs = mobs.filter(([, d]) => mobCorpses(d) || d.kills)
    .map(([m, d]) => [m, mobValuePerKill(d).total])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 12);

  // Most-fought mobs — kills where the game logs them, else corpses looted
  const activity = (d) => Math.max(d.kills || 0, mobCorpses(d));
  const topMobs = mobs.slice().sort((a, b) => activity(b[1]) - activity(a[1])).slice(0, 12);

  // Priciest items — by regular vendor sell price
  const priciest = items.filter((i) => i.prices.length)
    .map((i) => [i, regularPrice(i)])
    .sort((a, b) => b[1] - a[1]).slice(0, 12);

  // Valuable resources — harvestable things ranked by sell value, then by how
  // much you've gathered (ties gathering to economy)
  const resources = Object.keys(DATA.harvest)
    .map((r) => { const mv = itemMarketValue(r); return { name: r, value: mv.value, source: mv.source, n: DATA.harvest[r] }; })
    .sort((a, b) => b.value - a.value || b.n - a.n).slice(0, 12);

  // Recent player trades — newest first
  const recent = [];
  Object.values(TRADES).forEach((arr) => arr.forEach((t) => recent.push(t)));
  recent.sort((a, b) => new Date(b.date) - new Date(a.date));
  const recentTop = recent.slice(0, 10);

  // Rarity × value — items we both see drop and can put a price on.
  const scatterPts = items.map((i) => {
    const rate = (i.droppedBy || []).reduce((m, d) => Math.max(m, d.rate || 0), 0);
    const mv = itemMarketValue(i.name);
    return { i, rate, value: mv.value, source: mv.source };
  }).filter((p) => p.rate > 0 && p.value > 0);

  // Tables get inline magnitude bars (value scaled to the leader in each list).
  const maxVal = valMobs.length ? valMobs[0][1] : 0;
  const maxAct = topMobs.length ? activity(topMobs[0][1]) : 0;
  const maxPrice = priciest.length ? priciest[0][1] : 0;
  const maxRes = resources.reduce((m, r) => Math.max(m, r.value || 0), 0);

  const mobValRows = valMobs.map(([m, v]) => '<tr><td>' + mobLink(m) + '</td><td class="num">' +
    barCell(v, maxVal, '<span class="coin">' + coin(v) + '</span>') + '</td></tr>').join('');
  const killRows = topMobs.map(([m, d]) => '<tr><td>' + mobLink(m) + '</td><td class="num">' +
    barCell(activity(d), maxAct, '<span class="sample">' + (d.kills ? d.kills + ' kills' : mobCorpses(d) + ' looted') + '</span>') +
    '</td></tr>').join('');
  const priceRows = priciest.map(([i, v]) => '<tr><td>' + itemLink(i.id, i.name) + '</td><td class="num">' +
    barCell(v, maxPrice, '<span class="coin">' + coin(v) + '</span>') + '</td></tr>').join('');
  const resRows = resources.map((r) => '<tr><td>' + (nameToId[r.name] ? itemLink(nameToId[r.name], r.name) : esc(r.name)) +
    (r.source === 'trade' ? ' <span class="tag good">trade</span>' : '') +
    '</td><td class="num">' + (r.value
      ? barCell(r.value, maxRes, '<span class="coin">' + coin(r.value) + '</span>')
      : '<span class="sample">' + r.n + '× gathered</span>') + '</td></tr>').join('');

  // Most valuable by level bracket — needs both a wiki level and a value.
  const BRACKET = 10;
  const byBracket = {};
  mobs.forEach(([m, d]) => {
    const lvl = mobLevel(d), v = mobValuePerKill(d).total;
    if (!Number.isFinite(lvl) || v <= 0) return;
    const start = Math.floor((lvl - 1) / BRACKET) * BRACKET + 1; // 1-10→1, 11-20→11
    (byBracket[start] = byBracket[start] || []).push({ m, lvl, v });
  });
  const bracketKeys = Object.keys(byBracket).map(Number).sort((a, b) => a - b);
  const unleveled = mobs.filter(([, d]) => mobValuePerKill(d).total > 0 && !Number.isFinite(mobLevel(d))).length;
  const bracketCols = bracketKeys.map((start) => {
    const list = byBracket[start].sort((a, b) => b.v - a.v).slice(0, 8);
    const max = list[0].v;
    return '<div><h3 class="bracket">Lv ' + start + '–' + (start + BRACKET - 1) + '</h3><div class="card"><table><tbody>' +
      list.map((x) => '<tr><td>' + mobLink(x.m) + ' <span class="sample">L' + x.lvl + '</span></td><td class="num">' +
        barCell(x.v, max, '<span class="coin">' + coin(x.v) + '</span>') + '</td></tr>').join('') +
      '</tbody></table></div></div>';
  }).join('');
  const bracketSection = bracketKeys.length
    ? '<h2>Best value by level</h2><p class="sub">Top value/kill in each level band (level from the wiki).' +
      (unleveled ? ' ' + unleveled + ' valuable mob' + (unleveled === 1 ? '' : 's') + ' not shown — no wiki level yet.' : '') + '</p>' +
      '<div class="col2">' + bracketCols + '</div>'
    : '';

  const movers = tradeMovers();
  const moversSection = movers.length
    ? '<h2>Biggest movers</h2><p class="sub">7-day average sell price vs the previous week.</p>' +
      '<div class="ticker">' + movers.map((m) => {
        const up = m.pct >= 0;
        return '<a class="chip ' + (up ? 'up' : 'down') + '" href="#/item/' + encodeURIComponent(nameToId[m.name] || m.name) + '">' +
          esc(m.name) + ' <span class="mv">' + (up ? '▲' : '▼') + ' ' + Math.abs(Math.round(m.pct * 100)) + '%</span> ' +
          '<span class="sample">' + coin(m.recent) + '</span></a>';
      }).join('') + '</div>'
    : '';

  const flips = flipFinder();
  const hasVendorBuys = items.some((i) => i.wiki && i.wiki.soldBy && i.wiki.soldBy.base != null);
  const flipSection = flips.length
    ? '<h2>Flip finder</h2><p class="sub">Buy from a vendor, resell to players for profit. Margin = player sell price − vendor price.</p>' +
      '<div class="card"><table><thead><tr><th>Item</th><th class="num">Buy (vendor)</th><th class="num">Sell (players)</th><th class="num">Margin</th></tr></thead><tbody>' +
      flips.map((f) => '<tr><td>' + itemLink(f.it.id, f.it.name) + '</td>' +
        '<td class="num coin">' + coin(f.buy) + '</td>' +
        '<td class="num coin">' + coin(f.sell) + '</td>' +
        '<td class="num"><span class="pos">+' + coin(f.margin) + ' (' + Math.round(f.pct * 100) + '%)</span></td></tr>').join('') +
      '</tbody></table></div>'
    : hasVendorBuys
      ? '<h2>Flip finder</h2><p class="sub">Buy cheap from a vendor, resell to players for profit. ' +
        'No flips yet — this lights up once player <b>sell</b> prices are logged for items that vendors stock ' +
        '(we already have vendor buy prices). Log trades in the app to power it.</p>'
      : '';

  const recentBlock = recentTop.length
    ? '<h2>Recent player trades</h2><div class="card"><table><tbody>' +
      recentTop.map((t) => '<tr><td>' + (nameToId[t.item] ? itemLink(nameToId[t.item], t.item) : esc(t.item)) +
        ' <span class="tag ' + (t.side === 'buy' ? 'warn' : 'good') + '">' + (t.side === 'buy' ? 'WTB' : 'WTS') + '</span></td>' +
        '<td class="num coin">' + coin(t.price) + '</td><td class="num sample">' + esc(t.date) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '';

  const scatterSection = scatterPts.length >= 5
    ? '<h2>Rarity × value</h2><p class="sub">Each dot is an item — up = more valuable, right = rarer. ' +
      'The top-right is the rare, high-value chase loot. ' +
      '<span class="tag good">green</span> dots are priced from player trades, orange from vendors. Hover to identify, click to open.</p>' +
      '<div class="scatter">' + scatterSvg(scatterPts) + '<div class="scatter-tip" hidden></div></div>'
    : '';

  $('content').innerHTML =
    '<div class="home-intro">' +
      '<h1>Monsters &amp; Memories — gathering &amp; economy</h1>' +
      '<p class="sub">Community drop rates, vendor values and player trade prices, gathered by the ' +
        '<a href="https://github.com/Boisteroux/mnm-tools">mnm-tools</a> companion app. ' +
        'Search above, or dig into the numbers below.</p>' +
      '<div class="stat-row">' +
        stat(items.length, 'items') + stat(mobs.length, 'mobs') +
        stat(withVendor, 'with vendor prices') + stat(Object.keys(DATA.harvest).length, 'resources') +
      '</div>' +
    '</div>' +
    moversSection +
    flipSection +
    '<div class="col2">' +
      '<div><h2>Most-valuable mobs</h2><p class="sub">Estimated coin + loot per kill.</p><div class="card"><table><tbody>' +
        (mobValRows || '<tr><td class="muted">No data yet.</td></tr>') + '</tbody></table></div></div>' +
      '<div><h2>Most-fought mobs</h2><p class="sub">Where the grind has gone.</p><div class="card"><table><tbody>' +
        killRows + '</tbody></table></div></div>' +
    '</div>' +
    bracketSection +
    '<div class="col2">' +
      '<div><h2>Priciest items</h2><p class="sub">Top regular-vendor sell value.</p><div class="card"><table><tbody>' +
        (priceRows || '<tr><td class="muted">No vendor prices yet.</td></tr>') + '</tbody></table></div></div>' +
      '<div><h2>Valuable resources</h2><p class="sub">Gatherables by value — player trade price where known, else vendor.</p><div class="card"><table><tbody>' +
        (resRows || '<tr><td class="muted">No resources yet.</td></tr>') + '</tbody></table></div></div>' +
    '</div>' +
    scatterSection +
    recentBlock +
    '<div class="note">Values are observational — drop rates are per looted corpse and prices come from real play. ' +
      'Small samples are rough; numbers sharpen as more data is collected.</div>';

  wireScatter();
}

// Cursor-following tooltip for the rarity × value scatter (the dots are tiny, so
// a hover label saves a trip to each item page just to see what's what).
function wireScatter() {
  const box = document.querySelector('.scatter');
  if (!box) return;
  const tip = box.querySelector('.scatter-tip');
  if (!tip) return;
  box.addEventListener('mousemove', (e) => {
    const dot = e.target.closest && e.target.closest('.pt');
    if (!dot) { tip.hidden = true; return; }
    tip.innerHTML = dot.getAttribute('data-tip') || '';
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    tip.style.left = Math.max(4, Math.min(x + 12, box.clientWidth - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(y + 12, box.clientHeight - tip.offsetHeight - 4)) + 'px';
  });
  box.addEventListener('mouseleave', () => { tip.hidden = true; });
}

const stat = (n, l) => '<div class="stat"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>';

function renderItem(id) {
  const it = DATA.items.find((i) => i.id === id) || DATA.items.find((i) => i.name === id)
    || DATA.items.find((i) => i.gameId === id); // keep old hash-based URLs working
  if (!it) return notFound('item', id);

  const sections = [];
  const w = it.wiki || {};

  // Stats — wiki stats + your harvest tally + sell price, all in one block
  {
    const rows = [];
    const add = (k, v) => {
      if (v != null && v !== '') rows.push('<tr><td class="muted" style="width:140px">' + k + '</td><td>' + v + '</td></tr>');
    };
    add('Type', [...(w.categories || []).map(esc), ...(w.tradeskills || []).map(tradeskillLink),
      ...(w.harvestedBy ? [esc(w.harvestedBy)] : [])].join(', '));
    add('Slot', esc(w.slot || ''));
    add('Weapon DMG', w.dmg, true);
    add('Attack delay', w.delay, true);
    add('Skill', esc(w.skill || ''));
    add('Weight', w.weight, true);
    add('Size', esc(w.size || ''));
    add('Class', esc(w.class || ''));
    add('Race', esc(w.race || ''));
    if (it.harvested > 0) add('Harvested', it.harvested + '×');
    if (it.prices.length) add('Sells for', coin(regularPrice(it)));
    if (rows.length) {
      const fromWiki = ['slot', 'dmg', 'delay', 'skill', 'weight', 'size', 'class', 'race'].some((k) => w[k] != null && w[k] !== '');
      sections.push('<h2>Stats</h2><div class="card"><table><tbody>' + rows.join('') + '</tbody></table></div>' +
        (fromWiki ? '<div class="note">Item stats are pulled from the community wiki.</div>' : ''));
    }
  }

  // Crafting — if this item can be made, show how (with profit margin).
  {
    const crafts = recipesByResult[it.name.toLowerCase()] || [];
    if (crafts.length) sections.push('<h2>How to craft</h2>' + recipeTable(crafts, true) + marginNote);
  }

  // Dropped by — one list combining observed mobs (corpse drop rate) and gathering
  // nodes (harvest yield rate), plus any wiki-listed sources without a rate. A node
  // "drops" its yields, so we treat its harvest rate as the drop rate.
  const dropRows = [];
  const seenSrc = new Set();
  it.droppedBy.forEach((d) => { seenSrc.add(d.mob); dropRows.push(d); });
  const obs = (resNodes[it.name] || [])[0]; // observed harvest rate (from a specific cluster)
  const obsNodes = obs ? harvestWikiNodes[obs.node] : null; // which node names that rate applies to
  let anyRate = false;
  (w.from || []).forEach((s) => {
    const isNode = !!NODES[s] || isNodeName(s);
    const key = isNode ? collapseNode(s) : s; // merge rich/regular tiers into one row
    if (seenSrc.has(key)) return;
    seenSrc.add(key);
    // Only show the observed rate next to the node it was actually measured at; a
    // gem that also drops elsewhere shows "—" for those other nodes.
    if (isNode && obs && obsNodes && obsNodes.has(key)) {
      dropRows.push({ mob: key, rate: obs.rate, drops: obs.count, corpses: obs.pulls, node: true }); anyRate = true;
    } else dropRows.push({ mob: key, rate: null, node: isNode });
  });
  if (dropRows.length) {
    sections.push('<h2>Dropped by</h2><div class="card"><table><thead><tr><th>Source</th><th class="num">Drop rate</th></tr></thead><tbody>' +
      dropRows.map((r) => '<tr><td>' + (r.node ? nodeLink(r.mob) + ' <span class="sample">node</span>' : sourceLink(r.mob)) + '</td><td class="num">' +
        (r.rate == null ? '<span class="sample">—</span>'
          : r.node ? harvestRateCell(r.rate, r.drops, r.corpses) : rateCell(r.rate, r.drops, r.corpses)) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      (anyRate ? '<div class="note">Node drop rates are observed <b>per harvest</b> and combined across a node’s tiers (regular + rich) — the game log records what dropped, not which node. Click a node for its full table.</div>' : ''));
  }

  // Player trade value — 30-day high/low + 7-day average of player sell prices
  {
    const tv = tradeStats(it.name);
    const logged = 'Logged in the companion app as people play.';
    let body;
    if (tv && tv.n30) {
      const avg = tv.avg7 != null
        ? '<div class="vbox"><div class="vlbl">7-day average</div><div class="vval">' + coin(tv.avg7) + '</div></div>'
        : '<div class="vbox"><div class="vlbl">7-day average</div><div class="vval sample">no recent</div></div>';
      body = '<div class="vendor-summary">' +
        '<div class="vbox"><div class="vlbl">30-day high</div><div class="vval">' + coin(tv.high) + '</div></div>' +
        '<div class="vbox"><div class="vlbl">30-day low</div><div class="vval">' + coin(tv.low) + '</div></div>' +
        avg +
        '</div><div class="note">From ' + tv.n30 + ' sale' + (tv.n30 === 1 ? '' : 's') + ' in the last 30 days' +
        (tv.n7 ? ' (' + tv.n7 + ' in the last 7)' : '') +
        (tv.trimmed ? ' · ' + tv.trimmed + ' outlier' + (tv.trimmed === 1 ? '' : 's') + ' excluded' : '') + '. ' + logged + '</div>';
    } else if (tv) {
      body = '<div class="note">No sales in the last 30 days. Last seen ' + coin(tv.allLow) +
        (tv.allHigh !== tv.allLow ? '–' + coin(tv.allHigh) : '') + ' (older data). ' + logged + '</div>';
    } else {
      body = '<div class="note">No player trades logged yet. ' + logged + '</div>';
    }
    sections.push('<h2>Player trade value</h2>' + body);
  }

  // Vendor value
  if (it.prices.length) {
    const sorted = it.prices.slice().sort((a, b) => b.copper - a.copper); // best sell first
    const high = sorted[0], low = sorted[sorted.length - 1];
    const summary = '<div class="vendor-summary">' +
      '<div class="vbox"><div class="vlbl">Regular vendor (best price)</div><div class="vval">' + coin(high.copper) + '</div></div>' +
      (sorted.length > 1
        ? '<div class="vbox warnbox"><div class="vlbl">Shady vendor (worst price)</div><div class="vval">' + coin(low.copper) + '</div></div>'
        : '') +
      '</div>';
    const rows = sorted.map((p) => {
      let tag = '';
      if (sorted.length > 1 && p === high) tag = '<span class="tag good">regular</span>';
      else if (sorted.length > 1 && p === low) tag = '<span class="tag warn">shady</span>';
      return '<tr><td class="coin">' + coin(p.copper) + ' ' + tag + '</td><td class="num sample">seen ' + p.count + '×</td></tr>';
    }).join('');
    sections.push('<h2>Vendor value (selling)</h2>' + summary +
      '<div class="card"><table><thead><tr><th>Sell prices seen</th><th class="num">Times</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (sorted.length > 1
        ? '<div class="note">Regular vendors pay more when you sell (highest); shady vendors pay less (lowest).</div>'
        : ''));
  }

  // Sold by — where you can BUY this item: wiki base/shady price + the vendors who stock it
  const sellers = vendorsSelling[it.name] || [];
  if ((w.soldBy && (w.soldBy.base != null || w.soldBy.shady != null)) || sellers.length) {
    const sb = w.soldBy || {};
    const boxes = (sb.base != null || sb.shady != null) ? '<div class="vendor-summary">' +
      (sb.base != null ? '<div class="vbox"><div class="vlbl">Base price</div><div class="vval">' + coin(sb.base) + '</div></div>' : '') +
      (sb.shady != null ? '<div class="vbox warnbox"><div class="vlbl">Shady price</div><div class="vval">' + coin(sb.shady) + '</div></div>' : '') +
      '</div>' : '';
    let listHtml;
    if (sellers.length) {
      listHtml = '<div class="card"><table><tbody>' + sellers.map((v) =>
        '<tr><td>' + vendorLink(v.name) + '</td><td class="sample">' + esc(v.zone || '') + '</td></tr>').join('') + '</tbody></table></div>';
    } else {
      const vlist = (sb.vendors || []).map((v) => DATA.mobs[v] ? mobLink(v) : (v.match(/^(a|an) /i) ? esc(v) : zoneLink(v))).join(', ');
      listHtml = vlist ? '<div class="note">Vendors: ' + vlist + '</div>' : '';
    }
    sections.push('<h2>Sold by</h2>' + boxes + listHtml +
      (sb.base != null ? '<div class="note">Base = regular vendor price; shady vendors charge more.</div>' : ''));
  }

  // Sold to — vendors that would buy this item (approximate, from their buy categories)
  const buyers = vendorsBuying(it);
  if (buyers.length) {
    sections.push('<h2>Sold to</h2><div class="card"><table><tbody>' +
      buyers.map((v) => '<tr><td>' + vendorLink(v.name) + '</td><td class="sample">' + esc(v.zone || '') +
        (v.matched ? ' · buys ' + esc(v.matched) : '') + '</td></tr>').join('') +
      '</tbody></table></div><div class="note">Matched on each vendor’s stated buy categories — approximate.</div>');
  }

  // Found / gathered in — observed zones plus the wiki's listed zones
  const zoneSet = [...new Set([...(it.zones || []), ...(w.wikiZones || [])])];
  if (zoneSet.length) {
    const heading = it.harvested > 0 ? 'Gathered in' : 'Found in';
    sections.push('<h2>' + heading + '</h2><div class="card"><table><tbody>' +
      zoneSet.map((z) => '<tr><td>' + zoneLink(z) + '</td></tr>').join('') + '</tbody></table></div>');
  }

  if (!sections.length) {
    sections.push('<p class="muted">No drop, harvest, or vendor data recorded for this item yet. ' +
      'It\'ll fill in as more is collected.</p>');
  }

  const icon = w.icon ? '<img class="entity-icon" src="' + w.icon + '" alt="" /> ' : '';
  const wikiLine = (it.wiki && it.wiki.hasPage)
    ? '<p class="sub"><a href="' + wikiUrl(it.name) + '" target="_blank" rel="noopener">View on the wiki ↗</a></p>'
    : '';

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › item</div>' +
    '<h1>' + icon + esc(it.name) + '</h1>' +
    wikiLine +
    sections.join('');
}

function renderMob(name) {
  const m = DATA.mobs[name];
  if (!m) return notFound('mob', name);

  const zones = Object.keys(m.zones || {});
  const val = mobValuePerKill(m);
  const corpses = mobCorpses(m);

  const drops = Object.entries(m.drops).map(([item, n]) => {
    const rate = corpses ? n / corpses : null;
    const reg = regularPrice(itemByName[item]);
    return { item, n, rate, reg, perKill: rate ? rate * reg : 0, hasPrice: reg > 0 };
  }).sort((a, b) => (b.rate || 0) - (a.rate || 0) || b.n - a.n);

  let table = '<p class="muted">No drops recorded.</p>';
  if (drops.length) {
    table = '<div class="card"><table><thead><tr><th>Item</th><th class="num">Drop rate</th><th class="num">Sell value</th><th class="num">Avg kill value</th></tr></thead><tbody>' +
      drops.map((d) => {
        const id = nameToId[d.item] || d.item;
        const sell = d.hasPrice ? coin(d.reg) : '<span class="sample">no price yet</span>';
        const pk = d.hasPrice ? coin(d.perKill) : '<span class="sample">—</span>';
        return '<tr><td>' + itemLink(id, d.item) + '</td><td class="num">' + rateCell(d.rate, d.n, corpses) +
          '</td><td class="num coin">' + sell + '</td><td class="num coin">' + pk + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  const boxes = ['<div class="vbox"><div class="vlbl">Corpses looted</div><div class="vval">' + corpses + '</div></div>'];
  if (m.kills) boxes.push('<div class="vbox"><div class="vlbl">Coin / kill</div><div class="vval">' + coin(val.coin) + '</div></div>');
  boxes.push('<div class="vbox"><div class="vlbl">Est. value / kill</div><div class="vval">' + coin(val.total) + '</div></div>');
  const summary = '<div class="vendor-summary">' + boxes.join('') + '</div>';

  // Value breakdown — what share of an average kill's value each source contributes
  // (coin + each priced drop). A quick read on "where the worth comes from".
  let breakdown = '';
  {
    const segs = [];
    if (m.kills && val.coin > 0) segs.push({ label: 'Coin', value: val.coin });
    drops.forEach((d) => { if (d.perKill > 0) segs.push({ label: d.item, value: d.perKill, id: nameToId[d.item] || d.item }); });
    const segTotal = segs.reduce((s, x) => s + x.value, 0);
    if (segTotal > 0 && segs.some((s) => s.id)) {
      segs.sort((a, b) => b.value - a.value);
      // Fold a long tail of tiny drops into one "N more" segment to keep it legible.
      const MAX = 7;
      let shown = segs;
      if (segs.length > MAX) {
        const tail = segs.slice(MAX - 1);
        shown = segs.slice(0, MAX - 1)
          .concat([{ label: tail.length + ' more', value: tail.reduce((s, x) => s + x.value, 0), other: true }]);
      }
      const pctOf = (v) => Math.round((v / segTotal) * 100);
      const bar = shown.map((s, idx) => '<span class="seg" style="width:' + ((s.value / segTotal) * 100).toFixed(2) +
        '%;background:' + SEG_COLORS[idx % SEG_COLORS.length] + '" title="' + esc(s.label) + ' — ' + coin(s.value) +
        ' (' + pctOf(s.value) + '%)"></span>').join('');
      const legend = shown.map((s, idx) => '<span class="leg"><span class="dot" style="background:' +
        SEG_COLORS[idx % SEG_COLORS.length] + '"></span>' + (s.other ? esc(s.label) : (s.id ? itemLink(s.id, s.label) : esc(s.label))) +
        ' <span class="sample">' + coin(s.value) + ' · ' + pctOf(s.value) + '%</span></span>').join('');
      breakdown = '<h2>Where the value comes from</h2><div class="breakdown"><div class="stack">' + bar + '</div>' +
        '<div class="legend">' + legend + '</div></div>' +
        '<p class="sub">Share of the ~' + coin(segTotal) + ' average value of each kill.</p>';
    }
  }

  // Wiki stats block (level / race / class / special)
  const mw = m.wiki || {};
  let statsBlock = '';
  const srows = [];
  const sadd = (k, v) => { if (v != null && v !== '') srows.push('<tr><td class="muted" style="width:140px">' + k + '</td><td>' + esc(String(v)) + '</td></tr>'); };
  sadd('Level', mw.level);
  sadd('Race', mw.race);
  sadd('Class', mw.class);
  sadd('HP', mw.hp);
  sadd('AC', mw.ac);
  sadd('Special', mw.special);
  if (srows.length) statsBlock = '<h2>Stats</h2><div class="card"><table><tbody>' + srows.join('') + '</tbody></table></div>';

  const wikiLine = mw.hasPage
    ? '<p class="sub"><a href="' + wikiUrl(mw.title || (name.charAt(0).toUpperCase() + name.slice(1))) + '" target="_blank" rel="noopener">View on the wiki ↗</a></p>'
    : '';

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › mob</div>' +
    '<h1>' + esc(name) + '</h1>' +
    (zones.length ? '<p class="sub">Found in ' + zones.map(zoneLink).join(', ') + '</p>' : '') +
    wikiLine +
    statsBlock +
    summary +
    breakdown +
    '<h2>Drops &amp; farming value</h2>' + table +
    '<div class="note">Drop rates are per <em>looted corpse</em> (the game doesn’t log a kill for every mob, so loots are grouped into corpses). ' +
    '“Sell value” is the item’s regular vendor price; “Avg kill value” = drop rate × sell value. ' +
    'Rates are a floor — corpse items you didn’t loot aren’t recorded.</div>';
}

function renderZone(name) {
  const mobs = Object.entries(DATA.mobs)
    .filter(([, d]) => d.zones && d.zones[name])
    .sort((a, b) => b[1].kills - a[1].kills);
  const items = DATA.items
    .filter((i) => (i.zones || []).includes(name) || (i.wiki && (i.wiki.wikiZones || []).includes(name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!mobs.length && !items.length) return notFound('zone', name);

  const mobTable = mobs.length
    ? '<h2>Mobs</h2><div class="card"><table><tbody>' +
      mobs.map(([m, d]) => '<tr><td>' + mobLink(m) + '</td><td class="num sample">' + d.kills + ' kills</td></tr>').join('') +
      '</tbody></table></div>'
    : '';
  const itemTable = items.length
    ? '<h2>Items found here</h2><div class="card"><table><tbody>' +
      items.map((i) => '<tr><td>' + itemLink(i.id, i.name) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '';

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › zone</div>' +
    '<h1>' + esc(name) + '</h1>' +
    '<p class="sub"><a href="' + wikiUrl(name) + '" target="_blank" rel="noopener">View on the wiki ↗</a></p>' +
    mobTable + itemTable;
}

function renderNode(name) {
  name = collapseNode(name); // canonicalise "Rich X" -> "X" (shared loot table)

  // Observed drop rates: the harvest cluster whose yields the wiki maps to this node
  // (matched on either the base or rich tier name).
  const hn = HARVEST_NODES.find((node) => node.yields.some((y) => {
    if (y.rate < 0.4) return false; // match on bulk anchors only, not rare gems shared between nodes
    const it = itemByName[y.res]; const from = (it && it.wiki && it.wiki.from) || [];
    return from.includes(name) || from.includes('Rich ' + name);
  }));
  if (!NODES[name] && !isNodeName(name) && !hn) return notFound('node', name);

  const richSibling = NODE_RICH.has(name) ? 'Rich ' + name : null;
  const topNote = '<div class="note">' +
    (richSibling ? '<b>' + esc(name) + '</b> and <b>' + esc(richSibling) + '</b> share the same loot table, so their drops are shown together. ' : '') +
    'These rates are built from harvests collected through the app, so the <a href="' + wikiUrl(name) + '" target="_blank" rel="noopener">wiki</a> may list items that haven’t been picked up yet. ' +
    'As more people use the app, the rare yields fill in and the numbers get more accurate.' +
    '</div>';

  // Unified drop table: every item the wiki says drops here, plus anything we've
  // observed — with the observed rate, or a blank "—" when we don't have data yet.
  const observedByRes = {};
  if (hn) hn.yields.forEach((y) => { observedByRes[y.res] = y; });
  const allRes = new Set([...(nodeDrops[name] || []), ...Object.keys(observedByRes)]);
  let body;
  if (allRes.size) {
    const rows = [...allRes].map((res) => { const o = observedByRes[res]; return { res, rate: o ? o.rate : null, count: o ? o.count : 0 }; })
      .sort((a, b) => (b.rate == null ? -1 : b.rate) - (a.rate == null ? -1 : a.rate) || a.res.localeCompare(b.res));
    const tbody = rows.map((r) => '<tr><td>' + (nameToId[r.res] ? itemLink(nameToId[r.res], r.res) : esc(r.res)) +
      '</td><td class="num">' + (r.rate == null ? '<span class="sample">—</span>' : harvestRateCell(r.rate, r.count, hn.pulls)) + '</td></tr>').join('');
    body = '<h2>Drops</h2><div class="card"><table><thead><tr><th>Yield</th><th class="num">Chance / harvest</th></tr></thead><tbody>' +
      tbody + '</tbody></table></div>' +
      (hn ? '<div class="note">Rates from ' + hn.pulls + ' observed harvest' + (hn.pulls === 1 ? '' : 's') +
        (hn.zones.length ? ' in ' + esc(hn.zones.slice(0, 3).join(', ')) : '') + '. A “—” means the wiki lists it but it hasn’t been collected through the app yet; rare yields fade when the sample is thin.</div>'
        : '<div class="note">The wiki lists these as possible drops — no harvest rates collected through the app yet, so they’re blank for now.</div>');
  } else {
    body = '<p class="muted">Nothing recorded for this node yet.</p>';
  }

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › node</div>' +
    '<h1>' + esc(name) + '</h1>' +
    topNote +
    body;
}

// Build a recipe table sorted by best margin first (unpriced recipes last).
function recipeTable(recs, showSkill) {
  const rows = recs.map((r) => ({ r, e: recipeEconomics(r) }))
    .sort((a, b) => (b.e.margin == null ? -Infinity : b.e.margin) - (a.e.margin == null ? -Infinity : a.e.margin));
  const head = '<th>Make</th><th>From</th>' + (showSkill ? '<th>Skill</th>' : '') +
    '<th class="num">Mats</th><th class="num">Output</th><th class="num">Margin</th>';
  return '<div class="card"><table><thead><tr>' + head + '</tr></thead><tbody>' +
    rows.map(({ r, e }) => {
      const rid = nameToId[r.result.item] || r.result.item;
      const from = r.components.map((c) => c.qty + '× ' + (nameToId[c.item] ? itemLink(nameToId[c.item], c.item) : esc(c.item))).join(', ');
      const mats = e.matCost > 0 ? coin(e.matCost) + (e.missing ? ' <span class="sample">+?</span>' : '') : (e.missing ? '<span class="sample">?</span>' : '—');
      const out = e.haveOutput ? coin(e.outValue) : '—';
      const margin = e.margin == null ? '<span class="sample">—</span>'
        : '<span class="' + (e.margin >= 0 ? 'pos' : 'neg') + '">' + (e.margin >= 0 ? '+' : '') + coin(e.margin) + '</span>';
      return '<tr><td>' + (r.result.qty > 1 ? r.result.qty + '× ' : '') + itemLink(rid, r.result.item) + '</td>' +
        '<td class="sample">' + from + '</td>' + (showSkill ? '<td>' + tradeskillLink(r.tradeskill) + '</td>' : '') +
        '<td class="num coin">' + mats + '</td><td class="num coin">' + out + '</td><td class="num">' + margin + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

const marginNote = '<div class="note">“Margin” = output value − materials value (best known player-trade or vendor price) — ' +
  'what crafting adds over selling the raw mats. “?” means a material has no price logged yet; fills in as data grows.</div>';

// Simple placeholder icon per creature, mapped from its name/race. Stand-in until
// real art; keeps the grid scannable.
function mobIcon(name, race) {
  const n = (name + ' ' + (race || '')).toLowerCase();
  const map = [
    [/bat/, '🦇'], [/wolf|\bpup\b|jackal|hound|\bdog\b/, '🐺'], [/skeleton|skull|\bbone/, '💀'],
    [/widow|spider/, '🕷️'], [/snake|serpent|rattlesnake|viper|cobra/, '🐍'], [/scarab|beetle/, '🪲'],
    [/wasp|hornet|\bdrone\b|\bbee\b/, '🐝'], [/\brat\b|rodent/, '🐀'], [/drake|dragon|wyrm/, '🐉'],
    [/croc|gator|lizard/, '🐊'], [/fawn|dryad|deer|stag/, '🦌'], [/crab/, '🦀'],
    [/\borc\b|fellstone|goblin|ogre|troll/, '👹'],
    [/ashira|\bfox\b|vulpine|kitsune/, '🦊'],
    [/bandit|warrior|scout|shaman|lookout|guard|\bhuman|\belf|humanoid/, '⚔️'],
    [/elemental/, '💧'], [/fire|flame|ember/, '🔥'],
  ];
  for (const [rx, ic] of map) if (rx.test(n)) return ic;
  return '🐾';
}

// A unique colour per creature name (FNV hash → hue) so same-type mobs still look
// distinct, plus a size factor from descriptors. Keeps the placeholder unique.
function hashHue(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; }
function creatureScale(name) {
  const n = name.toLowerCase();
  if (/\blarge\b|greater|\belder\b|\bgiant\b|\bdire\b|\bold\b/.test(n)) return 1.22;
  if (/hatchling|\bpup\b|\bsmall\b|spiderling|\bdrone\b|whelp|\byoung\b|worker/.test(n)) return 0.82;
  return 1;
}

// Illustrated bestiary — a card per mob with a simple type icon (real art can
// replace it later). Stats + value + the best drops at a glance.
function renderBestiary() {
  const mobs = Object.entries(DATA.mobs)
    .map(([name, d]) => ({ name, d, val: mobValuePerKill(d).total, corpses: mobCorpses(d) }))
    .filter((m) => m.corpses > 0)
    .sort((a, b) => b.val - a.val || b.corpses - a.corpses);
  if (!mobs.length) return notFound('bestiary', '');

  const card = ({ name, d, val, corpses }) => {
    const w = d.wiki || {};
    const lvl = mobLevel(d);
    const zone = Object.keys(d.zones || {})[0] || w.zone || '';
    const chips = [
      Number.isFinite(lvl) ? 'Lv ' + (w.level || lvl) : '',
      w.race || '', zone,
    ].filter(Boolean).map((c) => '<span class="bchip">' + esc(c) + '</span>').join('');
    const drops = Object.entries(d.drops)
      .map(([item, n]) => ({ item, rate: corpses ? n / corpses : 0, value: regularPrice(itemByName[item]) }))
      .sort((a, b) => b.value - a.value || b.rate - a.rate).slice(0, 3);
    const dropRows = drops.map((dr) => {
      const id = nameToId[dr.item] || dr.item;
      return '<div class="bdrop"><span class="bd-name">' + itemLink(id, dr.item) + '</span>' +
        '<span class="bd-rate">' + Math.round(dr.rate * 100) + '%</span>' +
        '<span class="bd-val coin">' + (dr.value > 0 ? coin(dr.value) : '—') + '</span></div>';
    }).join('');
    return '<div class="beast">' +
      '<div class="beast-art" style="background:radial-gradient(circle at 50% 36%, hsl(' + hashHue(name) + ' 42% 15%), #130f0a);border-bottom-color:hsl(' + hashHue(name) + ' 35% 26%)" title="' + esc(w.race || name) + '">' +
      '<span class="beast-emoji" style="font-size:' + Math.round(48 * creatureScale(name)) + 'px">' + mobIcon(name, w.race) + '</span></div>' +
      '<div class="beast-body"><div class="beast-name">' + mobLink(name) + '</div>' +
      '<div class="bchips">' + chips + '</div>' +
      '<div class="beast-stats"><span>Value/kill <b class="coin">' + coin(val) + '</b></span>' +
      '<span>Looted <b>' + corpses + '</b></span></div>' +
      (dropRows ? '<div class="bdrops">' + dropRows + '</div>' : '') +
      '</div></div>';
  };

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › bestiary</div>' +
    '<h1>Bestiary</h1>' +
    '<p class="sub">Every creature you\'ve fought, by value. Drops are value-sorted (priciest first). Artwork slots in later.</p>' +
    '<div class="beastgrid">' + mobs.map(card).join('') + '</div>';
}

function renderTradeskills() {
  const counts = {};
  const bump = (t, k) => { (counts[t] = counts[t] || { recipes: 0, items: 0 })[k]++; };
  RECIPES.forEach((r) => bump(r.tradeskill, 'recipes'));
  DATA.items.forEach((i) => (i.wiki && i.wiki.tradeskills || []).forEach((t) => bump(t, 'items')));
  const names = Object.keys(counts).sort();
  if (!names.length) return notFound('tradeskill', '');
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › tradeskills</div>' +
    '<h1>Tradeskills</h1>' +
    '<p class="sub">Crafting professions — recipes, ingredients, and profit margins.</p>' +
    '<div class="card"><table><thead><tr><th>Tradeskill</th><th class="num">Recipes</th><th class="num">Items</th></tr></thead><tbody>' +
    names.map((n) => '<tr><td>' + tradeskillLink(n) + '</td>' +
      '<td class="num sample">' + (counts[n].recipes || '—') + '</td>' +
      '<td class="num sample">' + (counts[n].items || '—') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

// ---- Vendors (from the wiki's Merchant pages) ----

function renderVendors() {
  if (!VENDORS.length) return notFound('vendors', '');
  const byZone = {};
  VENDORS.forEach((v) => { const z = v.zone || 'Unknown'; (byZone[z] = byZone[z] || []).push(v); });
  const zones = Object.keys(byZone).sort((a, b) => byZone[b].length - byZone[a].length || a.localeCompare(b));
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › vendors</div>' +
    '<h1>Vendors</h1>' +
    '<p class="sub">Merchants from the community wiki — what they sell and buy, grouped by zone.</p>' +
    zones.map((z) => '<h2>' + esc(z) + ' <span class="sample">(' + byZone[z].length + ')</span></h2>' +
      '<div class="card"><table><tbody>' +
      byZone[z].slice().sort((a, b) => a.name.localeCompare(b.name)).map((v) =>
        '<tr><td>' + vendorLink(v.name) + '</td>' +
        '<td class="sample">' + esc(v.desc || v.location || '') + '</td>' +
        '<td class="num sample">' + (v.sells.length ? v.sells.length + ' sold' : '') + '</td></tr>').join('') +
      '</tbody></table></div>').join('');
}

function renderVendor(name) {
  const v = VENDORS.find((x) => x.name === name);
  if (!v) return notFound('vendor', name);
  const meta = [v.race, v.desc].filter(Boolean).join(' · ');
  const sells = v.sells.map((n) => {
    const price = vendorSellPrice(n);
    return '<tr><td>' + (nameToId[n] ? itemLink(nameToId[n], n) : esc(n)) + '</td>' +
      '<td class="num">' + (price != null ? coin(price) : '—') + '</td></tr>';
  }).join('');
  const buys = (v.buys || []).map((b) => '<li>' + esc(b) + '</li>').join('');
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › <a href="#/vendors">vendors</a></div>' +
    '<h1>' + esc(v.name) + '</h1>' +
    '<p class="sub">' + (v.zone ? zoneLink(v.zone) : '') + (v.location ? ' · ' + esc(v.location) : '') + (meta ? ' · ' + esc(meta) : '') + '</p>' +
    (sells ? '<h2>Sells</h2><div class="card"><table><thead><tr><th>Item</th><th class="num">Vendor price</th></tr></thead><tbody>' + sells + '</tbody></table></div>' : '') +
    (buys ? '<h2>Buys</h2><div class="card"><ul class="vbuys">' + buys + '</ul></div>' : '') +
    '<p class="note">From the wiki’s <a href="' + wikiUrl(v.name) + '" target="_blank" rel="noopener">' + esc(v.name) + ' ↗</a> page.</p>';
}

// ---- Crafting-flow (Sankey-ish) — ingredients flow into finished goods ----
const METALS = ['Copper', 'Bronze', 'Tin', 'Iron', 'Steel', 'Silver', 'Gold', 'Platinum'];
const familyOf = (item) => METALS.find((m) => item.includes(m)) || 'Other';

let flowRecipes = [];
let flowDownstream = {}; // item -> Set of itself + everything it crafts into
let flowActive = null;   // currently-traced item (click to toggle)

// Click a node: highlight it + its derivatives, grey the rest. Click again resets.
function flowTrace(item) {
  const svg = document.querySelector('#craftflow svg');
  if (!svg) return;
  if (flowActive === item) {
    flowActive = null;
    svg.classList.remove('tracing');
    svg.querySelectorAll('.fnode, .flink').forEach((el) => el.classList.remove('on', 'off'));
    return;
  }
  flowActive = item;
  const set = flowDownstream[item] || new Set([item]);
  svg.classList.add('tracing');
  svg.querySelectorAll('.fnode').forEach((g) => { const on = set.has(g.dataset.item); g.classList.toggle('on', on); g.classList.toggle('off', !on); });
  svg.querySelectorAll('.flink').forEach((p) => { const on = set.has(p.dataset.from) && set.has(p.dataset.to); p.classList.toggle('on', on); p.classList.toggle('off', !on); });
}

function craftFamilies(recs) {
  const fams = METALS.filter((m) => recs.some((r) => familyOf(r.result.item) === m));
  if (recs.some((r) => familyOf(r.result.item) === 'Other')) fams.push('Other');
  return fams;
}

// Layered node-link diagram: depth = longest path from a raw ingredient. Ribbon
// width grows with the output's value, so you see where worth concentrates.
function craftFlowSvg(recipes) {
  if (!recipes.length) return '<p class="muted">No recipes for this material.</p>';
  const nodes = new Set(), edges = [];
  recipes.forEach((r) => { nodes.add(r.result.item); r.components.forEach((c) => { nodes.add(c.item); edges.push({ from: c.item, to: r.result.item, value: itemMarketValue(r.result.item).value }); }); });
  const incoming = {}; nodes.forEach((n) => (incoming[n] = []));
  edges.forEach((e) => incoming[e.to].push(e.from));
  const depth = {};
  const dep = (n, seen) => {
    if (depth[n] != null) return depth[n];
    if (seen.has(n)) return 0;
    seen.add(n);
    const ins = incoming[n];
    depth[n] = ins.length ? 1 + Math.max.apply(null, ins.map((p) => dep(p, seen))) : 0;
    seen.delete(n);
    return depth[n];
  };
  [...nodes].forEach((n) => dep(n, new Set()));
  const maxD = Math.max(0, ...Object.values(depth));
  const cols = Array.from({ length: maxD + 1 }, () => []);
  [...nodes].sort().forEach((n) => cols[depth[n]].push(n));

  // Downstream set per node (itself + everything it crafts into, transitively),
  // for the click-to-trace highlight.
  const adj = {}; nodes.forEach((n) => (adj[n] = []));
  edges.forEach((e) => adj[e.from].push(e.to));
  flowDownstream = {};
  [...nodes].forEach((start) => {
    const seen = new Set([start]), stack = [start];
    while (stack.length) { const x = stack.pop(); (adj[x] || []).forEach((y) => { if (!seen.has(y)) { seen.add(y); stack.push(y); } }); }
    flowDownstream[start] = seen;
  });

  const NW = 152, NH = 26, VGAP = 12, COLGAP = 232, PADX = 8, PADY = 14;
  const pos = {}; let maxRows = 0;
  cols.forEach((col, ci) => { col.forEach((n, ri) => { pos[n] = { x: PADX + ci * COLGAP, y: PADY + ri * (NH + VGAP) }; }); maxRows = Math.max(maxRows, col.length); });
  const W = PADX * 2 + maxD * COLGAP + NW, H = PADY * 2 + maxRows * (NH + VGAP);
  const maxVal = Math.max(1, ...edges.map((e) => e.value));

  const links = edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, dx = (x2 - x1) / 2;
    const wpx = 2 + Math.round((e.value / maxVal) * 8);
    return '<path class="flink" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '" d="M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ',' + (x2 - dx) + ' ' + y2 + ',' + x2 + ' ' + y2 + '" fill="none" stroke="#f0922b" stroke-opacity="0.3" stroke-width="' + wpx + '"/>';
  }).join('');
  const boxes = [...nodes].map((n) => {
    const p = pos[n], isSrc = depth[n] === 0, isFin = depth[n] === maxD;
    const stroke = isSrc ? '#6f9a4a' : isFin ? '#f0922b' : '#4a3320';
    const short = n.length > 23 ? n.slice(0, 22) + '…' : n;
    return '<g class="fnode" data-item="' + esc(n) + '">' +
      '<rect x="' + p.x + '" y="' + p.y + '" width="' + NW + '" height="' + NH + '" rx="5" fill="#2c1e14" stroke="' + stroke + '"/>' +
      '<text x="' + (p.x + 8) + '" y="' + (p.y + NH / 2 + 4) + '" font-size="11" fill="#ece0d2">' + esc(short) + '</text></g>';
  }).join('');
  return '<div class="flow-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + links + boxes + '</svg></div>';
}

window.flowPick = (fam) => {
  document.querySelectorAll('.flow-pick').forEach((b) => b.classList.toggle('active', b.dataset.fam === fam));
  const el = $('craftflow');
  if (!el) return;
  flowActive = null;
  el.innerHTML = craftFlowSvg(flowRecipes.filter((r) => familyOf(r.result.item) === fam));
  el.onclick = (e) => {
    const node = e.target.closest('.fnode');
    if (node) flowTrace(node.dataset.item);
    else if (flowActive) flowTrace(flowActive); // click empty space to reset
  };
};

function renderTradeskill(name) {
  const items = DATA.items
    .filter((i) => i.wiki && (i.wiki.tradeskills || []).includes(name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const recs = RECIPES.filter((r) => r.tradeskill === name);
  if (!items.length && !recs.length) return notFound('tradeskill', name);

  flowRecipes = recs;
  const fams = craftFamilies(recs);
  const flowSection = recs.length && fams.length
    ? '<h2>Crafting flow</h2><p class="sub">Ingredients (left) flow into finished goods (right). Pick a material; thicker links = higher output value. Click a box to trace what it crafts into (the rest greys out); click it again or the background to reset.</p>' +
      '<div class="flow-tabs">' + fams.map((f, i) => '<button class="flow-pick' + (i === 0 ? ' active' : '') + '" data-fam="' + esc(f) + '" onclick="flowPick(\'' + esc(f) + '\')">' + esc(f) + '</button>').join('') + '</div>' +
      '<div id="craftflow"></div>'
    : '';

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › tradeskill</div>' +
    '<h1>' + esc(name) + '</h1>' +
    '<p class="sub"><a href="' + wikiUrl(name) + '" target="_blank" rel="noopener">View on the wiki ↗</a></p>' +
    (recs.length ? '<h2>Recipes &amp; profit</h2>' + recipeTable(recs, false) + marginNote : '') +
    flowSection +
    (items.length
      ? '<h2>Items used in ' + esc(name) + '</h2><div class="card"><table><tbody>' +
        items.map((i) => '<tr><td>' + itemLink(i.id, i.name) + '</td></tr>').join('') + '</tbody></table></div>'
      : '');
  if (fams.length) flowPick(fams[0]);
}

function notFound(kind, id) {
  $('content').innerHTML = '<div class="crumb"><a href="#/">MnMdb</a></div><h1>Not found</h1>' +
    '<p class="muted">No ' + esc(kind) + ' matching “' + esc(id) + '”.</p>';
}

// ---- Search ----

function renderSearch(q) {
  const query = q.toLowerCase();
  // Resources are now first-class items, so a single item search covers them
  const items = DATA.items.filter((i) => i.name.toLowerCase().includes(query)).slice(0, 50)
    .map((i) => {
      const bits = [];
      if (i.droppedBy.length) bits.push(i.droppedBy.length + ' source(s)');
      if (i.harvested) bits.push('harvested');
      if (i.prices.length) bits.push('vendor');
      const isResource = i.harvested && !i.droppedBy.length;
      return { kind: isResource ? 'harvest' : 'item', name: i.name, id: i.id, meta: bits.join(' · ') };
    });
  const mobs = Object.entries(DATA.mobs).filter(([m]) => m.toLowerCase().includes(query)).slice(0, 20)
    .map(([m, d]) => ({ kind: 'mob', name: m, meta: mobCorpses(d) + ' looted' }));

  const all = [...mobs, ...items];
  if (!all.length) {
    $('content').innerHTML = '<h1>No matches</h1><p class="muted">Nothing found for “' + esc(q) + '”.</p>';
    return;
  }
  $('content').innerHTML = '<h2>' + all.length + ' result' + (all.length === 1 ? '' : 's') + '</h2><div class="results">' +
    all.map((r) => {
      const href = r.kind === 'mob' ? '#/mob/' + encodeURIComponent(r.name)
        : '#/item/' + encodeURIComponent(r.id);
      const label = r.kind === 'harvest' ? 'resource' : r.kind;
      const inner = '<span class="kind ' + r.kind + '">' + label + '</span><span class="name">' + esc(r.name) +
        '</span><span class="meta">' + esc(r.meta) + '</span>';
      return '<a class="result" href="' + href + '">' + inner + '</a>';
    }).join('') + '</div>';
}

// ---- Browse tables (sortable) ----

const browse = { view: null, key: 'name', dir: 1 };

const browseCols = {
  items: [
    { key: 'name', label: 'Item' },
    { key: 'best', label: 'Drop Rate', num: true, render: (v) => (v ? Math.round(v * 100) + '%' : '—') },
    { key: 'vendor', label: 'Vendor Value', num: true, render: (v) => (v == null ? '—' : coin(v)) },
    { key: 'shady', label: 'Shady Value', num: true, render: (v) => (v == null ? '—' : coin(v)) },
    { key: 'sources', label: 'Sources', num: true },
    { key: 'harvested', label: 'Harvested', num: true, render: (v) => v || '—' },
  ],
  gathering: [
    { key: 'name', label: 'Resource' },
    { key: 'harvested', label: 'Harvested', num: true },
    { key: 'zones', label: 'Gathered in', render: (v) => v || '—' },
    { key: 'vendor', label: 'Vendor Value', num: true, render: (v) => (v == null ? '—' : coin(v)) },
  ],
  mobs: [
    { key: 'name', label: 'Mob' },
    { key: 'valuekill', label: 'Value/kill', num: true, render: (v) => coin(v) },
    { key: 'coinkill', label: 'Coin/kill', num: true, render: (v) => coin(v) },
    { key: 'corpses', label: 'Corpses', num: true },
    { key: 'drops', label: 'Drops', num: true },
  ],
};

function browseRows(view) {
  if (view === 'mobs') {
    return Object.entries(DATA.mobs).map(([name, d]) => {
      const v = mobValuePerKill(d);
      return {
        _href: '#/mob/' + encodeURIComponent(name), name, corpses: mobCorpses(d),
        drops: Object.keys(d.drops).length, coinkill: v.coin, valuekill: v.total,
      };
    });
  }
  const items = view === 'gathering' ? DATA.items.filter((i) => i.harvested > 0) : DATA.items;
  return items.map((i) => {
    const prices = i.prices.map((p) => p.copper);
    const max = prices.length ? Math.max.apply(null, prices) : null;
    const min = prices.length ? Math.min.apply(null, prices) : null;
    return {
      _href: '#/item/' + encodeURIComponent(i.id),
      name: i.name,
      sources: i.droppedBy.length,
      best: i.droppedBy.reduce((m, d) => Math.max(m, d.rate || 0), 0),
      vendor: max,                       // regular vendor = best (highest) sell
      shady: min != null && min < max ? min : null, // only if a genuinely lower price was seen
      harvested: i.harvested || 0,
      zones: (i.zones || []).join(', '),
    };
  });
}

// A harvest-rate cell — bar + chance, faded when the yield count is a thin sample.
function harvestRateCell(rate, count, pulls) {
  const w = Math.min(100, Math.round(rate * 100));
  const rough = count < 5;
  return '<span class="rate' + (rough ? ' rough' : '') + '"' + (rough ? ' title="' + count + ' seen — rough estimate"' : '') + '>' +
    '<span class="bar"><span class="fill" style="width:' + w + '%"></span></span>' +
    '<span class="pct">' + (rate * 100).toFixed(rate < 0.1 ? 2 : 0) + '%' + (rough ? ' ~' : '') + '</span></span> ' +
    '<span class="sample">' + count + '/' + pulls + '</span>';
}

// Gathering nodes — a compact, clickable index; full drop tables live on each
// node's page. Each observed harvest cluster is labelled with the wiki node(s) it
// maps to (Copper Vein / Rich Copper Vein, etc.).
function harvestNodesSection() {
  if (!HARVEST_NODES.length) return '';
  const rows = HARVEST_NODES.map((n) => {
    const top = n.yields[0];
    const it = top && itemByName[top.res];
    const wikiNodes = [...new Set(((it && it.wiki && it.wiki.from) || []).filter((f) => NODES[f] || isNodeName(f)).map(collapseNode))];
    const label = wikiNodes.length ? wikiNodes.map(nodeLink).join(' / ') : esc(n.name);
    const rares = n.yields.filter((y) => y.rate < 0.4).length;
    return '<tr><td>' + label + '</td>' +
      '<td class="num sample">' + n.pulls + ' harvests</td>' +
      '<td class="sample">' + (rares ? rares + ' rare yield' + (rares === 1 ? '' : 's') : '—') + '</td>' +
      '<td class="sample">' + esc(n.zones.slice(0, 3).join(', ')) + '</td></tr>';
  }).join('');
  return '<h2>Gathering nodes</h2><p class="sub">Click a node for its full drop table (observed yield rates per harvest).</p>' +
    '<div class="card"><table><thead><tr><th>Node</th><th class="num">Worked</th><th>Rare yields</th><th>Zones</th></tr></thead><tbody>' +
    rows + '</tbody></table></div>';
}

function renderBrowse(view) {
  // On entering a view, default-sort sensibly (mobs by value/kill, others by name)
  if (browse.view !== view) {
    browse.view = view;
    browse.key = view === 'mobs' ? 'valuekill' : 'name';
    browse.dir = view === 'mobs' ? -1 : 1;
  }
  const cols = browseCols[view];
  const rows = browseRows(view);
  rows.sort((a, b) => {
    let x = a[browse.key], y = b[browse.key];
    if (typeof x === 'string') return browse.dir * x.localeCompare(y);
    x = x == null ? -1 : x; y = y == null ? -1 : y;
    return browse.dir * (x - y);
  });
  const head = cols.map((c) => {
    const arrow = browse.key === c.key ? (browse.dir > 0 ? ' ▲' : ' ▼') : '';
    return '<th class="' + (c.num ? 'num ' : '') + 'sortable" onclick="setSort(\'' + c.key + '\')">' + c.label + arrow + '</th>';
  }).join('');
  const body = rows.map((r) =>
    '<tr class="rowlink" onclick="location.hash=\'' + r._href.slice(1) + '\'">' +
    cols.map((c) => {
      const v = r[c.key];
      const disp = c.key === 'name' ? '<a href="' + r._href + '">' + esc(v) + '</a>'
        : c.render ? c.render(v) : esc(String(v));
      return '<td class="' + (c.num ? 'num' : '') + '">' + disp + '</td>';
    }).join('') + '</tr>').join('');
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › ' + view + '</div>' +
    '<h1 style="text-transform:capitalize">' + view + ' <span class="sub" style="font-size:15px">' + rows.length + '</span></h1>' +
    (view === 'gathering' ? harvestNodesSection() : '') +
    '<h2 style="text-transform:capitalize">' + (view === 'gathering' ? 'All resources' : view) + '</h2>' +
    '<p class="sub">Click a column heading to sort. Click a row to open it.</p>' +
    '<div class="card"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

window.setSort = (key) => {
  if (browse.key === key) browse.dir *= -1;
  else { browse.key = key; browse.dir = key === 'name' ? 1 : -1; }
  renderBrowse(browse.view);
};

// ---- Read-only map viewer ----

function renderMapsList() {
  const zones = (MAPS.zones || []).slice();
  if (!zones.length) {
    return $('content').innerHTML = '<div class="crumb"><a href="#/">MnMdb</a> › maps</div><h1>Zone maps</h1>' +
      '<p class="muted">No maps published yet.</p>';
  }
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › maps</div>' +
    '<h1>Zone maps</h1>' +
    '<p class="sub">Curated maps with marked resource nodes, camps and points of interest. View-only.</p>' +
    '<div class="mapgrid">' + zones.map((z) => z.comingSoon
      ? '<a class="mapcard soon" href="#/map/' + encodeURIComponent(z.name) + '">' +
        '<span class="mapthumb"><span class="soon-tag">Map coming soon</span></span>' +
        '<span class="mapname">' + esc(z.name) + '</span></a>'
      : '<a class="mapcard" href="#/map/' + encodeURIComponent(z.name) + '">' +
        '<span class="mapthumb"><img src="maps/' + encodeURIComponent(z.image) + '" alt="" loading="lazy" /></span>' +
        '<span class="mapname">' + esc(z.name) +
        (z.markers.length ? ' <span class="sample">' + z.markers.length + ' marks</span>' : '') + '</span></a>'
    ).join('') + '</div>';
}

let pendingMap = null;
let mapLightSrc = '';   // current map image, for the click-to-enlarge lightbox

// Marker HTML positioned by percentage of the image's natural size (works at any
// display size — inline map or lightbox).
function markerLayerHTML(markers, nw, nh) {
  return markers.map((m) =>
    '<span class="mk" style="left:' + (m.x / nw * 100) + '%;top:' + (m.y / nh * 100) + '%;--mc:' + m.color + '" ' +
    'title="' + esc(m.label + (m.notes ? ' — ' + m.notes : '')) + '">' +
    '<span class="mk-ic">' + m.icon + '</span>' +
    (m.label ? '<span class="mk-lbl">' + esc(m.label) + '</span>' : '') + '</span>'
  ).join('');
}

// Full-size map overlay with zoom + pan. Scroll or +/− to zoom, drag to pan.
// Close with ✕, a backdrop click, or Esc.
function openMapLightbox() {
  if (!mapLightSrc || document.querySelector('.lightbox')) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML =
    '<button class="lb-close" aria-label="Close">✕</button>' +
    '<div class="lb-zoom"><button data-z="out" aria-label="Zoom out">−</button>' +
    '<button data-z="reset" aria-label="Reset">⤢</button>' +
    '<button data-z="in" aria-label="Zoom in">+</button></div>' +
    '<div class="lb-inner"><img src="' + mapLightSrc + '" alt="" /><div class="lb-layer"></div></div>';
  document.body.appendChild(lb);
  const inner = lb.querySelector('.lb-inner'), img = lb.querySelector('img'), layer = lb.querySelector('.lb-layer');

  let scale = 1, tx = 0, ty = 0;
  const apply = () => {
    inner.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    inner.classList.toggle('zoomed', scale > 1);
  };
  const zoom = (f) => { scale = Math.max(1, Math.min(8, scale * f)); if (scale === 1) { tx = 0; ty = 0; } apply(); };
  const place = () => { layer.innerHTML = markerLayerHTML(pendingMap || [], img.naturalWidth || 1, img.naturalHeight || 1); };
  img.complete && img.naturalWidth ? place() : img.addEventListener('load', place);

  lb.querySelector('[data-z=in]').onclick = (e) => { e.stopPropagation(); zoom(1.4); };
  lb.querySelector('[data-z=out]').onclick = (e) => { e.stopPropagation(); zoom(1 / 1.4); };
  lb.querySelector('[data-z=reset]').onclick = (e) => { e.stopPropagation(); scale = 1; tx = 0; ty = 0; apply(); };
  lb.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18); }, { passive: false });

  let dragging = false, moved = false, sx = 0, sy = 0;
  inner.addEventListener('mousedown', (e) => { if (scale <= 1) return; dragging = true; moved = false; sx = e.clientX - tx; sy = e.clientY - ty; e.preventDefault(); });
  const onMove = (e) => { if (!dragging) return; moved = true; tx = e.clientX - sx; ty = e.clientY - sy; apply(); };
  const onUp = () => { dragging = false; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === '+' || e.key === '=') zoom(1.4); else if (e.key === '-') zoom(1 / 1.4); };
  document.addEventListener('keydown', onKey);
  lb.addEventListener('click', (e) => {
    if (e.target.closest('.lb-close')) return close();
    if (e.target.closest('.lb-inner') || e.target.closest('.lb-zoom')) return; // map/controls
    if (!moved) close(); // backdrop
  });
}

function renderMapView(name) {
  const z = (MAPS.zones || []).find((x) => x.name === name);
  if (!z) return notFound('map', name);
  if (z.comingSoon) {
    return $('content').innerHTML =
      '<div class="crumb"><a href="#/">MnMdb</a> › <a href="#/maps">maps</a> › ' + esc(name) + '</div>' +
      '<h1>' + esc(name) + '</h1>' +
      '<div class="mapsoon"><span class="soon-tag big">Map coming soon</span>' +
      '<p class="sub">No map for this zone has been curated yet — check back later.</p></div>';
  }
  const catById = {};
  (MAPS.categories || []).forEach((c) => { catById[c.id] = c; });
  const fallback = { name: 'Other', color: '#b0bec5', icon: '📍' };

  const usedCats = [...new Set(z.markers.map((m) => m.category))];
  const legend = usedCats.map((id) => {
    const c = catById[id] || fallback;
    return '<span class="mlg"><span class="mdot" style="background:' + c.color + '"></span>' + esc(c.name) + '</span>';
  }).join('');

  pendingMap = z.markers.map((m) => {
    const c = catById[m.category] || fallback;
    return { x: m.x, y: m.y, label: m.label, notes: m.notes, color: c.color, icon: c.icon };
  });

  mapLightSrc = 'maps/' + encodeURIComponent(z.image);
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › <a href="#/maps">maps</a> › ' + esc(name) + '</div>' +
    '<h1>' + esc(name) + '</h1>' +
    (legend ? '<div class="mlegend">' + legend + '</div>' : '<p class="sub">No markers on this map yet.</p>') +
    '<div class="mapview" title="Click to enlarge"><img id="mapimg" src="' + mapLightSrc + '" alt="' + esc(name) + ' map" />' +
    '<div id="maplayer"></div></div>' +
    '<p class="sub">Click the map to view it full size.</p>';
  wireMapView();
}

// Markers are stored in image-pixel coords; place them as percentages once the
// image's natural size is known, so they track the responsive image.
function wireMapView() {
  const markers = pendingMap || [];
  const img = document.getElementById('mapimg');
  const layer = document.getElementById('maplayer');
  if (!img || !layer) return;
  const place = () => { layer.innerHTML = markerLayerHTML(markers, img.naturalWidth || 1, img.naturalHeight || 1); };
  if (img.complete && img.naturalWidth) place();
  else img.addEventListener('load', place);
  const box = img.closest('.mapview');
  if (box) box.addEventListener('click', openMapLightbox);
}

// ---- Router ----

// ---- Feedback — opens a pre-filled GitHub issue for the page you're on ----
const FEEDBACK_REPO = 'Boisteroux/mnm-tools';
function openFeedback() {
  const h1 = document.querySelector('#content h1');
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')) || 'home';
  const label = h1 ? h1.textContent.trim() : (h || 'Home');
  const body =
    '**Page:** ' + label + '\n' +
    '**Link:** ' + location.href + '\n\n' +
    "**What's off?** (e.g. wrong vendor price, bad drop rate, missing item, a typo)\n\n\n" +
    '---\n_Sent from the MnMdb “Give feedback” button._';
  const url = 'https://github.com/' + FEEDBACK_REPO + '/issues/new?labels=feedback' +
    '&title=' + encodeURIComponent('Feedback: ' + label) +
    '&body=' + encodeURIComponent(body);
  window.open(url, '_blank', 'noopener');
}
document.addEventListener('click', (e) => {
  const fb = e.target.closest('.feedback-link');
  if (fb) { e.preventDefault(); openFeedback(); }
});

function route() {
  const q = $('search').value.trim();
  if (q) return renderSearch(q);
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h === 'items' || h === 'mobs' || h === 'gathering') return renderBrowse(h);
  if (h === 'tradeskills') return renderTradeskills();
  if (h === 'vendors') return renderVendors();
  if (h === 'bestiary') return renderBestiary();
  if (h === 'maps') return renderMapsList();
  if (h.startsWith('vendor/')) return renderVendor(h.slice(7));
  if (h.startsWith('map/')) return renderMapView(h.slice(4));
  if (h.startsWith('item/')) return renderItem(h.slice(5));
  if (h.startsWith('mob/')) return renderMob(h.slice(4));
  if (h.startsWith('zone/')) return renderZone(h.slice(5));
  if (h.startsWith('node/')) return renderNode(h.slice(5));
  if (h.startsWith('tradeskill/')) return renderTradeskill(h.slice(11));
  renderHome();
}

// ---- Init ----

async function loadWikiStats() {
  // Optional — merged in if present; never fatal if missing
  try {
    const w = await (await fetch('./wiki.json?v=' + Date.now())).json();
    if (w && w.items) {
      DATA.items.forEach((i) => { if (w.items[i.name]) i.wiki = w.items[i.name]; });
      // Add wiki-only items (e.g. gems you've never looted) so they get pages too
      const have = new Set(DATA.items.map((i) => i.name));
      for (const [name, wd] of Object.entries(w.items)) {
        if (!have.has(name)) {
          DATA.items.push({ id: wd.linkId || slugify(name), name, droppedBy: [], prices: [], harvested: 0, zones: [], wiki: wd });
        }
      }
    }
    if (w && w.mobs) Object.keys(DATA.mobs).forEach((m) => { if (w.mobs[m]) DATA.mobs[m].wiki = w.mobs[m]; });
    if (w && w.nodes) NODES = w.nodes;
    if (w && w.recipes) {
      RECIPES = w.recipes;
      RECIPES.forEach((r) => { const k = r.result.item.toLowerCase(); (recipesByResult[k] = recipesByResult[k] || []).push(r); });
    }
  } catch {}
  try {
    const v = await (await fetch('./vendors.json?v=' + Date.now())).json();
    VENDORS = (v && v.vendors) || [];
    vendorsSelling = {};
    VENDORS.forEach((vn) => (vn.sells || []).forEach((n) => { (vendorsSelling[n] = vendorsSelling[n] || []).push(vn); }));
  } catch {}
  try {
    const t = await (await fetch('./trades.json?v=' + Date.now())).json();
    TRADES = {};
    for (const e of (t && t.trades) || []) {
      const k = String(e.item).toLowerCase();
      (TRADES[k] = TRADES[k] || []).push({ item: e.item, price: e.price, side: e.side === 'buy' ? 'buy' : 'sell', date: e.date });
    }
  } catch {}
  try {
    MAPS = await (await fetch('./maps.json?v=' + Date.now())).json();
  } catch {}
}

fetch('./data.json?v=' + Date.now())
  .then((r) => r.json())
  .then(async (d) => {
    DATA = d;
    await loadWikiStats();
    DATA.items.forEach((i) => { nameToId[i.name] = i.id; itemByName[i.name] = i; });
    HARVEST_NODES = DATA.harvestNodes || [];
    resNodes = {};
    HARVEST_NODES.forEach((node) => node.yields.forEach((y) => {
      (resNodes[y.res] = resNodes[y.res] || []).push({ node: node.name, pulls: node.pulls, count: y.count, rate: y.rate });
    }));
    NODE_RICH = new Set();
    nodeDrops = {};
    DATA.items.forEach((i) => ((i.wiki && i.wiki.from) || []).forEach((f) => {
      const m = /^Rich\s+(.+)/i.exec(f); if (m) NODE_RICH.add(m[1]);
      if (NODES[f] || isNodeName(f)) { const k = collapseNode(f); (nodeDrops[k] = nodeDrops[k] || new Set()).add(i.name); }
    }));
    // Which wiki node(s) each harvest cluster represents — by its BULK anchors only
    // (rate ≥ 40%), so a rare gem shared between veins doesn't mis-map the cluster.
    harvestWikiNodes = {};
    HARVEST_NODES.forEach((node) => {
      const set = new Set();
      node.yields.filter((y) => y.rate >= 0.4).forEach((y) => {
        const it = itemByName[y.res];
        ((it && it.wiki && it.wiki.from) || []).forEach((f) => { if (NODES[f] || isNodeName(f)) set.add(collapseNode(f)); });
      });
      harvestWikiNodes[node.name] = set;
    });
    const when = d.generatedAt ? new Date(d.generatedAt).toLocaleDateString() : '';
    $('data-meta').textContent = (d.events || 0).toLocaleString() + ' events · ' +
      DATA.items.length + ' items · updated ' + when;
    window.addEventListener('hashchange', () => {
      // Clicking a result navigates (changes the hash) — clear the search so the
      // page shows instead of the search results staying stuck over it.
      $('search').value = '';
      $('search').blur();
      route();
    });
    $('search').addEventListener('input', () => {
      // typing searches; clearing returns to the current hash view
      route();
    });
    route();
  })
  .catch((e) => {
    $('content').innerHTML = '<h1>Could not load data</h1><p class="muted">' + esc(e.message) + '</p>';
  });
