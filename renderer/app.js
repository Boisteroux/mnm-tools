// ---------------------------------------------------------------
// MnM Map — renderer logic: zones, pan/zoom canvas, markers
// ---------------------------------------------------------------

const CATEGORIES = [
  { id: 'ore',      name: 'Ore',        color: '#c0784a', icon: '⛏️' },
  { id: 'herb',     name: 'Herbs',      color: '#3c8f43', icon: '\u{1F33F}' },
  { id: 'wood',     name: 'Wood',       color: '#8a5a2b', icon: '\u{1FAB5}' },
  { id: 'quest',    name: 'Quest NPCs', color: '#fff176', icon: '❗️' },
  { id: 'named',    name: 'Named Mobs', color: '#d6453c', icon: '\u{1F480}' },
  { id: 'misc',     name: 'Other',      color: '#b0bec5', icon: '\u{1F4CD}' },
];

const catById = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

// White text on dark dots, near-black text on light dots — so any icon
// that renders as a plain glyph (not a color emoji) stays readable
function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#15161a' : '#ffffff';
}

// ---- State ----

let data = { zones: [] };
let currentZoneId = null;
let characterZoneId = null; // the zone the character is actually in (from the game log), vs. the map being viewed
let view = { x: 0, y: 0, scale: 1 };          // screen = world * scale + offset
let hiddenCategories = new Set();
let mapImage = null;                           // loaded Image for current zone
let editingMarkerId = null;                    // marker being edited in the modal
let pendingWorldPos = null;                    // where a new marker will be placed
let popupMarkerId = null;
let popupIsCommunity = false;                  // the open popup is a read-only community marker
let communityMarkers = [];                     // approved community submissions from mnm-db.com (read-only)
let showCommunity = false;                     // overlay them on the map?

const GRID_SIZE = 2000;                        // blank-map play area in world units
const MARKER_RADIUS = 11;                      // screen pixels, constant at any zoom
const COMMUNITY_MARKERS_URL = 'https://mnmdb-api.boisteroux.workers.dev/markers';
const COMMUNITY_KEY = 'community-markers';
const WEB_MAX = 8000;                          // must match tracker/export-maps.js MAX_WEB (how the web image was scaled)

// ---- Elements ----

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

// ---- Gathering-node tiers (kept in sync with mnmdb/app.js) ----
// A classified ore/herb/wood marker renders as a tier-colored disc with a greyscale
// icon, matching the website. The marker LABEL is the tier data; rares pair with the
// base node group they spawn on (Tin/Silver, Iron/Gold, Coal/Platinum), and a lone
// rare label resolves to that base too. Own markers pass the current zone name (for
// the zone default); community markers carry their own zone.
const ORE_TIERS = [
  { id: 'copper',    name: 'Copper',    color: '#b25f2e', re: /\bcopper\b/i },
  { id: 'limestone', name: 'Limestone', color: '#cbb05f', re: /\blimestone\b/i },
  { id: 'tin',       name: 'Tin',       color: '#97a1ad', re: /\b(?:tin|silver)\b/i },
  { id: 'iron',      name: 'Iron',      color: '#4e5d6c', re: /\b(?:iron|gold)\b/i },
  { id: 'coal',      name: 'Coal',      color: '#29261f', re: /\b(?:coal|platinum)\b/i },
];
const ZONE_ORE_DEFAULT = { 'Evershade Weald': 'copper', 'Night Harbor': 'copper' };
const HERB_TYPES = [
  { name: 'Duneleaf', color: '#c9a266' }, { name: 'Ethtongue', color: '#8a5fc0' },
  { name: 'Gadolvine', color: '#3e7a45' }, { name: 'Ghost Poppy', color: '#cf9fb4' },
  { name: 'Ironroot', color: '#8b4a2e' }, { name: 'Lionleaf', color: '#d4a017' },
  { name: 'Magebloom', color: '#4a7fd4' }, { name: 'Moonveil', color: '#a8a4d0' },
  { name: "Nomad's Grace", color: '#3f9088' }, { name: 'Phoenix Flower', color: '#e0562a' },
  { name: 'Selstie Kelp', color: '#2e8b6e' }, { name: 'Shadeshroom', color: '#6b5b73' },
  { name: 'Stranglevine', color: '#5a6b2f' }, { name: 'Stygian Moss', color: '#2f4a38' },
  { name: 'Sylvine', color: '#6fae3f' }, { name: 'Whispering Sage', color: '#8fa88a' },
  { name: 'Witherweed', color: '#7d6e55' },
];
const WOOD_TYPES = [
  { name: 'Fine Wood', color: '#c08a3e' }, { name: 'Ironbark Wood', color: '#55524c' },
  { name: 'Golden Palm Wood', color: '#d4b02a' }, { name: 'Whisperpine Wood', color: '#5e7d5a' },
  { name: 'Wood', color: '#8a5f38', re: /^(rich\s+)?wood(\s+pile)?$/i },
];
function oreTier(m, zoneName) {
  if (!m || m.category !== 'ore') return null;
  const byLabel = m.label ? ORE_TIERS.find((t) => t.re.test(m.label)) : null;
  if (byLabel) return byLabel;
  const def = ZONE_ORE_DEFAULT[zoneName];
  return def ? (ORE_TIERS.find((t) => t.id === def) || null) : null;
}
const herbType = (m) => (m && m.category === 'herb' && m.label)
  ? (HERB_TYPES.find((h) => m.label.toLowerCase().includes(h.name.toLowerCase())) || null) : null;
const woodType = (m) => (m && m.category === 'wood' && m.label)
  ? (WOOD_TYPES.find((w) => w.re ? w.re.test(m.label.trim()) : m.label.toLowerCase().includes(w.name.toLowerCase())) || null) : null;
const gatherType = (m, zoneName) => oreTier(m, zoneName) || herbType(m) || woodType(m);
// Greyscale + light/dark shift so the icon reads on any disc color.
const tierIconFilter = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150
    ? 'grayscale(1) brightness(0.5) contrast(1.1)'
    : 'grayscale(1) brightness(1.75) contrast(1.05)';
};
// Draw a marker's disc + icon at screen point p. Classified gatherables get their
// tier color + greyscale icon; everything else keeps the category color. `border`
// is 'own' (solid dark) or 'community' (dashed white, slightly faded fill).
function drawMarkerBody(p, m, zoneName, border) {
  const cat = catById(m.category);
  const tier = gatherType(m, zoneName);
  const disc = tier ? tier.color : cat.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, MARKER_RADIUS, 0, Math.PI * 2);
  if (border === 'community') ctx.globalAlpha = 0.9;
  ctx.fillStyle = disc;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;
  if (border === 'community') { ctx.setLineDash([3, 2]); ctx.strokeStyle = '#ffffff'; }
  else ctx.strokeStyle = '#08090b';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.save();
  if (tier) ctx.filter = tierIconFilter(tier.color);
  ctx.font = '12px "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = contrastColor(disc);
  ctx.fillText(cat.icon, p.x, p.y + 1);
  ctx.restore();
}

// ---- Helpers ----

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const currentZone = () => data.zones.find((z) => z.id === currentZoneId) || null;
const save = () => window.mapAPI.saveData(data);

function toScreen(wx, wy) {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
}
function toWorld(sx, sy) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

// Community markers are stored in WEB-image pixels (the downscaled map the site shows).
// The app draws on the full-res source image, so divide by the same scale export-maps
// applied to convert a web-pixel coord back into this image's pixel space.
function webScale() {
  if (!mapImage) return 1;
  const long = Math.max(mapImage.width, mapImage.height);
  return long > WEB_MAX ? WEB_MAX / long : 1;
}

// Pull approved community markers from the API (read-only). Best-effort: a failure
// (offline, etc.) just leaves the overlay empty without disturbing the user's own map.
async function loadCommunityMarkers() {
  try {
    const r = await fetch(COMMUNITY_MARKERS_URL + '?t=' + Date.now());
    if (!r.ok) return;
    const j = await r.json();
    communityMarkers = Array.isArray(j.markers) ? j.markers : [];
  } catch { return; }
  refreshSidebar();
  draw();
}

// ---- Rendering ----

function resizeCanvas() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  draw();
}

function draw() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  const zone = currentZone();
  if (!zone) return;

  // World layer (map image or grid)
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);

  if (mapImage) {
    ctx.drawImage(mapImage, 0, 0);
  } else {
    drawGrid();
  }
  ctx.restore();

  // Markers (drawn in screen space so they stay the same size at any zoom)
  for (const m of zone.markers) {
    if (hiddenCategories.has(m.category)) continue;
    const p = toScreen(m.x, m.y);
    drawMarkerBody(p, m, zone.name, 'own');

    if (view.scale > 0.6 && m.label) {
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.fillStyle = '#dfe6ec';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(m.label, p.x, p.y + MARKER_RADIUS + 10);
      ctx.fillText(m.label, p.x, p.y + MARKER_RADIUS + 10);
    }
  }

  // Community markers (read-only overlay from mnm-db.com) — a dashed white ring and a
  // faint-blue label set them apart from your own. Web-pixel coords ÷ scale → image px.
  if (showCommunity && mapImage && zone.name) {
    const sc = webScale();
    ctx.save();
    for (const m of communityMarkers) {
      if (m.zone !== zone.name || (m.map_id || 'official') !== 'official' || hiddenCategories.has(m.category)) continue;
      const p = toScreen(m.x / sc, m.y / sc);
      drawMarkerBody(p, m, m.zone, 'community');

      if (view.scale > 0.6 && m.label) {
        ctx.font = '11px "Segoe UI", sans-serif';
        ctx.fillStyle = '#bcd6ff';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = 3;
        ctx.strokeText(m.label, p.x, p.y + MARKER_RADIUS + 10);
        ctx.fillText(m.label, p.x, p.y + MARKER_RADIUS + 10);
      }
    }
    ctx.restore();
  }
}

