// ---------------------------------------------------------------
// mnmdb — static front-end for the Monsters & Memories drop/vendor
// dataset produced by the mnm-tools collector. Vanilla JS, no build.
// ---------------------------------------------------------------

let DATA = null;
let nameToId = {};   // item name -> item id (for linking mob drops to item pages)
let itemByName = {}; // item name -> full item record (for vendor-price lookups)
let NODES = {};      // gathering nodes (Copper Vein, …) from the wiki
let DROP_LEVELS = {}; // lowercase mob name -> wiki level, for every item dropper (mob-levels-wiki.json)
let VENDORS = [];    // wiki Merchant pages: { name, zone, sells[], buys[] } (vendors.json)
let vendorsSelling = {}; // item name -> [vendor] that stock it (inverted from sells)
let HARVEST_NODES = []; // node-type yield rates from clustered harvests (data.json)
let RECIPE_OBS = null;  // recipe-observations.json — trivials reverse-engineered in-game
let resNodes = {};      // resource name -> [{ node, pulls, count, rate }]
let NODE_RICH = new Set(); // node base-names that have a "Rich" tier (for the node note)
let nodeDrops = {};        // collapsed node name -> Set of items the wiki says drop there
let harvestWikiNodes = {}; // harvest-cluster name -> Set of wiki node names it represents
let TRADES = {};     // item name (lowercased) -> [{price, side, date}] player trade prices
let RECIPES = [];    // crafting recipes from the wiki tradeskill pages
let recipesByResult = {}; // item name (lowercased) -> [recipe] that produce it
let MAPS = { zones: [], categories: [] }; // curated zone maps for the read-only viewer

// Community-submitted markers, from the mnmdb submission API (api/ — a Cloudflare
// Worker + D1). Loaded lazily on the first map view and grouped by zone. The API only
// ever serves APPROVED markers, so nothing pending leaks onto the map.
const API_BASE = 'https://mnmdb-api.boisteroux.workers.dev';
// Cloudflare Turnstile site key (public — it lives in the page HTML, safe to commit).
// The matching secret is set on the Worker as TURNSTILE_SECRET, which verifies the token.
const TURNSTILE_SITE_KEY = '0x4AAAAAADsBgp1uszsr9gUW';

// ---- Login session (the Discord OAuth callback redirects to mnm-db.com/?login=<token>) ----
let SESSION = null;
(function initSession() {
  try {
    const q = new URLSearchParams(location.search);
    const incoming = q.get('login');
    if (incoming) localStorage.setItem('mnmdb-session', incoming);
    if (incoming || q.get('login_error')) history.replaceState({}, '', location.pathname + location.hash);
  } catch {}
  let saved; try { saved = localStorage.getItem('mnmdb-session'); } catch {}
  if (!saved) return;
  try {
    const bin = atob(saved.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (p.exp && p.exp > Date.now()) {
      SESSION = { token: saved, id: String(p.id), name: String(p.name || ''), admin: false, trusted: false };
      // hydrate cached powers so admin tools show without a flash; refreshMe() confirms them
      try { const m = JSON.parse(localStorage.getItem('mnmdb-me') || 'null'); if (m && m.id === SESSION.id) { SESSION.admin = !!m.admin; SESSION.trusted = !!m.trusted; } } catch {}
    } else localStorage.removeItem('mnmdb-session');
  } catch { try { localStorage.removeItem('mnmdb-session'); } catch {} }
})();
function signOut() { try { localStorage.removeItem('mnmdb-session'); localStorage.removeItem('mnmdb-me'); } catch {} SESSION = null; }
// Ask the API what this session can do (admin / trusted), cache it, and re-render if it
// changed from the cached guess — so a Discord admin's tools appear on their own browser.
async function refreshMe() {
  if (!SESSION) return;
  try {
    const r = await fetch(API_BASE + '/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: SESSION.token }) });
    if (r.status === 401) { signOut(); route(); return; }
    if (!r.ok) return;
    const me = await r.json();
    const before = SESSION.admin;
    SESSION.admin = !!me.admin; SESSION.trusted = !!me.trusted;
    try { localStorage.setItem('mnmdb-me', JSON.stringify({ id: SESSION.id, admin: SESSION.admin, trusted: SESSION.trusted })); } catch {}
    if (SESSION.admin !== before) route();
  } catch {}
}
// The identity block in the Add-a-Marker modal: signed-in users see their verified name
// (no free-text name, no bot check); everyone else gets the optional name + a sign-in button.
function identityBlock() {
  if (SESSION) {
    return '<div class="sp-row sp-identity"><span>Signed in as <b>' + esc(SESSION.name) + '</b></span>' +
      '<button type="button" id="sp-signout" class="linklike">sign out</button></div>';
  }
  return '<div class="sp-row"><label for="sp-name">Your name <span class="muted">(optional — for credit)</span></label><input id="sp-name" maxlength="40" /></div>' +
    '<div class="sp-signin"><button type="button" id="sp-discord" class="btn-discord">Sign in with Discord</button>' +
    '<span class="muted">verifies your name · skips the bot check</span></div>';
}
let COMMUNITY = null;
async function loadCommunity() {
  if (COMMUNITY) return COMMUNITY;
  COMMUNITY = {};
  try {
    const j = await (await fetch(API_BASE + '/markers?t=' + Date.now())).json();
    for (const m of (j.markers || [])) (COMMUNITY[m.zone] = COMMUNITY[m.zone] || []).push(m);
  } catch {}
  return COMMUNITY;
}
// Approved community maps, grouped by zone. Each: { id (string), label, submitter, src }.
let ZONEMAPS = null;
async function loadMaps() {
  if (ZONEMAPS) return ZONEMAPS;
  ZONEMAPS = {};
  try {
    const j = await (await fetch(API_BASE + '/maps?t=' + Date.now())).json();
    for (const m of (j.maps || [])) {
      (ZONEMAPS[m.zone] = ZONEMAPS[m.zone] || []).push({ id: String(m.id), label: m.label || 'Community map', submitter: m.submitter, src: API_BASE + m.url });
    }
  } catch {}
  return ZONEMAPS;
}
// Downscale (to maxSide) + re-encode a submitted map to WebP in the browser, so every
// community map is compressed BEFORE it's stored (the Cloudflare edge can't run an image
// library). Returns { blob, width, height, ext } or null if the browser can't do it.
async function compressMapImage(file, maxSide, quality) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = url; });
    const long = Math.max(img.naturalWidth, img.naturalHeight) || 1;
    const scale = long > maxSide ? maxSide / long : 1;
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', quality));
    if (!blob) return null;
    return { blob, width: w, height: h, ext: blob.type === 'image/webp' ? 'webp' : 'png' };
  } catch { return null; }
}
let QUESTS = []; // dev quests for the Database Quest Board (quests.json)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Escape text, then turn any bare http(s) URLs in it into clickable links.
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
// Cache-buster for curated map images: keyed to the maps' publish time, so browsers
// re-fetch a map only when it's actually republished (same filename, changed contents).
const mapVer = () => (typeof MAPS !== 'undefined' && MAPS && MAPS.generatedAt ? '?v=' + String(MAPS.generatedAt).replace(/\D/g, '').slice(0, 14) : '');

function coin(c) {
  c = Math.round(c);
  if (c < 0) return '-' + coin(-c); // render a minus so negatives don't rely on colour alone
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
// Ore-node tiers, derived from the marker's label ("Copper", "Rich Copper Vein",
// "Copper Ore 3" …) — the label IS the tier data, so classifying a node is just
// naming it, and nothing changes in the app, the export, or the API. Rares
// (Silver / Gold / Platinum) spawn at regular-tier spots, so they stay in the
// neutral ore style until the spot itself is named for its main tier.
const ORE_TIERS = [
  { id: 'copper',    name: 'Copper',    color: '#b25f2e', re: /\bcopper\b/i },
  { id: 'limestone', name: 'Limestone', color: '#cbb05f', re: /\blimestone\b/i },
  { id: 'tin',       name: 'Tin',       color: '#97a1ad', re: /\btin\b/i },
  { id: 'iron',      name: 'Iron',      color: '#4e5d6c', re: /\biron\b/i },
  { id: 'coal',      name: 'Coal',      color: '#29261f', re: /\bcoal\b/i },
];
// Zones whose ore spawns are all one tier — unlabeled ore inherits the zone's
// default, so classifying a whole zone is one line here; a tier named in a
// marker's label still wins, for the odd exception.
const ZONE_ORE_DEFAULT = {
  'Evershade Weald': 'copper',
};
const oreTier = (m) => {
  if (!m || m.category !== 'ore') return null;
  const byLabel = m.label ? ORE_TIERS.find((t) => t.re.test(m.label)) : null;
  if (byLabel) return byLabel;
  const def = ZONE_ORE_DEFAULT[m.zone];
  return def ? (ORE_TIERS.find((t) => t.id === def) || null) : null;
};
const tradeskillLink = (name) => '<a href="#/tradeskill/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const vendorLink = (name) => '<a href="#/vendor/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
// A wiki "source" (node/creature/item) — link internally where we can, else to the wiki
const sourceLink = (s) =>
  DATA.mobs[s] ? mobLink(s)
    : NODES[s] ? nodeLink(s)
    : nameToId[s] ? itemLink(nameToId[s], s)
    : '<a href="' + wikiUrl(s) + '" target="_blank" rel="noopener">' + esc(s) + ' ↗</a>';

// If a map-marker label names a mob we can point at, return a link to "more info":
// our own mob page when we have one (it lists drops/level and links to the wiki),
// otherwise the wiki's search-and-jump (case-insensitive) when the wiki is known to
// list that mob (it drops an item). Returns null when the label isn't a known mob.
let _mobByLc = null;
function mobInfoLink(label) {
  const lc = String(label || '').trim().toLowerCase();
  if (!lc) return null;
  if (!_mobByLc) { _mobByLc = {}; for (const k of Object.keys(DATA.mobs || {})) _mobByLc[k.toLowerCase()] = k; }
  const own = _mobByLc[lc];
  if (own) return { href: '#/mob/' + encodeURIComponent(own), wiki: false };
  if ((DROP_LEVELS || {})[lc] != null)
    return { href: 'https://monstersandmemories.miraheze.org/w/index.php?title=Special:Search&go=Go&search=' + encodeURIComponent(label.trim()), wiki: true };
  return null;
}

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
// Pass a server ('PvP'/'PvE') to restrict to that market (PvP and PvE price
// separately); omit it for the combined view.
function tradeStats(name, server) {
  const list = TRADES[String(name).toLowerCase()];
  if (!list || !list.length) return null;
  const sells = list.filter((t) => t.side === 'sell' && (!server || t.server === server));
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

// Fill in mob levels estimated from in-game /con colour (mob-levels.json) where the
// wiki has none, so the "best value by level" brackets can include them. Wiki wins.
function applyMobLevels(mobs, ml) {
  const est = (ml && ml.estimates) || {};
  for (const [name, d] of Object.entries(mobs || {})) {
    if (Number.isFinite(mobLevel(d))) continue;
    const e = est[name];
    if (!e || !Number.isFinite(+e.level)) continue;
    d.wiki = d.wiki || {};
    d.wiki.level = String(e.level);
    d.levelEst = e; // { level, range, confidence, from } — flags it as a con estimate
  }
}

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
const SEG_COLORS = ['#bd6a3e', '#5a9a82', '#e0593f', '#c98a3a', '#6fa8c7', '#b07fc9', '#d9b94a', '#7fc9a0'];

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

  // Valuable crafting materials — harvestable things ranked by sell value, then
  // by how much you've gathered (ties gathering to economy)
  const resources = Object.keys(DATA.harvest)
    .map((r) => { const mv = itemMarketValue(r); return { name: r, value: mv.value, source: mv.source, n: DATA.harvest[r] }; })
    .sort((a, b) => b.value - a.value || b.n - a.n).slice(0, 12);

  // Table gets inline magnitude bars (value scaled to the leader in the list).
  const maxRes = resources.reduce((m, r) => Math.max(m, r.value || 0), 0);

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
    (byBracket[start] = byBracket[start] || []).push({ m, lvl, v, est: d.levelEst });
  });
  const bracketKeys = Object.keys(byBracket).map(Number).sort((a, b) => a - b);
  const unleveled = mobs.filter(([, d]) => mobValuePerKill(d).total > 0 && !Number.isFinite(mobLevel(d))).length;
  const bracketCols = bracketKeys.map((start) => {
    const list = byBracket[start].sort((a, b) => b.v - a.v).slice(0, 8);
    const max = list[0].v;
    return '<div><h3 class="bracket">Lv ' + start + '–' + (start + BRACKET - 1) + '</h3><div class="card"><table><tbody>' +
      list.map((x) => '<tr><td>' + mobLink(x.m) + ' <span class="sample' + (x.est ? ' est' : '') + '"' +
        (x.est ? ' title="Estimated from in-game /con — ' + esc(x.est.from || '') + (x.est.confidence ? ', ' + esc(x.est.confidence) + ' confidence' : '') + '">~L' + esc(x.est.range || x.lvl) : '>L' + x.lvl) + '</span></td><td class="num">' +
        barCell(x.v, max, '<span class="coin">' + coin(x.v) + '</span>') + '</td></tr>').join('') +
      '</tbody></table></div></div>';
  }).join('');
  const hasEstLevel = bracketKeys.some((k) => byBracket[k].some((x) => x.est));
  const bracketSection = bracketKeys.length
    ? '<h2>Best value by level</h2><p class="sub">Top value/kill in each level band (level from the wiki).' +
      (hasEstLevel ? ' A <span class="est">~</span> level is estimated from in-game /con (rough, may change).' : '') +
      (unleveled ? ' ' + unleveled + ' valuable mob' + (unleveled === 1 ? '' : 's') + ' not shown — no wiki level yet.' : '') + '</p>' +
      '<div class="col2">' + bracketCols + '</div>'
    : '';

  // Zone maps — quick-jump grid (the flagship). Non-"coming soon" zones link to their map.
  const zones = ((MAPS && MAPS.zones) || []).filter((z) => !z.comingSoon);
  const mapGrid = zones.length
    ? '<div class="map-grid">' + zones.map((z) => '<a class="map-chip" href="#/map/' + encodeURIComponent(z.name) + '">' + esc(z.name) + '</a>').join('') + '</div>'
    : '<p class="sub">No maps yet.</p>';

  $('content').innerHTML =
    '<div class="home-intro">' +
      '<h1>MnMdb — Monsters &amp; Memories maps, market &amp; database</h1>' +
      '<p class="sub">Zone maps, live auction prices, drop rates and item stats — from the community and the ' +
        '<a href="https://github.com/Boisteroux/mnm-tools">companion app</a>. Search above to find any item, mob or zone.</p>' +
      '<div class="stat-row">' +
        stat(items.length, 'items') + stat(mobs.length, 'mobs') +
        stat(zones.length, 'zone maps') + stat('…', 'live listings', 'home-stat-live') +
      '</div>' +
    '</div>' +
    '<h2>🗺 Zone maps <a class="h2-link" href="#/maps">see all maps →</a></h2>' + mapGrid +
    '<h2>💰 Live market <a class="h2-link" href="#/auctions">open the Auction House →</a></h2>' +
    '<div id="home-market"><p class="sub">Loading the live market…</p></div>' +
    bracketSection +
    '<h2>🧪 Valuable Crafting Materials</h2><p class="sub">Gathered &amp; crafting materials ranked by market value.</p><div class="card"><table><tbody>' +
      (resRows || '<tr><td class="muted">No resources yet.</td></tr>') + '</tbody></table></div>' +
    '<div class="note">Drop rates and mob values are observational — from real play, and sharpen as more data is collected. ' +
      'Auction prices are OCR-read from the community LiveMNM stream.</div>';

  fillHomeMarket();
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

const stat = (n, l, id) => '<div class="stat"><div class="num"' + (id ? ' id="' + id + '"' : '') + '>' + n + '</div><div class="lbl">' + l + '</div></div>';

