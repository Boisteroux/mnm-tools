// ---------------------------------------------------------------
// mnmdb — static front-end for the Monsters & Memories drop/vendor
// dataset produced by the mnm-tools collector. Vanilla JS, no build.
// ---------------------------------------------------------------

let DATA = null;
let nameToId = {};   // item name -> item id (for linking mob drops to item pages)
let itemByName = {}; // item name -> full item record (for vendor-price lookups)
let NODES = {};      // gathering nodes (Copper Vein, …) from the wiki

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

function rateCell(rate, drops, kills) {
  if (rate == null) return '<span class="sample">' + drops + ' seen</span>';
  const w = Math.min(100, Math.round(rate * 100));
  return '<span class="rate"><span class="bar"><span class="fill" style="width:' + w + '%"></span></span>' +
    '<span class="pct">' + pct(rate) + '</span></span> <span class="sample">' + drops + '/' + kills + '</span>';
}

const WIKI_BASE = 'https://monstersandmemories.miraheze.org/wiki/';
const wikiUrl = (name) => WIKI_BASE + encodeURIComponent(String(name).replace(/ /g, '_'));

const itemLink = (id, name) => '<a href="#/item/' + encodeURIComponent(id) + '">' + esc(name) + '</a>';
const mobLink = (name) => '<a href="#/mob/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const zoneLink = (name) => '<a href="#/zone/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
const nodeLink = (name) => '<a href="#/node/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';
// A wiki "source" (node/creature/item) — link internally where we can, else to the wiki
const sourceLink = (s) =>
  DATA.mobs[s] ? mobLink(s)
    : NODES[s] ? nodeLink(s)
    : nameToId[s] ? itemLink(nameToId[s], s)
    : '<a href="' + wikiUrl(s) + '" target="_blank" rel="noopener">' + esc(s) + ' ↗</a>';

// Regular-vendor sell price = the BEST (highest) you'd get selling — regular
// vendors pay more than shady ones. Used as the realistic value of an item.
const regularPrice = (it) => (it && it.prices.length ? Math.max.apply(null, it.prices.map((p) => p.copper)) : 0);

// Expected loot value of one kill: coin + Σ(drop rate × item regular price)
function mobValuePerKill(d) {
  if (!d.kills) return { coin: 0, loot: 0, total: 0 };
  const coinPer = (d.coin || 0) / d.kills;
  let loot = 0;
  for (const [item, n] of Object.entries(d.drops)) loot += (n / d.kills) * regularPrice(itemByName[item]);
  return { coin: coinPer, loot, total: coinPer + loot };
}

// ---- Views ----

function renderHome() {
  const items = DATA.items;
  const mobs = Object.entries(DATA.mobs);
  const topMobs = mobs.slice().sort((a, b) => b[1].kills - a[1].kills).slice(0, 12);
  const harvest = Object.entries(DATA.harvest).sort((a, b) => b[1] - a[1]);
  const withVendor = items.filter((i) => i.prices.length).length;

  $('content').innerHTML =
    '<div class="home-intro">' +
      '<h1>Monsters &amp; Memories drop &amp; vendor database</h1>' +
      '<p class="sub">Community-collected drop rates and vendor values, gathered by the ' +
        '<a href="https://github.com/Boisteroux/mnm-tools">mnm-tools</a> companion app. ' +
        'Search above, or browse below.</p>' +
      '<div class="stat-row">' +
        stat(items.length, 'items') + stat(mobs.length, 'mobs') +
        stat(withVendor, 'with vendor prices') + stat(Object.keys(DATA.harvest).length, 'resources') +
      '</div>' +
    '</div>' +
    '<div class="col2">' +
      '<div><h2>Most-killed mobs</h2><div class="card"><table><tbody>' +
        topMobs.map(([m, d]) => '<tr><td>' + mobLink(m) + '</td><td class="num sample">' + d.kills + ' kills</td></tr>').join('') +
      '</tbody></table></div></div>' +
      '<div><h2>Gathering</h2><div class="card"><table><tbody>' +
        harvest.map(([r, n]) => '<tr><td>' + (nameToId[r] ? itemLink(nameToId[r], r) : esc(r)) + '</td><td class="num sample">' + n + '</td></tr>').join('') +
      '</tbody></table></div></div>' +
    '</div>' +
    '<div class="note">Rates are observational — computed as (times looted ÷ times killed) from real play. ' +
      'Small samples are rough; numbers sharpen as more data is collected.</div>';
}