function drawGrid() {
  const step = 100;
  ctx.strokeStyle = '#231810';
  ctx.lineWidth = 1 / view.scale;
  ctx.beginPath();
  for (let i = 0; i <= GRID_SIZE; i += step) {
    ctx.moveTo(i, 0); ctx.lineTo(i, GRID_SIZE);
    ctx.moveTo(0, i); ctx.lineTo(GRID_SIZE, i);
  }
  ctx.stroke();
  ctx.strokeStyle = '#3a291b';
  ctx.lineWidth = 2 / view.scale;
  ctx.strokeRect(0, 0, GRID_SIZE, GRID_SIZE);
}

let userMovedView = false; // true once the user pans/zooms; auto-refit stays off until the next zone switch

// Smallest allowed zoom: the whole map fits in the window (limited by whichever
// dimension is tighter). You can never zoom out past the full image.
function minZoom() {
  const w = mapImage ? mapImage.width : GRID_SIZE;
  const h = mapImage ? mapImage.height : GRID_SIZE;
  return Math.min(canvas.clientWidth / w, canvas.clientHeight / h);
}

function fitView() {
  const w = mapImage ? mapImage.width : GRID_SIZE;
  const h = mapImage ? mapImage.height : GRID_SIZE;
  view.scale = minZoom();
  view.x = (canvas.clientWidth - w * view.scale) / 2;
  view.y = (canvas.clientHeight - h * view.scale) / 2;
  userMovedView = false;
}

// ---- Zone handling ----

function loadZoneImage(zone, thenFit) {
  mapImage = null;
  if (zone && zone.image) {
    const img = new Image();
    img.onload = () => {
      mapImage = img;
      if (thenFit) fitView();
      draw();
    };
    img.onerror = () => draw();
    img.src = 'file:///' + zone.image.replace(/\\/g, '/');
  }
}

function switchZone(zoneId, fit = true) {
  currentZoneId = zoneId;
  const zone = currentZone();
  hidePopup();
  loadZoneImage(zone, fit);
  if (fit) fitView();
  refreshSidebar();
  draw();
}

// Enable zone tools only when they're usable, and surface the first-time action.
const ZONE_BTN_TITLES = {
  'btn-zone-image': "Pick an image file to use as this zone's map",
  'btn-zone-review': "See every zone's current map at a glance and set defaults",
};
function updateZoneControls() {
  const hasZones = data.zones.length > 0;
  const hasCurrent = !!currentZone();
  const setBtn = (id, on, offHint) => {
    const el = $(id);
    if (!el) return;
    el.disabled = !on;
    el.title = on ? ZONE_BTN_TITLES[id] : offHint;
  };
  setBtn('btn-zone-image', hasCurrent, 'Select or create a zone first');
  setBtn('btn-zone-review', hasZones, 'No zones yet — Import All or just play to create them');
  $('zone-select').disabled = !hasZones;
  // First run (no zones): surface a highlighted Import All above Options as the
  // getting-started action; it disappears once any zone exists.
  $('btn-wiki-all-hero').classList.toggle('hidden', hasZones);
}

function refreshSidebar() {
  // Zone dropdown
  const sel = $('zone-select');
  sel.innerHTML = '';
  for (const z of data.zones) {
    const opt = document.createElement('option');
    opt.value = z.id;
    opt.textContent = z.name;
    if (z.id === currentZoneId) opt.selected = true;
    sel.appendChild(opt);
  }
  $('empty-state').classList.toggle('hidden', data.zones.length > 0);
  updateOverlayZoneLabel();
  renderMapSwitcher();
  updateZoneControls();

  // Category list with live counts for this zone
  const zone = currentZone();
  const counts = {};
  if (zone) for (const m of zone.markers) counts[m.category] = (counts[m.category] || 0) + 1;

  const list = $('category-list');
  list.innerHTML = '';
  for (const cat of CATEGORIES) {
    const row = document.createElement('div');
    row.className = 'cat-row';

    // The checkbox itself is tinted with the category's color, so no separate dot is needed
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hiddenCategories.has(cat.id);
    cb.title = 'Show/hide ' + cat.name + ' markers';
    cb.style.accentColor = cat.color;
    cb.addEventListener('change', () => {
      cb.checked ? hiddenCategories.delete(cat.id) : hiddenCategories.add(cat.id);
      draw();
    });

    // A real button so it reads as clickable: click to arm quick-add, click again to stop
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.title = 'Quick-add ' + cat.name + ' markers (Esc to stop)';
    btn.addEventListener('click', () => {
      const alreadyArmed = quickPlace && quickAddCategory === cat.id;
      quickAddCategory = cat.id;
      setQuickPlace(!alreadyArmed);
    });

    const name = document.createElement('span');
    name.className = 'cat-name';
    name.textContent = cat.name;

    const count = document.createElement('span');
    count.className = 'cat-count';
    count.textContent = counts[cat.id] || '';

    // Armed = the button takes on its category's color
    if (quickPlace && quickAddCategory === cat.id) {
      btn.classList.add('active');
      btn.style.background = cat.color;
      btn.style.borderColor = cat.color;
      btn.style.color = contrastColor(cat.color);
      count.style.color = contrastColor(cat.color);
    }

    btn.append(name, count);
    row.append(cb, btn);
    list.appendChild(row);
  }

  // How many community markers exist in this zone (shown next to the toggle, even when off)
  const cc = $('community-count');
  if (cc) {
    const zn = currentZone() && currentZone().name;
    const n = zn ? communityMarkers.filter((m) => m.zone === zn && (m.map_id || 'official') === 'official').length : 0;
    cc.textContent = n ? ' ' + n : '';
  }
}

// ---- Pan / zoom ----

let dragging = false;
let dragMoved = false;
let last = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  dragMoved = false;
  last = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) { dragMoved = true; userMovedView = true; }
  view.x += dx;
  view.y += dy;
  last = { x: e.clientX, y: e.clientY };
  draw();
});

window.addEventListener('mouseup', () => {
  dragging = false;
  canvas.classList.remove('dragging');
});

// Zoom keeping the point under (mx, my) fixed on screen
function zoomAt(mx, my, factor) {
  const world = toWorld(mx, my);
  userMovedView = true;
  view.scale = Math.max(minZoom(), Math.min(view.scale * factor, 10));
  view.x = mx - world.x * view.scale;
  view.y = my - world.y * view.scale;
  draw();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
});

// Button zoom pivots on the centre of the visible map
function zoomByButton(factor) {
  zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
}

// ---- Clicking markers / adding markers ----

function markerAt(sx, sy) {
  const zone = currentZone();
  if (!zone) return null;
  // Search top-most first
  for (let i = zone.markers.length - 1; i >= 0; i--) {
    const m = zone.markers[i];
    if (hiddenCategories.has(m.category)) continue;
    const p = toScreen(m.x, m.y);
    if (Math.hypot(p.x - sx, p.y - sy) <= MARKER_RADIUS + 3) return m;
  }
  // Then the community overlay (read-only) — converting web-pixel coords to this image's
  if (showCommunity && mapImage && zone.name) {
    const sc = webScale();
    for (let i = communityMarkers.length - 1; i >= 0; i--) {
      const m = communityMarkers[i];
      if (m.zone !== zone.name || (m.map_id || 'official') !== 'official' || hiddenCategories.has(m.category)) continue;
      const p = toScreen(m.x / sc, m.y / sc);
      if (Math.hypot(p.x - sx, p.y - sy) <= MARKER_RADIUS + 3) return { ...m, _community: true };
    }
  }
  return null;
}

canvas.addEventListener('click', (e) => {
  if (dragMoved) return; // it was a pan, not a click
  const rect = canvas.getBoundingClientRect();

  // Quick Place: every click drops a marker of the chosen type, no dialog
  if (quickPlace) {
    const zone = currentZone();
    if (!zone) return;
    const cat = catById(quickAddCategory);
    const pos = toWorld(e.clientX - rect.left, e.clientY - rect.top);

    // "Other" and "Quest NPCs" can't be auto-named, so they get the dialog even in quick-add
    if (cat.id === 'misc' || cat.id === 'quest') {
      pendingWorldPos = pos;
      openMarkerModal(null, cat.id);
      return;
    }
    const count = zone.markers.filter((m) => m.category === cat.id).length + 1;
    zone.markers.push({
      id: uid(),
      x: pos.x,
      y: pos.y,
      label: cat.name.split(' / ')[0] + ' ' + count,
      category: cat.id,
      notes: '',
    });
    save();
    refreshSidebar();
    draw();
    return;
  }

  const m = markerAt(e.clientX - rect.left, e.clientY - rect.top);
  m ? showPopup(m, e.clientX, e.clientY) : hidePopup();
});