// Load the auction feed once (shared with the Auction House page's AUCTIONS cache).
async function loadAuctionsData() {
  if (!AUCTIONS) { try { AUCTIONS = await (await fetch('./auctions.json?v=' + Date.now())).json(); } catch { AUCTIONS = { listings: [], requests: [], stats: {}, generatedAt: null }; } }
  return AUCTIONS;
}
// Home "Live market" section — biggest cross-server price gaps + crafting demand, filled async.
async function fillHomeMarket() {
  const box = $('home-market'); if (!box) return;
  const A = await loadAuctionsData();
  const live = $('home-stat-live'); if (live) live.textContent = A.listings.length;
  const bySrv = { PvP: 0, PvE: 0 };
  for (const l of A.listings) if (bySrv[l.server] != null) bySrv[l.server]++;
  const pm = {};
  for (const l of A.listings) { if (l.price == null) continue; const m = pm[l.item] = pm[l.item] || {}; m[l.server] = Math.min(m[l.server] == null ? Infinity : m[l.server], l.price); }
  const gaps = Object.entries(pm).filter(([, m]) => m.PvP && m.PvE)
    .map(([item, m]) => ({ item, pvp: m.PvP, pve: m.PvE, ratio: Math.max(m.PvP, m.PvE) / Math.min(m.PvP, m.PvE) }))
    .sort((a, b) => b.ratio - a.ratio).slice(0, 6);
  const gapRows = gaps.length
    ? '<div class="card"><table><thead><tr><th>Item</th><th class="num">PvP</th><th class="num">PvE</th></tr></thead><tbody>' +
      gaps.map((g) => '<tr><td>' + itemLink(g.item, g.item) + '</td><td class="num coin">' + coin(g.pvp) + '</td><td class="num coin">' + coin(g.pve) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '<p class="sub">Not enough cross-server prices yet.</p>';
  const reqs = (A.requests || []).slice(-10).reverse();
  const reqHtml = reqs.length
    ? '<div class="ticker">' + reqs.map((r) => {
        const w = [r.plus && r.plus.length ? '+' + r.plus.join('/') : '', (r.stats || []).join('/'), r.category].filter(Boolean).join(' ') || r.text;
        return '<span class="chip">' + esc(w) + ' <span class="sample">' + esc(r.server) + '</span></span>';
      }).join('') + '</div>'
    : '<p class="sub">No open requests right now.</p>';
  box.innerHTML =
    '<p class="sub">' + A.listings.length + ' listings live · ' + bySrv.PvP + ' PvP · ' + bySrv.PvE + ' PvE' +
      (A.generatedAt ? ' · updated ' + esc(new Date(A.generatedAt).toLocaleString()) : '') + '</p>' +
    '<div class="col2"><div><h3 class="bracket">Biggest PvP ↔ PvE price gaps</h3>' + gapRows + '</div>' +
    '<div><h3 class="bracket">🛠 Crafting demand</h3>' + reqHtml + '</div></div>';
}

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
    if (w.flags && w.flags.length) add('Flags', w.flags.map((f) => '<span class="tag good">' + esc(f) + '</span>').join(' '));
    if (w.effect) {
      const e = w.effect, tag = e.trigger ? ' <span class="tag good">' + esc(e.trigger) + '</span>' : '';
      const extra = [e.castTime ? 'Cast ' + esc(e.castTime) : '', e.level ? 'Lvl ' + e.level : ''].filter(Boolean).join(' · ');
      add('Effect', '<strong>' + esc(e.name) + '</strong>' + tag + (extra ? ' <span class="muted">(' + extra + ')</span>' : '') + effectDescHTML(e));
    }
    add('Slot', esc(slotLabel(w)) + (w.handed ? ' (' + esc(w.handed) + ')' : ''));
    add('Weapon DMG', w.dmg);
    add('Attack delay', w.delay);
    add('Skill', esc(w.skill || ''));
    add('AC', w.ac);
    const sb = Object.entries(w.stats || {}).map(([k, v]) => k + ' ' + (v > 0 ? '+' : '') + v);
    if (sb.length) add('Attributes', sb.join('  ·  '));
    if (w.hp != null) add('HP', (w.hp > 0 ? '+' : '') + w.hp);
    if (w.mana != null) add('Mana', (w.mana > 0 ? '+' : '') + w.mana);
    if (w.hpRegen != null) add('HP regen', (w.hpRegen > 0 ? '+' : '') + w.hpRegen);
    if (w.manaRegen != null) add('Mana regen', (w.manaRegen > 0 ? '+' : '') + w.manaRegen);
    if (w.haste != null) add('Haste', (w.haste > 0 ? '+' : '') + w.haste);
    const rs = Object.entries(w.resists || {}).map(([k, v]) => k + ' ' + (v > 0 ? '+' : '') + v);
    if (rs.length) add('Resistances', rs.join('  ·  '));
    if (w.container) add('Holds', w.container.capacity + ' slots' + (w.container.maxSize ? '  ·  ' + esc(w.container.maxSize) + ' max item size' : '') + (w.container.weightReduction ? '  ·  ' + w.container.weightReduction + '% weight reduction' : ''));
    add('Weight', w.weight);
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

  // Player trade value — PvP and PvE are separate markets, so price each one on
  // its own: 30-day high/low + 7-day average of player sell prices.
  {
    const logged = 'Read from live player auctions on the <a href="https://www.twitch.tv/livemnm" target="_blank" rel="noopener">LiveMNM stream</a>.';
    // One market's summary card (or a muted line when there's no data for it).
    const marketBox = (label, tv) => {
      if (tv && tv.n30) {
        return '<div class="mkt"><div class="mkt-h">' + label + '</div><div class="vendor-summary">' +
          '<div class="vbox"><div class="vlbl">30-day high</div><div class="vval">' + coin(tv.high) + '</div></div>' +
          '<div class="vbox"><div class="vlbl">30-day low</div><div class="vval">' + coin(tv.low) + '</div></div>' +
          '<div class="vbox"><div class="vlbl">7-day avg</div><div class="vval">' + (tv.avg7 != null ? coin(tv.avg7) : '<span class="sample">no recent</span>') + '</div></div>' +
          '</div><div class="note">' + tv.n30 + ' sale' + (tv.n30 === 1 ? '' : 's') + ' in 30d' + (tv.n7 ? ' (' + tv.n7 + ' in 7d)' : '') +
          (tv.trimmed ? ' · ' + tv.trimmed + ' outlier' + (tv.trimmed === 1 ? '' : 's') + ' excluded' : '') + '</div></div>';
      }
      const older = tv ? 'Last seen ' + coin(tv.allLow) + (tv.allHigh !== tv.allLow ? '–' + coin(tv.allHigh) : '') + ' (older than 30d)' : 'No sales seen yet';
      return '<div class="mkt"><div class="mkt-h">' + label + '</div><div class="note sample">' + older + '</div></div>';
    };
    const pvp = tradeStats(it.name, 'PvP'), pve = tradeStats(it.name, 'PvE');
    let body;
    if (pvp || pve) {
      body = '<div class="mkt-cols">' + marketBox('PvP', pvp) + marketBox('PvE', pve) + '</div><div class="note">' + logged + '</div>';
    } else {
      // No server-tagged data — fall back to any legacy (untagged) trades.
      const tv = tradeStats(it.name);
      if (tv) body = marketBox('Player market', tv) + '<div class="note">' + logged + '</div>';
      else body = '<div class="note">No player auctions seen for this item yet. ' + logged + '</div>';
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

  // Drops the wiki lists for this mob that we haven't observed yet — shown as extra
  // rows with "no drop data" in the rate column (rates fill in once they're looted).
  const mw = m.wiki || {};
  const wikiLoot = (mw.loot || []).filter((it) => !m.drops[it]);

  let table = '<p class="muted">No drops recorded.</p>';
  if (drops.length || wikiLoot.length) {
    const obsRows = drops.map((d) => {
      const id = nameToId[d.item] || d.item;
      const sell = d.hasPrice ? coin(d.reg) : '<span class="sample">no price yet</span>';
      const pk = d.hasPrice ? coin(d.perKill) : '<span class="sample">—</span>';
      return '<tr><td>' + itemLink(id, d.item) + '</td><td class="num">' + rateCell(d.rate, d.n, corpses) +
        '</td><td class="num coin">' + sell + '</td><td class="num coin">' + pk + '</td></tr>';
    }).join('');
    const wikiRows = wikiLoot.map((it) => {
      const reg = regularPrice(itemByName[it]);
      const sell = reg > 0 ? coin(reg) : '<span class="sample">no price yet</span>';
      return '<tr><td>' + itemLink(nameToId[it] || it, it) + '</td>' +
        '<td class="num"><span class="sample">no drop data</span></td>' +
        '<td class="num coin">' + sell + '</td><td class="num sample">—</td></tr>';
    }).join('');
    table = '<div class="card"><table><thead><tr><th>Item</th><th class="num">Drop rate</th><th class="num">Sell value</th><th class="num">Avg kill value</th></tr></thead><tbody>' +
      obsRows + wikiRows + '</tbody></table></div>';
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

// A skill-zone / named harvest cluster (e.g. "Herbs - Evershade Weald") renders
// straight from its observed yields.
function renderHarvestNode(node) {
  const rows = node.yields.map((y) => '<tr><td>' + (nameToId[y.res] ? itemLink(nameToId[y.res], y.res) : esc(y.res)) +
    '</td><td class="num">' + harvestRateCell(y.rate, y.count, node.pulls) + '</td></tr>').join('');
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › <a href="#/gathering">gathering</a></div>' +
    '<h1>' + esc(node.name) + '</h1>' +
    '<p class="sub">' + node.pulls + ' harvests' + (node.zones.length ? ' in ' + node.zones.map(zoneLink).join(', ') : '') + '</p>' +
    '<h2>Yields</h2><div class="card"><table><thead><tr><th>Yield</th><th class="num">Drop rate</th></tr></thead><tbody>' +
    rows + '</tbody></table></div>' +
    '<div class="note">Chance per harvest from this gathering node, observed through the app. Rare yields fade when the sample is thin.</div>';
}

function renderNode(name) {
  const direct = HARVEST_NODES.find((n) => n.name === name); // skill-zone / named cluster
  if (direct) return renderHarvestNode(direct);
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
    body = '<h2>Drops</h2><div class="card"><table><thead><tr><th>Yield</th><th class="num">Drop rate</th></tr></thead><tbody>' +
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
// Compact raw-material list for a recipe (base mats, tools excluded).
function rawMatsHtml(rc) {
  return rc.parts.map((p) => fmtQty(p.qty) + '× ' + (nameToId[p.name] ? itemLink(nameToId[p.name], p.name) : esc(p.name)) +
    (p.value <= 0 ? ' <span class="sample">?</span>' : '')).join(', ');
}

// Apply trivials reverse-engineered from in-game crafting difficulty colours
// (recipe-observations.json) where the wiki has none. The wiki value always wins;
// estimates only fill the blanks and are flagged so the UI can mark them.
function applyTrivialEstimates(recipes, obs) {
  const est = (obs && obs.trivialEstimates) || {};
  for (const r of recipes || []) {
    if (r.trivial) continue;                       // keep any real wiki trivial
    const bySkill = est[r.tradeskill];
    const v = bySkill && bySkill[r.result.item];
    if (v == null) continue;
    const num = parseInt(v, 10);
    if (!num) continue;
    r.trivial = num;
    r.trivialEstimated = true;
    if (typeof v === 'string' && /\+\s*$/.test(v)) r.trivialMin = true; // "80+" = lower bound
  }
}

// Trivials we've reverse-engineered from in-game crafting colours for recipes the
// wiki doesn't list at all — shown as their own section so they don't pollute the
// cost/profit/leveling tables (which need ingredients we don't have for these yet).
function observedTrivialsSection(name) {
  const est = RECIPE_OBS && RECIPE_OBS.trivialEstimates && RECIPE_OBS.trivialEstimates[name];
  if (!est) return '';
  const have = new Set(RECIPES.filter((r) => r.tradeskill === name).map((r) => r.result.item));
  const extra = Object.keys(est).filter((k) => k !== '_method' && !have.has(k));
  if (!extra.length) return '';
  const rows = extra
    .map((item) => ({ item, v: est[item], n: parseInt(est[item], 10) || 9999 }))
    .sort((a, b) => a.n - b.n)
    .map((e) => {
      const known = DATA.items.find((i) => i.name === e.item);
      const cell = known ? itemLink(nameToId[e.item] || e.item, e.item) : esc(e.item);
      const label = '~' + (parseInt(e.v, 10) || '?') + (/\+\s*$/.test(String(e.v)) ? '+' : '');
      return '<tr><td>' + cell + '</td><td class="num sample"><span class="est">' + label + '</span></td></tr>';
    }).join('');
  return '<h2>Observed trivials <span class="sub">— not in the wiki yet</span></h2>' +
    '<p class="note">Reverse-engineered from in-game crafting difficulty colours for recipes the wiki doesn’t list. Estimated to the nearest 5 (in-game breakpoints fall every 5 skill); “+” is a lower bound until higher-skill data lands. These join the tables above once their full recipes are added.</p>' +
    '<div class="card"><table><thead><tr><th>Recipe</th><th class="num">Trivial</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// How a recipe's trivial reads in a table: a plain number from the wiki, or our
// estimate marked "~55" (and "~80+" when it's only a lower bound so far).
function trivialCell(r) {
  if (!r.trivial) return '—';
  if (!r.trivialEstimated) return String(r.trivial);
  return '<span class="est" title="Estimated from in-game crafting difficulty colours — the wiki has no trivial for this recipe">~' + r.trivial + (r.trivialMin ? '+' : '') + '</span>';
}

// One combined recipe table: raw materials, trivial, raw-material cost, sell value
// (best market price of the output) and margin (sell − raw cost). Sorted by trivial.
function recipeTable(recs, showSkill) {
  const rows = recs.map((r) => {
    const rc = recipeRawCost(r);
    const sellEach = itemMarketValue(r.result.item).value;
    const sell = r.result.qty * sellEach;
    const margin = (sellEach > 0 && !rc.unresolved) ? sell - rc.cost : null;
    return { r, rc, sell, haveSell: sellEach > 0, margin };
  }).sort((a, b) => (a.r.trivial || 1e9) - (b.r.trivial || 1e9) || a.rc.cost - b.rc.cost);
  const head = '<th>Make</th><th>Raw materials</th>' + (showSkill ? '<th>Skill</th>' : '') +
    '<th class="num">Trivial</th><th class="num">Raw cost</th><th class="num">Sell value</th><th class="num">Margin</th>';
  return '<div class="card"><table><thead><tr>' + head + '</tr></thead><tbody>' +
    rows.map(({ r, rc, sell, haveSell, margin }) => {
      const rid = nameToId[r.result.item] || r.result.item;
      // "?" only when a cost is genuinely unknown (an unresolved intermediate like an
      // enchanted bar). All-gathered recipes cost nothing to buy → "free", not "?".
      const cost = rc.unresolved
        ? (rc.cost > 0 ? coin(rc.cost) + ' <span class="sample">+?</span>' : '<span class="sample">?</span>')
        : (rc.cost > 0 ? coin(rc.cost) : '<span class="sample">free</span>');
      const mg = margin == null ? '<span class="sample">—</span>'
        : '<span class="' + (margin >= 0 ? 'pos' : 'neg') + '">' + (margin >= 0 ? '+' : '') + coin(margin) + '</span>';
      return '<tr><td>' + (r.result.qty > 1 ? r.result.qty + '× ' : '') + itemLink(rid, r.result.item) + '</td>' +
        '<td class="sample">' + rawMatsHtml(rc) + '</td>' + (showSkill ? '<td>' + tradeskillLink(r.tradeskill) + '</td>' : '') +
        '<td class="num sample">' + trivialCell(r) + '</td>' +
        '<td class="num coin">' + cost + '</td>' +
        '<td class="num coin">' + (haveSell ? coin(sell) : '—') + '</td>' +
        '<td class="num">' + mg + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

const marginNote = '<div class="note">Sorted by trivial. <b>Raw materials</b> = everything broken down to gathered/base mats (reusable tools like hammers &amp; pliers excluded; molds and other consumables counted). ' +
  '<b>Raw cost</b> values those at the best known price (gathered mats are free). <b>Sell value</b> = the output’s best player-trade/vendor price. <b>Margin</b> = sell − raw cost. <b>free</b> = made entirely from gathered mats (nothing to buy); <b>?</b> = a cost is genuinely unknown — an unresolved crafted intermediate (e.g. an enchanted bar whose enchanting cost we can’t see). ' +
  'A <b class="est">~</b> trivial (e.g. <span class="est">~55</span>) is our own estimate from in-game crafting colours where the wiki has none — “+” means a lower bound until more data lands.</div>';

// Reusable, one-time crafting tools (a hammer/pliers lasts many crafts), so they
// don't count toward per-craft material cost. Molds ARE consumed (1 per bar) — kept.
const isReusableTool = (name) => !/mold/i.test(name) &&
  /\b(hammer|pliers|tongs|mallet|chisel|shears|awl|whetstone|spindle|needle|loom|saw|file)\b/i.test(name);

// Leather "scraps" are the real crafting base: pelts (looted) are tanned into
// scraps, so we stop the raw-material expansion at scraps rather than pelts.
// "X Scraps" (rawhide, leather, padded leather, wool, cloth…) are always base looted/
// gathered materials — never a crafted intermediate, so stop expansion and treat as free.
const isBaseMaterial = (name) => /\bscraps$/i.test(name);

// Is this a base material we can actually get for ~free (gathered / looted / has a
// known source) — as opposed to an unknown crafted intermediate?
// Materials you obtain by playing (disenchant magic drops, mining, lumberjacking) rather
// than buying — treated as free like gathered ore. From in-game knowledge where the wiki
// lists no source. Enchant powders come from disenchanting (copper-tier = Clouded
// Crystallized Magic) or mining; Elder Wood is gathered wood. Add higher tiers as found.
const OBTAINED_MATS = new Set(['Enchanted Powder', 'Magic Powder', 'Arcane Powder', 'Astral Powder', 'Clouded Crystallized Magic', 'Elder Wood']);
function isGatherableRaw(name) {
  if (OBTAINED_MATS.has(name)) return true;
  if (/^raw\b.*\bmeat$/i.test(name)) return true; // "Raw X Meat" is looted from creatures
  const it = itemByName[name];
  if (!it) return false;
  const w = it.wiki || {};
  return (it.harvested > 0) || !!w.harvestedBy || (DATA.harvest && DATA.harvest[name] != null) ||
    (it.droppedBy && it.droppedBy.length > 0) || ((w.from || []).length > 0);
}
// A "raw" (no recipe) we can neither price nor gather/loot is an unresolved crafted
// intermediate — e.g. Enchanted Copper Bar, whose enchanting cost we can't see.
// Treating it as free makes recipes that use it look falsely cheap, so we flag it
// and keep those recipes out of the cheapest-path ranking.
function isUnresolvedRaw(name) {
  if (isBaseMaterial(name)) return false; // scraps are gathered/looted base mats — free, not unknown
  return !recipesByResult[name.toLowerCase()] && itemMarketValue(name).value <= 0 && !isGatherableRaw(name);
}

// Recursively expand an item into its base (gathered/looted) materials. A material
// is "raw" when no recipe makes it. Returns { rawName: qty }. The `seen` set guards
// against recipe cycles; the first known recipe is used when several exist.
function rawMaterials(name, qty, seen) {
  qty = qty == null ? 1 : qty;
  seen = seen || new Set();
  const key = name.toLowerCase();
  const recipes = recipesByResult[key];
  if (!recipes || !recipes.length || seen.has(key) || isBaseMaterial(name)) return { [name]: qty };
  const r = recipes[0];
  const factor = qty / (r.result.qty || 1);
  const next = new Set(seen); next.add(key);
  const out = {};
  for (const c of r.components) {
    if (isReusableTool(c.item)) continue; // one-time tool, not a per-craft cost
    const sub = rawMaterials(c.item, c.qty * factor, next);
    for (const [k, v] of Object.entries(sub)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

const fmtQty = (q) => { const n = Math.round(q * 100) / 100; return Number.isInteger(n) ? String(n) : String(n); };

// Raw materials for ONE craft of a recipe (components fully expanded, tools out).
function recipeRaws(r) {
  const out = {};
  for (const c of r.components) {
    if (isReusableTool(c.item)) continue; // exclude one-time tools (hammers, pliers)
    const sub = rawMaterials(c.item, c.qty);
    for (const [k, v] of Object.entries(sub)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

// Raw-material breakdown + total cost for one craft. Cost uses best-known market
// value (gathered mats with no price count as 0 and are flagged).
function recipeRawCost(r) {
  let cost = 0, missing = 0, unresolved = false;
  const parts = Object.entries(recipeRaws(r)).map(([n, q]) => {
    const v = itemMarketValue(n).value;
    if (v > 0) cost += q * v; else { missing++; if (isUnresolvedRaw(n)) unresolved = true; }
    return { name: n, qty: q, value: v };
  }).sort((a, b) => (b.qty * b.value) - (a.qty * a.value) || b.qty - a.qty);
  return { parts, cost, missing, unresolved };
}

// Cheapest path to level a tradeskill: at each skill point, the recipe that still
// gives skill (trivial > skill) with the lowest bought-material coin (tiebreak:
// fewest total mats). Greedy is optimal here since each skill-up is independent.
// Returns the segments + a combined gathering list for the whole grind.
// A recipe is an efficient skill-up source from when it first turns ORANGE (~25 below
// its trivial) up to its trivial (goes grey, no more skill). Enchanted variants are
// never the cheapest grind, so they're left out of the path entirely.
const START_GAP = 25;
const startSkill = (trivial) => Math.max(1, trivial - START_GAP);

function levelingPath(recs) {
  const cand = recs
    .filter((r) => r.trivial && !/^enchanted /i.test(r.result.item))
    .map((r) => {
      const raws = recipeRaws(r);
      const unknown = Object.keys(raws).some(isUnresolvedRaw);
      const cost = Object.entries(raws).reduce((sum, [n, q]) => sum + q * itemMarketValue(n).value, 0);
      const qty = Object.values(raws).reduce((sum, q) => sum + q, 0);
      return { name: r.result.item, id: nameToId[r.result.item] || r.result.item, trivial: r.trivial, start: startSkill(r.trivial), cost, qty, raws, unknown };
    }).filter((c) => c.qty > 0);
  if (!cand.length) return null;
  const maxTriv = Math.max(...cand.map((c) => c.trivial));
  const segments = [], totalRaws = {};
  let s = Math.max(1, Math.min(...cand.map((c) => c.start))), guard = 0;
  while (s < maxTriv && guard++ < 500) {
    const avail = cand.filter((c) => c.trivial > s);
    if (!avail.length) break;
    // Recipes already at least orange (start <= s) are the eligible grind; if there's
    // a gap, fall back to the nearest harder recipe to grow into.
    const inWindow = avail.filter((c) => c.start <= s);
    const base = inWindow.length ? inWindow : avail;
    const known = base.filter((c) => !c.unknown);
    const pool = known.length ? known : base; // prefer recipes we can actually price
    const best = inWindow.length
      ? pool.reduce((a, b) => (b.cost < a.cost || (b.cost === a.cost && b.qty < a.qty)) ? b : a) // cheapest in the orange→trivial window
      : pool.reduce((a, b) => (b.trivial < a.trivial || (b.trivial === a.trivial && b.cost < a.cost)) ? b : a); // grow into the nearest
    const crafts = best.trivial - s;
    segments.push({ from: s, to: best.trivial, name: best.name, id: best.id, raws: best.raws });
    for (const [n, q] of Object.entries(best.raws)) totalRaws[n] = (totalRaws[n] || 0) + q * crafts;
    s = best.trivial;
  }
  return { segments, totalRaws, maxTriv };
}

// Skill-specific leveling tips — community know-how the cost model can't infer.
const SKILL_TIPS = {
  Blacksmithing: 'Once you can mine tin, <b>Tin Cauldrons</b> (trivial ~90) are the most efficient grind — cheap, endlessly repeatable from tin ore, and they carry you through the 80s.',
};
function levelingPathSection(recs) {
  const path = levelingPath(recs);
  if (!path || !path.segments.length) return '';
  const skillTip = SKILL_TIPS[(recs[0] || {}).tradeskill]
    ? '<div class="note">💡 <b>Tip:</b> ' + SKILL_TIPS[(recs[0] || {}).tradeskill] + '</div>'
    : '';
  const segMats = (s) => Object.entries(s.raws || {}).sort((a, b) => b[1] - a[1])
    .map(([n, q]) => fmtQty(q) + '× ' + (nameToId[n] ? itemLink(nameToId[n], n) : esc(n))).join(', ');
  const segs = path.segments.map((s) => '<tr><td>' + s.from + '–' + s.to + '</td><td>' + itemLink(s.id, s.name) + '</td>' +
    '<td class="sample">' + segMats(s) + '</td></tr>').join('');
  const raws = Object.entries(path.totalRaws).sort((a, b) => b[1] - a[1])
    .map(([n, q]) => '<li>' + Math.round(q) + '× ' + (nameToId[n] ? itemLink(nameToId[n], n) : esc(n)) + '</li>').join('');
  return '<h2>Cheapest leveling path</h2>' +
    '<p class="sub">The cheapest recipe to grind in each skill band — usable from when it first turns <b>orange</b> (~25 below its trivial) until it goes grey at its <b>trivial</b>. Pick whichever needs the least material; it’s almost always something with just a few ore or ingots.</p>' +
    skillTip +
    '<div class="card"><table><thead><tr><th>Skill</th><th>Craft</th><th>Materials / craft</th></tr></thead><tbody>' +
    segs + '</tbody></table></div>' +
    '<div class="note"><b>Total to gather for the whole grind:</b><ul class="vbuys">' + raws + '</ul></div>';
}

// Table of recipes broken down to raw materials, cheapest first — for skilling up.
function rawCostTable(recs) {
  const rows = recs.map((r) => ({ r, rc: recipeRawCost(r) }))
    .sort((a, b) => (a.rc.cost > 0 ? a.rc.cost : Infinity) - (b.rc.cost > 0 ? b.rc.cost : Infinity));
  const matsHtml = (rc) => rc.parts.map((p) => fmtQty(p.qty) + '× ' +
    (nameToId[p.name] ? itemLink(nameToId[p.name], p.name) : esc(p.name)) + (p.value <= 0 ? ' <span class="sample">?</span>' : '')).join(', ');
  return '<div class="card"><table><thead><tr><th>Make</th><th>Raw materials</th><th class="num">Raw cost</th><th class="num">Trivials at</th></tr></thead><tbody>' +
    rows.map(({ r, rc }) => {
      const rid = nameToId[r.result.item] || r.result.item;
      // "?" only when a cost is genuinely unknown (an unresolved intermediate like an
      // enchanted bar). All-gathered recipes cost nothing to buy → "free", not "?".
      const cost = rc.unresolved
        ? (rc.cost > 0 ? coin(rc.cost) + ' <span class="sample">+?</span>' : '<span class="sample">?</span>')
        : (rc.cost > 0 ? coin(rc.cost) : '<span class="sample">free</span>');
      return '<tr><td>' + (r.result.qty > 1 ? r.result.qty + '× ' : '') + itemLink(rid, r.result.item) + '</td>' +
        '<td class="sample">' + matsHtml(rc) + '</td>' +
        '<td class="num coin">' + cost + '</td>' +
        '<td class="num sample">' + trivialCell(r) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

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
  recipes.forEach((r) => {
    nodes.add(r.result.item);
    r.components.forEach((c) => {
      if (isReusableTool(c.item)) return; // reusable tools aren't part of the crafting flow
      nodes.add(c.item);
      edges.push({ from: c.item, to: r.result.item, value: itemMarketValue(r.result.item).value });
    });
  });
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
    (recs.length ? levelingPathSection(recs) : '') +
    (recs.length ? '<h2>Recipes</h2>' + recipeTable(recs, false) + marginNote : '') +
    observedTrivialsSection(name) +
    flowSection;
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

const browse = { view: null, key: 'name', dir: 1, effect: '' };

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
      effect: (i.wiki && i.wiki.effect) || null,
    };
  });
}

// A harvest-rate cell — bar + chance, faded when the yield count is a thin sample.
function harvestRateCell(rate, count, pulls) {
  // Floor the bar so rare yields (well under 1%) still show a visible nub instead
  // of an empty track; the exact % text alongside stays precise.
  const w = rate > 0 ? Math.max(6, Math.min(100, Math.round(rate * 100))) : 0;
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
    const label = wikiNodes.length ? wikiNodes.map(nodeLink).join(' / ') : nodeLink(n.name);
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
  // Items can be filtered by their click/proc/worn effect; when a filter is active
  // we insert an Effect column so the matching ability is visible.
  const effOn = view === 'items' && browse.effect;
  const effCol = { key: 'effect', label: 'Effect', noSort: true, render: (v) => v ? esc(v.name) + (v.trigger ? ' <span class="tag good">' + esc(v.trigger) + '</span>' : '') : '—' };
  const cols = effOn ? [browseCols[view][0], effCol, ...browseCols[view].slice(1)] : browseCols[view];
  let rows = browseRows(view);
  if (effOn) rows = rows.filter((r) => r.effect && (browse.effect === 'any' || r.effect.trigger === browse.effect));
  rows.sort((a, b) => {
    let x = a[browse.key], y = b[browse.key];
    if (typeof x === 'string') return browse.dir * x.localeCompare(y);
    x = x == null ? -1 : x; y = y == null ? -1 : y;
    return browse.dir * (x - y);
  });
  const head = cols.map((c) => {
    if (c.noSort) return '<th class="' + (c.num ? 'num' : '') + '">' + c.label + '</th>';
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
    (view === 'mobs' ? '<p class="sub">Prefer the art? Browse the <a href="#/bestiary"><b>illustrated Bestiary →</b></a></p>' : '') +
    (view === 'gathering' ? harvestNodesSection() : '') +
    '<h2 style="text-transform:capitalize">' + (view === 'gathering' ? 'All resources' : view) + '</h2>' +
    '<p class="sub">Click a column heading to sort. Click a row to open it.' +
      (view === 'items' ? ' Filter by item effect: <select class="inline-select" onchange="setBrowseEffect(this.value)">' +
        ['', 'any', 'Click', 'Proc', 'Worn'].map((v) => '<option value="' + v + '"' + (browse.effect === v ? ' selected' : '') + '>' +
          (v === '' ? 'Any' : v === 'any' ? 'Has an effect' : v === 'Click' ? 'Clicky' : v === 'Proc' ? 'Proc / combat' : 'Worn') + '</option>').join('') +
        '</select>' + (effOn ? ' · <span class="sample">' + rows.length + ' with an effect</span>' : '') : '') + '</p>' +
    '<div class="card"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

window.setSort = (key) => {
  if (browse.key === key) browse.dir *= -1;
  else { browse.key = key; browse.dir = key === 'name' ? 1 : -1; }
  renderBrowse(browse.view);
};

window.setBrowseEffect = (v) => { browse.effect = v; renderBrowse('items'); };

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
        '<span class="mapthumb"><img src="maps/' + encodeURIComponent(z.image) + mapVer() + '" alt="" loading="lazy" /><span class="mapcount hidden" data-zone="' + esc(z.name) + '"></span></span>' +
        '<span class="mapname">' + esc(z.name) +
        (z.markers.length ? ' <span class="sample">' + z.markers.length + ' marks</span>' : '') + '</span></a>'
    ).join('') + '</div>';
  // Badge zones that have extra community maps (total = official + community).
  loadMaps().then((byZone) => {
    document.querySelectorAll('.mapcount[data-zone]').forEach((el) => {
      const extra = (byZone[el.dataset.zone] || []).length;
      if (extra) { el.textContent = (extra + 1) + ' maps'; el.classList.remove('hidden'); }
    });
  });
}

let pendingMap = null;
let mapLightSrc = '';   // current map image, for the click-to-enlarge lightbox

// Map legend: tiered ore becomes one ring-chip per tier present; the plain "Ore"
// entry stays only while the zone still has unclassified nodes.
function legendHTML(markers, catById, fallback) {
  const tiers = ORE_TIERS.filter((t) => markers.some((m) => oreTier(m) === t));
  const cats = [...new Set(markers.map((m) => m.category).filter(Boolean))]
    .filter((id) => id !== 'ore' || markers.some((m) => m.category === 'ore' && !oreTier(m)));
  return tiers.map((t) =>
    '<span class="mlg"><span class="mdot mdot-tier" style="--tc:' + t.color + '"></span>' + t.name + '</span>'
  ).concat(cats.map((id) => {
    const c = catById[id] || fallback;
    return '<span class="mlg"><span class="mdot" style="background:' + c.color + '"></span>' + esc(c.name) + '</span>';
  })).join('');
}

// Marker HTML positioned by percentage of the image's natural size (works at any
// display size — inline map or lightbox).
function markerLayerHTML(markers, nw, nh) {
  return markers.map((m, i) => {
    const tier = oreTier(m); // tiered ore gets a colored ring around the pickaxe
    return '<span class="mk' + (m.community ? ' mk-community' : '') + (tier ? ' mk-tier' : '') + '" data-idx="' + i + '"' + (m.community && m.id ? ' data-id="' + m.id + '" data-label="' + esc(m.label || '') + '"' : '') + ' style="left:' + (m.x / nw * 100) + '%;top:' + (m.y / nh * 100) + '%;--mc:' + m.color + (tier ? ';--tc:' + tier.color : '') + '" ' +
    'title="' + esc(m.label + (m.notes ? ' — ' + m.notes : '')) + '">' +
    '<span class="mk-ic">' + m.icon + '</span>' +
    (m.label ? '<span class="mk-lbl">' + esc(m.label) + '</span>' : '') + '</span>';
  }).join('');
}

// Full-size map overlay with zoom + pan. Scroll or +/− to zoom, drag to pan.
// Close with ✕, a backdrop click, or Esc.
function openMapLightbox(src, markers, caption) {
  src = src || mapLightSrc;
  markers = markers || pendingMap || [];
  if (!src || document.querySelector('.lightbox')) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML =
    '<button class="lb-close" aria-label="Close">✕</button>' +
    (caption ? '<div class="lb-caption">' + caption + '</div>' : '') +
    '<div class="lb-zoom"><button data-z="out" aria-label="Zoom out">−</button>' +
    '<button data-z="reset" aria-label="Reset">⤢</button>' +
    '<button data-z="in" aria-label="Zoom in">+</button></div>' +
    '<div class="lb-inner"><img src="' + src + '" alt="" /><div class="lb-layer"></div></div>';
  document.body.appendChild(lb);
  const inner = lb.querySelector('.lb-inner'), img = lb.querySelector('img'), layer = lb.querySelector('.lb-layer');

  // Zoom by resizing the IMG itself (the browser re-renders from the full-res
  // source = crisp) and pan with translate only. Transform-scaling instead would
  // just upscale a cached fit-size raster — blurry at any real zoom.
  let scale = 1, tx = 0, ty = 0, fitW = 0;
  const maxScale = () => (fitW && img.naturalWidth) ? Math.max(1, img.naturalWidth / fitW) : 8;
  const apply = () => {
    if (fitW) img.style.width = Math.round(fitW * scale) + 'px';
    inner.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
    inner.classList.toggle('zoomed', scale > 1);
  };
  const zoom = (f) => { scale = Math.max(1, Math.min(maxScale(), scale * f)); if (scale === 1) { tx = 0; ty = 0; } apply(); };
  const place = () => { layer.innerHTML = markerLayerHTML(markers, img.naturalWidth || 1, img.naturalHeight || 1); };
  const ready = () => {
    fitW = img.clientWidth || Math.min(img.naturalWidth || 1, Math.round(window.innerWidth * 0.98));
    img.style.maxWidth = 'none'; img.style.maxHeight = 'none'; img.style.width = fitW + 'px';
    place();
  };
  img.complete && img.naturalWidth ? requestAnimationFrame(ready) : img.addEventListener('load', ready);

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

  pendingMap = z.markers.map((m) => {
    const c = catById[m.category] || fallback;
    return { x: m.x, y: m.y, label: m.label, notes: m.notes, category: m.category, zone: name, color: c.color, icon: c.icon };
  });
  const legend = legendHTML(pendingMap, catById, fallback);

  const catOptions = (MAPS.categories || []).map((c) =>
    '<option value="' + c.id + '">' + c.icon + ' ' + esc(c.name) + '</option>').join('');
  const tierOptions = '<option value="">Not sure yet</option>' + ORE_TIERS.map((t) =>
    '<option value="' + t.id + '">' + t.name + '</option>').join('');

  mapLightSrc = 'maps/' + encodeURIComponent(z.image) + mapVer();
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › <a href="#/maps">maps</a> › ' + esc(name) + '</div>' +
    '<h1>' + esc(name) + '</h1>' +
    '<div id="map-tabs" class="map-tabs hidden"></div>' +
    '<div class="maptools">' +
      (legend ? '<div class="mlegend">' + legend + '</div>' : '<span class="sub">No markers yet — add the first one.</span>') +
      '<div class="maptool-btns"><span id="add-target" class="add-target hidden"></span>' +
      '<button id="suggest-btn" class="msuggest msuggest-fill">📍 Add a Marker</button>' +
      (SESSION ? '<button id="mymarkers-btn" class="msuggest">📋 My Markers</button>' : '') +
      '<button id="mapsuggest-btn" class="msuggest msuggest-quiet">Submit Map</button></div>' +
    '</div>' +
    '<p id="move-hint" class="sub hidden"></p>' +
    '<div class="mapview" title="Click to enlarge"><img id="mapimg" src="' + mapLightSrc + '" alt="' + esc(name) + ' map" />' +
    '<div id="maplayer"></div></div>' +
    '<p class="sub">Community-submitted markers are reviewed before they appear. <b>Click a marker</b> for its details; click the map itself to view it full size.<span id="map-count"></span></p>' +
    '<div id="suggest-modal" class="modal-overlay hidden">' +
      '<div class="modal-card">' +
        '<h3>Add a marker</h3>' +
        '<p id="sp-loc" class="sub"></p>' +
        '<div class="sp-row"><label for="sp-cat">Type</label><select id="sp-cat">' + catOptions + '</select></div>' +
        '<div class="sp-row" id="sp-tier-row"><label for="sp-tier">Ore tier</label><select id="sp-tier">' + tierOptions + '</select></div>' +
        '<div class="sp-row"><label for="sp-label">Label</label><input id="sp-label" maxlength="80" placeholder="e.g. Gnarlroot (named spawn)" /></div>' +
        identityBlock() +
        (SESSION ? '' : '<div id="cf-turnstile" class="cf-ts"></div>') +
        '<div class="sp-actions"><button id="sp-submit" class="primary">Submit for review</button><button id="sp-cancel">Cancel</button></div>' +
        '<div id="sp-status" class="sp-status"></div>' +
      '</div>' +
    '</div>' +
    '<div id="mine-modal" class="modal-overlay hidden"><div class="modal-card">' +
      '<h3>Your markers in ' + esc(name) + '</h3>' +
      '<div id="mine-modal-list"><p class="sub">Loading…</p></div>' +
      '<div class="sp-actions"><button id="mine-close">Close</button></div>' +
    '</div></div>' +
    '<div id="marker-modal" class="modal-overlay hidden"><div class="modal-card">' +
      '<h3>Community marker</h3>' +
      '<p id="mk-modal-info" class="sub"></p>' +
      '<div id="mk-modal-list"></div>' +
      '<div class="sp-actions"><button id="mk-modal-move" class="primary">Move on map</button><button id="mk-modal-close">Close</button></div>' +
    '</div></div>' +
    // Read-only marker info (any visitor clicking a pin) — shows its details plus a
    // link to the mob's page/wiki when the label names a mob we recognise.
    '<div id="mk-info" class="modal-overlay hidden"><div class="modal-card">' +
      '<h3 id="mk-info-title">Marker</h3>' +
      '<div id="mk-info-body"></div>' +
      '<div class="sp-actions"><button id="mk-info-close">Close</button></div>' +
    '</div></div>' +
    '<div id="map-modal" class="modal-overlay hidden"><div class="modal-card">' +
      '<h3>Submit a map for ' + esc(name) + '</h3>' +
      (SESSION
        ? '<p class="sub">Upload an image of this zone (JPG, PNG or WEBP · max 10 MB). It goes to review before appearing as another map option.</p>' +
          '<div class="sp-row"><label for="mapf-label">Name <span class="muted">(optional)</span></label><input id="mapf-label" maxlength="60" placeholder="e.g. Sewers, or Labeled" /></div>' +
          '<div class="sp-row"><label for="mapf-file">Image</label><input id="mapf-file" type="file" accept="image/png,image/jpeg,image/webp" /></div>' +
          '<div id="mapf-preview" class="mapf-preview hidden"><img id="mapf-img" alt="preview" /></div>' +
          '<div class="sp-actions"><button id="mapf-submit" class="primary">Submit for review</button><button id="mapf-cancel">Cancel</button></div>' +
          '<div id="mapf-status" class="sp-status"></div>'
        : '<p class="sub">Sign in with Discord to suggest a map — uploads need a verified account.</p>' +
          '<div class="sp-signin"><button id="mapf-discord" class="btn-discord">Sign in with Discord</button></div>' +
          '<div class="sp-actions"><button id="mapf-cancel">Close</button></div>') +
    '</div></div>';
  wireMapView(name, catById, fallback);
}

// Markers are stored in image-pixel coords; place them as percentages once the
// image's natural size is known, so they track the responsive image. Also loads
// approved community markers and wires the "suggest a marker" submission flow.
function wireMapView(name, catById, fallback) {
  const img = document.getElementById('mapimg');
  const layer = document.getElementById('maplayer');
  if (!img || !layer) return;
  const box = img.closest('.mapview');
  const place = () => { layer.innerHTML = markerLayerHTML(pendingMap || [], img.naturalWidth || 1, img.naturalHeight || 1); };
  if (img.complete && img.naturalWidth) place();
  else img.addEventListener('load', place);

  // ---- Multiple maps per zone: official (maps.json) + approved community maps ----
  const zrec = (MAPS.zones || []).find((x) => x.name === name) || {};
  const curated = (pendingMap || []).slice();              // the official map's curated markers
  let zoneCms = [], activeId = 'official';                  // community markers (with mapId) + active map
  const MAPLIST = [{ id: 'official', label: 'Recommended', src: 'maps/' + encodeURIComponent(zrec.image || '') + mapVer() }];
  const markersFor = (id) => id === 'official'
    ? curated.concat(zoneCms.filter((m) => m.mapId === 'official'))
    : zoneCms.filter((m) => m.mapId === id);
  const updateLegend = () => {
    const el = document.querySelector('.mlegend'); if (!el) return;
    el.innerHTML = legendHTML(pendingMap || [], catById, fallback);
  };
  const setAddTarget = () => { const at = document.getElementById('add-target'); const am = MAPLIST.find((x) => x.id === activeId); if (at && am && MAPLIST.length > 1) { at.textContent = 'Adding to: ' + am.label; at.classList.remove('hidden'); } };
  const showMap = (m) => {
    activeId = m.id; mapLightSrc = m.src; pendingMap = markersFor(m.id);
    document.querySelectorAll('#map-tabs .mtab').forEach((t) => t.classList.toggle('active', t.dataset.id === m.id));
    setAddTarget();
    if (img.getAttribute('src') === m.src) { place(); updateLegend(); }
    else { layer.innerHTML = ''; img.addEventListener('load', updateLegend, { once: true }); img.src = m.src; }
  };
  const buildTabs = () => {
    const tabs = document.getElementById('map-tabs'); if (!tabs) return;
    if (MAPLIST.length < 2) { tabs.classList.add('hidden'); return; }
    tabs.classList.remove('hidden');
    tabs.innerHTML = MAPLIST.map((m) => '<button class="mtab' + (m.id === activeId ? ' active' : '') + '" data-id="' + esc(m.id) + '">' + esc(m.label) + (m.submitter ? ' <span class="mtab-by">· ' + esc(m.submitter) + '</span>' : '') + '</button>').join('');
    tabs.querySelectorAll('.mtab').forEach((t) => t.addEventListener('click', () => { const m = MAPLIST.find((x) => x.id === t.dataset.id); if (m && m.id !== activeId) { cancelMove(); exitSuggest(); showMap(m); } }));
    setAddTarget();
  };

  // Convert a click on the responsively-sized image into its native pixel coords.
  const clickToImg = (e) => {
    const rect = img.getBoundingClientRect();
    return {
      px: Math.round((e.clientX - rect.left) / rect.width * (img.naturalWidth || 1)),
      py: Math.round((e.clientY - rect.top) / rect.height * (img.naturalHeight || 1)),
    };
  };

  // ---- Admin: click a community marker to edit / delete / move it (all via a modal) ----
  const moveHint = document.getElementById('move-hint');
  const markerModal = document.getElementById('marker-modal');
  const isAdmin = () => !!localStorage.getItem('mnmdb-admin') || !!(SESSION && SESSION.admin);
  // The token holder authenticates with the bearer; a signed-in admin uses their session.
  const adminAuth = () => { const t = localStorage.getItem('mnmdb-admin'); return t ? { bearer: t } : { session: SESSION.token }; };
  let moveId = null, moveAuth = null;
  if (isAdmin()) box.classList.add('admin');

  const closeMarkerModal = () => { markerModal.classList.add('hidden'); if (COMMUNITY === null) route(); };
  const openMarkerModal = (m, auth) => {
    const link = mobInfoLink(m.label);
    document.getElementById('mk-modal-info').innerHTML =
      (m.submitter ? 'By ' + esc(m.submitter) + ' · ' : '') + (m.verified ? 'verified ✓' : 'community') + ' · (' + m.x + ', ' + m.y + ')' +
      (link ? ' · <a href="' + link.href + '"' + (link.wiki ? ' target="_blank" rel="noopener"' : '') + '>' + (link.wiki ? 'wiki ↗' : 'mob info →') + '</a>' : '');
    renderMarkerList(document.getElementById('mk-modal-list'), [m], auth, { onDelete: closeMarkerModal });
    document.getElementById('mk-modal-move').onclick = () => { markerModal.classList.add('hidden'); startMove(m, auth); };
    markerModal.classList.remove('hidden');
  };
  if (markerModal) {
    document.getElementById('mk-modal-close').addEventListener('click', closeMarkerModal);
    markerModal.addEventListener('click', (e) => { if (e.target === markerModal) closeMarkerModal(); });
  }

  // Read-only marker detail popup shown when any visitor clicks a pin — includes a
  // "more info" link to the mob's page/wiki when the label names a mob we recognise.
  const infoModal = document.getElementById('mk-info');
  const closeInfo = () => infoModal && infoModal.classList.add('hidden');
  const openMarkerInfo = (m) => {
    if (!m || !infoModal) return;
    const cat = (MAPS.categories || []).find((c) => c.id === m.category);
    const link = mobInfoLink(m.label);
    document.getElementById('mk-info-title').textContent = m.label || 'Marker';
    document.getElementById('mk-info-body').innerHTML =
      (cat ? '<div class="mk-inforow"><span class="mdot" style="background:' + cat.color + '"></span>' + esc(cat.name) + '</div>' : '') +
      // Skip a note that's just a bare URL when we already show a proper mob link (some
      // curated markers stored the mob-page URL here); otherwise show it, linkified.
      (m.notes && !(link && /^https?:\/\/\S+$/.test(m.notes.trim())) ? '<div class="mk-inforow">' + linkify(m.notes) + '</div>' : '') +
      (m.submitter ? '<div class="mk-inforow muted">Added by ' + esc(m.submitter) + (m.verified ? ' · verified ✓' : '') + '</div>' : '') +
      (link
        ? '<div class="mk-inforow"><a class="mk-infolink" href="' + link.href + '"' + (link.wiki ? ' target="_blank" rel="noopener"' : '') + '>' +
          (link.wiki ? '📖 Look up “' + esc(m.label) + '” on the wiki ↗' : '→ View “' + esc(m.label) + '” — drops, level &amp; more') + '</a></div>'
        : '');
    infoModal.classList.remove('hidden');
  };
  if (infoModal) {
    document.getElementById('mk-info-close').addEventListener('click', closeInfo);
    infoModal.addEventListener('click', (e) => { if (e.target === infoModal) closeInfo(); });
  }

  const startMove = (m, auth) => {
    moveId = m.id; moveAuth = auth; box.classList.add('moving');
    moveHint.textContent = 'Click the correct spot for “' + (m.label || 'this marker') + '” · Esc to cancel';
    moveHint.classList.remove('hidden');
  };
  const cancelMove = () => { moveId = null; moveAuth = null; box.classList.remove('moving'); moveHint.classList.add('hidden'); };
  const reposition = async (id, x, y) => {
    moveHint.textContent = 'Saving…';
    try {
      const r = await fetch(API_BASE + '/marker/edit', Object.assign({ method: 'POST' }, markerAuthReq(moveAuth || {}, { id: +id, x, y })));
      if (r.ok) { COMMUNITY = null; moveId = null; moveAuth = null; box.classList.remove('moving'); route(); }
      else { const j = await r.json().catch(() => ({})); moveHint.textContent = '✗ ' + (j.error || ('Error ' + r.status)); }
    } catch { moveHint.textContent = '✗ Network error — try again.'; }
  };
  document.addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(box)) return document.removeEventListener('keydown', onKey);
    if (e.key === 'Escape' && moveId != null) cancelMove();
  });

  // This zone's community markers (each tagged with its map), then its community maps.
  loadCommunity().then((c) => {
    zoneCms = (c[name] || []).map((m) => {
      const cat = catById[m.category] || fallback;
      return { id: m.id, mapId: m.map_id || 'official', x: m.x, y: m.y, label: m.label, category: m.category, zone: name, submitter: m.submitter, verified: m.verified, color: cat.color, icon: cat.icon, community: true };
    });
    pendingMap = markersFor(activeId); place(); updateLegend();
  });
  loadMaps().then((byZone) => {
    (byZone[name] || []).forEach((m) => MAPLIST.push(m));
    buildTabs();
    const cnt = document.getElementById('map-count');
    if (cnt && MAPLIST.length > 1) cnt.textContent = ' · ' + MAPLIST.length + ' maps for this zone.';
  });

  // ---- Suggest-a-marker mode ----
  const btn = document.getElementById('suggest-btn');
  const modal = document.getElementById('suggest-modal');
  const loc = document.getElementById('sp-loc');
  const status = document.getElementById('sp-status');
  let suggestMode = false, pin = null, tsId = null;

  const exitSuggest = () => {
    suggestMode = false;
    box.classList.remove('suggesting');
    btn.textContent = '📍 Add a Marker'; btn.classList.remove('active');
    modal.classList.add('hidden');
    if (pin) { pin.remove(); pin = null; }
    if (tsId != null && window.turnstile) { try { turnstile.remove(tsId); } catch {} tsId = null; }
    status.textContent = ''; status.className = 'sp-status';
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) exitSuggest(); });
  btn.addEventListener('click', () => {
    if (suggestMode) return exitSuggest();
    cancelMove();                         // leave move-mode before adding a new marker
    suggestMode = true;
    box.classList.add('suggesting');
    btn.textContent = '✕ Cancel'; btn.classList.add('active');
  });

  box.addEventListener('click', (e) => {
    // Admin reposition: a click while moving drops the marker at the new spot…
    if (moveId != null) { const { px, py } = clickToImg(e); reposition(moveId, px, py); return; }
    // …and an admin click on a community pin opens its edit/delete/move modal.
    if (isAdmin() && !suggestMode) {
      const hitc = e.target.closest('.mk-community');
      if (hitc && hitc.dataset.id) {
        const mk = (pendingMap || []).find((m) => m.community && String(m.id) === hitc.dataset.id);
        if (mk) { openMarkerModal(mk, adminAuth()); return; }
      }
    }
    if (!suggestMode) {
      // Clicking a pin shows its details (+ a mob link); clicking the map enlarges it.
      const hit = e.target.closest('.mk');
      if (hit && hit.dataset.idx != null) { openMarkerInfo((pendingMap || [])[+hit.dataset.idx]); return; }
      return openMapLightbox();
    }
    const { px, py } = clickToImg(e);
    if (!pin) { pin = document.createElement('span'); pin.className = 'mk mk-temp'; box.appendChild(pin); }
    pin.style.left = (px / (img.naturalWidth || 1) * 100) + '%';
    pin.style.top = (py / (img.naturalHeight || 1) * 100) + '%';
    pin.dataset.x = px; pin.dataset.y = py;
    loc.textContent = name + ' · (' + px + ', ' + py + ')';
    modal.classList.remove('hidden');
    if (!SESSION && TURNSTILE_SITE_KEY && window.turnstile && tsId == null) { try { tsId = turnstile.render('#cf-turnstile', { sitekey: TURNSTILE_SITE_KEY }); } catch {} }
    document.getElementById('sp-label').focus();
  });

  // The ore-tier picker only applies to ore markers; the chosen tier is written
  // into the label (the label is the tier data — see ORE_TIERS).
  const spCat = document.getElementById('sp-cat');
  const spTierRow = document.getElementById('sp-tier-row');
  const syncTierRow = () => { if (spTierRow) spTierRow.classList.toggle('hidden', spCat.value !== 'ore'); };
  spCat.addEventListener('change', syncTierRow); syncTierRow();

  document.getElementById('sp-cancel').addEventListener('click', exitSuggest);
  const discordBtn = document.getElementById('sp-discord');
  if (discordBtn) discordBtn.addEventListener('click', () => { location.href = API_BASE + '/auth/discord/start'; });
  const signoutBtn = document.getElementById('sp-signout');
  if (signoutBtn) signoutBtn.addEventListener('click', () => { exitSuggest(); signOut(); route(); });
  document.getElementById('sp-submit').addEventListener('click', async () => {
    if (!pin) { status.textContent = 'Click the map to place your pin first.'; status.className = 'sp-status err'; return; }
    let label = document.getElementById('sp-label').value.trim();
    const spTier = document.getElementById('sp-tier');
    const tier = (spCat.value === 'ore' && spTier) ? ORE_TIERS.find((t) => t.id === spTier.value) : null;
    if (tier && !oreTier({ category: 'ore', label })) label = label ? tier.name + ' ' + label : tier.name;
    if (!label) { status.textContent = 'Please add a label.'; status.className = 'sp-status err'; return; }
    const nameEl = document.getElementById('sp-name');
    const body = {
      zone: name, map_id: activeId, x: +pin.dataset.x, y: +pin.dataset.y,
      category: document.getElementById('sp-cat').value, label,
      submitter: (!SESSION && nameEl) ? (nameEl.value.trim() || undefined) : undefined,
      session: SESSION ? SESSION.token : undefined,
      turnstile: (window.turnstile && tsId != null) ? turnstile.getResponse(tsId) : undefined,
    };
    status.textContent = 'Submitting…'; status.className = 'sp-status';
    try {
      const r = await fetch(API_BASE + '/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (r.ok) {
        const res = await r.json().catch(() => ({}));
        if (res.status === 'approved') {
          status.textContent = '✓ Added — it’s live on the map! Refreshing…'; status.className = 'sp-status ok';
          COMMUNITY = null;
          setTimeout(() => { exitSuggest(); route(); }, 1500);
        } else {
          status.textContent = '✓ Thanks! Your marker is pending review.'; status.className = 'sp-status ok';
          setTimeout(exitSuggest, 2400);
        }
      } else {
        const j = await r.json().catch(() => ({}));
        status.textContent = '✗ ' + (j.error || ('Error ' + r.status)); status.className = 'sp-status err';
      }
    } catch { status.textContent = '✗ Network error — please try again.'; status.className = 'sp-status err'; }
  });

  // My Markers — a per-zone modal for signed-in users to edit/delete their own pins here.
  const myBtn = document.getElementById('mymarkers-btn');
  const mineModal = document.getElementById('mine-modal');
  if (myBtn && mineModal) {
    const closeMine = () => { mineModal.classList.add('hidden'); if (COMMUNITY === null) route(); };
    myBtn.addEventListener('click', async () => {
      mineModal.classList.remove('hidden');
      const listEl = document.getElementById('mine-modal-list');
      listEl.innerHTML = '<p class="sub">Loading…</p>';
      let j;
      try { j = await (await fetch(API_BASE + '/my-markers', Object.assign({ method: 'POST' }, markerAuthReq({ session: SESSION.token }, {})))).json(); }
      catch { listEl.innerHTML = '<p class="sp-status err">Network error — try again.</p>'; return; }
      const mine = (j.markers || []).filter((m) => m.zone === name);
      if (!mine.length) { listEl.innerHTML = '<p class="sub">You haven’t added any markers in ' + esc(name) + ' yet.</p>'; return; }
      renderMarkerList(listEl, mine, { session: SESSION.token });
    });
    document.getElementById('mine-close').addEventListener('click', closeMine);
    mineModal.addEventListener('click', (e) => { if (e.target === mineModal) closeMine(); });
  }

  // ---- Suggest a map: upload an image of this zone for review (signed-in only) ----
  const mapBtn = document.getElementById('mapsuggest-btn');
  const mapModal = document.getElementById('map-modal');
  if (mapBtn && mapModal) {
    const closeMap = () => mapModal.classList.add('hidden');
    mapBtn.addEventListener('click', () => mapModal.classList.remove('hidden'));
    document.getElementById('mapf-cancel').addEventListener('click', closeMap);
    mapModal.addEventListener('click', (e) => { if (e.target === mapModal) closeMap(); });
    const dc = document.getElementById('mapf-discord');
    if (dc) dc.addEventListener('click', () => { location.href = API_BASE + '/auth/discord/start'; });
    const fileEl = document.getElementById('mapf-file');
    if (fileEl) {
      const mstatus = document.getElementById('mapf-status');
      const preview = document.getElementById('mapf-preview');
      const pimg = document.getElementById('mapf-img');
      let dims = null;
      fileEl.addEventListener('change', () => {
        const f = fileEl.files[0]; mstatus.textContent = ''; mstatus.className = 'sp-status'; dims = null;
        if (!f) { preview.classList.add('hidden'); return; }
        const url = URL.createObjectURL(f);
        pimg.onload = () => { dims = { w: pimg.naturalWidth, h: pimg.naturalHeight }; URL.revokeObjectURL(url); };
        pimg.src = url; preview.classList.remove('hidden');
      });
      document.getElementById('mapf-submit').addEventListener('click', async () => {
        const f = fileEl.files[0];
        if (!f) { mstatus.textContent = 'Choose an image first.'; mstatus.className = 'sp-status err'; return; }
        // Always compress in the browser first, so a map is never stored (or made markable) huge.
        mstatus.textContent = 'Compressing…'; mstatus.className = 'sp-status';
        const comp = await compressMapImage(f, 4800, 0.82);
        const fd = new FormData();
        fd.set('zone', name);
        fd.set('label', document.getElementById('mapf-label').value.trim());
        fd.set('session', SESSION.token);
        if (comp) {
          fd.set('width', comp.width); fd.set('height', comp.height);
          fd.set('image', comp.blob, (f.name.replace(/\.[^.]+$/, '') || 'map') + '.' + comp.ext);
        } else {
          if (f.size > 10 * 1024 * 1024) { mstatus.textContent = 'That image is over 10 MB and couldn’t be compressed here — please shrink it and retry.'; mstatus.className = 'sp-status err'; return; }
          if (dims) { fd.set('width', dims.w); fd.set('height', dims.h); }
          fd.set('image', f, f.name);
        }
        mstatus.textContent = 'Uploading…'; mstatus.className = 'sp-status';
        try {
          const r = await fetch(API_BASE + '/map/submit', { method: 'POST', body: fd });
          if (r.ok) {
            const res = await r.json().catch(() => ({}));
            if (res.status === 'approved') {
              mstatus.textContent = '✓ Added — it’s live! Refreshing…'; mstatus.className = 'sp-status ok';
              ZONEMAPS = null; setTimeout(() => { closeMap(); route(); }, 1500);
            } else {
              mstatus.textContent = '✓ Thanks! Your map is pending review.'; mstatus.className = 'sp-status ok';
              setTimeout(closeMap, 2400);
            }
          } else {
            const j = await r.json().catch(() => ({}));
            mstatus.textContent = '✗ ' + (j.error || ('Error ' + r.status)); mstatus.className = 'sp-status err';
          }
        } catch { mstatus.textContent = '✗ Network error — please try again.'; mstatus.className = 'sp-status err'; }
      });
    }
  }
}

// ---- Moderation — a private page (#/moderate, not linked in the nav). Reachable two
// ways: the ADMIN_TOKEN password (super-admin, kept in localStorage), or signing in with
// Discord as a per-user admin (their session token is used as the bearer). ----
function renderModerate() {
  const mod = localStorage.getItem('mnmdb-admin') || '';   // the moderator password, if set
  const viaSession = !mod && !!(SESSION && SESSION.admin);
  const creds = mod || (viaSession ? SESSION.token : '');
  const isSuper = !!mod;                                    // only the password holder is super-admin
  const adminAuth = mod ? { bearer: mod } : { session: SESSION && SESSION.token };
  if (!creds) {
    $('content').innerHTML =
      '<h1>Moderation</h1>' +
      '<p class="sub">Enter the moderator password to review submissions.</p>' +
      '<div class="modlogin"><input id="mod-token" type="password" placeholder="Moderator password" autocomplete="current-password" />' +
      '<button id="mod-signin" class="primary">Sign in</button></div>' +
      (SESSION
        ? '<p class="sub">Signed in as <b>' + esc(SESSION.name) + '</b> — this account isn’t an admin.</p>'
        : '<div class="sp-signin"><button id="mod-discord" class="btn-discord">Sign in with Discord</button><span class="muted">if you’re an admin</span></div>');
    const go = () => { const t = $('mod-token').value.trim(); if (t) { localStorage.setItem('mnmdb-admin', t); renderModerate(); } };
    $('mod-signin').addEventListener('click', go);
    $('mod-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const dc = $('mod-discord'); if (dc) dc.addEventListener('click', () => { location.href = API_BASE + '/auth/discord/start'; });
    return;
  }
  $('content').innerHTML =
    '<div class="modbar"><h1>Moderation</h1>' + (isSuper ? '' : '<span class="modwho">admin · ' + esc(SESSION.name) + '</span>') + '<button id="mod-signout">Sign out</button></div>' +
    '<div id="mod-trusted" class="modtrusted"></div>' +
    (isSuper ? '<div id="mod-admins" class="modtrusted"></div>' : '') +
    '<div id="mod-maps"></div>' +
    '<div id="mod-list"><p class="sub">Loading…</p></div>' +
    '<div class="modmanage"><button id="mod-manage-btn">⚙ Manage approved markers</button><div id="mod-manage"></div></div>' +
    '<div class="modmanage"><button id="mod-maps-btn">⚙ Manage approved maps</button><div id="mod-maps-manage"></div></div>';
  $('mod-signout').addEventListener('click', () => { if (mod) localStorage.removeItem('mnmdb-admin'); else signOut(); renderModerate(); });
  $('mod-manage-btn').addEventListener('click', async () => {
    const box = $('mod-manage'), btn = $('mod-manage-btn');
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; btn.textContent = '⚙ Manage approved markers'; return; }
    box.dataset.open = '1'; btn.textContent = '▾ Hide approved markers'; box.innerHTML = '<p class="sub">Loading…</p>';
    let j; try { j = await (await fetch(API_BASE + '/admin/markers', { headers: { Authorization: 'Bearer ' + creds } })).json(); }
    catch { box.innerHTML = '<p class="sp-status err">Network error.</p>'; return; }
    renderMarkerList(box, j.markers || [], adminAuth, { showView: true });
  });
  $('mod-maps-btn').addEventListener('click', () => {
    const box = $('mod-maps-manage'), btn = $('mod-maps-btn');
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; btn.textContent = '⚙ Manage approved maps'; return; }
    box.dataset.open = '1'; btn.textContent = '▾ Hide approved maps'; box.innerHTML = '<p class="sub">Loading…</p>';
    loadApprovedMaps(creds, box);
  });
  if (isSuper) loadAdmins(creds);
  loadTrusted(creds, isSuper);
  loadPending(creds, isSuper);
  loadPendingMaps(creds);
}

// Pending map submissions — image preview + Approve / Reject. Shows nothing when empty.
async function loadPendingMaps(creds) {
  const el = $('mod-maps'); if (!el) return;
  let j; try { j = await (await fetch(API_BASE + '/admin/maps/pending', { headers: { Authorization: 'Bearer ' + creds } })).json(); } catch { return; }
  const items = j.pending || [];
  if (!items.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<h2 class="modsub">Map submissions <span class="pill">' + items.length + '</span></h2>' + items.map((m) =>
    '<div class="modmapcard" data-id="' + m.id + '">' +
      '<a class="modmapthumb" href="' + API_BASE + m.url + '" target="_blank" rel="noopener"><img src="' + API_BASE + m.url + '" alt="" loading="lazy" /></a>' +
      '<div class="modinfo">' +
        '<div class="modlabel">' + esc(m.zone) + (m.label ? ' · ' + esc(m.label) : '') + '</div>' +
        '<div class="modmeta">' + (m.width && m.height ? m.width + '×' + m.height + ' · ' : '') + (m.submitter ? 'by ' + esc(m.submitter) : '') + '</div>' +
        '<div class="modactions"><button class="primary" data-mact="approve">Approve</button><button class="danger" data-mact="reject">Reject</button></div>' +
      '</div></div>'
  ).join('');
  el.querySelectorAll('.modmapcard').forEach((card) => {
    card.querySelectorAll('[data-mact]').forEach((b) => b.addEventListener('click', async () => {
      const id = +card.dataset.id, act = b.dataset.mact;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        const r = await fetch(API_BASE + '/admin/maps/' + act, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ id }) });
        if (r.ok) { ZONEMAPS = null; card.classList.add('done'); card.querySelector('.modactions').innerHTML = '<span class="sp-status ok">' + (act === 'approve' ? 'Approved ✓ — now a map option' : 'Rejected') + '</span>'; }
        else card.querySelectorAll('button').forEach((x) => (x.disabled = false));
      } catch { card.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    }));
  });
}

// Approved community maps — delete (also purges the R2 image).
async function loadApprovedMaps(creds, box) {
  let j; try { j = await (await fetch(API_BASE + '/admin/maps', { headers: { Authorization: 'Bearer ' + creds } })).json(); }
  catch { box.innerHTML = '<p class="sp-status err">Network error.</p>'; return; }
  const items = j.maps || [];
  if (!items.length) { box.innerHTML = '<p class="sub">No approved community maps yet.</p>'; return; }
  box.innerHTML = items.map((m) =>
    '<div class="mmrow" data-id="' + m.id + '">' +
      '<a class="modmapthumb sm" href="' + API_BASE + m.url + '" target="_blank" rel="noopener"><img src="' + API_BASE + m.url + '" alt="" /></a>' +
      '<span class="mmlabel">' + esc(m.zone) + (m.label ? ' · ' + esc(m.label) : '') + '</span>' +
      '<span class="mmmeta muted">' + (m.submitter ? 'by ' + esc(m.submitter) : '') + '</span>' +
      '<span class="mmbtns"><button class="danger" data-mdel>Delete</button></span></div>'
  ).join('');
  box.querySelectorAll('.mmrow').forEach((row) => {
    row.querySelector('[data-mdel]').addEventListener('click', async () => {
      if (!confirm('Delete this map? Any markers placed on it will be orphaned.')) return;
      row.querySelector('button').disabled = true;
      try { const r = await fetch(API_BASE + '/admin/maps/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ id: +row.dataset.id }) });
        if (r.ok) { ZONEMAPS = null; row.remove(); } else row.querySelector('button').disabled = false; } catch { row.querySelector('button').disabled = false; }
    });
  });
}

// The per-user admin chips (super-admin only): promote by trusting first, demote with ✕.
async function loadAdmins(creds) {
  const el = $('mod-admins');
  if (!el) return;
  let j; try { j = await (await fetch(API_BASE + '/admin/admins', { headers: { Authorization: 'Bearer ' + creds } })).json(); } catch { return; }
  const list = j.admins || [];
  el.innerHTML = '<span class="modtrusted-lbl">Admins</span> ' +
    (list.length
      ? list.map((a) => '<span class="trustchip trustchip-admin">' + esc(a.name || a.discord_id) + '<button data-demote="' + esc(String(a.discord_id)) + '" title="Remove admin" aria-label="Remove">✕</button></span>').join('')
      : '<span class="muted">none yet — use ⬆ Make admin on a verified person below.</span>');
  el.querySelectorAll('[data-demote]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fetch(API_BASE + '/admin/demote', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ discord_id: b.dataset.demote }) }); } catch {}
    loadAdmins(creds);
  }));
}

async function loadPending(creds, isSuper) {
  const list = $('mod-list');
  let j;
  try {
    const r = await fetch(API_BASE + '/admin/pending', { headers: { Authorization: 'Bearer ' + creds } });
    if (r.status === 401) { localStorage.removeItem('mnmdb-admin'); list.innerHTML = '<p class="sp-status err">Wrong password.</p>'; setTimeout(renderModerate, 1000); return; }
    j = await r.json();
  } catch { list.innerHTML = '<p class="sp-status err">Network error — try again.</p>'; return; }
  const items = j.pending || [];
  if (!items.length) { list.innerHTML = '<p class="sub">🎉 Queue is clear — nothing pending.</p>'; return; }
  const catById = {}; (MAPS.categories || []).forEach((c) => { catById[c.id] = c; });
  list.innerHTML = '<p class="sub">' + items.length + ' pending</p>' + items.map((m) => {
    const c = catById[m.category] || { name: m.category, color: '#b0bec5', icon: '📍' };
    const z = (MAPS.zones || []).find((x) => x.name === m.zone);
    const preview = z && z.image
      ? '<div class="modprev"><img src="maps/' + encodeURIComponent(z.image) + mapVer() + '" alt="" />' +
        '<span class="mk mk-temp modpin" data-px="' + m.x + '" data-py="' + m.y + '"></span></div>'
      : '<div class="modprev modprev-none">no map</div>';
    return '<div class="modcard" data-id="' + m.id + '">' + preview +
      '<div class="modinfo">' +
        '<div class="modlabel"><span class="mdot" style="background:' + c.color + '"></span>' + esc(m.label) + (m.verified ? ' <span class="vbadge">✓ verified</span>' : '') + '</div>' +
        '<div class="modmeta">' + esc(c.name) + ' · ' + esc(m.zone) + ' · (' + m.x + ', ' + m.y + ')' + (m.submitter ? ' · by ' + esc(m.submitter) : '') + '</div>' +
        '<div class="modmeta muted">' + esc(String(m.created_at || '').replace('T', ' ').replace(/\..*$/, '')) + ' UTC</div>' +
        '<div class="modactions"><button class="primary" data-act="approve">Approve</button>' +
        '<button class="danger" data-act="reject">Reject</button>' +
        (m.verified && m.discord_id ? '<button class="trustbtn" data-trust="' + esc(String(m.discord_id)) + '" data-name="' + esc(m.submitter || '') + '">★ Trust ' + esc(m.submitter || 'this user') + '</button>' : '') +
        (isSuper && m.verified && m.discord_id ? '<button class="adminbtn" data-makeadmin="' + esc(String(m.discord_id)) + '" data-name="' + esc(m.submitter || '') + '">⬆ Make admin</button>' : '') +
        '</div>' +
      '</div></div>';
  }).join('');
  // position each preview pin once its image knows its natural size
  list.querySelectorAll('.modpin').forEach((pin) => {
    const img = pin.previousElementSibling;
    const pos = () => { pin.style.left = (pin.dataset.px / (img.naturalWidth || 1) * 100) + '%'; pin.style.top = (pin.dataset.py / (img.naturalHeight || 1) * 100) + '%'; };
    if (img.complete && img.naturalWidth) pos(); else img.addEventListener('load', pos);
  });
  const byId = {}; items.forEach((m) => (byId[m.id] = m));
  list.querySelectorAll('.modcard').forEach((card) => {
    const m = byId[+card.dataset.id];
    const c = catById[m.category] || { name: m.category, color: '#b0bec5', icon: '📍' };
    const z = (MAPS.zones || []).find((x) => x.name === m.zone);
    const prev = card.querySelector('.modprev');
    if (prev && z && z.image) {
      prev.classList.add('zoomable'); prev.title = 'Click to preview full size';
      prev.addEventListener('click', () => openMapLightbox(
        'maps/' + encodeURIComponent(z.image) + mapVer(),
        [{ x: m.x, y: m.y, label: m.label, icon: c.icon, color: c.color, community: true }],
        '<b>' + esc(m.label) + '</b> &nbsp;<span class="lbtag"><span class="mdot" style="background:' + c.color + '"></span>' + esc(c.name) + '</span>&nbsp; ' + esc(m.zone) + ' · (' + m.x + ', ' + m.y + ')' + (m.submitter ? ' · by ' + esc(m.submitter) : '')));
    }
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const id = +card.dataset.id, act = b.dataset.act;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        const r = await fetch(API_BASE + '/admin/' + act, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ id }),
        });
        if (r.ok) {
          card.classList.add('done');
          card.querySelector('.modactions').innerHTML = '<span class="sp-status ok">' + (act === 'approve' ? 'Approved ✓ — live on the map' : 'Rejected') + '</span>';
          COMMUNITY = null; // refresh the map cache so an approved marker shows on next visit
        } else { card.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
      } catch { card.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    }));
    const tb = card.querySelector('[data-trust]');
    if (tb) tb.addEventListener('click', async () => {
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        const r = await fetch(API_BASE + '/admin/trust', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ discord_id: tb.dataset.trust, name: tb.dataset.name }),
        });
        if (r.ok) { COMMUNITY = null; loadTrusted(creds, isSuper); loadPending(creds, isSuper); }
        else card.querySelectorAll('button').forEach((x) => (x.disabled = false));
      } catch { card.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    });
    const ab = card.querySelector('[data-makeadmin]');
    if (ab) ab.addEventListener('click', async () => {
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        const r = await fetch(API_BASE + '/admin/promote', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ discord_id: ab.dataset.makeadmin, name: ab.dataset.name }),
        });
        if (r.ok) { COMMUNITY = null; loadAdmins(creds); loadTrusted(creds, isSuper); loadPending(creds, isSuper); }
        else card.querySelectorAll('button').forEach((x) => (x.disabled = false));
      } catch { card.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    });
  });
}

