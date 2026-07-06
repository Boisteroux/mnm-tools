// ---------------------------------------------------------------
// Auction parser — turns raw in-game /auction lines (OCR'd from the LiveMMCam
// Twitch stream) into structured listings, one per item, tagged by server
// (PvE vs PvP — separate markets, separate prices).
//
//   • Clear price          → a priced listing (item + copper price + intent).
//   • No price             → an availability listing (item is on the market,
//                            price TBD/negotiate) — still valuable to track.
//   • Ambiguous / unknown  → nothing guessed; the line goes to a REVIEW queue
//                            (unknown slang, unmappable multi-item prices, etc.)
//                            for Zak to define, which then grows the glossary.
//
// Coin math + slang come from tracker/auction-glossary.json (the "formula DB").
//
// Run:  node tracker/parse-auctions.js <sample.json>   (prints a report)
//       (sample.json = [{ "server": "PvP"|"PvE", "line": "..." }, ...])
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const GLOSSARY_PATH = path.join(__dirname, 'auction-glossary.json');
const WIKI_PATH = path.join(__dirname, '..', 'mnmdb', 'wiki.json');

const loadGlossary = () => JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf8'));

// Canonical item names (lowercased key -> display name) from wiki.json, so we can
// recognise both bracketed links and un-bracketed / slang item mentions.
function loadItemIndex() {
  const idx = new Map();
  try {
    const w = JSON.parse(fs.readFileSync(WIKI_PATH, 'utf8'));
    for (const name of Object.keys(w.items || {})) idx.set(name.toLowerCase(), name);
  } catch { /* fine — matching just degrades to "unmatched" */ }
  return idx;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// OCR wraps long auctions across several visual lines. Re-join them into one logical
// line each: a new auction always begins with "<Name> auctions"; anything else is a
// continuation of the line above.
function foldOcrLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\S+\s+auctions\b/i.test(line) || out.length === 0) out.push(line);
    else out[out.length - 1] += ' ' + line;
  }
  return out.filter((l) => /\bauctions\b/i.test(l));
}

// Sum every coin amount in a string -> copper. "1.5g" -> 15000, "35 s" -> 3500,
// "1g 5s" -> 10500. Returns null if no coin token is present.
function parseCoins(text, coins) {
  const re = /(\d+(?:\.\d+)?)\s*(platinum|plat|pp|p|gold|gp|g|silver|sp|s|copper|cp|c)\b/gi;
  let total = 0, found = false, m;
  while ((m = re.exec(text))) {
    const mult = coins[m[2].toLowerCase()];
    if (mult == null) continue;
    total += parseFloat(m[1]) * mult;
    found = true;
  }
  return found ? Math.round(total) : null;
}

// Quantity: "x2", "2x", "x1stack", "5s stacks". Returns { qty, perStack }.
function parseQty(text) {
  let qty = null, perStack = false;
  const q = text.match(/(?:x\s*(\d+))|(?:(\d+)\s*x\b)/i);
  if (q) qty = parseInt(q[1] || q[2], 10);
  if (/\bstacks?\b|\dstack/i.test(text)) perStack = true;
  return { qty, perStack };
}

// A stat/gear "request" (jewelcrafting demand), e.g. "+4 or +5 str/agi or str/dex gear".
// Not an item sale — someone wants a crafter to make gear/jewelry with these stats.
const STAT_WORDS = ['str', 'sta', 'agi', 'dex', 'int', 'wis', 'cha', 'hp', 'mana', 'ac', 'atk', 'dmg', 'regen', 'resist', 'resists', 'haste', 'heal', 'healing'];
const GEAR_WORDS = ['gear', 'jewelry', 'jewellery', 'jewelery', 'jeweler', 'jewelcraft', 'ring', 'earring', 'necklace', 'amulet', 'bracelet', 'armor', 'armour', 'weapon', 'shield'];
function extractStats(text) {
  const t = text.toLowerCase();
  const plus = [...new Set([...t.matchAll(/\+\s*(\d+)/g)].map((m) => +m[1]))];
  const stats = STAT_WORDS.filter((s) => new RegExp('\\b' + s + '\\b').test(t));
  const category = GEAR_WORDS.find((g) => t.includes(g)) || null;
  return { plus, stats, category };
}
const isStatRequest = (text) => { const s = extractStats(text); return s.stats.length > 0 || s.category != null; };

