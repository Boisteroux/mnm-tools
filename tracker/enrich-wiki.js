// ---------------------------------------------------------------
// Wiki enrichment — pulls item stats + icons and mob stats from the
// M&M community wiki into mnmdb/wiki.json (separate from the ledger
// data so re-generating data.json never clobbers it).
//
// Run:  node tracker/enrich-wiki.js          (enrich + write)
//       node tracker/enrich-wiki.js --test   (parse a few, print, no write)
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const WIKI_API = 'https://monstersandmemories.miraheze.org/w/api.php';
const HEADERS = { 'User-Agent': 'MnM-Map-Companion/0.1 (personal fan-made map tool)' };
const DATA = path.join(__dirname, '..', 'mnmdb', 'data.json');
const OUT = path.join(__dirname, '..', 'mnmdb', 'wiki.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (s) => (s == null || s === '' ? null : (isNaN(+s) ? null : +s));
const clean = (s) =>
  s == null ? null : s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() || null;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Title-case each word so a casually-typed trade name ("brilliant crystallized
// magic") resolves to its real wiki page ("Brilliant Crystallized Magic").
const titleCaseName = (s) => String(s || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));

const ZONES = new Set([
  'Ancient Crypt', 'Blacktide Bay', 'Caves of Irem', 'Evershade Weald', 'Faelindral',
  'Fallen Pass', 'Fallen Watch', 'Glass Flats', 'Glinting Hollow', 'Grain Cellar',
  'Grimtide Sanctum', 'Infested Crypt', "Keeper's Bight", 'Night Harbor', 'Night Harbor Sewers',
  'Rothold', 'Scarwood', 'Shaded Dunes', 'Shallow Shoals', 'Sungreet Strand',
  'Tel Ekir', 'Tomb of the Last Wyrmsbane', 'Vale of Zintar',
]);

// Fetch raw wikitext for up to ~45 page titles at once -> { title: wikitext }
async function fetchWikitext(titles) {
  const url = WIKI_API + '?' + new URLSearchParams({
    format: 'json', action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
    redirects: '1', titles: titles.join('|'),
  });
  const j = await (await fetch(url, { headers: HEADERS })).json();
  const out = {};
  const back = {};
  // Map the final page title back to the name we asked for (title normalization
  // then redirects, chained) so results stay keyed by the input name.
  (j.query && j.query.normalized || []).forEach((n) => { back[n.to] = n.from; });
  (j.query && j.query.redirects || []).forEach((r) => { back[r.to] = back[r.from] || r.from; });
  for (const p of Object.values((j.query && j.query.pages) || {})) {
    if (p.missing !== undefined) continue;
    const rev = p.revisions && p.revisions[0];
    const content = rev && (rev.slots ? rev.slots.main['*'] : rev['*']);
    if (content) out[back[p.title] || p.title] = content;
  }
  return out;
}

// Every page title in a wiki category (handles pagination).
async function fetchCategory(name) {
  const members = [];
  let cont;
  do {
    const url = WIKI_API + '?' + new URLSearchParams({
      format: 'json', action: 'query', list: 'categorymembers',
      cmtitle: 'Category:' + name, cmlimit: '500', ...(cont ? { cmcontinue: cont } : {}),
    });
    const j = await (await fetch(url, { headers: HEADERS })).json();
    members.push(...((j.query && j.query.categorymembers) || []).map((m) => m.title));
    cont = j.continue && j.continue.cmcontinue;
  } while (cont);
  return members;
}

// Resolve a list of "File:Name.png" titles -> { title: small-thumb url }
async function fetchImageUrls(fileTitles) {
  const out = {};
  for (let i = 0; i < fileTitles.length; i += 45) {
    const batch = fileTitles.slice(i, i + 45);
    const url = WIKI_API + '?' + new URLSearchParams({
      format: 'json', action: 'query', titles: batch.join('|'),
      prop: 'imageinfo', iiprop: 'url', iiurlwidth: '64',
    });
    const j = await (await fetch(url, { headers: HEADERS })).json();
    const back = {};
    (j.query && j.query.normalized || []).forEach((n) => { back[n.to] = n.from; });
    for (const p of Object.values((j.query && j.query.pages) || {})) {
      if (p.imageinfo && p.imageinfo[0]) out[back[p.title] || p.title] = p.imageinfo[0].thumburl || p.imageinfo[0].url;
    }
    await sleep(300);
  }
  return out;
}

function templateParams(body) {
  const params = {};
  // NB: `=[ \t]*` (not `\s*`) so an empty field doesn't swallow the next line
  const re = /\|\s*([a-z0-9_]+)\s*=[ \t]*([\s\S]*?)(?=\n\s*\|\s*[a-z0-9_]+\s*=|\n\}\}|$)/gi;
  let pm;
  while ((pm = re.exec(body))) params[pm[1].toLowerCase()] = pm[2].trim();
  return params;
}