const stat = (n, l) => '<div class="stat"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>';

function renderItem(id) {
  const it = DATA.items.find((i) => i.id === id) || DATA.items.find((i) => i.name === id);
  if (!it) return notFound('item', id);

  const sections = [];
  const w = it.wiki || {};

  // Stats — wiki stats + your harvest tally + sell price, all in one block
  {
    const rows = [];
    const add = (k, v) => {
      if (v != null && v !== '') rows.push('<tr><td class="muted" style="width:140px">' + k + '</td><td>' + v + '</td></tr>');
    };
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
    if (rows.length) sections.push('<h2>Stats</h2><div class="card"><table><tbody>' + rows.join('') + '</tbody></table></div>');
  }

  // Dropped by — one list combining your observed mobs (with drop rate) and any
  // wiki-listed sources/nodes (no rate). De-dupes mobs that appear in both.
  const dropRows = [];
  const seenSrc = new Set();
  it.droppedBy.forEach((d) => { seenSrc.add(d.mob); dropRows.push(d); });
  (w.from || []).forEach((s) => { if (!seenSrc.has(s)) { seenSrc.add(s); dropRows.push({ mob: s, rate: null }); } });
  if (dropRows.length) {
    sections.push('<h2>Dropped by</h2><div class="card"><table><thead><tr><th>Source</th><th class="num">Drop rate</th></tr></thead><tbody>' +
      dropRows.map((r) => '<tr><td>' + sourceLink(r.mob) + '</td><td class="num">' +
        (r.rate != null ? rateCell(r.rate, r.drops, r.kills) : '<span class="sample">—</span>') + '</td></tr>').join('') +
      '</tbody></table></div>');
  }

  // Vendor value
  if (it.prices.length) {
    const sorted = it.prices.slice().sort((a, b) => b.copper - a.copper); // best sell first
    const high = sorted[0], low = sorted[sorted.length - 1];
    const summary = '<div class="vendor-summary">' +
      '<div class="vbox"><div class="vlbl">Regular vendor (best sell)</div><div class="vval">' + coin(high.copper) + '</div></div>' +
      (sorted.length > 1
        ? '<div class="vbox warnbox"><div class="vlbl">Shady vendor (worst sell)</div><div class="vval">' + coin(low.copper) + '</div></div>'
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
        ? '<div class="note">Regular vendors pay more when you sell (highest); shady vendors pay less (lowest). ' +
          'Buy prices aren’t in the game logs — they’ll come from the wiki later.</div>'
        : '<div class="note">Buy prices and confirmed vendor types will come from the wiki in a later update.</div>'));
  }

  // Found in — your observed zones plus the wiki's listed zones (bottom)
  const zoneSet = [...new Set([...(it.zones || []), ...(w.wikiZones || [])])];
  if (zoneSet.length) {
    sections.push('<h2>Found in</h2><div class="card"><table><tbody>' +
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

  const drops = Object.entries(m.drops).map(([item, n]) => {
    const rate = m.kills ? n / m.kills : null;
    const reg = regularPrice(itemByName[item]);
    return { item, n, rate, perKill: rate ? rate * reg : 0, hasPrice: reg > 0 };
  }).sort((a, b) => b.perKill - a.perKill || b.n - a.n);

  let table = '<p class="muted">No drops recorded.</p>';
  if (drops.length) {
    table = '<div class="card"><table><thead><tr><th>Item</th><th class="num">Drop rate</th><th class="num">Value / kill</th></tr></thead><tbody>' +
      drops.map((d) => {
        const id = nameToId[d.item] || d.item;
        const pk = d.hasPrice ? coin(d.perKill) : '<span class="sample">no price yet</span>';
        return '<tr><td>' + itemLink(id, d.item) + '</td><td class="num">' + rateCell(d.rate, d.n, m.kills) +
          '</td><td class="num coin">' + pk + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  const summary = '<div class="vendor-summary">' +
    '<div class="vbox"><div class="vlbl">Kills observed</div><div class="vval">' + m.kills + '</div></div>' +
    '<div class="vbox"><div class="vlbl">Coin / kill</div><div class="vval">' + coin(val.coin) + '</div></div>' +
    '<div class="vbox"><div class="vlbl">Est. value / kill</div><div class="vval">' + coin(val.total) + '</div></div>' +
    '</div>';

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
    '<h2>Drops &amp; farming value</h2>' + table +
    '<div class="note">“Value / kill” = drop rate × the item’s regular vendor price; add coin/kill for the total. ' +
    'A rough guide to the most profitable mobs and drops.</div>';
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
  const n = NODES[name];
  if (!n) return notFound('node', name);
  const yieldLink = (it) => nameToId[it]
    ? itemLink(nameToId[it], it)
    : '<a href="' + wikiUrl(it) + '" target="_blank" rel="noopener">' + esc(it) + ' ↗</a>';
  const body = (n.yields || []).map((y) =>
    '<h2>' + esc(y.section) + '</h2><div class="card"><table><tbody>' +
    y.items.map((it) => '<tr><td>' + yieldLink(it) + '</td></tr>').join('') +
    '</tbody></table></div>'
  ).join('');
  $('content').innerHTML =
    '<div class="crumb"><a href="#/">MnMdb</a> › node</div>' +
    '<h1>' + esc(name) + '</h1>' +
    '<p class="sub"><a href="' + wikiUrl(name) + '" target="_blank" rel="noopener">View on the wiki ↗</a></p>' +
    '<div class="note">The wiki lists what this node can yield. Per-node drop rates aren’t available — ' +
    'the wiki doesn’t track them, and the game logs don’t record which node a gather came from.</div>' +
    body;
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
    .map(([m, d]) => ({ kind: 'mob', name: m, meta: d.kills + ' kills' }));

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
    { key: 'best', label: 'Drop Percent', num: true, render: (v) => (v ? Math.round(v * 100) + '%' : '—') },
    { key: 'vendor', label: 'Vendor Value', num: true, render: (v) => (v == null ? '—' : coin(v)) },
    { key: 'shady', label: 'Shady Value', num: true, render: (v) => (v == null ? '—' : coin(v)) },
    { key: 'sources', label: 'Sources', num: true },
    { key: 'harvested', label: 'Harvested', num: true, render: (v) => v || '—' },
  ],
  gathering: [
    { key: 'name', label: 'Resource' },
    { key: 'harvested', label: 'Harvested', num: true },
    { key: 'vendor', label: 'Vendor Value', num: true, render: (v) => (v == null ? '—' : coin(v)) },
  ],
  mobs: [
    { key: 'name', label: 'Mob' },
    { key: 'valuekill', label: 'Value/kill', num: true, render: (v) => coin(v) },
    { key: 'coinkill', label: 'Coin/kill', num: true, render: (v) => coin(v) },
    { key: 'kills', label: 'Kills', num: true },
    { key: 'drops', label: 'Drops', num: true },
  ],
};

function browseRows(view) {
  if (view === 'mobs') {
    return Object.entries(DATA.mobs).map(([name, d]) => {
      const v = mobValuePerKill(d);
      return {
        _href: '#/mob/' + encodeURIComponent(name), name, kills: d.kills,
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
    };
  });
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
    '<p class="sub">Click a column heading to sort. Click a row to open it.</p>' +
    '<div class="card"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

window.setSort = (key) => {
  if (browse.key === key) browse.dir *= -1;
  else { browse.key = key; browse.dir = key === 'name' ? 1 : -1; }
  renderBrowse(browse.view);
};

// ---- Router ----

function route() {
  const q = $('search').value.trim();
  if (q) return renderSearch(q);
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h === 'items' || h === 'mobs' || h === 'gathering') return renderBrowse(h);
  if (h.startsWith('item/')) return renderItem(h.slice(5));
  if (h.startsWith('mob/')) return renderMob(h.slice(4));
  if (h.startsWith('zone/')) return renderZone(h.slice(5));
  if (h.startsWith('node/')) return renderNode(h.slice(5));
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
  } catch {}
}

fetch('./data.json?v=' + Date.now())
  .then((r) => r.json())
  .then(async (d) => {
    DATA = d;
    await loadWikiStats();
    DATA.items.forEach((i) => { nameToId[i.name] = i.id; itemByName[i.name] = i; });
    const when = d.generatedAt ? new Date(d.generatedAt).toLocaleDateString() : '';
    $('data-meta').textContent = (d.events || 0).toLocaleString() + ' events · ' +
      DATA.items.length + ' items · updated ' + when;
    window.addEventListener('hashchange', route);
    $('search').addEventListener('input', () => {
      // typing searches; clearing returns to the current hash view
      route();
    });
    route();
  })
  .catch((e) => {
    $('content').innerHTML = '<h1>Could not load data</h1><p class="muted">' + esc(e.message) + '</p>';
  });