canvas.addEventListener('dblclick', (e) => {
  const zone = currentZone();
  if (!zone || quickPlace) return;
  const rect = canvas.getBoundingClientRect();
  const m = markerAt(e.clientX - rect.left, e.clientY - rect.top);
  if (m) return; // double-clicked an existing marker; the click handler opened it
  pendingWorldPos = toWorld(e.clientX - rect.left, e.clientY - rect.top);
  openMarkerModal(null);
});

// ---- Quick-add mode ----
// Armed by clicking a category button; every map click then drops that marker.

let quickPlace = false;
let quickAddCategory = CATEGORIES[0].id;

function setQuickPlace(on) {
  quickPlace = on;
  canvas.classList.toggle('quickplace', on);
  if (on) hidePopup();
  refreshSidebar(); // the armed category button shows its own active color
}

// ---- Auto-follow the game's current zone (read from its log file) ----
// The log uses internal names; map them to our zone names here as we learn them.

const ZONE_ALIASES = {
  evergrove: 'Evershade Weald',
};

// Zones that share one game zone-code but have several maps (loaded from
// zone-aliases.json at startup). Drives the manual map switcher.
let MULTI_MAP = {};

const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

let appReady = false;        // don't react to zone events until saved data is loaded
let pendingGameZone = null;  // a zone event that arrived during startup

window.mapAPI.onGameZone((internalName) => {
  appReady ? handleGameZone(internalName) : (pendingGameZone = internalName);
});

async function handleGameZone(internalName) {
  if (!$('follow-zone').checked) return;
  const key = internalName.toLowerCase();

  // 1. A zone we've already linked to this internal name
  let zone = data.zones.find((z) => z.gameName === key);

  // 2. Match by alias or name similarity, then remember the link
  if (!zone) {
    const aliased = ZONE_ALIASES[key];
    zone =
      (aliased && data.zones.find((z) => z.name.toLowerCase() === aliased.toLowerCase())) ||
      data.zones.find((z) => normName(z.name) === normName(key)) ||
      data.zones.find(
        (z) => normName(z.name).includes(normName(key)) || normName(key).includes(normName(z.name))
      );
    if (zone) {
      zone.gameName = key;
      save();
    }
  }

  if (zone) {
    characterZoneId = zone.id;
    if (zone.id !== currentZoneId) {
      switchZone(zone.id);
    } else {
      updateOverlayZoneLabel(); // refresh the [current zone] marker even if the map didn't change
    }
    return;
  }

  // 3. Brand-new place: create the zone automatically
  const pretty = key.charAt(0).toUpperCase() + key.slice(1);
  zone = { id: uid(), name: pretty, gameName: key, image: null, markers: [] };
  data.zones.push(zone);
  characterZoneId = zone.id;
  save();
  switchZone(zone.id);
  // Desktop: let you pick when several maps exist. Overlay: just grab the best.
  const got = await chooseWikiMap(zone, isOverlay);
  if (got === 'picker') {
    wikiStatus('New zone "' + pretty + '" created — choose its map.');
  } else {
    wikiStatus(
      got
        ? 'New zone "' + pretty + '" created with its wiki map.'
        : 'New zone "' + pretty + '" created. Use Import Map to set its map.'
    );
  }
}

// ---- Marker modal (add + edit) ----

function openMarkerModal(marker, presetCategory) {
  editingMarkerId = marker ? marker.id : null;
  $('marker-modal-title').textContent = marker ? 'Edit Marker' : 'Add Marker';

  const catSel = $('marker-category');
  catSel.innerHTML = '';
  for (const cat of CATEGORIES) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.icon + '  ' + cat.name;
    catSel.appendChild(opt);
  }

  $('marker-label').value = marker ? marker.label : '';
  catSel.value = marker ? marker.category : (presetCategory || CATEGORIES[0].id);
  $('marker-notes').value = marker ? (marker.notes || '') : '';
  $('marker-error').classList.add('hidden');

  $('marker-modal').classList.remove('hidden');
  $('marker-label').focus();
}

function closeMarkerModal() {
  $('marker-modal').classList.add('hidden');
  editingMarkerId = null;
  pendingWorldPos = null;
}

$('marker-save').addEventListener('click', () => {
  const zone = currentZone();
  if (!zone) return closeMarkerModal();

  const label = $('marker-label').value.trim();
  const category = $('marker-category').value;
  const notes = $('marker-notes').value.trim();

  // "Other" and "Quest / NPC" markers must say what they are
  if ((category === 'misc' || category === 'quest') && !label && !notes) {
    $('marker-error').textContent =
      'Give "' + catById(category).name + '" markers a name or a note — future you will thank you.';
    $('marker-error').classList.remove('hidden');
    $('marker-label').focus();
    return;
  }

  if (editingMarkerId) {
    const m = zone.markers.find((x) => x.id === editingMarkerId);
    if (m) Object.assign(m, { label, category, notes });
  } else if (pendingWorldPos) {
    zone.markers.push({
      id: uid(),
      x: pendingWorldPos.x,
      y: pendingWorldPos.y,
      label: label || catById(category).name,
      category,
      notes,
    });
  }
  save();
  closeMarkerModal();
  refreshSidebar();
  draw();
});

$('marker-cancel').addEventListener('click', closeMarkerModal);

// ---- Marker popup ----

function showPopup(marker, pageX, pageY) {
  popupMarkerId = marker.id;
  popupIsCommunity = !!marker._community;
  const cat = catById(marker.category);
  $('popup-title').textContent = marker.label;
  $('popup-category').textContent = cat.icon + ' ' + cat.name;
  $('popup-notes').textContent = popupIsCommunity
    ? ('Community marker' + (marker.verified ? ' (verified)' : '') + (marker.submitter ? ' · by ' + marker.submitter : ''))
    : (marker.notes || '');
  // Community markers are read-only — only your own get Edit / Delete.
  $('popup-edit').classList.toggle('hidden', popupIsCommunity);
  $('popup-delete').classList.toggle('hidden', popupIsCommunity);

  const popup = $('marker-popup');
  popup.classList.remove('hidden');
  const maxX = window.innerWidth - 260;
  const maxY = window.innerHeight - 180;
  popup.style.left = Math.min(pageX + 12, maxX) + 'px';
  popup.style.top = Math.min(pageY + 12, maxY) + 'px';
}

function hidePopup() {
  $('marker-popup').classList.add('hidden');
  popupMarkerId = null;
  popupIsCommunity = false;
}

$('popup-close').addEventListener('click', hidePopup);

$('popup-delete').addEventListener('click', () => {
  if (popupIsCommunity) return; // read-only
  const zone = currentZone();
  if (zone) {
    zone.markers = zone.markers.filter((m) => m.id !== popupMarkerId);
    save();
    refreshSidebar();
    draw();
  }
  hidePopup();
});

$('popup-edit').addEventListener('click', () => {
  if (popupIsCommunity) return; // read-only
  const zone = currentZone();
  const m = zone && zone.markers.find((x) => x.id === popupMarkerId);
  hidePopup();
  if (m) openMarkerModal(m);
});

// ---- Zone modal ----

$('zone-select').addEventListener('change', (e) => switchZone(e.target.value));

$('btn-zone-image').addEventListener('click', async () => {
  const zone = currentZone();
  if (!zone) return;
  const imagePath = await window.mapAPI.chooseMapImage();
  if (!imagePath) return;
  zone.image = imagePath;
  save();
  loadZoneImage(zone, true);
});

// ---- Wiki map import ----

const wikiStatus = (msg) => { $('wiki-status').textContent = msg; };

async function fetchWikiMapFor(zone) {
  wikiStatus('Downloading map for ' + zone.name + '…');
  const result = await window.mapAPI.wikiFetchMap(zone.name);
  if (result.error) {
    wikiStatus(result.error);
    return false;
  }
  zone.image = result.path;
  save();
  if (zone.id === currentZoneId) loadZoneImage(zone, true);
  return true;
}

async function downloadAndSetMap(zone, title) {
  wikiStatus('Downloading map for ' + zone.name + '…');
  const res = await window.mapAPI.wikiDownloadMap(zone.name, title);
  if (!res || res.error) { wikiStatus((res && res.error) || 'Download failed.'); return false; }
  zone.image = res.path;
  save();
  if (zone.id === currentZoneId) loadZoneImage(zone, true);
  wikiStatus('Map set for ' + zone.name + '.');
  return true;
}

// Look up a zone's wiki maps; auto-pick the best, or show a picker when there
// are several. `auto` forces the best pick (overlay mode / bulk import).
// onClose (optional) is called after the map is set, the picker is cancelled, or
// no candidates were found — used by the Review panel to come back into view.
async function chooseWikiMap(zone, auto, onClose) {
  wikiStatus('Looking up maps for ' + zone.name + '…');
  const r = await window.mapAPI.wikiListMaps(zone.name);
  if (!r || r.error) { wikiStatus((r && r.error) || 'Lookup failed.'); if (onClose) onClose(); return false; }
  const cands = r.candidates;
  if (auto || cands.length === 1) { const ok = await downloadAndSetMap(zone, cands[0].title); if (onClose) onClose(); return ok; }
  openMapPicker(zone, cands, onClose);
  return 'picker';
}

let mapPickerOnClose = null;