const copperToStr = (c) => {
  if (c == null) return '—';
  const parts = [];
  const p = Math.floor(c / 1000000); c %= 1000000;
  const g = Math.floor(c / 10000); c %= 10000;
  const s = Math.floor(c / 100); c %= 100;
  if (p) parts.push(p + 'p'); if (g) parts.push(g + 'g'); if (s) parts.push(s + 's'); if (c) parts.push(c + 'c');
  return parts.join(' ') || '0c';
};

// Parse one raw line for one server. Returns { listings:[], review:[], enrich:[] }.
//   review  = things only a human can resolve (slang, ambiguous prices, freeform).
//   enrich  = exact in-game item names not yet in our DB → auto-fetch from the wiki
//             (NOT a question for Zak — the same path the trade-orphan system uses).
function parseLine(raw, server, gloss, itemIndex) {
  const listings = [], review = [], enrich = [], requests = [];
  const push = (r) => review.push(Object.assign({ server, raw }, r));

  const line = String(raw).trim();
  const m = line.match(/^(\S+)\s+auctions,?\s*["“](.*?)["”]?\s*$/i);
  if (!m) { push({ reason: 'unparsed-line', detail: 'no "Name auctions, \\"...\\"" shape' }); return { listings, review, enrich, requests }; }
  const player = m[1];
  let msg = m[2].trim();

  // Intent (WTS/WTB/…) off the front.
  let intent = null;
  const im = msg.match(/^\s*(wts|wtb|wtt|selling|buying|iso|pc|price\s*check)\b[:,]?\s*/i);
  if (im) { intent = gloss.intents[im[1].toLowerCase().replace(/\s+/g, ' ')] || null; msg = msg.slice(im[0].length).trim(); }

  const bracket = [...msg.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1].trim());
  const coinsAnywhere = parseCoins(msg, gloss.coins);
  const { perStack } = parseQty(msg);

  // Resolve a raw item name to a canonical wiki name (exact / case-insensitive / normalized).
  const resolve = (name) => {
    const exact = itemIndex.get(name.toLowerCase());
    if (exact) return { name: exact, matched: true };
    const n = norm(name);
    for (const [k, v] of itemIndex) if (norm(k) === n) return { name: v, matched: true };
    return { name, matched: false };
  };

  const addItem = (rawName, priceCopper, note) => {
    // A price-check (PC) is a question, not a listing. Only keep it if a price is
    // attached (the useful part is the priced answer); a bare "PC [Item]" is ignored.
    if (intent === 'inquiry' && priceCopper == null) return;
    const r = resolve(rawName);
    listings.push({ server, player, intent, item: r.name, matched: r.matched,
      priceCopper: priceCopper ?? null, qty: parseQty(msg).qty, perStack: perStack || undefined, note, raw });
    if (!r.matched) enrich.push(r.name); // exact name, just missing from our DB → auto-enrich
  };

  // --- Case A: exactly one bracketed item — the clean case. ---
  if (bracket.length === 1) {
    addItem(bracket[0], coinsAnywhere, perStack ? 'per-stack price' : undefined); // stack price = whole stack (confirmed)
    return { listings, review, enrich, requests };
  }

  // --- Case C: multiple bracketed items. ---
  // Give each item the price that appears AFTER it and before the next item — this
  // reads the common "[Item] 8g [Item] 20s" / "[Item] 35s / [Item] 35s" forms.
  if (bracket.length > 1) {
    const its = [...msg.matchAll(/\[([^\]]+)\]/g)].map((x) => ({ name: x[1].trim(), start: x.index, end: x.index + x[0].length }));
    const priced = its.map((it, i) => ({ name: it.name, price: parseCoins(msg.slice(it.end, i + 1 < its.length ? its[i + 1].start : msg.length), gloss.coins) }));
    if (priced.some((p) => p.price != null)) {
      priced.forEach((p) => addItem(p.name, p.price)); // at least one item→price mapped; use per-item windows
    } else if (coinsAnywhere != null) {
      bracket.forEach((b) => addItem(b, null)); // prices exist but as prose ("1 for 50s, 2 for 80s") — keep availability…
      push({ reason: 'complex-pricing', detail: `bundle/quantity pricing (${copperToStr(coinsAnywhere)} seen), items listed as available` }); // …and flag once
    } else {
      bracket.forEach((b) => addItem(b, null)); // no prices at all — clean availability
    }
    return { listings, review, enrich, requests };
  }

  // --- Case B: no brackets — freeform / slang. ---
  // Strip prices, quantities and known qualifiers; whatever's left is a candidate item/abbrev.
  let leftover = msg
    .replace(/(\d+(?:\.\d+)?)\s*(platinum|plat|pp|p|gold|gp|g|silver|sp|s|copper|cp|c)\b/gi, ' ')
    .replace(/(?:x\s*\d+)|(?:\d+\s*x\b)|\dstack/gi, ' ');
  const words = leftover.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    return lw && !gloss.qualifiers[lw];
  });
  const candidate = kept.join(' ').trim();

  if (!candidate) { push({ reason: 'no-item', detail: 'message had a price/qualifier but no item' }); return { listings, review, enrich, requests }; }

  // Known slang → item?
  const abbrevKey = candidate.toLowerCase();
  if (gloss.abbreviations[abbrevKey]) { addItem(gloss.abbreviations[abbrevKey], coinsAnywhere); return { listings, review, enrich, requests }; }

  // A recognised (un-bracketed) item name?
  const r = resolve(candidate);
  if (r.matched) { addItem(candidate, coinsAnywhere); return { listings, review, enrich, requests }; }

  // Otherwise: don't guess. Route to review — is this slang, or a fuzzy/freeform request?
  // Stat/gear request (jewelcrafting demand) — capture in its own bucket, don't flag.
  if (isStatRequest(msg)) {
    requests.push(Object.assign({ server, player, intent, text: msg.trim(), raw }, extractStats(msg)));
    return { listings, review, enrich, requests };
  }
  const isAbbrev = /^[a-z0-9]{2,6}$/i.test(candidate.replace(/\s/g, '')) && candidate.length <= 6;
  push({ reason: isAbbrev ? 'unknown-abbreviation' : 'freeform-request',
    detail: candidate + (coinsAnywhere != null ? `  (price seen: ${copperToStr(coinsAnywhere)})` : ''),
    intent });
  return { listings, review, enrich, requests };
}

