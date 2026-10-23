// Bulk tradeskill materials — gathered ore, stone, wood, resin, herbs, fish, foraged
// goods, looted scraps, bone chips and spider silk, and crafting materials (bars,
// boards, thread, powders…) — trade by the STACK. Players post "WTS Copper Ore 2s"
// meaning 2s for a stack, so for these
// items a price is normalized to a per-stack price (and a per-unit price = stack / size)
// and the site shows both. Rare node drops (gems, Crystallized Magic, Alunite) still
// trade per piece and keep the usual per-unit rules in publish-auctions.js.
//
// Stack size: STACK_DEFAULT (20) unless the wiki gives one (wiki.json stackSize — the
// ItemBox has no such field yet) or STACK_OVERRIDES says otherwise.

const STACK_DEFAULT = 20;
const STACK_OVERRIDES = {}; // lowercase item name -> stack size, once confirmed in game

const RESOURCE_NODE = /\b(vein|wood pile|deposit)\b/i;            // wiki "from" = gathered from a node
const RARE_NAME = /^(chipped|flawed|imperfect|flawless)\b|crystallized magic|\bfrond\b|\balunite\b|\bquartz\b/i;
const GATHER_CATS = /^(herb|fish|foraged)$/i;
// Looted tradeskill stock that also trades by the stack: every Scraps (metal, cloth,
// leather, silk) and Chips (bone) item, and spider silk ("Cloth Scraps 1s/stack",
// "Bone Chips 60c a stack"). Pelts stay per piece — players price them each.
const TRADESKILL_STACK = /\b(?:scraps|chips)$|\bspider silk$/i;

// lowercase name -> { name, stack } for every bulk material we know of:
//  - yields a harvest node drops on ≥10% of pulls (our own gathering logs), plus
//  - wiki items gathered from a vein / wood pile / deposit, or tagged Herb / Fish /
//    Foraged — minus gems (any name that also exists as a Chipped/Flawed/Imperfect
//    variant, e.g. Ruby) and other rare drops.
// Crafting materials stack too (bars, plates, links, boards, thread, padding, canvas,
// straps, powders, bolts, molds, vials, spices — "Bronze Bar 8s/stack", "Enchanted
// Powder 12s per stack"): every recipe ingredient except gear, gems/rare drops, pelts,
// and mob drops that nobody makes or sells (Wolf Heart, raw meats, Fire Beetle Gland),
// which players still price per piece.
function craftingMaterials(wikiItems, recipes, gems) {
  const results = new Set(recipes.map((r) => String(r.result.item).toLowerCase()));
  const byLc = {};
  for (const [name, w] of Object.entries(wikiItems)) byLc[name.toLowerCase()] = [name, w];
  const out = [];
  for (const r of recipes) for (const c of r.components || []) {
    const lc = String(c.item).toLowerCase(), hit = byLc[lc];
    if (!hit) continue;
    const [name, w] = hit;
    if (w.slot || RARE_NAME.test(name) || /\bpelt$/i.test(name) || gems.has(lc)) continue;
    const made = results.has(lc), vendor = !!(w.soldBy && w.soldBy.base != null);
    const mobDrop = (w.from || []).some((f) => !RESOURCE_NODE.test(f));
    if (mobDrop && !made && !vendor) continue;
    out.push(name);
  }
  return out;
}

function bulkMaterials({ wikiItems = {}, harvestNodes = [], recipes = [] } = {}) {
  const gems = new Set();
  for (const n of Object.keys(wikiItems)) { const m = n.match(/^(?:chipped|flawed|imperfect)\s+(.+)$/i); if (m) gems.add(m[1].toLowerCase()); }
  for (const node of harvestNodes) for (const y of node.yields || []) { const m = y.res.match(/^(?:chipped|flawed|imperfect)\s+(.+)$/i); if (m) gems.add(m[1].toLowerCase()); }
  const out = new Map();
  const add = (name) => {
    const lc = name.toLowerCase();
    if (out.has(lc) || RARE_NAME.test(name) || gems.has(lc)) return;
    const w = wikiItems[name] || {};
    out.set(lc, { name, stack: STACK_OVERRIDES[lc] || (w.stackSize > 1 ? w.stackSize : STACK_DEFAULT) });
  };
  for (const node of harvestNodes) for (const y of node.yields || []) if (y.rate >= 0.1) add(y.res);
  for (const [name, w] of Object.entries(wikiItems)) {
    if ((w.from || []).some((f) => RESOURCE_NODE.test(f)) || (w.categories || []).some((c) => GATHER_CATS.test(c)) || w.harvestedBy || TRADESKILL_STACK.test(name)) add(name);
  }
  for (const name of craftingMaterials(wikiItems, recipes, gems)) add(name);
  return out;
}

const COIN = '(\\d+(?:\\.\\d+)?)\\s*(?:pp|platinum|plat|gp|gold|sp|silver|cp|copper|p|g|s|c)\\b';
const COIN_VALUE = { pp: 1e6, platinum: 1e6, plat: 1e6, p: 1e6, gp: 1e4, gold: 1e4, g: 1e4, sp: 100, silver: 100, s: 100, cp: 1, copper: 1, c: 1 };