function openMapPicker(zone, candidates, onClose) {
  mapPickerOnClose = onClose || null;
  const grid = $('map-picker-grid');
  grid.innerHTML = '';
  for (const c of candidates) {
    const name = c.title.replace(/^File:/, '');
    const card = document.createElement('button');
    card.className = 'map-pick';
    card.title = name;
    card.innerHTML =
      '<img src="' + c.preview + '" alt="" />' +
      '<span class="map-pick-name">' + name + '</span>' +
      '<span class="map-pick-dim">' + c.width + ' × ' + c.height + '</span>';
    card.addEventListener('click', async () => {
      $('map-picker-modal').classList.add('hidden');
      await downloadAndSetMap(zone, c.title);
      const cb = mapPickerOnClose; mapPickerOnClose = null; if (cb) cb();
    });
    grid.appendChild(card);
  }
  $('map-picker-title').textContent = 'Choose a map for ' + zone.name;
  $('map-picker-modal').classList.remove('hidden');
}

$('map-picker-cancel').addEventListener('click', () => {
  $('map-picker-modal').classList.add('hidden');
  const cb = mapPickerOnClose; mapPickerOnClose = null; if (cb) cb();
});

// ---- Review zone maps ----

function openZoneReview() {
  const grid = $('zone-review-grid');
  grid.innerHTML = '';
  const zones = data.zones.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const zone of zones) {
    const card = document.createElement('button');
    card.className = 'map-pick' + (zone.image ? '' : ' nomap');
    const thumb = zone.image
      ? '<img src="file:///' + zone.image.replace(/\\/g, '/') + '" alt="" />'
      : '<span class="map-pick-empty">No map</span>';
    const marks = (zone.markers || []).length;
    card.innerHTML = thumb +
      '<span class="map-pick-name">' + zone.name + '</span>' +
      '<span class="map-pick-dim">' + (zone.image ? (marks ? marks + ' markers' : 'mapped') : 'tap to add') + '</span>';
    card.addEventListener('click', () => changeZoneMap(zone));
    grid.appendChild(card);
  }
  $('zone-review-modal').classList.remove('hidden');
}

function changeZoneMap(zone) {
  $('zone-review-modal').classList.add('hidden');
  chooseWikiMap(zone, false, openZoneReview); // reopens the review when done/cancelled
}

$('btn-zone-review').addEventListener('click', openZoneReview);
$('zone-review-close').addEventListener('click', () => $('zone-review-modal').classList.add('hidden'));

$('btn-wiki-all-hero').addEventListener('click', () => $('btn-wiki-all').click());

$('btn-wiki-all').addEventListener('click', async () => {
  if (!confirm(
    'Import All is normally only needed once, when first setting up.\n\n' +
    'It creates any missing zones and downloads maps only for zones that have none — maps you already have are left untouched. Continue?'
  )) return;
  wikiStatus('Fetching zone list from wiki…');
  const names = await window.mapAPI.wikiZoneList();
  if (names.error) {
    wikiStatus(names.error);
    return;
  }

  // Create any zones we don't have yet
  for (const name of names) {
    if (!data.zones.some((z) => z.name.toLowerCase() === name.toLowerCase())) {
      data.zones.push({ id: uid(), name, image: null, markers: [] });
    }
  }
  save();
  if (!currentZoneId && data.zones.length) switchZone(data.zones[0].id);
  refreshSidebar();

  // Download maps one at a time (zones that already have a map are skipped)
  let done = 0, failed = 0, skipped = 0;
  for (let i = 0; i < data.zones.length; i++) {
    const zone = data.zones[i];
    if (zone.image) { skipped++; continue; }
    wikiStatus('(' + (i + 1) + '/' + data.zones.length + ') ' + zone.name + '…');
    (await fetchWikiMapFor(zone)) ? done++ : failed++;
  }
  wikiStatus('Done: ' + done + ' maps downloaded' +
    (skipped ? ', ' + skipped + ' already had maps' : '') +
    (failed ? ', ' + failed + ' had no wiki map yet' : '') + '.');
  refreshSidebar();
});

// ---- Export / import ----

$('btn-export').addEventListener('click', () => {
  if (!currentZone()) return;
  $('export-modal').classList.remove('hidden');
});

$('export-cancel').addEventListener('click', () => $('export-modal').classList.add('hidden'));

$('export-current').addEventListener('click', async () => {
  $('export-modal').classList.add('hidden');
  const zone = currentZone();
  if (!zone) return;
  await window.mapAPI.exportData('current', [
    { name: zone.name, gameName: zone.gameName, image: zone.image, markers: zone.markers },
  ]);
});

$('export-all').addEventListener('click', async () => {
  $('export-modal').classList.add('hidden');
  await window.mapAPI.exportData(
    'all',
    data.zones.map((z) => ({ name: z.name, gameName: z.gameName, image: z.image, markers: z.markers }))
  );
});

// Merge one imported zone into our data. Creates the zone if new; adopts the
// imported map only when the target has none. Exact-duplicate markers (same
// position, category and label) are skipped, so re-importing adds only what's new.
function mergeImportedZone(z) {
  let zone = data.zones.find((t) => t.name.toLowerCase() === String(z.name).toLowerCase());
  if (!zone) {
    zone = { id: uid(), name: String(z.name) || 'Imported Zone', gameName: z.gameName || undefined, image: null, markers: [] };
    data.zones.push(zone);
  }
  if (z.image && !zone.image) zone.image = z.image;
  if (z.gameName && !zone.gameName) zone.gameName = z.gameName;

  let added = 0;
  for (const m of z.markers || []) {
    if (typeof m.x !== 'number' || typeof m.y !== 'number') continue;
    const dupe = zone.markers.some(
      (ex) => ex.x === m.x && ex.y === m.y && ex.category === m.category && ex.label === m.label
    );
    if (dupe) continue;
    zone.markers.push({
      id: uid(),
      x: m.x,
      y: m.y,
      label: String(m.label || 'Imported'),
      category: catById(m.category).id,
      notes: String(m.notes || ''),
    });
    added++;
  }
  return { zone, added };
}

$('btn-import').addEventListener('click', async () => {
  const result = await window.mapAPI.importOpen();
  if (!result) return; // cancelled the file dialog
  if (result.error) { alert(result.error); return; }
  if (!result.zones || result.zones.length === 0) { alert('That file has no zones in it.'); return; }
  openImportModal(result.zones);
});

function openImportModal(zones) {
  const list = $('import-list');
  list.innerHTML = '';
  for (const z of zones) {
    const row = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.zoneName = z.name;

    const name = document.createElement('span');
    name.textContent = z.name;

    const meta = document.createElement('span');
    meta.className = 'imp-meta';
    meta.textContent = z.markerCount + ' marker' + (z.markerCount === 1 ? '' : 's') +
      (z.hasImage ? ' · map' : '');

    row.append(cb, name, meta);
    list.appendChild(row);
  }
  $('import-all-toggle').checked = true;
  $('import-modal').classList.remove('hidden');
}

$('import-all-toggle').addEventListener('change', (e) => {
  for (const cb of $('import-list').querySelectorAll('input')) cb.checked = e.target.checked;
});

$('import-cancel').addEventListener('click', () => {
  $('import-modal').classList.add('hidden');
  window.mapAPI.importCommit([]); // clears the pending import in the backend
});

$('import-go').addEventListener('click', async () => {
  const names = [...$('import-list').querySelectorAll('input')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.zoneName);
  $('import-modal').classList.add('hidden');
  if (names.length === 0) return;

  const result = await window.mapAPI.importCommit(names);
  if (!result || result.error) { alert((result && result.error) || 'Import failed.'); return; }

  let totalAdded = 0, firstZone = null;
  for (const z of result.zones) {
    const merged = mergeImportedZone(z);
    totalAdded += merged.added;
    if (!firstZone) firstZone = merged.zone;
  }
  save();
  if (firstZone) {
    currentZoneId = null; // force a reload so an adopted map image shows
    switchZone(firstZone.id);
  }
  alert('Imported ' + totalAdded + ' new marker(s) across ' + result.zones.length + ' zone(s).');
});

// ---- Keyboard ----

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMarkerModal();
    $('export-modal').classList.add('hidden');
    $('import-modal').classList.add('hidden');
    $('map-picker-modal').classList.add('hidden');
    $('replay-modal').classList.add('hidden');
    hidePopup();
    setQuickPlace(false);
  }
});

// ---- Startup ----

function handleViewportResize() {
  resizeCanvas();
  // Keep the map filling the window unless the user has zoomed in on purpose
  if (!userMovedView) {
    fitView();
    draw();
  } else if (view.scale < minZoom()) {
    // Window grew enough that the current zoom is now below the floor — refit
    fitView();
    draw();
  }
}

window.addEventListener('resize', handleViewportResize);

// A ResizeObserver catches every size change of the map area — including the
// overlay window's late/odd sizing and compact↔fullscreen swaps — so the map
// always re-fits, where the window 'resize' event alone can miss them.
new ResizeObserver(handleViewportResize).observe(document.getElementById('map-area'));

$('btn-fit').addEventListener('click', () => {
  fitView();
  draw();
});

$('btn-zoom-in').addEventListener('click', () => zoomByButton(1.25));
$('btn-zoom-out').addEventListener('click', () => zoomByButton(1 / 1.25));

// ---- Overlay mode ----

