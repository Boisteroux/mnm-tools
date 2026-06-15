// ---------------------------------------------------------------
// Wiki enrichment — fetches each item's {{ItemBox}} from the M&M
// community wiki and merges stats (damage, delay, slot, weight,
// class, race, icon) into mnmdb/data.json.
//
// Run:  node tracker/enrich-wiki.js          (enrich + write)
//       node tracker/enrich-wiki.js --test   (parse a few, print, no write)
// ---------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const WIKI_API = 'https://monstersandmemories.miraheze.org/w/api.php';
const HEADERS = { 'User-Agent': 'MnM-Map-Companion/0.1 (personal fan-made map tool)' };
const DATA = path.join(__dirname, '..', 'mnmdb', 'data.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (s) => (s == null || s === '' ? null : (isNaN(+s) ? null : +s));
const clean = (s) =>
  s == null ? null : s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim() || null;

// Fetch raw wikitext for up to 50 page titles at once
async function fetchWikitext(titles) {
  const url = WIKI_API + '?' + new URLSearchParams({
    format: 'json', action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
    titles: titles.join('|'),
  });
  const j = await (await fetch(url, { headers: HEADERS })).json();
  const out = {};
  const back = {};
  (j.query && j.query.normalized || []).forEach((n) => { back[n.to] = n.from; });
  for (const p of Object.values((j.query && j.query.pages) || {})) {
    if (p.missing !== undefined) continue;
    const rev = p.revisions && p.revisions[0];
    const content = rev && (rev.slots ? rev.slots.main['*'] : rev['*']);
    if (content) out[back[p.title] || p.title] = content;
  }
  return out;
}

// Parse the {{ItemBox}} template into structured stats
function parseItemBox(wikitext) {
  const m = wikitext.match(/\{\{\s*ItemBox([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const body = m[1];

  // top-level template params: |key = value  (value may span lines)
  const params = {};
  const re = /\|\s*([a-z_]+)\s*=\s*([\s\S]*?)(?=\n\s*\|\s*[a-z_]+\s*=|\n\}\}|$)/gi;
  let pm;
  while ((pm = re.exec(body))) params[pm[1].toLowerCase()] = pm[2].trim();

  const stats = params.item_stats || '';
  const grab = (rx) => { const x = stats.match(rx); return x ? x[1] : null; };

  // class spans from "Class:" up to "Race:" (can contain <br> + line breaks)
  const classRaw = stats.match(/Class:\s*([\s\S]*?)\s*Race:/i);
  const sizeVal = (params.size || grab(/Size:\s*([A-Za-z]+)/i) || '').trim().toUpperCase() || null;

  const data = {
    linkId: params.item_link_id || null,
    iconId: params.icon_id || null,
    slot: clean(grab(/Slot:\s*([^\n<]+)/i)),
    dmg: toNum(grab(/Weapon DMG:\s*([\d.]+)/i)),
    delay: toNum(grab(/ATK Delay:\s*([\d.]+)/i)),
    skill: grab(/Skill:\s*([A-Z]{2,4})/),
    weight: toNum(params.weight || grab(/Weight:\s*([\d.]+)/i)),
    size: sizeVal,
    class: clean(params.class || (classRaw && classRaw[1]) || grab(/Class:\s*([^\n<]+)/i)),
    race: clean(params.race || grab(/Race:\s*([A-Za-z ]+)/i)),
  };
  // Drop entirely-empty results (page exists but no usable stats)
  const hasAny = Object.entries(data).some(([k, v]) => !['linkId', 'iconId'].includes(k) && v != null);
  return hasAny || data.iconId ? data : null;
}

// Known M&M zones, so we can split the wiki's "dropsfrom" list into zones vs.
// other sources (gathering nodes like Copper Vein, or mobs).
const ZONES = new Set([
  'Ancient Crypt', 'Blacktide Bay', 'Caves of Irem', 'Evershade Weald', 'Faelindral',
  'Fallen Pass', 'Fallen Watch', 'Glass Flats', 'Glinting Hollow', 'Grain Cellar',
  'Grimtide Sanctum', 'Infested Crypt', "Keeper's Bight", 'Night Harbor', 'Night Harbor Sewers',
  'Rothold', 'Scarwood', 'Shaded Dunes', 'Shallow Shoals', 'Sungreet Strand',
  'Tel Ekir', 'Tomb of the Last Wyrmsbane', 'Vale of Zintar',
]);

// Pull the wiki's curated "drops/gathered from" list from the {{Itempage}}
// section, split into zones and other sources (nodes like "Copper Vein", mobs).
function parseSources(wikitext) {
  const m = wikitext.match(/\{\{\s*Itempage([\s\S]*?)\n\}\}/i);
  if (!m) return { zones: [], from: [] };
  const dm = m[1].match(/\|\s*dropsfrom\s*=\s*([\s\S]*?)(?=\n\s*\|\s*[a-z_]+\s*=|\n\}\}|$)/i);
  if (!dm) return { zones: [], from: [] };
  const links = [...new Set([...dm[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim()))];
  return { zones: links.filter((l) => ZONES.has(l)), from: links.filter((l) => !ZONES.has(l)) };
}

async function run() {
  const test = process.argv.includes('--test');
  const ds = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const items = ds.items;
  const names = test
    ? ['Rusty Scimitar', 'Bronze Dagger', 'Bone Chips', 'Copper Ore', 'Bat Wing']
    : items.map((i) => i.name);

  const result = {};
  for (let i = 0; i < names.length; i += 45) {
    const batch = names.slice(i, i + 45);
    process.stdout.write(`  fetching ${i + 1}-${i + batch.length} of ${names.length}…\r`);
    let texts;
    try { texts = await fetchWikitext(batch); } catch (e) { console.error('\nbatch failed:', e.message); continue; }
    for (const [title, wt] of Object.entries(texts)) {
      const box = parseItemBox(wt);
      const src = parseSources(wt);
      if (box || src.zones.length || src.from.length) {
        result[title] = Object.assign(
          { hasPage: true }, box || {},
          src.zones.length ? { wikiZones: src.zones } : {},
          src.from.length ? { from: src.from } : {}
        );
      }
    }
    await sleep(400);
  }
  console.log(`\nParsed wiki stats for ${Object.keys(result).length} / ${names.length} items.`);

  if (test) {
    for (const n of names) console.log('\n' + n + ':', JSON.stringify(result[n] || '(no page / no stats)'));
    return;
  }

  // Write a SEPARATE wiki.json (keyed by item name). The site merges it at load,
  // so re-generating data.json from the ledger never clobbers the wiki stats and
  // we don't re-fetch the wiki on every data publish.
  const outFile = path.join(__dirname, '..', 'mnmdb', 'wiki.json');
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), items: result }, null, 2));
  console.log(`Wrote wiki stats for ${Object.keys(result).length} items to ${outFile}.`);
}

run();