// The part of a post that belongs to one item: a little lead-in (back to the previous
// "]" or "/" — so "4x stack [Wood]" keeps its "4x stack") plus everything after the item
// up to the next [item] or WTS/WTB. Players list several mats in one post ("WTB wood
// 2s/stack WTB fine wood 4s/stacks …") and the generic parser sums every coin in it.
function itemSegment(raw, item) {
  const lc = String(raw || '').toLowerCase(), name = String(item).toLowerCase();
  let i = lc.indexOf('[' + name + ']'), len = name.length + 2;
  if (i < 0) { i = lc.search(new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')); len = name.length; }
  if (i < 0) return null;
  const lead = lc.slice(Math.max(0, i - 30), i);
  const cut = Math.max(lead.lastIndexOf(']'), lead.lastIndexOf('/'), lead.lastIndexOf('"'));
  const tail = lc.slice(i + len);
  const end = tail.search(/\[|\bwt[sbt]\b|\s\/\/|\s[-|]\s/);
  return { before: cut >= 0 ? lead.slice(cut + 1) : lead, after: end >= 0 ? tail.slice(0, end) : tail };
}
// First price in a string, keeping split amounts together ("1s 30c", "1g 5s").
// Returns { value, end } (copper, index just past it) or null.
function firstPrice(s) {
  const re = /(\d+(?:\.\d+)?)\s*(pp|platinum|plat|gp|gold|sp|silver|cp|copper|p|g|s|c)\b/gi;
  let m, total = null, lastEnd = -1;
  while ((m = re.exec(s))) {
    if (total != null && !/^\s*$/.test(s.slice(lastEnd, m.index))) break;
    total = (total || 0) + parseFloat(m[1]) * COIN_VALUE[m[2].toLowerCase()];
    lastEnd = m.index + m[0].length;
  }
  return total == null ? null : { value: Math.round(total), end: lastEnd };
}
const segmentQty = (s) => { const m = s.match(/\bx\s*(\d+)|\b(\d+)\s*x\b|\b(\d+)\s*(?:stacks?|stk)\b/); return m ? +(m[1] || m[2] || m[3]) : null; };

// Per-stack price for one bulk-material listing, read from the item's own segment of
// the post (itemSegment). Rules, from how Trem actually posts these (Oct 2026 history):
//   "2s", "2s/stack", "2s/s", "3 stacks 5s each", "stack x2, 3s/each" → 2s / 5s / 3s a stack
//   "1s/per ore", "15c each ore"                                     → per unit, × stack
//   "3s/20", "10/1s"                                                  → per N units, scaled
//   "x80 13s", "x45 9 silver" (10+ with no "stack")                   → total for that many units
//   "x4 2s" (under 10, no "stack")                                    → 4 stacks at 2s
//   "x4 stacks 10s for all", "total"                                  → total ÷ quantity
// Only the wording up to just past the item's price counts, so "2.5s/stack or 24s for
// the lot" is 2.5s a stack and "x46 for 10s (5s a stack …)" is 10s for 46.
// `price`/`qty` are the generic parser's reads, used only when the segment has none.
// `header` = text before the post's first [item] ("WTS STACKS [Resin] x7 50c // [Wood] x4 2s").
// Returns { stackPrice, unit, stack } in copper, or null when no price belongs to this item.
function normalizeBulk({ raw, item, price, qty, header = '', stack = STACK_DEFAULT, multiItem = false }) {
  const seg = itemSegment(raw, item);
  const own = seg ? firstPrice(seg.after) : null;
  if (own) price = own.value;
  else if (multiItem) return null; // several items, none of the prices is this one's
  if (price == null) return null;
  // Wording that counts: the lead-in, the price, and a few words after it — stopping at
  // a "(" aside, an "or", or the next number (another offer).
  const tailWords = own ? seg.after.slice(own.end).split(/[(\d]|\bor\b/)[0].slice(0, 16) : '';
  const s = seg ? seg.before + ' ' + (own ? seg.after.slice(0, own.end) + tailWords : seg.after) : String(raw || '').toLowerCase();
  // The count: this item's own text first ("[Bronze Scraps] x37"), then its lead-in.
  const q = (seg && (segmentQty(seg.after.slice(0, own ? own.end + tailWords.length : undefined)) || segmentQty(seg.before))) || (qty && qty > 1 ? qty : 1);
  const stackWord = /\bstac\w*|\bst[ac]?ck\b|\bstk\b|\/\s*s\b|[/\s]st\b|\dstack/.test(s) || /\bstacks?\b/.test(header);
  const perUnit = /\b(?:per|each|ea)\s*(?:ore|unit|piece|pc|log|one)\b|\/\s*(?:ore|unit|piece|pc)\b/.test(s);
  const total = /\btotal\b|\bfor all\b|\ball for\b|\btake all\b|\bthe lot\b/.test(s);
  const each = /\b(?:ea|each|per)\b/.test(s);
  const perN = s.match(new RegExp(COIN + '\\s*\\/\\s*(\\d+)\\b(?!\\s*(?:pp|p|g|s|c)\\b)'));
  const nPer = s.match(new RegExp('\\b(\\d+)\\s*\\/\\s*' + COIN));
  // "5s/per", "1s ea" with no stack and no count anywhere = one piece ("Burnt Bone Chips 5s/per").
  const eachOne = each && !stackWord && q === 1;
  let stackPrice;
  if (perUnit || eachOne) stackPrice = price * stack;
  else if (perN && +perN[2] > 1) stackPrice = price * stack / +perN[2];
  else if (nPer && +nPer[1] > 1) stackPrice = price * stack / +nPer[1];
  else if (stackWord) stackPrice = total && q > 1 ? price / q : price;
  else if (q >= 10) stackPrice = each ? price * stack : price * stack / q; // a count of units
  else stackPrice = total && q > 1 ? price / q : price;                     // bare, or a count of stacks
  stackPrice = Math.round(stackPrice);
  return { stackPrice, unit: Math.round(stackPrice / stack), stack };
}

module.exports = { STACK_DEFAULT, STACK_OVERRIDES, bulkMaterials, normalizeBulk };