// The trusted-contributor chips at the top of the moderation page (each removable).
// The super-admin also gets a ⬆ on each chip to promote a trusted person to full admin.
async function loadTrusted(creds, isSuper) {
  const el = $('mod-trusted');
  if (!el) return;
  let j; try { j = await (await fetch(API_BASE + '/admin/trusted', { headers: { Authorization: 'Bearer ' + creds } })).json(); } catch { return; }
  const list = j.trusted || [];
  el.innerHTML = '<span class="modtrusted-lbl">Trusted contributors</span> ' +
    (list.length
      ? list.map((t) => '<span class="trustchip">' + esc(t.name || t.discord_id) +
          (isSuper ? '<button class="chip-up" data-makeadmin="' + esc(String(t.discord_id)) + '" data-name="' + esc(t.name || '') + '" title="Make admin" aria-label="Make admin">⬆</button>' : '') +
          '<button data-untrust="' + esc(String(t.discord_id)) + '" title="Remove trust" aria-label="Remove">✕</button></span>').join('')
      : '<span class="muted">none yet — use ★ Trust on a verified submission below.</span>');
  el.querySelectorAll('[data-untrust]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fetch(API_BASE + '/admin/untrust', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ discord_id: b.dataset.untrust }) }); } catch {}
    loadTrusted(creds, isSuper);
  }));
  el.querySelectorAll('[data-makeadmin]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fetch(API_BASE + '/admin/promote', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + creds }, body: JSON.stringify({ discord_id: b.dataset.makeadmin, name: b.dataset.name }) }); } catch {}
    loadAdmins(creds);
  }));
}