const isOverlay = new URLSearchParams(location.search).get('overlay') === '1';
let overlayIsFull = false;
let overlayClickThrough = false;
let hintTimer = null;

// ---- Collapsible sidebar ----

// Keep the overlay's collapse state separate from the desktop's, so collapsing
// the sidebar in the overlay never carries over to the full desktop window.
const SIDEBAR_KEY = isOverlay ? 'mnm-sidebar-collapsed-overlay' : 'mnm-sidebar-collapsed';
const cameFromOverlay = new URLSearchParams(location.search).get('fromOverlay') === '1';

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('btn-sidebar').textContent = collapsed ? '»' : '«';
  $('btn-sidebar').title = (collapsed ? 'Show' : 'Hide') + ' the sidebar';
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch {}
  // The map area just changed width — refit unless the user has zoomed in
  setTimeout(() => { resizeCanvas(); if (!userMovedView) fitView(); draw(); }, 0);
}

$('btn-sidebar').addEventListener('click', () => {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
});

// Zone "Options" disclosure: hides the rename/map/import buttons until needed
$('btn-zone-options').addEventListener('click', () => {
  const hidden = $('zone-options').classList.toggle('hidden');
  $('btn-zone-options').textContent = hidden ? 'Options ▾' : 'Options ▴';
});

// ---- Drop tracker (data collection) ----

const TRACKER_KEY = 'mnm-tracker-enabled';
const trackerStatus = (msg) => { $('tracker-status').textContent = msg; };

function showTrackerSummary(r, suffix) {
  if (!r || r.error) return trackerStatus((r && r.error) || 'Scan failed.');
  if (r.disabled) return trackerStatus('Collection off.');
  trackerStatus(r.items + ' items · ' + r.mobs + ' mobs · ' + r.events + ' events' + (suffix || ''));
}

$('tracker-enabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try { localStorage.setItem(TRACKER_KEY, on ? '1' : '0'); } catch {}
  if (on) {
    trackerStatus('Collecting…');
    showTrackerSummary(await window.mapAPI.trackerSetEnabled(true), ' · auto-updating');
  } else {
    await window.mapAPI.trackerSetEnabled(false);
    trackerStatus('Collection off.');
  }
});

// Publish to MnMdb — owner build only (the dev flag is passed from main.js).
const isDev = new URLSearchParams(location.search).get('dev') === '1';
const publishStatus = (msg) => { $('publish-status').textContent = msg; };
if (isDev) {
  const pubBtn = $('tracker-publish');
  pubBtn.classList.remove('hidden');
  // The owner publishes their own data directly, so the friend-facing
  // "Export my data to share" button is redundant on the owner build — hide it.
  $('btn-export-contribution').classList.add('hidden');
  pubBtn.addEventListener('click', async () => {
    pubBtn.disabled = true;
    publishStatus('Publishing… regenerating data & pushing to GitHub.');
    const r = await window.mapAPI.publishMnmdb();
    publishStatus(r && r.ok ? r.message : (r && r.error) ? r.error : 'Publish failed.');
    pubBtn.disabled = false;
  });
}

// Export my data to share — everyone can do this (it's how trusted friends
// contribute their play data; the owner merges the file in on Publish).
const contributionStatus = (msg) => { $('contribution-status').textContent = msg; };
{
  const exBtn = $('btn-export-contribution');
  exBtn.addEventListener('click', async () => {
    exBtn.disabled = true;
    contributionStatus('Building your data file…');
    const r = await window.mapAPI.exportContribution();
    if (r && r.ok) contributionStatus(`Saved ${r.events.toLocaleString()} events (${r.mobs} mobs, ${r.items} items). Send the file to the site owner to pool it in.`);
    else if (r && r.canceled) contributionStatus('');
    else contributionStatus((r && r.error) || 'Export failed.');
    exBtn.disabled = false;
  });
}

// (Manual "Log a Trade" removed — buy/sell prices are now collected automatically
// by the Auction House tracker, so there's nothing to log by hand.)

// Compact coin string for session-replay coin lines (base-100)
function coinStr(c) {
  c = Math.round(c);
  const p = Math.floor(c / 1000000); c %= 1000000;
  const g = Math.floor(c / 10000); c %= 10000;
  const s = Math.floor(c / 100); const cp = c % 100;
  return [p && p + 'p', g && g + 'g', s && s + 's', cp && cp + 'c'].filter(Boolean).join(' ') || '0c';
}

// ---- Session Replay ----
// A recap of recent play sessions read from the game's Ledger: where you went,
// what you killed/looted/harvested, and the coin you made.

let replaySessions = [];
let replayToday = null;
let replayIdx = 0;
let replayView = 'session'; // 'session' (current/browsable) or 'today' (whole-day rollup)
let replayLive = false;     // is the shown session the live current one?

const startOfTodayMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

function renderToday() {
  const el = $('replay-today');
  const t = replayToday;
  if (!t) { el.innerHTML = '<p class="replay-empty">Nothing logged today yet — go play and it’ll fill in.</p>'; return; }
  const extended = t.spanStart < startOfTodayMs(); // a session carried over from before midnight
  const sub = t.sessionCount + ' session' + (t.sessionCount === 1 ? '' : 's') + ' · ' + fmtDur(t.playMs) + ' played' +
    (extended ? ' · since ' + fmtClock(t.spanStart) + ' (carried over midnight)' : '');
  const coinSub = [];
  const tPK = t.party ? t.party.kills : 0, tSK = t.party ? t.party.solo : t.counts.kills;
  if (tPK > 0) {
    if (tSK > 0) coinSub.push(coinStr(t.coin.killsSolo) + ' from ' + tSK + ' solo kills');
    coinSub.push(coinStr(t.coin.killsParty) + ' from ' + tPK + ' party kills (÷' + t.party.max + ')');
  } else if (t.coin.fromKills) coinSub.push(coinStr(t.coin.fromKills) + ' from kills');
  if (t.coin.fromSales) coinSub.push(coinStr(t.coin.fromSales) + ' from vendor');

  const tiles = [
    { n: t.counts.kills, l: 'kills' },
    { n: t.counts.loot, l: 'looted' },
    { n: t.counts.harvest, l: 'harvested' },
    { n: t.counts.sales, l: 'vendor sales' },
  ].map((x) => '<div class="rtile"><span class="rt-num">' + x.n + '</span><span class="rt-lbl">' + x.l + '</span></div>').join('');

  // Zones played today, ranked by time (no per-zone timeline across sessions, so bars by total time).
  const zones = (t.zones || []).filter((z) => z.ms > 0);
  const zMax = Math.max(1, ...zones.map((z) => z.ms));
  const zoneHtml = zones.map((z) => {
    const w = Math.max(8, Math.round((z.ms / zMax) * 100));
    return '<div class="rseg"><div class="rseg-top"><span class="rseg-zone">' + reEsc(z.zone) + '</span></div>' +
      '<div class="rseg-track"><div class="rseg-bar" style="width:' + w + '%"></div></div>' +
      '<div class="rseg-meta">' + reEsc(fmtDur(z.ms)) + '</div></div>';
  }).join('');

  const cols = [];
  if (t.topKills.length) cols.push('<div><div class="replay-col-title">Most killed</div>' + topList(t.topKills) + '</div>');
  if (t.topLoot.length) cols.push('<div><div class="replay-col-title">Top loot</div>' + topList(t.topLoot) + '</div>');
  if (t.topHarvest.length) cols.push('<div><div class="replay-col-title">Most harvested</div>' + topList(t.topHarvest) + '</div>');

  el.innerHTML =
    '<div class="replay-when"><b>Today</b> · ' + reEsc(sub) + (t.active ? ' · <span class="replay-live">● Live</span>' : '') + '</div>' +
    '<div class="replay-coin">+' + reEsc(coinStr(t.coin.total)) + ' earned' +
      (coinSub.length ? ' <span class="replay-coin-sub">(' + reEsc(coinSub.join(' · ')) + ')</span>' : '') + '</div>' +
    '<div class="replay-tiles">' + tiles + '</div>' +
    (zoneHtml ? '<div class="replay-col-title">Where you played</div><div class="replay-timeline">' + zoneHtml + '</div>' : '') +
    (cols.length ? '<div class="replay-cols">' + cols.join('') + '</div>' : '');
}

const reEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

function topList(rows) {
  if (!rows.length) return '<p class="replay-empty">Nothing this session.</p>';
  return '<ul class="replay-list">' + rows.slice(0, 6).map((r) =>
    '<li><span class="rl-name">' + reEsc(r.name) + '</span><span class="rl-count">' + r.count + '</span></li>').join('') + '</ul>';
}