function parseItemBox(wikitext) {
  const m = wikitext.match(/\{\{\s*ItemBox([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const params = templateParams(m[1]);
  const stats = params.item_stats || '';
  const grab = (rx) => { const x = stats.match(rx); return x ? x[1] : null; };
  const classRaw = stats.match(/Class:\s*([\s\S]*?)\s*Race:/i);
  const data = {
    iconId: params.icon_id || null,
    slot: clean(grab(/Slot:\s*([^\n<]+)/i)),
    dmg: toNum(grab(/Weapon DMG:\s*([\d.]+)/i)),
    delay: toNum(grab(/ATK Delay:\s*([\d.]+)/i)),
    skill: grab(/Skill:\s*([A-Z]{2,4})/),
    weight: toNum(params.weight || grab(/Weight:\s*([\d.]+)/i)),
    size: (params.size || grab(/Size:\s*([A-Za-z]+)/i) || '').trim().toUpperCase() || null,
    class: clean(params.class || (classRaw && classRaw[1]) || grab(/Class:\s*([^\n<]+)/i)),
    race: clean(params.race || grab(/Race:\s*([A-Za-z ]+)/i)),
  };
  const hasAny = Object.entries(data).some(([k, v]) => k !== 'iconId' && v != null);
  return hasAny || data.iconId ? data : null;
}

function parseSources(wikitext) {
  const m = wikitext.match(/\{\{\s*Itempage([\s\S]*?)\n\}\}/i);
  if (!m) return { zones: [], from: [] };
  const dm = m[1].match(/\|\s*dropsfrom\s*=\s*([\s\S]*?)(?=\n\s*\|\s*[a-z_]+\s*=|\n\}\}|$)/i);
  if (!dm) return { zones: [], from: [] };
  // "Harvested by [[Herbalism]] using their [[sickle]]" is a gather method, not a
  // drop source — strip those lines so we don't list skills/tools/images as droppers.
  const body = dm[1].replace(/(harvested|gathered|mined|foraged|caught)\s+by[^\n]*/gi, '');
  const links = [...new Set([...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim()))]
    .filter((l) => !/^File:/i.test(l) && !SKILLS.has(l));
  return { zones: links.filter((l) => ZONES.has(l)), from: links.filter((l) => !ZONES.has(l)) };
}

// Base-100 coin from wiki text like "Base Price: 2 Gold 5 Silver" -> copper.
function parseCoinText(s) {
  if (!s) return null;
  const mul = { platinum: 1000000, plat: 1000000, gold: 10000, silver: 100, copper: 1 };
  let total = 0, found = false;
  for (const m of s.matchAll(/(\d+)\s*(platinum|plat|gold|silver|copper)/gi)) { total += +m[1] * mul[m[2].toLowerCase()]; found = true; }
  return found ? total : null;
}

// "Sold by" — vendors that SELL the item (you buy from them), with base (regular)
// and shady prices. This is the wiki's authoritative vendor price.
function parseSoldBy(wikitext) {
  const m = wikitext.match(/\{\{\s*Itempage([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const fm = m[1].match(/\|\s*soldby\s*=\s*([\s\S]*?)(?=\n\s*\|\s*[a-z_]+\s*=|\n\}\}|$)/i);
  if (!fm) return null;
  const base = (fm[1].match(/Base Price:\s*([^\n<]*)/i) || [])[1];
  const shady = (fm[1].match(/Shady Price:\s*([^\n<]*)/i) || [])[1];
  const b = parseCoinText(base), s = parseCoinText(shady);
  if (b == null && s == null) return null;
  const vendors = [...new Set([...fm[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim()))]
    .filter((l) => !/^File:/i.test(l));
  return { base: b, shady: s, vendors };
}

// Vendor (merchant) page — {{Merchantpage}} with `sells` (exact item links),
// `buys` (freeform bullet categories like "Weapons" / "Animal parts (meat …)"),
// plus zone, location, race, description.
function parseMerchant(wikitext) {
  const m = wikitext.match(/\{\{\s*Merchantpage([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const p = templateParams(m[1]);
  // Render wiki markup as plain text: [[Target|Display]] -> Display, [[Page]] -> Page,
  // and strip '' / ''' italic/bold markers.
  const wikiText = (s) => (s || '')
    .replace(/\[\[([^\]]+)\]\]/g, (mm, inner) => { const seg = inner.split('|'); return seg[seg.length - 1].trim(); })
    .replace(/''+/g, '').replace(/\s+/g, ' ').trim();
  const itemLinks = (s) => [...new Set([...(s || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim()))]
    .filter((l) => !/^File:/i.test(l));
  const bullets = (s) => (s || '').split('\n').filter((l) => /^\s*\*/.test(l))
    .map((l) => clean(wikiText(l.replace(/^\s*\*\s*/, '')))).filter(Boolean);
  const notPlaceholder = (s) => { const c = clean(wikiText(s)); return c && !/^unknown$|place\s*holder/i.test(c) ? c : null; };
  const zoneM = (p.zone || '').match(/\[\[([^\]|]+)/);
  return {
    sells: itemLinks(p.sells),
    buys: bullets(p.buys),
    zone: zoneM ? zoneM[1].trim() : notPlaceholder(p.zone),
    location: notPlaceholder(p.location),
    race: notPlaceholder(p.race),
    desc: notPlaceholder(p.description),
  };
}

// Gather skill from "Harvested by [[Herbalism]]" (a real category for herbs/ore).
function parseHarvestedBy(wikitext) {
  const m = wikitext.match(/(harvested|gathered|mined|foraged|caught)\s+by\s+\[\[([^\]|]+)/i);
  const skill = m ? m[2].trim() : null;
  return skill && SKILLS.has(skill) ? skill : null;
}

function parseMobPage(wikitext) {
  const m = wikitext.match(/\{\{\s*Namedmobpage([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const p = templateParams(m[1]);
  const data = {
    level: clean(p.level), race: clean(p.race), class: clean(p.class), // keep ranges like "3-7"
    hp: toNum(p.hp), ac: toNum(p.ac),
    special: clean(p.special), zone: clean(p.zone),
    imageFile: p.imagefilename || null,
  };
  const loot = [];
  [p.known_loot, p.common_loot].forEach((t) => {
    if (t) [...t.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].forEach((x) => loot.push(x[1].trim()));
  });
  if (loot.length) data.loot = [...new Set(loot)];
  const has = Object.entries(data).some(([k, v]) => k !== 'imageFile' && v != null);
  return has || data.imageFile ? data : null;
}

// Item "type" from wiki categories (drops class-equipment + meta categories).
// These types are what decide which vendor NPCs will buy an item.
function parseCategories(wikitext) {
  const cats = [...new Set([...wikitext.matchAll(/\[\[Category:([^\]|]+)/gi)].map((x) => x[1].trim()))];
  return cats.filter((c) => !/Equipment$/i.test(c) && !/^(Items|Old Itembox Items|Inventory Items)$/i.test(c));
}

// Known tradeskills — filtering against this avoids picking up recipe outputs,
// crafting stations, etc. that also appear as links in the recipe fields.
const TRADESKILLS = new Set([
  'Alchemy', 'Baking', 'Blacksmithing', 'Brewing', 'Cooking', 'Enchanting', 'Fletching', 'Jewelcrafting',
  'Leatherworking', 'Pottery', 'Smelting', 'Survival', 'Tailoring', 'Tanning', 'Woodworking',
]);
// Gathering skills + crafting skills — used to filter skill/tool links out of
// drop sources and to recognise "Harvested by [[Skill]]".
const GATHER_SKILLS = new Set(['Herbalism', 'Mining', 'Lumberjacking', 'Foraging', 'Fishing', 'Skinning']);
const SKILLS = new Set([...TRADESKILLS, ...GATHER_SKILLS]);

// Tradeskills an item is part of — whether used as an ingredient ("recipes") or
// produced by the skill ("playercrafted"). Filtered to the known set above.
function parseTradeskills(wikitext) {
  const m = wikitext.match(/\{\{\s*Itempage([\s\S]*?)\n\}\}/i);
  if (!m) return [];
  const body = m[1];
  const grab = (field) => {
    const r = body.match(new RegExp('\\|\\s*' + field + '\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-z_]+\\s*=|\\n\\}\\}|$)', 'i'));
    return r ? r[1] : '';
  };
  const text = grab('recipes') + '\n' + grab('playercrafted');
  const links = [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim());
  return [...new Set(links.filter((l) => TRADESKILLS.has(l)))];
}

// Strip a wiki table cell's leading "style=...|" attribute segment + pipe.
const cellLabel = (c) => {
  c = c.replace(/^\s*[!|]\s*/, '');
  const p = c.lastIndexOf('|');
  if (p >= 0 && /style=|align|background|width|colspan|scope|rowspan/i.test(c.slice(0, p))) c = c.slice(p + 1);
  return c.trim();
};
const firstItemLink = (s) => { const m = s.match(/(?:(\d+)\s*x?\s*)?\[\[([^\]]+)\]\]/i); return m ? { qty: +(m[1] || 1), item: m[2].split('|')[0].trim() } : null; };
const allItemLinks = (s) => [...s.matchAll(/(?:(\d+)\s*x?\s*)?\[\[([^\]]+)\]\]/gi)].map((m) => ({ qty: +(m[1] || 1), item: m[2].split('|')[0].trim() }));

// Reusable tools appear in Components cells but aren't consumed per craft (Smithing
// Pliers/Hammer, Hammer & Chisel) — excluded so they don't inflate a recipe's cost.
const TOOLS = new Set(['Smithing Pliers', 'Smithing Hammer', 'Hammer and Chisel', 'Rivet Cutters']);

// Parse ONE wiki table into recipes, reading the column HEADERS so it adapts to each
// skill's layout (Result/Product/Name for the output, Components/Ingredients for inputs).
function parseRecipeTable(table, tradeskill) {
  const rows = table.split(/\n\|-/);
  // Column map from the header — only lines that START with "!" (so the "{|" table
  // line's attributes aren't mistaken for a column).
  let labels = null;
  for (const r of rows) {
    const hls = r.split('\n').filter((l) => /^\s*!/.test(l));
    if (hls.length) { labels = hls.flatMap((l) => l.replace(/^\s*!/, '').split(/\s*!!\s*/)).map(cellLabel).filter(Boolean); break; }
  }
  if (!labels) return [];
  const find = (...rxs) => { for (const rx of rxs) { const i = labels.findIndex((l) => rx.test(l)); if (i >= 0) return i; } return -1; };
  const resultCol = find(/result/i, /product/i, /yield/i, /^name/i, /^item/i);
  const compCol = find(/component/i, /ingredient/i);
  const trivCol = find(/trivial/i);
  if (resultCol < 0 || compCol < 0) return [];

  const out = [];
  for (const r of rows) {
    if (/(^|\n)\s*!/.test(r) || !/\[\[/.test(r)) continue; // header / empty
    let cells = r.split('||').map((c) => c.replace(/^\s*\|\s*/, '').trim());
    if (cells[0] === '') cells = cells.slice(1);
    const res = firstItemLink(cells[resultCol] || '');
    const components = allItemLinks(cells[compCol] || '').filter((c) => !TOOLS.has(c.item));
    if (!res || !components.length || /example/i.test(res.item)) continue;
    if (/scraps$/i.test(res.item)) continue; // breakdown byproduct (Hammer & Chisel master list), not a craft recipe
    out.push({ tradeskill, result: res, components, trivial: trivCol >= 0 ? (parseInt(cells[trivCol], 10) || null) : null });
  }
  return out;
}

// Parse ALL tables under a tradeskill page's "== Recipes ==" section (which runs to the
// next level-2 heading, or end). Skill pages like Blacksmithing carry many tables
// (components, sharpening stones, mount gear, shields, and weapons + armor by metal
// tier); the old code stopped at the first table, dropping everything after "Components".
function parseRecipes(wikitext, tradeskill) {
  const h = wikitext.search(/==\s*Recipes\s*==/i);
  if (h < 0) return [];
  const bodyStart = wikitext.indexOf('\n', h) + 1;
  const rest = wikitext.slice(bodyStart);
  const nextH2 = rest.search(/\n==(?!=)[^\n]*==[ \t]*\r?\n/); // next level-2 heading
  const section = nextH2 >= 0 ? rest.slice(0, nextH2) : rest;
  const out = [];
  const tableRe = /\{\|[\s\S]*?\n\|\}/g;
  let tm;
  while ((tm = tableRe.exec(section))) out.push(...parseRecipeTable(tm[0], tradeskill));
  return out;
}

// Recipes found on item PAGES (the wiki keeps "playercrafted" recipes on each item's
// own page, not only in the tradeskill Recipes table — so these were being missed).
const itemRecipes = [];

// Parse an item page's "playercrafted" block into a recipe. The page's trivial is a
// "##" placeholder, so trivial is left null — our reverse-engineered observations
// (recipe-observations.json) fill those in. Crafting stations (Anvil/Forge/…) and the
// yield item itself are skipped; only "xN [[Item]]" ingredients are kept.
function parsePlayercrafted(wikitext, itemName) {
  const m = wikitext.match(/\{\{\s*Itempage([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  let pc = templateParams(m[1]).playercrafted;
  if (!pc || !/Yield:/i.test(pc)) return null;
  pc = pc.split(/\n(?=\*\s*\[\[[^\]]+\]\]\s*\(\s*Trivial)/i)[0]; // first recipe block only
  if (/\bx\s*\?\s*\[\[/.test(pc)) return null; // an ingredient qty is unknown on the wiki ("x?") — skip rather than publish a partial recipe
  const tsM = pc.match(/\[\[([^\]|]+?)\]\]\s*\(\s*Trivial/i);
  const tradeskill = tsM && tsM[1].trim();
  if (!tradeskill || !TRADESKILLS.has(tradeskill)) return null;
  const yQty = parseInt((pc.match(/Yield:[\s\S]*?\bx\s*(\d+)/i) || [])[1], 10) || 1;
  const comps = [];
  const re = /\bx\s*(\d+)\s*\[\[([^\]|]+?)\]\]/gi;
  let c;
  while ((c = re.exec(pc))) {
    const item = c[2].trim();
    if (item === itemName) continue; // the yield, not an ingredient
    if (/^(Anvil|Forge|Oven|Loom|Kiln|Workbench|Stove|Campfire|Brewing Barrel|Spinning Wheel|Tanning Kit|Pottery Wheel)$/i.test(item)) continue;
    comps.push({ qty: parseInt(c[1], 10), item });
  }
  if (!comps.length) return null;
  return { tradeskill, result: { qty: yQty, item: itemName }, components: comps, trivial: null, fromItemPage: true };
}

// Fetch + parse ItemBox/sources for a list of item names into `into`
async function enrichItems(names, into, label, wikiOnly) {
  for (let i = 0; i < names.length; i += 45) {
    const batch = names.slice(i, i + 45);
    process.stdout.write(`  ${label} ${i + 1}-${i + batch.length}/${names.length}…       \r`);
    let texts; try { texts = await fetchWikitext(batch); } catch { continue; }
    for (const [title, wt] of Object.entries(texts)) {
      const box = parseItemBox(wt), src = parseSources(wt);
      const cats = parseCategories(wt), ts = parseTradeskills(wt);
      const soldBy = parseSoldBy(wt), harvestedBy = parseHarvestedBy(wt);
      // A real item page has an ItemBox. Discovered (wikiOnly) candidates without
      // one are NPCs / spell lists / skills — skip them so they don't pollute Items.
      if (wikiOnly && !box) continue;
      const pcr = parsePlayercrafted(wt, title);
      if (pcr) itemRecipes.push(pcr);
      if (box || src.zones.length || src.from.length || cats.length || ts.length || soldBy) {
        into[title] = Object.assign({ hasPage: true }, wikiOnly ? { wikiOnly: true } : {}, box || {},
          src.zones.length ? { wikiZones: src.zones } : {}, src.from.length ? { from: src.from } : {},
          cats.length ? { categories: cats } : {}, ts.length ? { tradeskills: ts } : {},
          soldBy ? { soldBy } : {}, harvestedBy ? { harvestedBy } : {});
      }
    }
    await sleep(350);
  }
}

// Gathering-node pages (e.g. Copper Vein) list what they yield, grouped by
// == Section == headings with bullet [[links]]. No drop rates exist on the wiki.
function parseNodePage(wikitext) {
  const sections = [];
  const re = /==\s*([^=\n]+?)\s*==\s*([\s\S]*?)(?=\n==|$)/g;
  let m;
  while ((m = re.exec(wikitext))) {
    const items = [...new Set(
      [...m[2].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim()).filter((x) => !/^File:/i.test(x))
    )];
    if (items.length) sections.push({ section: m[1].trim(), items });
  }
  return sections.length ? { yields: sections } : null;
}

async function run() {
  const test = process.argv.includes('--test');
  const ds = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  // Seed the item list from looted/vendored/harvested items PLUS items you've only
  // ever traded (bought/sold) — otherwise a trade-only item never gets a wiki page.
  let tradeNames = [];
  try {
    const tj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'trades.json'), 'utf8'));
    tradeNames = [...new Set((tj.trades || []).map((t) => titleCaseName(t.item)))];
  } catch {}
  const itemNames = test ? ['Rusty Scimitar', 'Bronze Dagger', 'Copper Ore']
    : [...new Set([...ds.items.map((i) => i.name), ...tradeNames])];
  const mobNames = test ? ['a green drakeling', 'a rotting skeleton'] : Object.keys(ds.mobs);

  // ---- Items (from your ledger) ----
  const items = {};
  await enrichItems(itemNames, items, 'items', false);

  // ---- Mobs ----
  // Ledger mob name -> wiki page title, where the wiki spells it differently (usually
  // punctuation, e.g. a comma). The page is fetched under the alias but stored back
  // under the ledger name so it matches data.json. Add entries as mismatches turn up.
  const MOB_ALIASES = {
    'Gurowl the Beast': 'Gurowl, The Beast',
  };
  const mobs = {};
  const titleToMob = {};
  mobNames.forEach((n) => { titleToMob[MOB_ALIASES[n] || cap(n)] = n; });
  const titles = Object.keys(titleToMob);
  for (let i = 0; i < titles.length; i += 45) {
    const batch = titles.slice(i, i + 45);
    process.stdout.write(`  mobs ${i + 1}-${i + batch.length}/${titles.length}…   \r`);
    let texts; try { texts = await fetchWikitext(batch); } catch (e) { console.error('\nmob batch failed:', e.message); continue; }
    for (const [title, wt] of Object.entries(texts)) {
      const parsed = parseMobPage(wt);
      if (parsed) mobs[titleToMob[title] || title] = Object.assign({ hasPage: true, title }, parsed);
    }
    await sleep(350);
  }
  // resolve mob images
  const mobImgTitles = [...new Set(Object.values(mobs).map((m) => m.imageFile).filter(Boolean))].map((f) => 'File:' + f);
  const mobImgs = await fetchImageUrls(mobImgTitles);
  for (const m of Object.values(mobs)) if (m.imageFile) m.image = mobImgs['File:' + m.imageFile] || null;

  // ---- Nodes (gathering veins, referenced in items' "from") ----
  // Also parse the gathering/cooking skill pages as "yield" pages — their section
  // lists are how herbs, ores, fish and cooked items get discovered.
  const SKILL_PAGES = ['Cooking', 'Herbalism', 'Survival', 'Foraging', 'Fishing', 'Mining', 'Lumberjacking', 'Skill Forage'];
  const fromSet = new Set(SKILL_PAGES);
  Object.values(items).forEach((i) => (i.from || []).forEach((f) => fromSet.add(f)));
  const nodeCandidates = [...fromSet].filter((f) => !ds.mobs[f] && !itemNames.includes(f));
  const nodes = {};
  for (let i = 0; i < nodeCandidates.length; i += 45) {
    const batch = nodeCandidates.slice(i, i + 45);
    process.stdout.write(`  nodes ${i + 1}-${i + batch.length}/${nodeCandidates.length}…   \r`);
    let texts; try { texts = await fetchWikitext(batch); } catch { continue; }
    for (const [title, wt] of Object.entries(texts)) {
      const parsed = parseNodePage(wt);
      if (parsed) nodes[title] = Object.assign({ hasPage: true }, parsed);
    }
    await sleep(350);
  }

  // ---- Recipes (from each tradeskill page's Recipes table) ----
  const recipes = [];
  const tsList = [...TRADESKILLS];
  for (let i = 0; i < tsList.length; i += 45) {
    const batch = tsList.slice(i, i + 45);
    process.stdout.write(`  recipes ${i + 1}-${i + batch.length}/${tsList.length}…   \r`);
    let texts; try { texts = await fetchWikitext(batch); } catch { continue; }
    for (const [title, wt] of Object.entries(texts)) parseRecipes(wt, title).forEach((rec) => recipes.push(rec));
    await sleep(350);
  }

  // ---- Discover more items: every item referenced by node yields, mob loot, or a recipe ----
  const discovered = new Set();
  Object.values(nodes).forEach((n) => (n.yields || []).forEach((y) => y.items.forEach((it) => discovered.add(it))));
  Object.values(mobs).forEach((m) => (m.loot || []).forEach((it) => discovered.add(it)));
  recipes.forEach((r) => { discovered.add(r.result.item); r.components.forEach((c) => discovered.add(c.item)); });
  // Also every item we have a reverse-engineered trivial for — these are usually crafted
  // results we never looted, so they're not discovered any other way (e.g. Copper Plate Helm).
  try {
    const obs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'recipe-observations.json'), 'utf8'));
    for (const skill of Object.values(obs.trivialEstimates || {})) for (const n of Object.keys(skill)) if (n !== '_method') discovered.add(n);
  } catch {}
  const known = new Set(Object.keys(items));
  const toFetch = [...discovered].filter((nm) =>
    !known.has(nm) && !ds.mobs[nm] && !nodes[nm] && !ZONES.has(nm) &&
    !SKILLS.has(nm) && !/^(a|an|the)\s/i.test(nm) && !/^File:/i.test(nm)); // skip NPCs/skills/images
  if (toFetch.length) await enrichItems(toFetch, items, 'extra items', true);

  // ---- Merge in recipes found on item pages (not in the tradeskill tables) ----
  // Tradeskill-table recipes win on conflict (they may carry a real trivial).
  const haveResult = new Set(recipes.map((r) => r.result.item));
  let itemPageAdded = 0;
  for (const r of itemRecipes) {
    if (haveResult.has(r.result.item)) continue;
    recipes.push(r); haveResult.add(r.result.item); itemPageAdded++;
  }
  console.log(`  + ${itemPageAdded} recipes from item pages.`);

  // ---- Conflict check: our VERIFIED screenshot trivials vs the (unverified) wiki ----
  // recipe-observations.json is ground truth (read in-game); the wiki is a strong lead.
  // Name any disagreement loudly so it gets double-checked, rather than silently trusting
  // either source. (The site still overlays the observed trivial; this is just a heads-up.)
  try {
    const obs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'recipe-observations.json'), 'utf8'));
    const leadNum = (v) => { if (typeof v === 'number') return v; const m = String(v).match(/\d+/); return m ? +m[0] : null; };
    const conflicts = [];
    for (const r of recipes) {
      if (r.trivial == null) continue;
      const skillObs = (obs.trivialEstimates || {})[r.tradeskill];
      if (!skillObs || skillObs[r.result.item] == null) continue;
      const ov = leadNum(skillObs[r.result.item]);
      if (ov != null && ov !== r.trivial) conflicts.push(`${r.tradeskill} / ${r.result.item}: observed=${skillObs[r.result.item]} vs wiki=${r.trivial}`);
    }
    if (conflicts.length) {
      console.log(`  !! ${conflicts.length} TRIVIAL CONFLICT(S) — verified observation vs wiki (double-check in-game):`);
      conflicts.forEach((c) => console.log('     ' + c));
    } else {
      console.log('  Trivial conflict check: clean — every verified observation matches the wiki.');
    }
  } catch (e) { console.log('  (conflict check skipped:', e.message + ')'); }

  // Second pass: the item-page recipes may reference components not seen anywhere else
  // (e.g. Jagged Stone). Fetch those so their price / gather source resolves the cost.
  const known2 = new Set(Object.keys(items));
  const toFetch2 = [...new Set(recipes.flatMap((r) => r.components.map((c) => c.item)))].filter((nm) =>
    !known2.has(nm) && !ds.mobs[nm] && !nodes[nm] && !ZONES.has(nm) && !SKILLS.has(nm) && !/^(a|an|the)\s/i.test(nm) && !/^File:/i.test(nm));
  if (toFetch2.length) await enrichItems(toFetch2, items, 'recipe components', true);

  // ---- Resolve icons for ALL items (ledger + discovered) ----
  const iconIds = [...new Set(Object.values(items).map((i) => i.iconId).filter(Boolean))];
  const iconUrls = await fetchImageUrls(iconIds.map((id) => 'File:' + id + '.png'));
  for (const it of Object.values(items)) if (it.iconId) it.icon = iconUrls['File:' + it.iconId + '.png'] || null;

  const wikiOnlyCount = Object.values(items).filter((i) => i.wikiOnly).length;
  console.log(`\nItems: ${Object.keys(items).length} (${wikiOnlyCount} wiki-only, icons: ${Object.values(items).filter((i) => i.icon).length}). Mobs: ${Object.keys(mobs).length}/${mobNames.length}. Nodes: ${Object.keys(nodes).length}.`);

  // ---- Vendors (from the wiki's Merchant pages) ----
  const vendorNames = test ? ['Quartermaster Obaid', 'Chef Belle', 'A baker'] : await fetchCategory('Merchant');
  const vendors = [];
  for (let i = 0; i < vendorNames.length; i += 45) {
    const batch = vendorNames.slice(i, i + 45);
    process.stdout.write(`  vendors ${i + 1}-${i + batch.length}/${vendorNames.length}…   \r`);
    let texts; try { texts = await fetchWikitext(batch); } catch { continue; }
    for (const [title, wt] of Object.entries(texts)) {
      const mer = parseMerchant(wt);
      if (mer && (mer.sells.length || mer.buys.length)) vendors.push(Object.assign({ name: title }, mer));
    }
    await sleep(350);
  }
  vendors.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\nVendors: ${vendors.length}/${vendorNames.length} (with ${vendors.reduce((n, v) => n + v.sells.length, 0)} sell-listings).`);

  if (test) {
    console.log('\nRusty Scimitar:', JSON.stringify(items['Rusty Scimitar']));
    console.log('\na green drakeling:', JSON.stringify(mobs['a green drakeling']));
    console.log('\nVendor sample:', JSON.stringify(vendors, null, 1));
    return;
  }
  console.log(`Recipes: ${recipes.length} from ${tsList.length} tradeskills.`);
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items, mobs, nodes, recipes }, null, 2));
  console.log(`Wrote ${OUT}.`);
  const VOUT = path.join(__dirname, '..', 'mnmdb', 'vendors.json');
  fs.writeFileSync(VOUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    _note: "Auto-generated from the wiki's Merchant pages by tracker/enrich-wiki.js — do not hand-edit.",
    vendors,
  }, null, 2));
  console.log(`Wrote ${VOUT} (${vendors.length} vendors).`);
}

if (require.main === module) run();

// Exported so a targeted update can reuse the wiki fetch + recipe parsing without a
// full re-scrape (e.g. scripts that pull just the item-page recipes the tables miss).
module.exports = {
  parsePlayercrafted, parseSources, templateParams, fetchWikitext, TRADESKILLS,
  // Also used by enrich-trades.js to enrich trade-only items without a full re-scrape.
  parseItemBox, parseSoldBy, parseCategories, parseTradeskills, parseHarvestedBy,
  fetchImageUrls, titleCaseName,
};