// Shared marker manager (relabel/recategorize + delete), used by the admin "manage
// approved markers" view and a contributor's "my markers" page. `auth` is { bearer } for
// the admin or { session } for a signed-in owner; the Worker enforces who may touch what.
function markerAuthReq(auth, extra) {
  const headers = { 'Content-Type': 'application/json' };
  const body = Object.assign({}, extra);
  if (auth.bearer) headers.Authorization = 'Bearer ' + auth.bearer;
  if (auth.session) body.session = auth.session;
  return { headers, body: JSON.stringify(body) };
}
function renderMarkerList(el, markers, auth, opts) {
  opts = opts || {};
  const catById = {}; (MAPS.categories || []).forEach((c) => (catById[c.id] = c));
  if (!markers.length) { el.innerHTML = '<p class="sub">No markers.</p>'; return; }
  el.innerHTML = markers.map((m) => {
    const c = catById[m.category] || { name: m.category, color: '#b0bec5' };
    return '<div class="mmrow" data-id="' + m.id + '">' +
      '<span class="mdot" style="background:' + c.color + '"></span>' +
      '<span class="mmlabel">' + esc(m.label) + '</span>' +
      '<span class="mmmeta muted">' + esc(c.name) + ' · ' + esc(m.zone) + (m.status && m.status !== 'approved' ? ' · ' + esc(m.status) : '') + '</span>' +
      '<span class="mmbtns">' + (opts.showView ? '<a class="mmview" href="#/map/' + encodeURIComponent(m.zone) + '">View marker</a>' : '') + '<button data-mm="edit">Edit</button><button class="danger" data-mm="del">Delete</button></span></div>';
  }).join('');
  const byId = {}; markers.forEach((m) => (byId[m.id] = m));
  el.querySelectorAll('.mmrow').forEach((row) => {
    const m = byId[+row.dataset.id];
    const dis = (v) => row.querySelectorAll('button').forEach((b) => (b.disabled = v));
    row.querySelector('[data-mm=del]').addEventListener('click', async () => {
      if (!confirm('Delete “' + m.label + '”? This removes it from the map.')) return;
      dis(true);
      try { const r = await fetch(API_BASE + '/marker/delete', Object.assign({ method: 'POST' }, markerAuthReq(auth, { id: m.id })));
        if (r.ok) { COMMUNITY = null; row.remove(); if (opts.onDelete) opts.onDelete(); } else dis(false); } catch { dis(false); }
    });
    row.querySelector('[data-mm=edit]').addEventListener('click', () => {
      const opts = (MAPS.categories || []).map((c) => '<option value="' + c.id + '"' + (c.id === m.category ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.name) + '</option>').join('');
      row.classList.add('editing');
      row.innerHTML = '<input class="mm-elabel" maxlength="80" value="' + esc(m.label) + '" />' +
        '<select class="mm-ecat">' + opts + '</select>' +
        '<span class="mmbtns"><button class="primary" data-mm="save">Save</button><button data-mm="cancel">Cancel</button></span>';
      row.querySelector('[data-mm=cancel]').addEventListener('click', () => renderMarkerList(el, markers, auth));
      row.querySelector('[data-mm=save]').addEventListener('click', async () => {
        const label = row.querySelector('.mm-elabel').value.trim();
        const category = row.querySelector('.mm-ecat').value;
        if (!label) return;
        row.querySelectorAll('button').forEach((b) => (b.disabled = true));
        try { const r = await fetch(API_BASE + '/marker/edit', Object.assign({ method: 'POST' }, markerAuthReq(auth, { id: m.id, label, category })));
          if (r.ok) { m.label = label; m.category = category; COMMUNITY = null; renderMarkerList(el, markers, auth); }
          else row.querySelectorAll('button').forEach((b) => (b.disabled = false)); } catch { row.querySelectorAll('button').forEach((b) => (b.disabled = false)); }
      });
    });
  });
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

// ---- Database Quest Board — gaps in the live data become claimable bounties ----

const APP_DOWNLOAD = 'https://github.com/' + FEEDBACK_REPO + '/releases/latest';
const WIKI_HOME = 'https://monstersandmemories.miraheze.org';
// A "go to page" wiki search — resolves to the right page even when our name differs
// (e.g. "a Fellstone guard" → the wiki's "Fellstone Guard"); strips the leading article.
const questWikiUrl = (name) => WIKI_HOME + '/w/index.php?title=Special:Search&go=Go&search=' + encodeURIComponent(String(name).replace(/^(a|an|the)\s+/i, ''));

// Each bounty is computed from the current data, so its count shrinks as it's filled.
function questBounties() {
  const items = DATA.items;
  const mobs = Object.entries(DATA.mobs);
  return {
    unpriced: {
      tag: 'data', tagLabel: 'Data · in-game', title: 'Appraise the Unpriced', reward: 'Merchant renown', diff: 1,
      flav: 'items have no known value yet. Player sale prices come in automatically from the live auction feed — add a vendor price to fill in the rest.',
      how: 'Add the vendor “Base Price” to the item’s wiki page (linked by each item below) and it’s pulled in on the next refresh. Player sale prices are read automatically from the LiveMNM auction stream, so an unpriced item just hasn’t been auctioned yet.',
      list: items.filter((it) => itemMarketValue(it.name).value <= 0)
        .map((it) => ({ name: it.name, href: '#/item/' + encodeURIComponent(it.id) })),
    },
    unleveled: {
      tag: 'data', tagLabel: 'Data · in-game', title: 'Con the Unknown', reward: "Scout’s eye", diff: 1,
      flav: 'mobs you’ve fought have no level. /con them and report the colour so they slot into the value-by-level brackets.',
      how: 'Add the level to the mob’s wiki page (linked by each mob below); the wiki level overrides our estimate on the next refresh. No app needed — just /con it in game first.',
      list: mobs.filter(([, d]) => !Number.isFinite(mobLevel(d)) && (d.corpses > 0 || d.kills > 0))
        .map(([name]) => ({ name, href: '#/mob/' + encodeURIComponent(name) })),
    },
    sourceless: {
      tag: 'data', tagLabel: 'Data · in-game', title: 'Trace Lost Sources', reward: 'Pathfinder', diff: 2,
      flav: 'items have no known origin — no drop, gather, or recipe on record. Help us find where they come from.',
      how: 'Note where it drops or is gathered on the item’s wiki page (linked below) — or just loot/gather it in the companion app and it records automatically.',
      list: items.filter((it) => !isGatherableRaw(it.name) && !recipesByResult[it.name.toLowerCase()] && itemMarketValue(it.name).value <= 0)
        .map((it) => ({ name: it.name, href: '#/item/' + encodeURIComponent(it.id) })),
    },
    unmapped: {
      tag: 'maps', tagLabel: 'Maps', title: 'Chart the Unmapped', reward: 'Cartographer', diff: 2,
      flav: 'zones still have no map. Track down a top-down map image so others can navigate them.',
      how: 'Find a top-down map on the zone’s wiki page (linked below) and share it — maps are imported and published from the companion app.',
      list: (MAPS.zones || []).filter((z) => z.comingSoon || !z.image)
        .map((z) => ({ name: z.name, href: '#/maps' })),
    },
  };
}

const questStars = (n) => '★'.repeat(Math.max(1, Math.min(3, n))) + '☆'.repeat(Math.max(0, 3 - Math.max(1, Math.min(3, n))));

function renderQuests() {
  const items = DATA.items, mobs = Object.entries(DATA.mobs);
  const priced = items.filter((it) => itemMarketValue(it.name).value > 0).length;
  const leveled = mobs.filter(([, d]) => Number.isFinite(mobLevel(d))).length;
  const pct = items.length ? Math.round((priced / items.length) * 100) : 0;
  const B = questBounties();
  const bountyCards = Object.entries(B).map(([slug, b]) =>
    '<div class="quest"><span class="qtag ' + b.tag + '">' + esc(b.tagLabel) + '</span>' +
    '<h3>' + esc(b.title) + '</h3>' +
    '<p class="qflav"><span class="qcount">' + b.list.length + '</span> ' + esc(b.flav) + '</p>' +
    '<div class="qmeta"><span class="qdiff">' + questStars(b.diff) + '</span></div>' +
    (b.list.length
      ? '<a class="btn-link qgo" href="#/quests/' + slug + '">See the list →</a>'
      : '<span class="qmeta qgo">All done 🎉</span>') +
    '</div>').join('');
  const devCards = (QUESTS || []).map((q) => {
    const link = 'https://github.com/' + FEEDBACK_REPO + '/issues/new?labels=quest&title=' + encodeURIComponent('[Quest] ' + q.title);
    return '<div class="quest"><span class="qtag dev">Dev · code</span>' +
      '<h3>' + esc(q.title) + '</h3>' +
      '<p class="qflav">' + esc(q.blurb) + '</p>' +
      '<div class="qmeta"><span class="qdiff">' + questStars(q.difficulty || 1) + '</span></div>' +
      '<a class="btn-link qgo" href="' + link + '" target="_blank" rel="noopener">Claim on GitHub ↗</a></div>';
  }).join('');
  $('content').innerHTML =
    '<div class="home-intro"><h1>Database Quest Board</h1>' +
    '<p class="sub">Help complete the Monsters &amp; Memories Economy Database. Most quests just need you to play — the bounties below come straight from the database’s current gaps and shrink as they’re filled.</p>' +
    '<div class="qb-prog" title="' + priced + ' of ' + items.length + ' items priced"><i style="width:' + pct + '%"></i></div>' +
    '<p class="sub">' + priced + ' of ' + items.length + ' items priced · ' + leveled + ' of ' + mobs.length + ' mobs leveled</p>' +
    '<p class="sub"><span class="qdiff">★★★</span> = difficulty — one star is a quick errand, three is a deeper effort.</p></div>' +
    '<h2>Data bounties</h2><p class="sub">No coding needed — fill these on the wiki or with the companion app.</p>' +
    '<div class="quests">' + bountyCards + '</div>' +
    '<div class="note">Two ways to help, no account here required: edit the community <a href="' + WIKI_HOME + '" target="_blank" rel="noopener">wiki</a> — each mob/item in a list links straight to its page, and edits flow in on the next refresh — or <a href="' + APP_DOWNLOAD + '" target="_blank" rel="noopener">download the companion app</a> to record prices, loot and drops automatically as you play.</div>' +
    '<h2>Dev quests</h2><p class="sub">For the coders — pulled from the roadmap.</p>' +
    '<div class="quests">' + (devCards || '<p class="muted">No dev quests posted yet.</p>') + '</div>' +
    '<div class="note">Spot a gap we’re missing, or want to add a coding quest? Edit <b>quests.json</b> or the ROADMAP on GitHub, or hit <b>Give feedback</b> in the footer.</div>';
}

function renderQuestList(slug) {
  const b = questBounties()[slug];
  if (!b) return renderQuests();
  const rows = b.list.map((x) => '<li><a href="' + x.href + '">' + esc(x.name) + '</a>' +
    '<a class="wlink" href="' + questWikiUrl(x.name) + '" target="_blank" rel="noopener">edit on wiki ↗</a></li>').join('');
  $('content').innerHTML =
    '<div class="crumb"><a href="#/quests">Database Quest Board</a> › ' + esc(b.title) + '</div>' +
    '<h1>' + esc(b.title) + '</h1>' +
    '<p class="sub">' + b.list.length + ' ' + esc(b.flav) + '</p>' +
    '<div class="note"><b>How to help:</b> ' + esc(b.how) + '</div>' +
    (b.list.length
      ? '<div class="card"><ul class="plain">' + rows + '</ul></div>'
      : '<p class="muted">All done — nothing left on this quest. 🎉</p>');
}

// ---- Auction House (player market from the LiveMNM OCR feed) ----
let AUCTIONS = null;
const aucCoin = (c) => { if (c == null) return null; let x = c; const p = Math.floor(x / 1e6); x %= 1e6; const g = Math.floor(x / 1e4); x %= 1e4; const s = Math.floor(x / 100); x %= 100; return [p ? p + 'p' : '', g ? g + 'g' : '', s ? s + 's' : '', x ? x + 'c' : ''].filter(Boolean).join(' ') || '0c'; };
const aucTag = (i) => i === 'sell' ? '<span class="atag sell">WTS</span>' : i === 'buy' ? '<span class="atag buy">WTB</span>' : i === 'trade' ? '<span class="atag trade">WTT</span>' : i === 'inquiry' ? '<span class="atag pc">PC</span>' : '<span class="atag">?</span>';

async function renderAuctions() {
  if (!AUCTIONS) {
    $('content').innerHTML = '<div class="crumb"><a href="#/">MnMdb</a> › auctions</div><h1>Auction House</h1><p class="sub">Loading live market…</p>';
    try { AUCTIONS = await (await fetch('./auctions.json?v=' + Date.now())).json(); } catch { AUCTIONS = { listings: [], requests: [], stats: {}, generatedAt: null }; }
  }
  const A = AUCTIONS;
  const priced = A.listings.filter((l) => l.price != null).length;
  const when = A.generatedAt ? new Date(A.generatedAt).toLocaleString() : '—';
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › auctions</div><h1>Auction House</h1>' +
    '<div class="auc-paused">⏸ Auction data collection is paused — please visit the <a href="https://www.twitch.tv/livemnm" target="_blank" rel="noopener">LiveMNM stream ↗</a> for live data.</div>' +
    '<p class="sub">Player buy/sell auctions read from the <a href="https://www.twitch.tv/livemnm" target="_blank" rel="noopener">LiveMNM stream ↗</a> — PvP and PvE are separate markets. ' +
    '<span id="auc-meta"></span> Hover an item for its stats.</p>' +
    '<div class="auc-controls"><input id="auc-q" placeholder="Search item or seller…">' +
    '<select id="auc-sort"><option value="new">Newest</option><option value="price">Price (high→low)</option><option value="item">Item name</option></select>' +
    '<button id="auc-priced" class="toggle-btn" type="button" aria-pressed="false">Prices Only</button></div>' +
    '<div class="auc-cols"><div class="auc-panel"><div class="auc-head">PvP <span id="auc-pvp-n" class="muted"></span></div><div id="auc-pvp"></div></div>' +
    '<div class="auc-panel"><div class="auc-head">PvE <span id="auc-pve-n" class="muted"></span></div><div id="auc-pve"></div></div></div>' +
    '<div class="auc-panel" style="margin-top:16px"><div class="auc-head">🛠 Crafting / gear requests <span class="muted" id="auc-reqn"></span></div><div id="auc-reqs"></div></div>';
  ['auc-q', 'auc-sort'].forEach((id) => { const el = $(id); if (el) { el.addEventListener('input', paintAuctions); el.addEventListener('change', paintAuctions); } });
  const pb = $('auc-priced');
  if (pb) pb.addEventListener('click', () => { const on = pb.getAttribute('aria-pressed') !== 'true'; pb.setAttribute('aria-pressed', String(on)); pb.classList.toggle('is-on', on); paintAuctions(); });
  paintAuctions(); aucReqs(); aucHoverInit(); aucUpdateMeta(); aucAutoRefreshInit();
}
const onAuctionsPage = () => decodeURIComponent(location.hash.replace(/^#\/?/, '')) === 'auctions';
// Header line: counts + how long ago the data was published (kept fresh by the tick).
function aucUpdateMeta() {
  const el = $('auc-meta'); if (!el || !AUCTIONS) return;
  const priced = AUCTIONS.listings.filter((l) => l.price != null).length;
  el.innerHTML = '<b>' + AUCTIONS.listings.length + '</b> listings · ' + priced + ' priced · ' + aucReqRecentCount() +
    ' requests (24h) · updated ' + esc(aucAgo(AUCTIONS.generatedAt) || '—');
}
// Poll for a newer auctions.json; if the data changed, swap it in and repaint —
// but not while the user is mid-hover or typing a search (don't yank the DOM).
async function aucCheckForUpdate() {
  if (!onAuctionsPage()) return;
  const pop = $('auc-pop'), q = $('auc-q');
  if ((pop && pop.classList.contains('show')) || (q && document.activeElement === q)) return;
  try {
    const fresh = await (await fetch('./auctions.json?v=' + Date.now())).json();
    if (fresh && fresh.generatedAt && (!AUCTIONS || fresh.generatedAt !== AUCTIONS.generatedAt)) {
      AUCTIONS = fresh;
      paintAuctions(); aucReqs(); aucUpdateMeta();
      const m = $('auc-meta'); if (m) { m.classList.remove('auc-flash'); void m.offsetWidth; m.classList.add('auc-flash'); }
    }
  } catch {}
}
// Keep the page feeling live: every minute refresh the "x ago" times in place
// (no repaint, so hovers aren't disturbed) and every ~3 min check for new data.
// Also checks whenever the tab regains focus. Stops when you leave the page.
let aucRefreshTimer = null, aucRefreshWired = false;
function aucAutoRefreshInit() {
  clearInterval(aucRefreshTimer);
  let ticks = 0;
  aucRefreshTimer = setInterval(() => {
    if (!onAuctionsPage()) { clearInterval(aucRefreshTimer); aucRefreshTimer = null; return; }
    document.querySelectorAll('#content .aw[data-seen]').forEach((c) => { c.textContent = aucAgo(c.getAttribute('data-seen')); });
    aucUpdateMeta();
    if (++ticks % 3 === 0) aucCheckForUpdate();
  }, 60000);
  if (!aucRefreshWired) {
    aucRefreshWired = true;
    const onShow = () => { if (!document.hidden) aucCheckForUpdate(); };
    window.addEventListener('focus', onShow);
    document.addEventListener('visibilitychange', onShow);
  }
}
const AUC_RECENT_N = 50; // recent feed shows this many live rows before compressing older ones
const aucPricedOnly = () => { const b = $('auc-priced'); return !b || b.getAttribute('aria-pressed') === 'true'; };
// Base filter for one server: search + priced-only toggle.
function aucBase(server) {
  const q = ($('auc-q').value || '').trim().toLowerCase();
  let rs = AUCTIONS.listings.filter((l) => l.server === server);
  if (q) rs = rs.filter((l) => (l.item + ' ' + l.player).toLowerCase().includes(q));
  return rs;
}
// "Recent activity" — raw per-post feed, most recent first (a live scrolling
// feed). No-price rows sit in their chronological place, greyed, and only when
// "Priced Listings Only" is off.
function aucRecentRows(server) {
  const pricedOnly = aucPricedOnly(), sort = $('auc-sort').value;
  let rs = aucBase(server);
  if (pricedOnly) rs = rs.filter((l) => l.price != null);
  return rs.sort((a, b) =>
    sort === 'item' ? a.item.localeCompare(b.item) :
    sort === 'price' ? aucUnit(b) - aucUnit(a) : // compare on per-unit price
    (b.seen || '').localeCompare(a.seen || '')); // default: newest first
}
// Per-unit price for a listing (normalized at publish time); 0 if unpriced.
const aucUnit = (l) => l.unit != null ? l.unit : (l.price || 0);
// Collapse a set of listings to one entry per item: sell-price range + how many
// are selling / buying it. Used for the compressed tail of the ticker feed.
function aggregateItems(list) {
  const map = new Map();
  for (const l of list) {
    const k = l.item.toLowerCase();
    let g = map.get(k);
    if (!g) { g = { item: l.item, matched: l.matched, sellers: new Set(), buyers: new Set(), prices: [], sightings: 0 }; map.set(k, g); }
    g.sightings += (l.count || 1); // total times this item was read — the "most seen" measure
    if (l.intent === 'buy') g.buyers.add(l.player);
    else { g.sellers.add(l.player); if (l.price != null) g.prices.push(aucUnit(l)); } // per-unit, so ranges compare fairly
  }
  return [...map.values()].map((g) => ({
    item: g.item, matched: g.matched, sellers: g.sellers.size, buyers: g.buyers.size, sightings: g.sightings,
    low: g.prices.length ? Math.min.apply(null, g.prices) : null,
    high: g.prices.length ? Math.max.apply(null, g.prices) : null,
    priced: g.prices.length > 0,
  }));
}
const aucPriceCell = (priced, low, high) => priced ? (low === high ? esc(aucCoin(low)) : esc(aucCoin(low)) + '–' + esc(aucCoin(high))) : '<span class="muted">—</span>';
// Listing time, in the viewer's local timezone (e.g. "Jul 6, 5:03 PM"), with the
// full timestamp on hover — so you can track when something was posted.
const aucTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
// Relative "how long ago" — easier to gauge if the seller might still be around.
// The exact timestamp is preserved in the data (seen) and shown on hover.
const aucAgo = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' hr' + (h === 1 ? '' : 's') + ' ago';
  const dy = Math.round(h / 24); return dy + ' day' + (dy === 1 ? '' : 's') + ' ago';
};
// Price cell — shows the per-unit price with an "ea" tag when a quantity/stack was
// listed (the whole-lot total is on hover); otherwise the plain price.
function aucPriceDisplay(l) {
  if (l.price == null) return '<span class="muted">—</span>';
  const multi = l.perStack || (l.qty && l.qty > 1);
  if (multi && l.unit != null) {
    const q = l.perStack ? 'stack (20)' : '×' + l.qty;
    return esc(aucCoin(l.unit)) + ' <span class="muted" title="' + q + ' = ' + esc(aucCoin(l.price)) + '">ea</span>';
  }
  return esc(l.priceStr || aucCoin(l.price));
}
const aucRecentRowHtml = (l) =>
  '<tr data-item="' + esc(l.item) + '"' + (l.price == null ? ' class="noprice"' : '') + '><td class="at">' + aucTag(l.intent) + (l.assumed ? '<span class="amute" title="intent inferred">?</span>' : '') + '</td>' +
  '<td class="ai">' + (l.matched ? itemLink(l.item, l.item) : esc(l.item)) + (l.qty ? ' <span class="muted">×' + l.qty + '</span>' : '') + '</td>' +
  '<td class="ap">' + aucPriceDisplay(l) + '</td>' +
  '<td class="muted">' + esc(l.player) + '</td>' +
  '<td class="aw muted" data-seen="' + esc(l.seen || '') + '" title="' + esc(aucTime(l.seen)) + '">' + esc(aucAgo(l.seen)) + '</td></tr>';
const aucItemRowHtml = (g) =>
  '<tr data-item="' + esc(g.item) + '"' + (g.priced ? '' : ' class="noprice"') + '>' +
  '<td class="ai">' + (g.matched ? itemLink(g.item, g.item) : esc(g.item)) + '</td>' +
  '<td class="ap">' + aucPriceCell(g.priced, g.low, g.high) + '</td>' +
  '<td class="muted">' + g.sellers + ' selling' + (g.buyers ? ' · ' + g.buyers + ' buying' : '') +
  (g.sightings ? ' · <span title="times seen in the feed">seen ' + g.sightings + '×</span>' : '') + '</td></tr>';
const aucTable = (rowsHtml) => '<table class="auc"><tbody>' + rowsHtml + '</tbody></table>';
const AUC_MAX_ITEMS = 250; // cap what the page shows; search still spans the whole published set
const AUC_TOP_ITEMS = 50;  // grouped tail shows only the 50 most-seen items per server
function paintAuctions() {
  const searching = ($('auc-q').value || '').trim().length > 0;
  for (const [srv, id] of [['PvP', 'auc-pvp'], ['PvE', 'auc-pve']]) {
    const rs = aucRecentRows(srv);
    $(id + '-n').textContent = rs.length;
    const recent = rs.slice(0, AUC_RECENT_N), older = rs.slice(AUC_RECENT_N);
    let html = recent.length ? aucTable(recent.map(aucRecentRowHtml).join('')) : '<div class="auc-empty">No listings.</div>';
    if (older.length) {
      // Rank the grouped tail by how often each item was seen and show only the top
      // 50 — the long low-activity tail past that isn't useful (search still reaches it).
      let agg = aggregateItems(older).sort((a, b) => b.sightings - a.sightings || b.sellers - a.sellers || a.item.localeCompare(b.item));
      if (aucPricedOnly()) agg = agg.filter((g) => g.priced); // keep the grouped tail consistent with the filter
      const total = agg.length;
      if (!searching) agg = agg.slice(0, AUC_TOP_ITEMS);
      if (agg.length) html += '<div class="auc-subhead">Top ' + agg.length + ' most-seen item' + (agg.length === 1 ? '' : 's') +
        (total > agg.length ? ' <span class="muted">(' + (total - agg.length) + ' more — search to find them)</span>' : '') + '</div>' + aucTable(agg.map(aucItemRowHtml).join(''));
    }
    $(id).innerHTML = html;
  }
}
// When a request was last seen (falls back to first-seen for older data).
const aucReqWhen = (r) => new Date(r.lastSeen || r.seen || 0).getTime();
// A short label for a request — its stat/category ask, or the raw text.
const aucReqLabel = (r) => [r.plus && r.plus.length ? '+' + r.plus.join('/') : '', (r.stats || []).join('/'), r.category].filter(Boolean).join(' ') || (r.text || '').trim();
const aucReqRecentCount = () => (AUCTIONS && AUCTIONS.requests || []).filter((r) => aucReqWhen(r) >= Date.now() - 24 * 3600 * 1000).length;
// Requests: a "most requested (last 7 days)" demand summary + the raw feed limited
// to the last 24h. Anything older than a day isn't useful, so it's dropped from the
// live list but still counts toward the weekly demand picture.
function aucReqs() {
  const rq = (AUCTIONS.requests || []);
  const now = Date.now(), day = 24 * 3600 * 1000, week = 7 * day;

  // Most-requested asks over the last 7 days, grouped by their stat/category label
  // and ranked by how many distinct players asked.
  const demand = new Map();
  for (const r of rq) {
    if (aucReqWhen(r) < now - week) continue;
    const key = aucReqLabel(r).toLowerCase(); if (!key) continue;
    let g = demand.get(key);
    if (!g) { g = { label: aucReqLabel(r), players: new Set(), n: 0 }; demand.set(key, g); }
    g.players.add(r.player); g.n++;
  }
  const top = [...demand.values()].sort((a, b) => b.players.size - a.players.size || b.n - a.n).slice(0, 12);
  const topHtml = top.length
    ? '<div class="auc-demand">' + top.map((g) => '<span class="auc-dchip">' + esc(g.label) + ' <b>' + g.players.size + '</b></span>').join('') + '</div>'
    : '<div class="auc-empty">No requests in the last 7 days.</div>';

  // The live feed — last 24h only, newest first.
  const recent = rq.filter((r) => aucReqWhen(r) >= now - day).sort((a, b) => aucReqWhen(b) - aucReqWhen(a));
  const recentHtml = recent.length
    ? '<table class="auc"><tbody>' + recent.map((r) => {
        const t = r.lastSeen || r.seen || '';
        return '<tr><td class="at">' + aucTag(r.intent || 'buy') + '</td><td class="ai">' + esc(aucReqLabel(r)) + '</td><td class="muted">' + esc(r.server) + '</td><td class="muted">' + esc(r.player) +
          '</td><td class="aw muted" data-seen="' + esc(t) + '" title="' + esc(aucTime(t)) + '">' + esc(aucAgo(t)) + '</td></tr>';
      }).join('') + '</tbody></table>'
    : '<div class="auc-empty">No requests in the last 24 hours.</div>';

  $('auc-reqs').innerHTML =
    '<div class="auc-reqsub">Most requested · last 7 days <span class="muted">(number = players asking)</span></div>' + topHtml +
    '<div class="auc-reqsub">Recent · last 24 hours</div>' + recentHtml;
  const rn = $('auc-reqn'); if (rn) rn.textContent = recent.length;
}
function aucPopEl() { let el = $('auc-pop'); if (!el) { el = document.createElement('div'); el.id = 'auc-pop'; document.body.appendChild(el); } return el; }
// Full item stat-card body from a stats-like object — works for auction stats and
// for a plain wiki entry (item.wiki), so the same hover card serves every table.
function statCardInner(s) {
  const sign = (n) => (n > 0 ? '+' : '') + n;
  const chips = (ps) => '<div class="achips">' + ps.map(([k, v]) => '<span class="achip ' + (v < 0 ? 'neg' : 'pos') + '">' + esc(k) + ' ' + sign(v) + '</span>').join('') + '</div>';
  const row = (a) => a.length ? '<div class="arow">' + a.join(' · ') + '</div>' : '';
  const P = [];
  if (s.flags && s.flags.length) P.push('<div class="aflags">' + s.flags.map((f) => '<span class="aflag">' + esc(f) + '</span>').join('') + '</div>');
  if (s.effect) {
    const e = s.effect, extra = [e.trigger || '', e.castTime ? 'Cast ' + esc(e.castTime) : '', e.level ? 'Lvl ' + e.level : ''].filter(Boolean).join(' · ');
    P.push('<div class="arow aeff"><span class="muted">Effect</span> <strong>' + esc(e.name) + '</strong>' + (extra ? ' <span class="muted">(' + esc(extra) + ')</span>' : '') + effectDescHTML(e) + '</div>');
  }
  P.push(row([s.slot ? 'Slot ' + esc(s.slot) : ''].filter(Boolean)));
  if (s.dmg != null || s.delay != null || s.skill) P.push(row([s.dmg != null ? 'DMG ' + s.dmg : '', s.delay != null ? 'Delay ' + s.delay : '', s.skill ? esc(s.skill) : ''].filter(Boolean)));
  const st = Object.entries(s.stats || {}); if (s.ac != null) st.unshift(['AC', s.ac]); if (st.length) P.push(chips(st));
  const vit = []; if (s.hp != null) vit.push(['HP', s.hp]); if (s.mana != null) vit.push(['Mana', s.mana]); if (s.haste != null) vit.push(['Haste', s.haste]);
  if (vit.length) P.push(chips(vit));
  const rz = Object.entries(s.resists || {}); if (rz.length) P.push(chips(rz));
  P.push(row([s.weight != null ? 'Weight ' + s.weight : '', s.size ? 'Size ' + esc(s.size) : '', s.vendor != null ? 'Vendor ' + esc(aucCoin(s.vendor)) : ''].filter(Boolean)));
  if (s.container) P.push('<div class="arow"><span class="muted">Holds</span> ' + s.container.capacity + ' slots' + (s.container.maxSize ? ' · ' + esc(s.container.maxSize) + ' max' : '') + '</div>');
  if (s.class) P.push('<div class="arow"><span class="muted">Class</span> ' + esc(s.class) + '</div>');
  if (s.race) P.push('<div class="arow"><span class="muted">Race</span> ' + esc(s.race) + '</div>');
  if (s.tradeskills && s.tradeskills.length) P.push('<div class="arow"><span class="muted">Used in</span> <span class="ats">' + esc(s.tradeskills.join(', ')) + '</span></div>');
  const src = [];
  const zones = s.zones || s.wikiZones;
  if (zones && zones.length) src.push('Zones: ' + esc(zones.join(', ')));
  if (s.from && s.from.length) src.push('Drops: ' + esc(s.from.join(', ')));
  return P.filter(Boolean).join('') + (src.length ? '<div class="asrc">' + src.join('<br>') + '</div>' : '');
}
// Card for a hovered item name — prefers live auction stats (has a vendor price),
// falls back to the item's wiki entry so it works on every page.
function itemCardHTML(name) {
  const s = (AUCTIONS && AUCTIONS.stats && AUCTIONS.stats[String(name).toLowerCase()]) || (itemByName[name] && itemByName[name].wiki) || null;
  const icon = (s && s.icon) ? '<img src="' + esc(s.icon) + '" alt="">' : '';
  const head = '<div class="aph">' + icon + '<span class="apn">' + esc(name) + '</span></div>';
  if (!s) return head + '<div class="anone">No wiki info yet.</div>';
  const body = statCardInner(s);
  return head + (body.trim() ? body : '<div class="anone">No wiki info yet.</div>');
}
let hoverWired = false;
function cardHoverInit() {
  if (hoverWired) return; hoverWired = true;
  const pop = aucPopEl();
  document.addEventListener('mouseover', (e) => { const tr = e.target.closest && e.target.closest('#content tr[data-item]'); if (tr) { pop.innerHTML = itemCardHTML(tr.dataset.item); pop.classList.add('show'); } else pop.classList.remove('show'); });
  document.addEventListener('mousemove', (e) => { if (!pop.classList.contains('show')) return; const w = pop.offsetWidth || 280, h = pop.offsetHeight || 160; pop.style.left = Math.min(e.clientX + 14, window.innerWidth - w - 10) + 'px'; pop.style.top = Math.min(e.clientY + 14, window.innerHeight - h - 10) + 'px'; });
}
const aucHoverInit = cardHoverInit;   // auctions page
const itemHoverInit = cardHoverInit;  // advanced search + best in slot

// ---- Advanced (stat) search ----
const ADV_STATS = ['STR', 'STA', 'AGI', 'DEX', 'INT', 'WIS', 'CHA', 'AC', 'HP'];
const advStatOf = (w, s) => s === 'AC' ? (w.ac || 0) : s === 'HP' ? (w.hp || 0) : ((w.stats && w.stats[s]) || 0);

// Lowercased mob name → level (only mobs whose level we know). Built once.
let _mobLevels = null;
function mobLevelByName() {
  if (_mobLevels) return _mobLevels;
  _mobLevels = {};
  // Primary source: wiki levels scraped for every item dropper (keys already lowercase).
  for (const [n, l] of Object.entries(DROP_LEVELS)) if (Number.isFinite(l)) _mobLevels[n] = l;
  // Fall back to the ledger mobs (wiki level or /con estimate) where the scrape had nothing.
  for (const [n, d] of Object.entries(DATA.mobs || {})) { const l = mobLevel(d); if (Number.isFinite(l) && _mobLevels[n.toLowerCase()] == null) _mobLevels[n.toLowerCase()] = l; }
  return _mobLevels;
}
// The lowest-level mob known to drop this item (observed drops + the wiki's "from"
// list). null when no dropper's level is known. Powers the "max mob level" filter —
// a level-20 player can find gear farmable from mobs at or below their level.
function itemMinDropperLevel(i) {
  const ml = mobLevelByName();
  const names = new Set();
  (i.droppedBy || []).forEach((d) => d.mob && names.add(d.mob.toLowerCase()));
  ((i.wiki && i.wiki.from) || []).forEach((n) => names.add(String(n).toLowerCase()));
  let min = Infinity;
  for (const n of names) { const l = ml[n]; if (l != null && l < min) min = l; }
  return min === Infinity ? null : min;
}
// Advanced Search hosts two tools under one page: a stat filter and the
// Best-in-Slot builder. #/bis deep-links straight to the Best-in-slot tab.
function advShowTab(t) {
  const s = $('adv-search-panel'), b = $('adv-bis-panel');
  if (s) s.style.display = t === 'bis' ? 'none' : '';
  if (b) b.style.display = t === 'bis' ? '' : 'none';
  document.querySelectorAll('.adv-tab').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === t));
}
// Wiki slot text is messy — stray HTML entities ("PRIMARY &emsp; Two Handed"),
// typos ("CEHST"), and multi-slot items ("PRIMARY SECONDARY"). Decode + drop the
// handedness words for a plain display fallback; itemSlots() does the canonical
// tokenising (typo-fixing + multi-slot splitting) used for the dropdown + filter.
const cleanSlot = (s) => String(s || '')
  .replace(/&(?:emsp|ensp|nbsp|thinsp|#8195|#8194|#8201|#160);/gi, ' ')
  .replace(/\b(?:one|two)[\s-]*handed\b/gi, ' ')
  .replace(/\s+/g, ' ').trim().toUpperCase();
// Readable canonical slot(s) for an item, e.g. "PRIMARY (2H)" or "CHEST" — falls
// back to the cleaned raw text for odd slots itemSlots doesn't recognise (BAG, etc.).
function slotLabel(w) {
  const { slots, twoH } = itemSlots(w && w.slot);
  const base = [...slots].join(' / ');
  return base ? base + (twoH ? ' (2H)' : '') : cleanSlot(w && w.slot);
}
function renderAdvanced() {
  const tab = decodeURIComponent(location.hash.replace(/^#\/?/, '')).toLowerCase() === 'bis' ? 'bis' : 'search';
  // Canonical single slots for the dropdown; odd slots itemSlots can't map keep their cleaned name.
  const slotSet = new Set();
  for (const i of DATA.items) {
    const w = i.wiki; if (!w || !w.slot) continue;
    const { slots: ss } = itemSlots(w.slot);
    if (ss.size) ss.forEach((s) => slotSet.add(s)); else { const c = cleanSlot(w.slot); if (c) slotSet.add(c); }
  }
  const slots = [...slotSet].sort();
  const statInputs = ADV_STATS.map((s) => '<label class="adv-stat">' + s + ' ≥ <input type="number" id="adv-' + s + '" min="0" inputmode="numeric"></label>').join('');
  const statOpt = (id, blank) => '<select id="' + id + '"><option value="">' + blank + '</option>' + BIS_STATS.map((s) => '<option>' + s + '</option>').join('') + '</select>';
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › advanced search</div><h1>Advanced Search</h1>' +
    '<div class="adv-tabs">' +
      '<button class="adv-tab" type="button" data-tab="search">Stat search</button>' +
      '<button class="adv-tab" type="button" data-tab="bis">Best in slot</button>' +
    '</div>' +
    '<div id="adv-search-panel">' +
      '<p class="sub">Filter items by their stats. Leave a field blank to ignore it.</p>' +
      '<div class="adv-controls">' +
        '<input id="adv-name" placeholder="Item name contains…">' +
        '<select id="adv-slot"><option value="">Any slot</option>' + slots.map((s) => '<option>' + esc(s) + '</option>').join('') + '</select>' +
        '<input id="adv-class" placeholder="Class (e.g. FTR)">' +
        '<select id="adv-effect"><option value="">Any effect</option><option value="any">Has an effect</option><option value="Click">Clicky</option><option value="Proc">Proc / combat</option><option value="Worn">Worn</option></select>' +
        '<input id="adv-maxlvl" type="number" min="1" inputmode="numeric" placeholder="Max mob level">' +
        '<label class="adv-check"><input type="checkbox" id="adv-magic"> MAGIC only</label>' +
      '</div>' +
      '<div class="adv-stats">' + statInputs + '</div>' +
      '<div id="adv-results"></div>' +
    '</div>' +
    '<div id="adv-bis-panel">' +
      '<p class="sub">Pick a class — its wiki stat priorities fill in with balanced weights. Change any stat or type your own weight next to it (how much that stat counts toward an item’s score), and we assemble the highest-scoring wearable set. Blank a stat to ignore it.</p>' +
      '<div class="adv-controls bis-row1">' +
        '<select id="bis-class"><option value="">Any class</option>' + MNM_CLASSES.map((c) => '<option>' + c + '</option>').join('') + '</select>' +
        '<input id="bis-maxlvl" type="number" min="1" inputmode="numeric" placeholder="Max Mob Level">' +
      '</div>' +
      '<div class="adv-controls bis-row2">' +
        [1, 2, 3].map((n) => '<span class="bis-prow">' + statOpt('bis-p' + n, 'Priority ' + n + '…') +
          '<label class="bis-wlab">× <input type="number" id="bis-w' + n + '" class="bis-w" min="0" step="0.1" inputmode="decimal" value="' + BIS_WEIGHT_PRESETS.balanced[n - 1] + '"></label></span>').join('') +
      '</div>' +
      '<div id="bis-results"></div>' +
    '</div>';
  ['adv-name', 'adv-slot', 'adv-class', 'adv-effect', 'adv-maxlvl', 'adv-magic'].concat(ADV_STATS.map((s) => 'adv-' + s))
    .forEach((id) => { const el = $(id); if (el) el.addEventListener('input', paintAdvanced); });
  ['bis-p1', 'bis-p2', 'bis-p3'].forEach((id) => { const el = $(id); if (el) el.addEventListener('change', paintBis); });
  ['bis-w1', 'bis-w2', 'bis-w3', 'bis-maxlvl'].forEach((id) => { const el = $(id); if (el) el.addEventListener('input', paintBis); });
  // Picking a class auto-fills its suggested stats AND resets their weights to the
  // balanced default (not locked — change either after). Runs before the repaint.
  const bc = $('bis-class');
  if (bc) bc.addEventListener('change', () => {
    const d = CLASS_STATS[bc.value], bal = BIS_WEIGHT_PRESETS.balanced;
    if (d) for (const n of [1, 2, 3]) { $('bis-p' + n).value = d[n - 1] || ''; $('bis-w' + n).value = bal[n - 1]; }
    paintBis();
  });
  document.querySelectorAll('.adv-tab').forEach((b) => b.addEventListener('click', () => advShowTab(b.dataset.tab)));
  advShowTab(tab);
  paintAdvanced(); paintBis();
}
function paintAdvanced() {
  const name = ($('adv-name').value || '').trim().toLowerCase();
  const slot = ($('adv-slot').value || '').toUpperCase();
  const cls = ($('adv-class').value || '').trim().toUpperCase();
  const eff = $('adv-effect').value;
  const maxlvlRaw = $('adv-maxlvl').value;
  const maxlvl = maxlvlRaw !== '' ? +maxlvlRaw : null;
  const magic = $('adv-magic').checked;
  const mins = {};
  for (const s of ADV_STATS) { const v = $('adv-' + s).value; if (v !== '') mins[s] = +v; }
  const anyFilter = name || slot || cls || eff || maxlvl != null || magic || Object.keys(mins).length;
  const box = $('adv-results');
  if (!anyFilter) { box.innerHTML = '<p class="sub">Enter a filter above to search.</p>'; return; }
  const results = DATA.items.map((i) => ({ i, dropLvl: maxlvl != null ? itemMinDropperLevel(i) : null })).filter(({ i, dropLvl }) => {
    const w = i.wiki; if (!w) return false;
    if (name && !i.name.toLowerCase().includes(name)) return false;
    if (slot) { const ss = itemSlots(w.slot); if (!ss.slots.has(slot) && cleanSlot(w.slot) !== slot) return false; }
    if (cls && !(w.class || '').toUpperCase().includes(cls)) return false;
    if (eff) { if (!w.effect) return false; if (eff !== 'any' && (w.effect.trigger || '') !== eff) return false; }
    if (maxlvl != null && (dropLvl == null || dropLvl > maxlvl)) return false; // farmable from a mob at/below this level
    if (magic && !(w.flags && w.flags.includes('MAGIC'))) return false;
    for (const s in mins) if (advStatOf(w, s) < mins[s]) return false;
    return true;
  }).sort((a, b) => maxlvl != null ? (a.dropLvl - b.dropLvl) || a.i.name.localeCompare(b.i.name) : a.i.name.localeCompare(b.i.name));
  const cols = Object.keys(mins);
  const showEff = !!eff, showLvl = maxlvl != null;
  const shown = results.slice(0, 200);
  box.innerHTML = '<p class="sub">' + results.length + ' match' + (results.length === 1 ? '' : 'es') + (results.length > 200 ? ' — showing 200' : '') +
      (showLvl ? ' · dropped by mobs ≤ L' + maxlvl + ' (whose level we know)' : '') + '</p>' +
    (shown.length ? '<div class="card"><table><thead><tr><th>Item</th><th>Slot</th><th>Class</th>' + (showEff ? '<th>Effect</th>' : '') + (showLvl ? '<th class="num">Drop lvl</th>' : '') + cols.map((c) => '<th class="num">' + c + '</th>').join('') + '</tr></thead><tbody>' +
      shown.map(({ i, dropLvl }) => { const w = i.wiki; return '<tr data-item="' + esc(i.name) + '"><td>' + itemLink(i.id, i.name) + (w.flags && w.flags.includes('MAGIC') ? ' <span class="tag good">MAGIC</span>' : '') + '</td>' +
        '<td class="sample">' + esc(slotLabel(w) || '—') + '</td><td class="sample">' + esc(w.class || '—') + '</td>' +
        (showEff ? '<td class="sample">' + (w.effect ? esc(w.effect.name) + (w.effect.trigger ? ' <span class="tag good">' + esc(w.effect.trigger) + '</span>' : '') : '—') + '</td>' : '') +
        (showLvl ? '<td class="num">' + (dropLvl != null ? 'L' + dropLvl : '—') + '</td>' : '') +
        cols.map((c) => '<td class="num">' + advStatOf(w, c) + '</td>').join('') + '</tr>'; }).join('') +
      '</tbody></table></div>' : '');
  itemHoverInit();
}

// ---- Best in Slot (subjective, weighted by your stat priorities) ----
// Equipment slots and how many of each you can wear. Weapons are handled apart
// (2-hander vs main-hand + off-hand). Order = how they render, head → feet.
const BIS_SLOTS = [
  { key: 'HEAD', label: 'Head', n: 1 }, { key: 'FACE', label: 'Face', n: 1 }, { key: 'EAR', label: 'Ears', n: 2 },
  { key: 'NECK', label: 'Neck', n: 1 }, { key: 'SHOULDERS', label: 'Shoulders', n: 1 }, { key: 'BACK', label: 'Back', n: 1 },
  { key: 'CHEST', label: 'Chest', n: 1 }, { key: 'SHIRT', label: 'Shirt', n: 1 }, { key: 'WRIST', label: 'Wrists', n: 2 },
  { key: 'HANDS', label: 'Hands', n: 1 }, { key: 'FINGER', label: 'Rings', n: 2 }, { key: 'WAIST', label: 'Waist', n: 1 },
  { key: 'LEGS', label: 'Legs', n: 1 }, { key: 'FEET', label: 'Feet', n: 1 }, { key: 'RANGE', label: 'Range', n: 1 },
];
// Wiki slot text is messy (multi-slot, typos, stray HTML entities). Map tokens to
// canonical slots. TWO/HANDED marks a 2-hander (blocks the off-hand).
const SLOT_NORM = {
  HEAD: 'HEAD', FACE: 'FACE', EAR: 'EAR', EARRING: 'EAR', NECK: 'NECK', SHOULDER: 'SHOULDERS', SHOULDERS: 'SHOULDERS',
  BACK: 'BACK', CLOAK: 'BACK', CHEST: 'CHEST', CHES: 'CHEST', CEHST: 'CHEST', SHIRT: 'SHIRT', WRIST: 'WRIST', WRISTS: 'WRIST',
  HAND: 'HANDS', HANDS: 'HANDS', FINGER: 'FINGER', RING: 'FINGER', WAIST: 'WAIST', WAISTE: 'WAIST', BELT: 'WAIST',
  LEGS: 'LEGS', LEG: 'LEGS', FEET: 'FEET', BOOTS: 'FEET', PRIMARY: 'PRIMARY', SECONDARY: 'SECONDARY', RANGE: 'RANGE', AMMO: 'AMMO',
};
function itemSlots(str) {
  const s = String(str || '');
  const twoH = /two\s*hand|2\s*h(and)?\b/i.test(s);
  const toks = s.replace(/&[a-z]+;/gi, ' ').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const slots = new Set();
  for (const t of toks) if (SLOT_NORM[t]) slots.add(SLOT_NORM[t]);
  return { slots, twoH };
}
// Priority stats offered (attributes, defenses, resists).
const BIS_STATS = ['STR', 'STA', 'AGI', 'DEX', 'INT', 'WIS', 'CHA', 'AC', 'HP', 'MANA', 'MR', 'FR', 'CR', 'PR', 'DR'];
const BIS_RESISTS = new Set(['MR', 'FR', 'CR', 'PR', 'DR', 'COR', 'ER', 'HR']);
function bisStatVal(w, s) {
  if (!w) return 0;
  if (s === 'AC') return w.ac || 0;
  if (s === 'HP') return w.hp || 0;
  if (s === 'MANA') return w.mana || 0;
  if (BIS_RESISTS.has(s)) return (w.resists && w.resists[s]) || 0;
  return (w.stats && w.stats[s]) || 0;
}
// The 18 real classes (the class field also carries OCR/parse junk — these are the
// tokens that appear on hundreds of items; everything else is noise).
const MNM_CLASSES = ['ARC', 'BRD', 'BST', 'CLR', 'DRU', 'ELE', 'ENC', 'FTR', 'INQ', 'MNK', 'NEC', 'PAL', 'RNG', 'ROG', 'SHD', 'SHM', 'SPB', 'WIZ'];
// Each class's [primary, secondary, tertiary] stats per the M&M wiki — auto-filled
// when you pick a class (you can still change them; not locked).
const CLASS_STATS = {
  ARC: ['DEX', 'STR', 'AGI'], BRD: ['CHA', 'DEX', 'STR'], BST: ['STR', 'AGI', 'WIS'],
  CLR: ['WIS', 'STR', 'STA'], DRU: ['WIS', 'CHA', 'AGI'], ELE: ['INT', 'STA'],
  ENC: ['INT', 'CHA'], FTR: ['STR', 'STA', 'AGI'], INQ: ['STA', 'INT', 'CHA'],
  MNK: ['AGI', 'DEX', 'STR'], NEC: ['INT', 'DEX'], PAL: ['STA', 'WIS', 'STR'],
  RNG: ['DEX', 'WIS', 'AGI'], ROG: ['DEX', 'AGI'], SHD: ['STR', 'INT', 'STA'],
  SHM: ['WIS', 'STA', 'DEX'], SPB: ['DEX', 'INT', 'STR'], WIZ: ['INT', 'STR', 'DEX'],
};
// Weighting presets for how much the 2nd/3rd priorities count vs the 1st (always 1).
// Default per-stat weights (balanced) auto-filled when a class is chosen; each is
// editable per priority row, so the old preset picker is gone.
const BIS_WEIGHT_PRESETS = { balanced: [1, 0.7, 0.5] };
// Classes that can dual-wield (equip a weapon in the off-hand). Everyone else can
// only put a shield / off-hand item there. Best guess from archetypes — tell me to
// adjust. Non-listed casters/priests/knights (WIZ/CLR/PAL/SHD/…) do NOT dual-wield.
const DUAL_WIELD = new Set(['FTR', 'RNG', 'ROG', 'MNK', 'BRD', 'BST', 'SPB', 'ARC']);
// Strict class check: an item is usable only if its class list names this class or
// is ALL. Items with NO class listed are treated as not-usable when a class is
// chosen (so e.g. plate with no class data can't land on a wizard).
function bisClassFits(w, cls) {
  if (!cls) return true;
  const c = (w.class || '').toUpperCase();
  if (!c) return false;
  if (c.includes('ALL')) return true;
  return new RegExp('\\b' + cls + '\\b').test(c);
}
// Pick the highest-scoring wearable item for every slot, given a class + ordered
// priorities. Returns [{ slotLabel, item, score }]. Weapons: compares the best
// 2-hander against the best main-hand + off-hand and keeps whichever scores more.
function computeBis(cls, priorities, weights, maxlvl) {
  const score = (w) => priorities.reduce((s, p, idx) => s + (weights[idx] || 0) * bisStatVal(w, p), 0);
  const canDualWield = !cls || DUAL_WIELD.has(cls);
  const armor = {}; // slotKey -> [{ item, sc }]
  const wpn = { primary: [], secondary: [], twoH: [] };
  for (const i of DATA.items) {
    const w = i.wiki; if (!w || !w.slot || !bisClassFits(w, cls)) continue;
    // Drop-level filter: exclude items we KNOW drop only from mobs above the cap
    // (unknown-level items are kept — we can't rule them out yet).
    if (maxlvl != null) { const dl = itemMinDropperLevel(i); if (dl != null && dl > maxlvl) continue; }
    const parsed = itemSlots(w.slot);
    const slots = parsed.slots;
    // Two-handed can live in the slot text ("PRIMARY TWO HANDED") OR the separate
    // `handed` field ("Two Handed") — check both, or a 2H lands in the 1H pile.
    const twoH = parsed.twoH || /two\s*hand|2\s*h(?:and)?\b/i.test(w.handed || '');
    if (!slots.size) continue;
    const sc = score(w);
    for (const s of slots) {
      if (s === 'PRIMARY') (twoH ? wpn.twoH : wpn.primary).push({ item: i, sc });
      else if (s === 'SECONDARY') {
        if (twoH) continue;                                   // a 2-hander can't go in the off-hand
        if (canDualWield || w.dmg == null) wpn.secondary.push({ item: i, sc }); // non-dual-wielders: shields/off-hand only (no weapon)
      } else (armor[s] = armor[s] || []).push({ item: i, sc });
    }
  }
  const chosen = [];
  for (const def of BIS_SLOTS) {
    const arr = (armor[def.key] || []).sort((a, b) => b.sc - a.sc);
    const seen = new Set();
    let placed = 0;
    for (const c of arr) {
      if (seen.has(c.item.name)) continue; seen.add(c.item.name); // don't equip the same item twice
      chosen.push({ slotLabel: def.label + (def.n > 1 ? ' ' + (placed + 1) : ''), item: c.item, score: c.sc });
      if (++placed >= def.n) break;
    }
    for (; placed < def.n; placed++) chosen.push({ slotLabel: def.label + (def.n > 1 ? ' ' + (placed + 1) : ''), item: null, score: 0 });
  }
  const top = (a) => a.sort((x, y) => y.sc - x.sc)[0] || null;
  const t2 = top(wpn.twoH), tp = top(wpn.primary), ts = top(wpn.secondary);
  const dualScore = (tp ? tp.sc : 0) + (ts ? ts.sc : 0);
  if (t2 && (t2.sc >= dualScore)) {
    chosen.push({ slotLabel: 'Primary (2H)', item: t2.item, score: t2.sc });
    chosen.push({ slotLabel: 'Secondary', item: null, score: 0 });
  } else {
    chosen.push({ slotLabel: 'Primary', item: tp ? tp.item : null, score: tp ? tp.sc : 0 });
    chosen.push({ slotLabel: 'Secondary', item: ts ? ts.item : null, score: ts ? ts.sc : 0 });
  }
  return chosen;
}
// Drop-level tag shown on each BiS row when a Max Mob Level is set. Colour tracks
// how the item's lowest known dropper level sits against the cap: green = well
// within, amber = right near the cap, muted "L?" = dropper level unknown (kept in
// the set but unconfirmed). All shown known items are already ≤ the cap.
function bisDropTag(item, maxlvl) {
  const dl = itemMinDropperLevel(item);
  if (dl == null) return ' <span class="tag" title="Dropper level unknown — kept in the set but not confirmed at or below your Max Mob Level (' + maxlvl + ')">L?</span>';
  const near = dl > maxlvl - 5;
  return ' <span class="tag ' + (near ? 'warn' : 'good') + '" title="Lowest known dropper is level ' + dl + ' — ' + (near ? 'near' : 'well within') + ' your Max Mob Level (' + maxlvl + ')">≤' + maxlvl + ' · L' + dl + '</span>';
}
function paintBis() {
  const cls = ($('bis-class').value || '').toUpperCase();
  // Each priority row carries its own editable weight; skip rows with no stat so
  // priorities and weights stay index-aligned for computeBis.
  const priorities = [], weights = [];
  for (const n of [1, 2, 3]) {
    const stat = $('bis-p' + n).value; if (!stat) continue;
    const wv = $('bis-w' + n).value;
    priorities.push(stat); weights.push(wv !== '' ? +wv : 0);
  }
  const maxlvlRaw = $('bis-maxlvl').value;
  const maxlvl = maxlvlRaw !== '' ? +maxlvlRaw : null;
  const box = $('bis-results');
  if (!priorities.length) { box.innerHTML = '<p class="sub">Choose at least one stat priority to build a set.</p>'; return; }
  const set = computeBis(cls, priorities, weights, maxlvl);
  const filled = set.filter((r) => r.item);
  // Totals: summed priority-stat points + total weighted score across the set.
  const totalScore = filled.reduce((s, r) => s + r.score, 0);
  const totalStat = {}; priorities.forEach((p) => { totalStat[p] = filled.reduce((s, r) => s + bisStatVal(r.item.wiki, p), 0); });
  const head = '<tr><th>Slot</th><th>Item</th>' + priorities.map((p) => '<th class="num">' + p + '</th>').join('') + '<th class="num">Score</th></tr>';
  const rows = set.map((r) => '<tr' + (r.item ? ' data-item="' + esc(r.item.name) + '"' : ' class="noprice"') + '><td class="sample">' + esc(r.slotLabel) + '</td>' +
    '<td>' + (r.item ? itemLink(r.item.id, r.item.name) + (r.item.wiki.flags && r.item.wiki.flags.includes('MAGIC') ? ' <span class="tag good">MAGIC</span>' : '') + (maxlvl != null ? bisDropTag(r.item, maxlvl) : '') : '<span class="muted">— none —</span>') + '</td>' +
    priorities.map((p) => '<td class="num">' + (r.item ? (bisStatVal(r.item.wiki, p) || '') : '') + '</td>').join('') +
    '<td class="num">' + (r.item ? Math.round(r.score * 10) / 10 : '') + '</td></tr>').join('');
  const totalRow = '<tr class="bis-total"><td></td><td><b>Set total</b></td>' +
    priorities.map((p) => '<td class="num"><b>' + (totalStat[p] || 0) + '</b></td>').join('') +
    '<td class="num"><b>' + Math.round(totalScore * 10) / 10 + '</b></td></tr>';
  box.innerHTML = '<p class="sub">' + filled.length + ' slots filled' + (cls ? ' for <b>' + esc(cls) + '</b>' : '') +
      ' · weights: ' + priorities.map((p, idx) => esc(p) + ' ×' + weights[idx]).join(', ') +
      (maxlvl != null ? ' · excluding items known to drop above L' + maxlvl : '') + '</p>' +
    '<div class="card"><table>' + head + '<tbody>' + rows + totalRow + '</tbody></table></div>' +
    '<p class="note">Highest-scoring <b>mix</b> of your chosen stats per slot — an item wins if its weighted total beats the rest, so a high 2nd-priority item can outrank a slightly better 1st. Ignores stats/effects you didn’t prioritise and whether you can actually get the item. Hover any item for its full stats.</p>';
  itemHoverInit();
}

function route() {
  const q = $('search').value.trim();
  // The auctions page shows two side-by-side markets — give it a wider content
  // column so PvP/PvE don't get squeezed (they stack on narrow screens via CSS).
  document.body.classList.toggle('page-wide', !q && decodeURIComponent(location.hash.replace(/^#\/?/, '')) === 'auctions');
  if (q) return renderSearch(q);
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h === 'items' || h === 'mobs' || h === 'gathering') return renderBrowse(h);
  if (h === 'tradeskills') return renderTradeskills();
  if (h === 'vendors') return renderVendors();
  if (h === 'bestiary') return renderBestiary();
  if (h === 'maps') return renderMapsList();
  if (h === 'auctions') return renderAuctions();
  if (h === 'advanced' || h === 'bis') return renderAdvanced();
  if (h === 'moderate') return renderModerate();
  if (h === 'quests') return renderQuests();
  if (h.startsWith('quests/')) return renderQuestList(h.slice(7));
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
    const w = await (await fetch('./wiki.json')).json();
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
  // Merge in manually-confirmed recipes (recipe-overrides.json) for items the wiki gets
  // wrong, leaves empty, or has no page for — read off the in-game anvil. An override
  // replaces any wiki recipe for the same result, so our data wins and survives a re-scrape.
  try {
    const ov = await (await fetch('./recipe-overrides.json')).json();
    const overrides = (ov && ov.recipes) || [];
    const overridden = new Set(overrides.map((r) => r.result.item.toLowerCase()));
    RECIPES = RECIPES.filter((r) => !overridden.has(r.result.item.toLowerCase())).concat(overrides);
    recipesByResult = {};
    RECIPES.forEach((r) => { const k = r.result.item.toLowerCase(); (recipesByResult[k] = recipesByResult[k] || []).push(r); });
  } catch {}
  // Fill in recipe trivials we've reverse-engineered from in-game crafting colours
  // where the wiki has none — our own observations beat the wiki's "?".
  try {
    RECIPE_OBS = await (await fetch('./recipe-observations.json')).json();
    applyTrivialEstimates(RECIPES, RECIPE_OBS);
  } catch {}
  // Fill in mob levels estimated from in-game /con colour where the wiki has none.
  try {
    const ml = await (await fetch('./mob-levels.json')).json();
    applyMobLevels(DATA.mobs, ml);
  } catch {}
  // Wiki levels for every item dropper — powers the "max mob level" drop filter
  // (Advanced Search + Best-in-Slot). Far more mobs than the ledger alone knows.
  try { DROP_LEVELS = (await (await fetch('./mob-levels-wiki.json')).json()) || {}; _mobLevels = null; } catch {}
  try {
    const v = await (await fetch('./vendors.json')).json();
    VENDORS = (v && v.vendors) || [];
    vendorsSelling = {};
    VENDORS.forEach((vn) => (vn.sells || []).forEach((n) => { (vendorsSelling[n] = vendorsSelling[n] || []).push(vn); }));
  } catch {}
  try {
    const t = await (await fetch('./trades.json')).json();
    TRADES = {};
    for (const e of (t && t.trades) || []) {
      const k = String(e.item).toLowerCase();
      (TRADES[k] = TRADES[k] || []).push({ item: e.item, price: e.price, side: e.side === 'buy' ? 'buy' : 'sell', date: e.date });
    }
  } catch {}
  // Live player prices now come from the LiveMNM auction feed (auctions.json),
  // not the retired manual trade log. Merge priced listings into TRADES so item
  // pages, crafting economics and movers all reflect current market prices.
  // (Prices are base-100 copper, same unit as trades.json — safe to combine.)
  try {
    AUCTIONS = AUCTIONS || await (await fetch('./auctions.json?v=' + Date.now())).json();
    for (const l of (AUCTIONS && AUCTIONS.listings) || []) {
      if (l.price == null) continue; // only priced listings inform value
      const k = String(l.item).toLowerCase();
      // Use the per-unit price so a "x4 for 48s" listing values the item at 12s, not 48s.
      (TRADES[k] = TRADES[k] || []).push({ item: l.item, price: l.unit != null ? l.unit : l.price, side: l.intent === 'buy' ? 'buy' : 'sell', date: l.seen, server: l.server });
    }
  } catch {}
  try {
    MAPS = await (await fetch('./maps.json')).json();
  } catch {}
  try {
    const qj = await (await fetch('./quests.json')).json();
    QUESTS = (qj && qj.quests) || [];
  } catch {}
  try {
    SPELLS = (await (await fetch('./spells.json')).json()).spells || {};
  } catch {}
}
// Spell/ability details (from the wiki) an item's proc/effect refers to, by name.
let SPELLS = {};
const spellFor = (effect) => (effect && effect.name && SPELLS[effect.name.toLowerCase()]) || null;
// A one-line "what it does" for an item's effect, from the matched wiki spell page.
function effectDescHTML(effect) {
  const sp = spellFor(effect);
  if (!sp || !sp.description) return '';
  const bits = [sp.mana && sp.mana !== '0' ? 'Mana ' + esc(sp.mana) : '', sp.castTime ? 'Cast ' + esc(sp.castTime) : '', sp.range ? esc(sp.range) : '', sp.duration && !/instant/i.test(sp.duration) ? esc(sp.duration) : ''].filter(Boolean);
  return '<div class="eff-desc"><em>' + esc(sp.description) + '</em>' + (bits.length ? ' <span class="muted">(' + bits.join(' · ') + ')</span>' : '') + '</div>';
}

fetch('./data.json')
  .then((r) => r.json())
  .then(async (d) => {
    DATA = d;
    // Drop the "party_split" pseudo-mob — a party coin-split mis-logged as a kill,
    // not a real mob (also fixed at the source in tracker/ledger-parser.js). Guards
    // older data.json and any friend-contributed data that still carries it.
    if (DATA.mobs) Object.keys(DATA.mobs).forEach((k) => { if (/^party[_ ]?split$/i.test(k)) delete DATA.mobs[k]; });
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
    refreshMe(); // confirm admin/trusted powers from the API (after the first render)
  })
  .catch((e) => {
    $('content').innerHTML = '<h1>Could not load data</h1><p class="muted">' + esc(e.message) + '</p>';
  });