function renderReplay() {
  const body = $('replay-body');
  if (!replaySessions.length) {
    $('replay-count').textContent = '';
    body.innerHTML = '<p class="replay-empty">No play sessions found yet. Go play, then check back — sessions are read straight from the game\'s Ledger.</p>';
    $('replay-prev').disabled = $('replay-next').disabled = true;
    replayLive = false; updateEndBtn();
    return;
  }
  const s = replaySessions[replayIdx];
  const live = s.active && replayIdx === 0; // most-recent session still within the idle window
  replayLive = live;
  // replayIdx 0 = most recent; "Newer" decreases the index.
  // No "Latest" text here — the toggle already says it and the card shows the date.
  // Just a Live dot for the live session, or a position counter when browsing older.
  $('replay-count').innerHTML = live
    ? '<span class="replay-live">● Live</span>'
    : (replayIdx === 0 ? '' : (replayIdx + 1) + ' of ' + replaySessions.length);
  $('replay-next').disabled = replayIdx <= 0;
  $('replay-prev').disabled = replayIdx >= replaySessions.length - 1;
  updateEndBtn(); // "end session" only on the live session, in session view

  const tiles = [
    { n: s.counts.kills, l: 'kills' },
    { n: s.counts.loot, l: 'looted' },
    { n: s.counts.harvest, l: 'harvested' },
    { n: s.counts.sales, l: 'vendor sales' },
  ].map((t) => '<div class="rtile"><span class="rt-num">' + t.n + '</span><span class="rt-lbl">' + t.l + '</span></div>').join('');

  const segMax = Math.max(1, ...s.segments.map((g) => g.end - g.start));
  const timeline = s.segments.map((g) => {
    const bits = [fmtDur(g.end - g.start)];
    if (g.harvest) bits.push(g.harvest + ' harvested');
    if (g.kills) bits.push(g.kills + ' killed');
    if (g.loot) bits.push(g.loot + ' looted');
    if (g.sales) bits.push(g.sales + ' sold');
    const w = Math.max(8, Math.round(((g.end - g.start) / segMax) * 100));
    return '<div class="rseg">' +
      '<div class="rseg-top"><span class="rseg-zone">' + reEsc(g.zone) + '</span>' +
      (g.coin ? '<span class="rseg-coin">+' + reEsc(coinStr(g.coin)) + '</span>' : '') + '</div>' +
      '<div class="rseg-track"><div class="rseg-bar" style="width:' + w + '%"></div></div>' +
      '<div class="rseg-meta">' + reEsc(bits.join(' · ')) + '</div></div>';
  }).join('');

  const cols = [];
  if (s.topKills.length) cols.push('<div><div class="replay-col-title">Most killed</div>' + topList(s.topKills) + '</div>');
  if (s.topLoot.length) cols.push('<div><div class="replay-col-title">Top loot</div>' + topList(s.topLoot) + '</div>');
  if (s.topHarvest.length) cols.push('<div><div class="replay-col-title">Most harvested</div>' + topList(s.topHarvest) + '</div>');

  const coinSub = [];
  const sPK = s.party ? s.party.kills : 0, sSK = s.party ? s.party.solo : s.counts.kills;
  if (sPK > 0) {
    if (sSK > 0) coinSub.push(coinStr(s.coin.killsSolo) + ' from ' + sSK + ' solo kills');
    coinSub.push(coinStr(s.coin.killsParty) + ' from ' + sPK + ' party kills (÷' + s.party.max + ')');
  } else if (s.coin.fromKills) coinSub.push(coinStr(s.coin.fromKills) + ' from kills');
  if (s.coin.fromSales) coinSub.push(coinStr(s.coin.fromSales) + ' from vendor');

  const whenHTML = live
    ? reEsc(fmtDay(s.start)) + ' · started ' + reEsc(fmtClock(s.start)) + ' · <b>in progress</b> · ' + reEsc(fmtDur(Date.now() - s.start)) + ' so far'
    : reEsc(fmtDay(s.start)) + ' · ' + reEsc(fmtClock(s.start)) + '–' + reEsc(fmtClock(s.end)) + ' · <b>' + reEsc(fmtDur(s.durationMs)) + '</b>';

  const charBadge = (replayMultiChar && s.character) ? '<span class="replay-char-badge">' + reEsc(s.character) + '</span> ' : '';
  body.innerHTML =
    '<div class="replay-when">' + charBadge + whenHTML + '</div>' +
    '<div class="replay-coin">+' + reEsc(coinStr(s.coin.total)) + (live ? ' earned so far' : ' earned') +
      (coinSub.length ? ' <span class="replay-coin-sub">(' + reEsc(coinSub.join(' · ')) + ')</span>' : '') + '</div>' +
    '<div class="replay-tiles">' + tiles + '</div>' +
    '<div class="replay-col-title">Where you went</div>' +
    '<div class="replay-timeline">' + timeline + '</div>' +
    (cols.length ? '<div class="replay-cols">' + cols.join('') + '</div>' : '');
}

let replayCharacter = null;   // null = all characters
let replayMultiChar = false;  // true when 2+ characters exist (show picker + badges)
let replayDefaultRecent = false; // on a fresh open, default to the most recently played character

async function openReplay() {
  $('replay-modal').classList.remove('hidden');
  $('replay-today').innerHTML = '';
  $('replay-body').innerHTML = '<p class="replay-empty">Reading your Ledger…</p>';
  $('replay-count').textContent = '';
  const r = await window.mapAPI.sessionReplay({ character: replayCharacter || undefined, defaultRecent: replayDefaultRecent });
  replayDefaultRecent = false;
  replaySessions = (r && r.sessions) || [];
  replayToday = (r && r.today) || null;
  replayIdx = 0;
  if (r && r.error) { $('replay-today').innerHTML = ''; $('replay-body').innerHTML = '<p class="replay-empty">Could not read sessions: ' + reEsc(r.error) + '</p>'; return; }
  replayCharacter = (r && r.character) || null; // reflect the resolved character (e.g. most-recent default)
  populateCharacterPicker((r && r.characters) || []);
  renderToday();
  renderReplay();
  setReplayView(replayView); // default 'session' — always opens on the current session
}

// Switch between the current-session card and the whole-day rollup. Both are already
// rendered; this just toggles which is visible (plus the Older/Newer nav, which only
// applies to browsing sessions).
function setReplayView(view) {
  replayView = view;
  const isSession = view === 'session';
  $('replay-body').classList.toggle('hidden', !isSession);
  $('replay-today').classList.toggle('hidden', isSession);
  $('replay-nav').classList.toggle('hidden', !isSession);
  $('rv-session').classList.toggle('active', isSession);
  $('rv-today').classList.toggle('active', !isSession);
  updateEndBtn();
}
// "End session now" only applies to the live current session, in session view.
function updateEndBtn() { $('replay-end').classList.toggle('hidden', !(replayView === 'session' && replayLive)); }

// Show a character dropdown only when more than one character has been played.
function populateCharacterPicker(characters) {
  const sel = $('replay-character');
  replayMultiChar = characters.length > 1;
  if (!replayMultiChar) { sel.classList.add('hidden'); replayCharacter = null; return; }
  sel.innerHTML = ['<option value="">All characters</option>']
    .concat(characters.map((c) => '<option value="' + reEsc(c) + '">' + reEsc(c) + '</option>')).join('');
  sel.value = replayCharacter || '';
  sel.classList.remove('hidden');
}

$('replay-character').addEventListener('change', (e) => {
  replayCharacter = e.target.value || null;
  openReplay();
});

$('btn-session-replay').addEventListener('click', () => { replayView = 'session'; replayCharacter = null; replayDefaultRecent = true; openReplay(); });
$('rv-session').addEventListener('click', () => setReplayView('session'));
$('rv-today').addEventListener('click', () => setReplayView('today'));
$('replay-close').addEventListener('click', () => $('replay-modal').classList.add('hidden'));
$('replay-x').addEventListener('click', () => $('replay-modal').classList.add('hidden'));
$('replay-end').addEventListener('click', async () => {
  $('replay-end').disabled = true;
  await window.mapAPI.sessionEnd();
  await openReplay(); // re-read — the current session is now closed out
  $('replay-end').disabled = false;
});
$('replay-prev').addEventListener('click', () => { if (replayIdx < replaySessions.length - 1) { replayIdx++; renderReplay(); } });
$('replay-next').addEventListener('click', () => { if (replayIdx > 0) { replayIdx--; renderReplay(); } });

