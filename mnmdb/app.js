// ---------------------------------------------------------------
// mnmdb — static front-end for the Monsters & Memories drop/vendor
// dataset produced by the mnm-tools collector. Vanilla JS, no build.
// ---------------------------------------------------------------

let DATA = null;
let nameToId = {};   // item name -> item id (for linking mob drops to item pages)
let itemByName = {}; // item name -> full item record (for vendor-price lookups)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function coin(c) {
  c = Math.round(c);
  const p = Math.floor(c / 1000); c %= 1000;
  const g = Math.floor(c / 100); c %= 100;
  const s = Math.floor(c / 10); const cp = c % 10;
  return [p && p + 'p', g && g + 'g', s && s + 's', cp && cp + 'c'].filter(Boolean).join(' ') || '0c';
}

const pct = (r) => (r == null ? '—' : Math.round(r * 100) + '%');

function rateCell(rate, drops, kills) {
  if (rate == null) return '<span class="sample">' + drops + ' seen</span>';
  const w = Math.min(100, Math.round(rate * 100));
  return '<span class="rate"><span class="bar"><span class="fill" style="width:' + w + '%"></span></span>' +
    '<span class="pct">' + pct(rate) + '</span></span> <span class="sample">' + drops + '/' + kills + '</span>';
}

const itemLink = (id, name) => '<a href="#/item/' + encodeURIComponent(id) + '">' + esc(name) + '</a>';
const mobLink = (name) => '<a href="#/mob/' + encodeURIComponent(name) + '">' + esc(name) + '</a>';

// Regular (lowest observed) vendor price for an item, in copper
const regularPrice = (it) => (it && it.prices.length ? Math.min.apply(null, it.prices.map((p) => p.copper)) : 0);

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
      '<div><h2>Harvested resources</h2><div class="card"><table><tbody>' +
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

  // Sources (mob drops)
  if (it.droppedBy.length) {
    sections.push('<h2>Dropped by</h2><div class="card"><table><thead><tr><th>Mob</th><th class="num">Drop rate</th></tr></thead><tbody>' +
      it.droppedBy.map((d) => '<tr><td>' + mobLink(d.mob) + '</td><td class="num">' + rateCell(d.rate, d.drops, d.kills) + '</td></tr>').join('') +
      '</tbody></table></div>');
  }

  // Found in (zones)
  if (it.zones && it.zones.length) {
    sections.push('<h2>Found in</h2><div class="card"><table><tbody>' +
      it.zones.map((z) => '<tr><td>' + esc(z) + '</td></tr>').join('') + '</tbody></table></div>');
  }

  // Harvested
  if (it.harvested > 0) {
    sections.push('<h2>Harvested</h2><div class="card"><table><tbody>' +
      '<tr><td>Gathered from nodes</td><td class="num sample">' + it.harvested + '×</td></tr>' +
      '</tbody></table></div>' +
      '<div class="note">Which node it comes from (e.g. Copper Veins) isn\'t in the game logs — that detail will be pulled from the community wiki in a later update.</div>');
  }

  // Vendor value
  if (it.prices.length) {
    const sorted = it.prices.slice().sort((a, b) => a.copper - b.copper);
    const low = sorted[0], high = sorted[sorted.length - 1];
    const summary = '<div class="vendor-summary">' +
      '<div class="vbox"><div class="vlbl">Regular vendor</div><div class="vval">' + coin(low.copper) + '</div></div>' +
      (sorted.length > 1
        ? '<div class="vbox warnbox"><div class="vlbl">Shady / best seen</div><div class="vval">' + coin(high.copper) + '</div></div>'
        : '') +
      '</div>';
    const rows = sorted.map((p) => {
      let tag = '';
      if (sorted.length > 1 && p === low) tag = '<span class="tag good">regular</span>';
      else if (sorted.length > 1 && p === high) tag = '<span class="tag warn">shady / best</span>';
      return '<tr><td class="coin">' + coin(p.copper) + ' ' + tag + '</td><td class="num sample">seen ' + p.count + '×</td></tr>';
    }).join('');
    sections.push('<h2>Vendor value</h2>' + summary +
      '<div class="card"><table><thead><tr><th>All prices seen</th><th class="num">Times</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (sorted.length > 1 ? '<div class="note">Different sale amounts = the regular vs. shady (or specialist) vendor split. ' +
        'Lowest is the regular vendor; higher prices are shady or a specialist who pays more for this item.</div>' : ''));
  }

  if (!sections.length) {
    sections.push('<p class="muted">No drop, harvest, or vendor data recorded for this item yet. ' +
      'It\'ll fill in as more is collected.</p>');
  }

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">mnmdb</a> › item</div>' +
    '<h1>' + esc(it.name) + '</h1>' +
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

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">mnmdb</a> › mob</div>' +
    '<h1>' + esc(name) + '</h1>' +
    (zones.length ? '<p class="sub">Found in ' + zones.map(esc).join(', ') + '</p>' : '') +
    summary +
    '<h2>Drops &amp; farming value</h2>' + table +
    '<div class="note">“Value / kill” = drop rate × the item’s regular vendor price; add coin/kill for the total. ' +
    'A rough guide to the most profitable mobs and drops.</div>';
}

function notFound(kind, id) {
  $('content').innerHTML = '<div class="crumb"><a href="#/">mnmdb</a></div><h1>Not found</h1>' +
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
    { key: 'sources', label: 'Sources', num: true },
    { key: 'best', label: 'Best drop', num: true, render: (v) => (v ? Math.round(v * 100) + '%' : '—') },
    { key: 'vendor', label: 'Vendor', num: true, render: (v) => (v == null ? '—' : coin(v)) },
    { key: 'harvested', label: 'Harvested', num: true, render: (v) => v || '—' },
  ],
  resources: [
    { key: 'name', label: 'Resource' },
    { key: 'harvested', label: 'Gathered', num: true },
    { key: 'vendor', label: 'Vendor', num: true, render: (v) => (v == null ? '—' : coin(v)) },
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
  const items = view === 'resources' ? DATA.items.filter((i) => i.harvested > 0) : DATA.items;
  return items.map((i) => ({
    _href: '#/item/' + encodeURIComponent(i.id),
    name: i.name,
    sources: i.droppedBy.length,
    best: i.droppedBy.reduce((m, d) => Math.max(m, d.rate || 0), 0),
    vendor: i.prices.length ? Math.min.apply(null, i.prices.map((p) => p.copper)) : null,
    harvested: i.harvested || 0,
  }));
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
    '<div class="crumb"><a href="#/">mnmdb</a> › ' + view + '</div>' +
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
  if (h === 'items' || h === 'mobs' || h === 'resources') return renderBrowse(h);
  if (h.startsWith('item/')) return renderItem(h.slice(5));
  if (h.startsWith('mob/')) return renderMob(h.slice(4));
  renderHome();
}

// ---- Init ----

fetch('./data.json?v=' + Date.now())
  .then((r) => r.json())
  .then((d) => {
    DATA = d;
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
