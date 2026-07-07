// Import every spell / ability from the wiki (Category:Spells & Abilities) into
// mnmdb/spells.json, so an item's proc/effect can show WHAT it does. Each wiki
// spell page uses the {{Spellpagesmart}} template; we parse its description +
// key mechanics + slot effects. Keyed by lowercased spell name for item lookup.
//
//   node tracker/import-spells.js          (import + write spells.json)
//   node tracker/import-spells.js --dry     (report count only)

const fs = require('fs');
const path = require('path');
const https = require('https');
const W = require('./enrich-wiki.js');

const OUT = path.join(__dirname, '..', 'mnmdb', 'spells.json');
const API = 'https://monstersandmemories.miraheze.org/w/api.php';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiGet = (params) => new Promise((res, rej) => {
  const url = API + '?' + new URLSearchParams(Object.assign({ format: 'json' }, params));
  https.get(url, { headers: { 'User-Agent': 'mnm-tools-spells/1.0' } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

async function spellTitles() {
  const out = []; let cont = null, calls = 0;
  do {
    const j = await apiGet(Object.assign({ action: 'query', list: 'categorymembers', cmtitle: 'Category:Spells & Abilities', cmlimit: '500', cmtype: 'page' }, cont ? { cmcontinue: cont } : {}));
    (j.query && j.query.categorymembers || []).forEach((m) => out.push(m.title));
    cont = j.continue && j.continue.cmcontinue;
    await sleep(200);
  } while (cont && ++calls < 15);
  return out;
}

// Wikitext → plain text: drop '' italics, [[a|b]]→b, [[a]]→a, refs, stray braces.
const plain = (s) => String(s || '')
  .replace(/'''?/g, '').replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/<[^>]+>/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();
const prune = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) { if (v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) continue; r[k] = v; } return r; };

function parseSpell(wt) {
  const m = wt.match(/\{\{\s*Spellpagesmart([\s\S]*?)\n\}\}/i);
  if (!m) return null;
  const p = W.templateParams(m[1]);
  if (!p.spellname) return null;
  // classes: "*[[Necromancer]] - Level 4" → { Necromancer: 4 }
  const classes = {};
  for (const c of (p.classes || '').matchAll(/\[\[([^\]|]+)[^\]]*\]\]\s*[-–]\s*Level\s*(\d+)/gi)) classes[plain(c[1])] = +c[2];
  // slot effects: {{SpellSlotRow | 1 | Decrease Hitpoints by 9}} → the effect text
  const effects = [...(p.slots || '').matchAll(/\{\{\s*SpellSlotRow\s*\|[^|]*\|\s*([^}]+?)\s*\}\}/gi)].map((x) => plain(x[1])).filter(Boolean);
  // notes: bullet list
  const notes = (p.notes || '').split('\n').map((l) => plain(l.replace(/^\s*\*+\s*/, ''))).filter(Boolean);
  return prune({
    name: plain(p.spellname),
    description: plain(p.description),
    effects, notes,
    classes,
    skill: plain(p.skill),
    mana: p.mana ? plain(p.mana) : null,
    range: plain(p.range), castTime: plain(p.casting_time), recast: plain(p.recast_time),
    duration: plain(p.duration), target: plain(p.target_type), spellType: plain(p.spell_type),
    resist: plain(p.resist),
  });
}

(async () => {
  console.log('Listing Spells & Abilities…');
  const titles = await spellTitles();
  console.log(`spell/ability pages: ${titles.length}`);
  if (process.argv.includes('--dry')) return;
  const spells = {};
  for (let i = 0; i < titles.length; i += 45) {
    const batch = titles.slice(i, i + 45);
    process.stdout.write(`  ${Math.min(i + 45, titles.length)}/${titles.length}\r`);
    let texts; try { texts = await W.fetchWikitext(batch); } catch (e) { console.error('\n  batch failed:', e.message); continue; }
    for (const t of batch) { const wt = texts[t]; if (!wt) continue; const s = parseSpell(wt); if (s) spells[s.name.toLowerCase()] = s; }
    await sleep(300);
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), spells }, null, 2));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  const withDesc = Object.values(spells).filter((s) => s.description).length;
  console.log(`\nWrote ${Object.keys(spells).length} spells (${withDesc} with a description) to spells.json (${kb} KB).`);
})().catch((e) => { console.error(e); process.exit(1); });