// ---- Mob respawn timers (multiple, named, pinned to the map) ----
// Each timer is { id, name, durMs, endAt }; endAt>now means it's running. The whole
// list persists (mt-timers) so it survives a reload / overlay-mode switch. One running
// timer shows a STOP icon; stopped/expired shows a RESET icon that restarts it.
(() => {
  const KEY = 'mt-timers';
  const list = $('mt-list');
  if (!list) return;
  const soundCb = $('mt-sound-cb');
  soundCb.checked = localStorage.getItem('mt-sound') !== '0'; // remembered; default on
  soundCb.addEventListener('change', () => localStorage.setItem('mt-sound', soundCb.checked ? '1' : '0'));

  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const beep = (n = 3) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      const ctx = new Ctx();
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.32;
        o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
        o.start(t0); o.stop(t0 + 0.28);
      }
    } catch {}
  };
  const ICON_PLAY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
  const ICON_STOP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
  const ICON_RESET = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.7-6.4"/><path d="M3 3v5h5"/></svg>';
  const uid = () => Math.random().toString(36).slice(2, 9);
  const clampM = (v) => Math.max(0, Math.min(99, parseInt(v, 10) || 0));
  const clampS = (v) => Math.max(0, Math.min(59, parseInt(v, 10) || 0));

  let TIMERS = null;
  try { TIMERS = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (TIMERS === null) { // first run only — seed one timer (migrating the old single timer if present)
    const oldEnd = parseInt(localStorage.getItem('mt-endat'), 10);
    TIMERS = [{ id: uid(), name: '', durMs: 600000, endAt: (oldEnd && oldEnd > Date.now()) ? oldEnd : 0 }];
  }
  if (!Array.isArray(TIMERS)) TIMERS = []; // a saved empty list stays empty (max-space mode)
  try { localStorage.removeItem('mt-endat'); } catch {}
  TIMERS.forEach((t) => { if (t.endAt && t.endAt <= Date.now()) t.endAt = 0; t.started = !!t.started || t.endAt > Date.now(); }); // expired while closed -> idle; a running one counts as started
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(TIMERS)); } catch {} };
  const rowOf = (id) => list.querySelector('.mt-row[data-id="' + id + '"]');

  let tickH = null;
  const ensureTick = () => { if (!tickH) tickH = setInterval(tick, 250); };
  function tick() {
    let any = false;
    for (const t of TIMERS) {
      const row = rowOf(t.id); if (!row) continue;
      if (t.endAt > Date.now()) { any = true; row.querySelector('.mt-disp').textContent = fmt(t.endAt - Date.now()); }
      else if (t.endAt) { // just hit zero
        t.endAt = 0; save();
        row.querySelector('.mt-disp').textContent = '0:00';
        paintAct(row, t); row.classList.add('mt-alarm');
        if (soundCb.checked) beep();
      }
    }
    if (!any) { clearInterval(tickH); tickH = null; }
  }
  // Action button: ▶ play (never started) → ⏹ stop (running) → ↻ reset (ran, now stopped).
  function paintAct(row, t) {
    const running = t.endAt > Date.now();
    row.classList.toggle('running', running);
    const b = row.querySelector('.mt-act');
    b.innerHTML = running ? ICON_STOP : (t.started ? ICON_RESET : ICON_PLAY);
    b.title = running ? 'Stop' : (t.started ? 'Reset' : 'Start');
  }
  function syncInputs(t, row) {
    row.querySelector('.mt-min').value = String(Math.floor(t.durMs / 60000));
    row.querySelector('.mt-sec').value = String(Math.floor((t.durMs % 60000) / 1000)).padStart(2, '0');
  }
  function startRow(t, row) {
    t.durMs = (clampM(row.querySelector('.mt-min').value) * 60 + clampS(row.querySelector('.mt-sec').value)) * 1000;
    if (t.durMs <= 0) return;
    t.endAt = Date.now() + t.durMs;
    t.started = true;
    row.classList.remove('mt-alarm');
    paintAct(row, t);
    row.querySelector('.mt-disp').textContent = fmt(t.durMs);
    save(); ensureTick();
  }
  function stopRow(t, row) {
    t.endAt = 0;
    row.classList.remove('mt-alarm');
    paintAct(row, t); syncInputs(t, row);
    save();
  }
  function removeTimer(t) {
    const i = TIMERS.indexOf(t); if (i >= 0) TIMERS.splice(i, 1);
    const row = rowOf(t.id); if (row) row.remove();
    save(); // removing the last one is allowed — leaves just the header bar (+ Timer to add one back)
  }
  function addTimer() {
    const t = { id: uid(), name: '', durMs: 600000, endAt: 0, started: false };
    TIMERS.push(t); list.appendChild(makeRow(t)); save();
  }
  function makeRow(t) {
    const row = document.createElement('div');
    row.className = 'mt-row'; row.dataset.id = t.id;
    row.innerHTML =
      '<input class="mt-name" maxlength="18" placeholder="Timer" />' +
      '<span class="mt-time-edit"><input class="mt-min" type="text" inputmode="numeric" maxlength="2" aria-label="Minutes" /><span class="mt-colon">:</span><input class="mt-sec" type="text" inputmode="numeric" maxlength="2" aria-label="Seconds" /></span>' +
      '<span class="mt-disp"></span>' +
      '<button class="mt-act"></button>' +
      '<button class="mt-del" title="Remove timer" aria-label="Remove timer">✕</button>';
    const nameEl = row.querySelector('.mt-name'), minEl = row.querySelector('.mt-min'), secEl = row.querySelector('.mt-sec');
    nameEl.value = t.name || '';
    syncInputs(t, row);
    nameEl.addEventListener('input', () => { t.name = nameEl.value; save(); });
    minEl.addEventListener('blur', () => { minEl.value = String(clampM(minEl.value)); t.durMs = (clampM(minEl.value) * 60 + clampS(secEl.value)) * 1000; save(); });
    secEl.addEventListener('blur', () => { secEl.value = String(clampS(secEl.value)).padStart(2, '0'); t.durMs = (clampM(minEl.value) * 60 + clampS(secEl.value)) * 1000; save(); });
    [minEl, secEl].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') startRow(t, row); }));
    row.querySelector('.mt-act').addEventListener('click', () => { (t.endAt > Date.now()) ? stopRow(t, row) : startRow(t, row); });
    row.querySelector('.mt-del').addEventListener('click', () => removeTimer(t));
    const running = t.endAt > Date.now();
    paintAct(row, t);
    if (running) row.querySelector('.mt-disp').textContent = fmt(t.endAt - Date.now());
    return row;
  }
  $('mt-add').addEventListener('click', addTimer);
  TIMERS.forEach((t) => list.appendChild(makeRow(t)));
  if (TIMERS.some((t) => t.endAt > Date.now())) ensureTick();
})();

// Make the respawn timer draggable: grab its body (not the inputs/buttons) to move
// it anywhere on the map; the position is remembered across sessions and modes.
(() => {
  const t = $('mob-timer');
  if (!t) return;
  // Position is remembered per mode — full-screen and the minimap overlay keep their
  // own spots (they share localStorage but use separate keys).
  const KEY = isOverlay ? 'mt-pos-overlay' : 'mt-pos';
  const parentRect = () => { const p = t.offsetParent || t.parentElement; return p ? p.getBoundingClientRect() : null; };
  // Anchor by the bottom-right corner so adding a timer grows the panel UPWARD,
  // keeping its bottom edge pinned (it never spills below the map).
  const applyRB = (right, bottom) => {
    const pr = parentRect(); if (!pr) return;
    right = Math.max(0, Math.min(right, pr.width - t.offsetWidth));
    bottom = Math.max(0, Math.min(bottom, pr.height - t.offsetHeight));
    t.classList.add('mt-floating');
    t.style.left = 'auto'; t.style.top = 'auto';
    t.style.right = right + 'px'; t.style.bottom = bottom + 'px';
  };
  // x,y = desired top-left in parent coords (from the drag) → convert to a bottom-right anchor
  const place = (x, y) => { const pr = parentRect(); if (pr) applyRB(pr.width - x - t.offsetWidth, pr.height - y - t.offsetHeight); };
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p) requestAnimationFrame(() => {
      if (typeof p.right === 'number') applyRB(p.right, p.bottom);
      else if (typeof p.left === 'number') place(p.left, p.top); // migrate old top-left saves
    });
  } catch {}
  let drag = null;
  t.addEventListener('mousedown', (e) => {
    if (e.target.closest('input, button, label')) return; // leave the controls usable
    const r = t.getBoundingClientRect();
    const pr = parentRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, px: pr.left, py: pr.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    place(e.clientX - drag.dx - drag.px, e.clientY - drag.dy - drag.py);
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    try { localStorage.setItem(KEY, JSON.stringify({ right: parseFloat(t.style.right) || 0, bottom: parseFloat(t.style.bottom) || 0 })); } catch {}
  });
})();

// Light/dark theme toggle (mirrors the website; default dark, remembered).
(() => {
  const btn = $('theme-toggle');
  if (!btn) return;
  const root = document.documentElement;
  const paint = () => { const dark = root.dataset.theme !== 'light'; btn.textContent = dark ? '☀' : '☾'; btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme'; };
  paint();
  btn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('mnm-app-theme', root.dataset.theme); } catch {}
    paint();
  });
})();

// Give feedback — opens a pre-filled GitHub issue in the browser (the app version and
// OS are filled in automatically so bug reports have context).
(() => {
  const btn = $('btn-feedback');
  if (!btn) return;
  const ver = new URLSearchParams(location.search).get('appVersion') || '';
  btn.addEventListener('click', () => {
    const body = 'What happened, or what would you change?\n\n\n\n---\nApp version: ' + ver + '\nOS: ' + navigator.platform;
    const url = 'https://github.com/Boisteroux/mnm-tools/issues/new?labels=feedback,app' +
      '&title=' + encodeURIComponent('App feedback') + '&body=' + encodeURIComponent(body);
    window.open(url, '_blank');
  });
})();

// The app re-scans itself a few seconds after the game writes new loot/kills
window.mapAPI.onTrackerUpdated((r) => showTrackerSummary(r, ' · updated just now'));

$('btn-overlay').addEventListener('click', () => window.mapAPI.toggleOverlay());
$('overlay-exit-btn').addEventListener('click', () => window.mapAPI.overlayExit());
$('overlay-min-btn').addEventListener('click', () => window.mapAPI.minimizeWindow());
// Two independent opacity controls: the map canvas, and the UI chrome (bar + sidebar)
$('opacity-map').addEventListener('input', (e) => {
  canvas.style.opacity = String(+e.target.value / 100);
});
$('opacity-ui').addEventListener('input', (e) => {
  const v = String(+e.target.value / 100);
  $('overlay-bar').style.opacity = v;
  $('sidebar').style.opacity = v;
});

