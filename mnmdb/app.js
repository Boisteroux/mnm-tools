// ---------------------------------------------------------------
// mnmdb — static front-end for the Monsters & Memories drop/vendor
// dataset produced by the mnm-tools collector. Vanilla JS, no build.
// ---------------------------------------------------------------

let DATA = null;
let nameToId = {};   // item name -> item id (for linking mob drops to item pages)

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
        harvest.map(([r, n]) => '<tr><td>' + esc(r) + '</td><td class="num sample">' + n + '</td></tr>').join('') +
      '</tbody></table></div></div>' +
    '</div>' +
    '<div class="note">Rates are observational — computed as (times looted ÷ times killed) from real play. ' +
      'Small samples are rough; numbers sharpen as more data is collected.</div>';
}

const stat = (n, l) => '<div class="stat"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>';

function renderItem(id) {
  const it = DATA.items.find((i) => i.id === id) || DATA.items.find((i) => i.name === id);
  if (!it) return notFound('item', id);

  let drops = '<p class="muted">No drop sources recorded yet.</p>';
  if (it.droppedBy.length) {
    drops = '<div class="card"><table><thead><tr><th>Dropped by</th><th class="num">Drop rate</th></tr></thead><tbody>' +
      it.droppedBy.map((d) => '<tr><td>' + mobLink(d.mob) + '</td><td class="num">' + rateCell(d.rate, d.drops, d.kills) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  let vendor = '<p class="muted">No vendor sales recorded yet.</p>';
  if (it.prices.length) {
    const sorted = it.prices.slice().sort((a, b) => a.copper - b.copper);
    const low = sorted[0], high = sorted[sorted.length - 1];
    const rows = sorted.map((p, i) => {
      let tag = '';
      if (sorted.length > 1 && p === low) tag = '<span class="tag good">likely regular</span>';
      else if (sorted.length > 1 && p === high) tag = '<span class="tag warn">likely shady / best</span>';
      return '<tr><td class="coin">' + coin(p.copper) + ' ' + tag + '</td><td class="num sample">seen ' + p.count + '×</td></tr>';
    }).join('');
    vendor = '<div class="card"><table><thead><tr><th>Sells to vendor for</th><th class="num">Observations</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
    if (sorted.length > 1) {
      vendor += '<div class="note">This item sold for different amounts — that\'s the regular vs. shady (or specialist) ' +
        'vendor split. Vendor tagging is coming; for now the lowest price is most likely the regular vendor.</div>';
    }
  }

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">mnmdb</a> › item</div>' +
    '<h1>' + esc(it.name) + '</h1>' +
    '<h2>Sources</h2>' + drops +
    '<h2>Vendor value</h2>' + vendor;
}

function renderMob(name) {
  const m = DATA.mobs[name];
  if (!m) return notFound('mob', name);

  const drops = Object.entries(m.drops).map(([item, n]) => ({
    item, n, rate: m.kills ? n / m.kills : null,
  })).sort((a, b) => b.n - a.n);

  let table = '<p class="muted">No drops recorded.</p>';
  if (drops.length) {
    table = '<div class="card"><table><thead><tr><th>Item</th><th class="num">Drop rate</th></tr></thead><tbody>' +
      drops.map((d) => {
        const id = nameToId[d.item] || d.item;
        return '<tr><td>' + itemLink(id, d.item) + '</td><td class="num">' + rateCell(d.rate, d.n, m.kills) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  $('content').innerHTML =
    '<div class="crumb"><a href="#/">mnmdb</a> › mob</div>' +
    '<h1>' + esc(name) + '</h1>' +
    '<p class="sub">' + m.kills + ' kills observed</p>' +
    '<h2>Drops</h2>' + table;
}

function notFound(kind, id) {
  $('content').innerHTML = '<div class="crumb"><a href="#/">mnmdb</a></div><h1>Not found</h1>' +
    '<p class="muted">No ' + esc(kind) + ' matching “' + esc(id) + '”.</p>';
}

// ---- Search ----

function renderSearch(q) {
  const query = q.toLowerCase();
  const items = DATA.items.filter((i) => i.name.toLowerCase().includes(query)).slice(0, 40)
    .map((i) => ({ kind: 'item', name: i.name, id: i.id,
      meta: (i.droppedBy.length ? i.droppedBy.length + ' source(s)' : '') + (i.prices.length ? ' · vendor' : '') }));
  const mobs = Object.entries(DATA.mobs).filter(([m]) => m.toLowerCase().includes(query)).slice(0, 20)
    .map(([m, d]) => ({ kind: 'mob', name: m, meta: d.kills + ' kills' }));
  const harvest = Object.keys(DATA.harvest).filter((r) => r.toLowerCase().includes(query)).slice(0, 20)
    .map((r) => ({ kind: 'harvest', name: r, meta: DATA.harvest[r] + ' gathered' }));

  const all = [...mobs, ...items, ...harvest];
  if (!all.length) {
    $('content').innerHTML = '<h1>No matches</h1><p class="muted">Nothing found for “' + esc(q) + '”.</p>';
    return;
  }
  $('content').innerHTML = '<h2>' + all.length + ' result' + (all.length === 1 ? '' : 's') + '</h2><div class="results">' +
    all.map((r) => {
      const href = r.kind === 'mob' ? '#/mob/' + encodeURIComponent(r.name)
        : r.kind === 'item' ? '#/item/' + encodeURIComponent(r.id)
        : '#/';
      const clickable = r.kind !== 'harvest';
      const inner = '<span class="kind ' + r.kind + '">' + r.kind + '</span><span class="name">' + esc(r.name) +
        '</span><span class="meta">' + esc(r.meta) + '</span>';
      return clickable ? '<a class="result" href="' + href + '">' + inner + '</a>'
        : '<div class="result">' + inner + '</div>';
    }).join('') + '</div>';
}

// ---- Router ----

function route() {
  const q = $('search').value.trim();
  if (q) return renderSearch(q);
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h.startsWith('item/')) return renderItem(h.slice(5));
  if (h.startsWith('mob/')) return renderMob(h.slice(4));
  renderHome();
}

// ---- Init ----

fetch('./data.json')
  .then((r) => r.json())
  .then((d) => {
    DATA = d;
    DATA.items.forEach((i) => { nameToId[i.name] = i.id; });
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