function parseAuctions(rows, opts = {}) {
  const gloss = opts.glossary || loadGlossary();
  const itemIndex = opts.itemIndex || loadItemIndex();
  const listings = [], review = [], requests = [], enrichSet = new Set();
  for (const row of rows) {
    const r = parseLine(row.line, row.server, gloss, itemIndex);
    listings.push(...r.listings); review.push(...r.review); requests.push(...r.requests);
    r.enrich.forEach((n) => enrichSet.add(n));
  }
  return { listings, review, requests, enrich: [...enrichSet] };
}

module.exports = { parseAuctions, parseLine, parseCoins, copperToStr, loadGlossary, loadItemIndex, foldOcrLines };

// ---- CLI report ----
if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tracker/parse-auctions.js <sample.json>'); process.exit(1); }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { listings, review, requests, enrich } = parseAuctions(rows);

  for (const server of ['PvP', 'PvE']) {
    const rows = listings.filter((l) => l.server === server);
    console.log(`\n=== ${server}  (${rows.length} listings) ===`);
    for (const l of rows) {
      const price = l.priceCopper != null ? copperToStr(l.priceCopper) : 'available (no price)';
      console.log(`  ${(l.intent || '?').toUpperCase().padEnd(4)} ${l.item}${l.matched ? '' : ' «unmatched»'}` +
        `${l.qty ? ' x' + l.qty : ''}  — ${price}${l.perStack ? ' /stack' : ''}  (${l.player})`);
    }
  }

  if (requests.length) {
    console.log(`\n=== 🛠 CRAFTING / GEAR REQUESTS  (${requests.length}) ===`);
    for (const r of requests) {
      const stats = [r.plus.length ? '+' + r.plus.join('/') : '', r.stats.join('/'), r.category].filter(Boolean).join(' ');
      console.log(`  ${(r.intent || '?').toUpperCase()} ${stats || r.text}  (${r.player}, ${r.server})`);
    }
  }

  if (enrich.length) console.log(`\n=== 🔎 AUTO-ENRICH from wiki (${enrich.length} new items, no action needed) ===\n  ${enrich.join(', ')}`);

  console.log(`\n=== ⚠ NEEDS YOUR INPUT  (${review.length}) ===`);
  const byReason = {};
  for (const r of review) (byReason[r.reason] = byReason[r.reason] || []).push(r);
  for (const [reason, items] of Object.entries(byReason)) {
    console.log(`\n  [${reason}]`);
    for (const r of items) console.log(`    ${r.server}: ${r.detail}   ← "${r.raw}"`);
  }
}