// Single Lock toggle (stays reachable via the bar-hover logic below)
$('overlay-lock-btn').addEventListener('click', () => window.mapAPI.overlayClickThrough(!overlayClickThrough));

// In play mode the whole window is click-through, EXCEPT while the cursor is over
// the control bar — then we briefly re-enable clicks so Edit/Play stay usable.
let pointerOverBar = false;
const overlayBarEl = $('overlay-bar');
overlayBarEl.addEventListener('mouseenter', () => {
  pointerOverBar = true;
  if (overlayClickThrough) window.mapAPI.overlaySetIgnore(false);
});
overlayBarEl.addEventListener('mouseleave', () => {
  pointerOverBar = false;
  if (overlayClickThrough) window.mapAPI.overlaySetIgnore(true);
});

// main process tells us when click-through or full-screen changes (via hotkey or button)
window.mapAPI.onOverlayState((state) => {
  overlayClickThrough = state.clickThrough;
  $('overlay-lock-btn').classList.toggle('locked', state.clickThrough);
  // Flash the play-mode hint, then fade it out after 2s
  const hint = $('overlay-passthrough-hint');
  clearTimeout(hintTimer);
  if (state.clickThrough) {
    hint.classList.remove('hidden');
    hintTimer = setTimeout(() => hint.classList.add('hidden'), 2000);
  } else {
    hint.classList.add('hidden');
  }
  // Entering play with the cursor already on the bar: keep the bar clickable
  if (state.clickThrough && pointerOverBar) window.mapAPI.overlaySetIgnore(false);
  overlayIsFull = state.overlayFull;
  // a full/compact resize changes the canvas size — refit shortly after
  setTimeout(() => { resizeCanvas(); if (!userMovedView) fitView(); draw(); }, 60);
});

// The overlay's zone name is a live dropdown so you can peek at other zones' maps
$('overlay-zone-select').addEventListener('change', (e) => switchZone(e.target.value));

function updateOverlayZoneLabel() {
  const sel = $('overlay-zone-select');
  if (!sel) return;
  sel.innerHTML = '';
  // The character's actual zone floats to the top and is labelled, regardless of
  // which map you're currently viewing
  const charZone = data.zones.find((z) => z.id === characterZoneId);
  const ordered = charZone
    ? [charZone, ...data.zones.filter((z) => z.id !== charZone.id)]
    : data.zones.slice();
  for (const z of ordered) {
    const opt = document.createElement('option');
    opt.value = z.id;
    opt.textContent = z.id === characterZoneId ? z.name + '  [current zone]' : z.name;
    if (z.id === currentZoneId) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ---- Manual map switcher (multi-map zones, e.g. Evershade Weald ⇄ Faelindral) ----

// Which multi-map group does the player's situation belong to? Prefer the zone
// the character is actually in; fall back to the one being viewed.
function multiMapGroup() {
  // Show the switcher only when the map you're VIEWING is itself part of a
  // multi-map group (Evershade Weald ⇄ Faelindral) — not merely because your
  // character happens to be in that zone-code while you're viewing somewhere else.
  const probes = [currentZone()].filter(Boolean);
  for (const [code, grp] of Object.entries(MULTI_MAP)) {
    const names = grp.maps.map((m) => m.name.toLowerCase());
    if (probes.some((z) => z.gameName === code || names.includes(z.name.toLowerCase()))) {
      return { code, ...grp };
    }
  }
  return null;
}

// Show a single toggle that names the *other* map ("Show Faelindral"), with a
// gradient fill leaning left when you're viewing the first (ground) map and
// right when viewing the second (city). Hidden when the place has one map.
function renderMapSwitcher() {
  const group = multiMapGroup();
  const viewed = currentZone();
  const charZone = data.zones.find((z) => z.id === characterZoneId);
  for (const id of ['map-switcher', 'overlay-map-switcher']) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = '';
    if (!group) { el.classList.add('hidden'); continue; }
    el.classList.remove('hidden');

    const names = group.maps.map((m) => m.name.toLowerCase());
    let curIdx = viewed ? names.indexOf(viewed.name.toLowerCase()) : -1;
    if (curIdx < 0 && charZone) curIdx = names.indexOf(charZone.name.toLowerCase());
    if (curIdx < 0) curIdx = 0;
    const other = group.maps[curIdx === 0 ? 1 : 0];

    const btn = document.createElement('button');
    btn.className = 'map-toggle';
    btn.innerHTML = '<svg class="map-swap" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9h16"/><path d="M16 6l3 3l-3 3"/><path d="M21 15H5"/><path d="M8 12l-3 3l3 3"/></svg>';
    btn.appendChild(document.createTextNode('Show ' + other.name));
    btn.title = other.note ? 'Show ' + other.name + ' — ' + other.note : 'Show ' + other.name;
    btn.addEventListener('click', () => switchToMap(other.name));
    el.appendChild(btn);
  }
}

// View a sibling map by name, creating + fetching it from the wiki if we don't
// have it yet. Doesn't change which zone you're tracked as being in.
async function switchToMap(name) {
  let zone = data.zones.find((z) => z.name.toLowerCase() === name.toLowerCase());
  if (zone) {
    if (zone.id !== currentZoneId) switchZone(zone.id);
    else renderMapSwitcher();
    return;
  }
  zone = { id: uid(), name, gameName: null, image: null, markers: [] };
  data.zones.push(zone);
  save();
  switchZone(zone.id);
  wikiStatus('Fetching the ' + name + ' map from the wiki…');
  const got = await chooseWikiMap(zone, true);
  wikiStatus(got ? name + ' map ready.' : name + ' added — use Import Map if the map is missing.');
}

(async function init() {
  if (isOverlay) document.body.classList.add('overlay');

  // Restore the saved sidebar state — but when we just left the overlay, always
  // open the sidebar (don't inherit a collapse the user set while in overlay).
  try {
    if (!cameFromOverlay && localStorage.getItem(SIDEBAR_KEY) === '1') document.body.classList.add('sidebar-collapsed');
  } catch {}
  $('btn-sidebar').textContent = document.body.classList.contains('sidebar-collapsed') ? '»' : '«';

  // Restore the drop-tracker toggle; if it was left on, scan + start auto-watch
  try { $('tracker-enabled').checked = localStorage.getItem(TRACKER_KEY) === '1'; } catch {}
  if ($('tracker-enabled').checked) {
    window.mapAPI.trackerSetEnabled(true).then((r) => showTrackerSummary(r, ' · auto-updating'));
  }

  // Multi-map zones (Evershade Weald ⇄ Faelindral, etc.). Also feed each group's
  // default name into ZONE_ALIASES so auto-follow lands on the right map first.
  try {
    const aliases = await window.mapAPI.zoneAliases();
    // Tolerate either format: { zones: { code: {...} } } or a bare { code: {...} }.
    const raw = (aliases && aliases.zones) || aliases || {};
    MULTI_MAP = {};
    for (const [code, grp] of Object.entries(raw)) {
      if (code.startsWith('_') || !grp || !Array.isArray(grp.maps)) continue; // skip _readme/_example etc.
      MULTI_MAP[code] = grp;
      if (grp.default && !ZONE_ALIASES[code]) ZONE_ALIASES[code] = grp.default;
    }
  } catch {}

  data = await window.mapAPI.loadData();
  if (!data || !Array.isArray(data.zones)) data = { zones: [] };

  // Markers from categories that no longer exist become "Other"
  let migrated = false;
  for (const zone of data.zones) {
    for (const m of zone.markers) {
      if (!CATEGORIES.some((c) => c.id === m.category)) {
        m.category = 'misc';
        if (!m.notes) m.notes = 'Was: ' + m.label;
        migrated = true;
      }
    }
  }
  if (migrated) save();

  resizeCanvas();
  if (data.zones.length > 0) {
    switchZone(data.zones[0].id);
  } else {
    refreshSidebar();
  }
  // Re-fit once layout has fully settled (first fit can run against a
  // not-yet-final window size, which leaves the map cut off in a corner)
  requestAnimationFrame(() => {
    if (!userMovedView) {
      fitView();
      draw();
    }
  });
  // Overlay windows finish sizing a beat later; refit again so the map isn't
  // left stretched or off-centre on the smaller, differently-shaped window
  if (isOverlay) {
    setTimeout(() => { resizeCanvas(); if (!userMovedView) { fitView(); draw(); } }, 200);
  }

  // Community markers overlay (read-only, from mnm-db.com). Restore the toggle, wire it,
  // and load now if it was left on.
  try { $('community-enabled').checked = localStorage.getItem(COMMUNITY_KEY) === '1'; } catch {}
  showCommunity = $('community-enabled').checked;
  $('community-enabled').addEventListener('change', () => {
    showCommunity = $('community-enabled').checked;
    try { localStorage.setItem(COMMUNITY_KEY, showCommunity ? '1' : '0'); } catch {}
    if (showCommunity && !communityMarkers.length) loadCommunityMarkers();
    else { refreshSidebar(); draw(); }
  });
  if (showCommunity) loadCommunityMarkers();

  // Open on whatever zone the player was last in, according to the game log
  appReady = true;
  const startZone = pendingGameZone || (await window.mapAPI.currentGameZone());
  if (startZone) handleGameZone(startZone);
})();
