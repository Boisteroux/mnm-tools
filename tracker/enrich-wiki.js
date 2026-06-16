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
  const re = /\|\s*([a-z_]+)\s*=[ \t]*([\s\S]*?)(?=\n\s*\|\s*[a-z_]+\s*=|\n\}\}|$)/gi;
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
  const links = [...new Set([...dm[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim()))];
  return { zones: links.filter((l) => ZONES.has(l)), from: links.filter((l) => !ZONES.has(l)) };
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
  'Alchemy', 'Baking', 'Blacksmithing', 'Brewing', 'Cooking', 'Fletching', 'Jewelcrafting',
  'Leatherworking', 'Pottery', 'Smelting', 'Survival', 'Tailoring', 'Tanning', 'Woodworking',
]);

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

// Parse a tradeskill page's "== Recipes ==" table into structured recipes:
// { tradeskill, result:{qty,item}, components:[{qty,item}], trivial }.
function parseRecipes(wikitext, tradeskill) {
  const h = wikitext.search(/==\s*Recipes\s*==/i);
  if (h < 0) return [];
  const tStart = wikitext.indexOf('{|', h);
  if (tStart < 0) return [];
  const table = wikitext.slice(tStart, wikitext.indexOf('|}', tStart));
  const out = [];
  for (const r of table.split(/\n\|-/).slice(1)) {
    if (/^\s*!/.test(r)) continue;
    let cells = r.split('||').map((c) => c.trim());
    if (cells[0] === '') cells = cells.slice(1);
    if (cells.length < 4) continue;
    const rm = cells[3].match(/(\d+)\s*x?\s*\[\[([^\]]+)\]\]/i);
    const components = [...cells[2].matchAll(/(\d+)\s*x\s*\[\[([^\]]+)\]\]/gi)]
      .map((m) => ({ qty: +m[1], item: m[2].split('|')[0].trim() }));
    if (!rm || !components.length) continue;
    out.push({ tradeskill, result: { qty: +rm[1], item: rm[2].split('|')[0].trim() }, components, trivial: parseInt(cells[4], 10) || null });
  }
  return out;
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
      if (box || src.zones.length || src.from.length || cats.length || ts.length) {
        into[title] = Object.assign({ hasPage: true }, wikiOnly ? { wikiOnly: true } : {}, box || {},
          src.zones.length ? { wikiZones: src.zones } : {}, src.from.length ? { from: src.from } : {},
          cats.length ? { categories: cats } : {}, ts.length ? { tradeskills: ts } : {});
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
  const itemNames = test ? ['Rusty Scimitar', 'Bronze Dagger', 'Copper Ore'] : ds.items.map((i) => i.name);
  const mobNames = test ? ['a green drakeling', 'a rotting skeleton'] : Object.keys(ds.mobs);

  // ---- Items (from your ledger) ----
  const items = {};
  await enrichItems(itemNames, items, 'items', false);

  // ---- Mobs ----
  const mobs = {};
  const titleToMob = {};
  mobNames.forEach((n) => { titleToMob[cap(n)] = n; });
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
  const fromSet = new Set();
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
  const known = new Set(Object.keys(items));
  const toFetch = [...discovered].filter((nm) => !known.has(nm) && !ds.mobs[nm] && !nodes[nm] && !ZONES.has(nm));
  if (toFetch.length) await enrichItems(toFetch, items, 'extra items', true);

  // ---- Resolve icons for ALL items (ledger + discovered) ----
  const iconIds = [...new Set(Object.values(items).map((i) => i.iconId).filter(Boolean))];
  const iconUrls = await fetchImageUrls(iconIds.map((id) => 'File:' + id + '.png'));
  for (const it of Object.values(items)) if (it.iconId) it.icon = iconUrls['File:' + it.iconId + '.png'] || null;

  const wikiOnlyCount = Object.values(items).filter((i) => i.wikiOnly).length;
  console.log(`\nItems: ${Object.keys(items).length} (${wikiOnlyCount} wiki-only, icons: ${Object.values(items).filter((i) => i.icon).length}). Mobs: ${Object.keys(mobs).length}/${mobNames.length}. Nodes: ${Object.keys(nodes).length}.`);

  if (test) {
    console.log('\nRusty Scimitar:', JSON.stringify(items['Rusty Scimitar']));
    console.log('\na green drakeling:', JSON.stringify(mobs['a green drakeling']));
    return;
  }
  console.log(`Recipes: ${recipes.length} from ${tsList.length} tradeskills.`);
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items, mobs, nodes, recipes }, null, 2));
  console.log(`Wrote ${OUT}.`);
}

run();
