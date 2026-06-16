// ---------------------------------------------------------------
// MnM Map — renderer logic: zones, pan/zoom canvas, markers
// ---------------------------------------------------------------

const CATEGORIES = [
  { id: 'ore',      name: 'Ore',        color: '#c0784a', icon: '⛏️' },
  { id: 'herb',     name: 'Herbs',      color: '#3c8f43', icon: '\u{1F33F}' },
  { id: 'wood',     name: 'Wood',       color: '#8a5a2b', icon: '\u{1FAB5}' },
  { id: 'fishing',  name: 'Fish',       color: '#4fc3f7', icon: '\u{1F3A3}' },
  { id: 'crafting', name: 'Crafting',   color: '#f06292', icon: '\u{1F528}' },
  { id: 'quest',    name: 'Quest NPCs', color: '#fff176', icon: '❗️' },
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

const GRID_SIZE = 2000;                        // blank-map play area in world units
const MARKER_RADIUS = 11;                      // screen pixels, constant at any zoom

// ---- Elements ----

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

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
    const cat = catById(m.category);
    const p = toScreen(m.x, m.y);

    ctx.beginPath();
    ctx.arc(p.x, p.y, MARKER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = cat.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#08090b';
    ctx.stroke();

    ctx.font = '12px "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = contrastColor(cat.color);
    ctx.fillText(cat.icon, p.x, p.y + 1);

    if (view.scale > 0.6 && m.label) {
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.fillStyle = '#dfe6ec';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(m.label, p.x, p.y + MARKER_RADIUS + 10);
      ctx.fillText(m.label, p.x, p.y + MARKER_RADIUS + 10);
    }
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
      wikiStatus('Followed you into ' + zone.name + '.');
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
        : 'New zone "' + pretty + '" created. If the name looks off, Rename it then use Import Map from Wiki.'
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
  const cat = catById(marker.category);
  $('popup-title').textContent = marker.label;
  $('popup-category').textContent = cat.icon + ' ' + cat.name;
  $('popup-notes').textContent = marker.notes || '';

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
}

$('popup-close').addEventListener('click', hidePopup);

$('popup-delete').addEventListener('click', () => {
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
  const zone = currentZone();
  const m = zone && zone.markers.find((x) => x.id === popupMarkerId);
  hidePopup();
  if (m) openMarkerModal(m);
});

// ---- Zone modal ----

$('btn-rename-zone').addEventListener('click', () => {
  const zone = currentZone();
  if (!zone) return;
  $('zone-name').value = zone.name;
  $('zone-modal').classList.remove('hidden');
  $('zone-name').focus();
  $('zone-name').select();
});

$('zone-cancel').addEventListener('click', () => $('zone-modal').classList.add('hidden'));

$('zone-save').addEventListener('click', () => {
  const zone = currentZone();
  const name = $('zone-name').value.trim();
  if (!zone || !name) return;
  zone.name = name;
  save();
  $('zone-modal').classList.add('hidden');
  refreshSidebar();
});

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

$('btn-wiki-zone').addEventListener('click', async () => {
  const zone = currentZone();
  if (!zone) {
    wikiStatus('Create or select a zone first.');
    return;
  }
  if (zone.image && !confirm(
    'This replaces ' + zone.name + "'s current map with the wiki version.\n\n" +
    'If the new image is framed differently, your existing markers may no longer line up. Continue?'
  )) return;
  await chooseWikiMap(zone, false);
});

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
    $('zone-modal').classList.add('hidden');
    $('export-modal').classList.add('hidden');
    $('import-modal').classList.add('hidden');
    $('map-picker-modal').classList.add('hidden');
    hidePopup();
    setQuickPlace(false);
  }
  if (e.key === 'Enter' && !$('zone-modal').classList.contains('hidden')) {
    $('zone-save').click();
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

const SIDEBAR_KEY = 'mnm-sidebar-collapsed';

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

$('tracker-export').addEventListener('click', async () => {
  trackerStatus('Exporting…');
  const ok = await window.mapAPI.trackerExport();
  trackerStatus(ok === true ? 'Exported dataset.' : (ok && ok.error) ? ok.error : 'Export cancelled.');
});

// Publish to MnMdb — owner build only (the dev flag is passed from main.js).
const isDev = new URLSearchParams(location.search).get('dev') === '1';
const publishStatus = (msg) => { $('publish-status').textContent = msg; };
if (isDev) {
  const pubBtn = $('tracker-publish');
  pubBtn.classList.remove('hidden');
  pubBtn.addEventListener('click', async () => {
    pubBtn.disabled = true;
    publishStatus('Publishing… regenerating data & pushing to GitHub.');
    const r = await window.mapAPI.publishMnmdb();
    publishStatus(r && r.ok ? r.message : (r && r.error) ? r.error : 'Publish failed.');
    pubBtn.disabled = false;
  });
}

// ---- Log a Trade ----

const tradeStatus = (msg) => { $('trade-status').textContent = msg; };

// Autocomplete from the items you've already collected
window.mapAPI.tradeItemNames().then((names) => {
  const dl = $('trade-item-list');
  dl.innerHTML = (names || []).map((n) => '<option value="' + n.replace(/"/g, '&quot;') + '"></option>').join('');
}).catch(() => {});

$('trade-log-btn').addEventListener('click', async () => {
  const item = $('trade-item').value.trim();
  const p = +$('trade-p').value || 0, g = +$('trade-g').value || 0, s = +$('trade-s').value || 0, c = +$('trade-c').value || 0;
  const price = p * 1000000 + g * 10000 + s * 100 + c; // M&M coin is base-100
  if (!item) { tradeStatus('Enter an item name.'); return; }
  if (price <= 0) { tradeStatus('Enter a price (p / g / s / c).'); return; }
  const side = $('trade-side').value;
  const r = await window.mapAPI.tradeLog({ item, price, side });
  if (r && r.ok) {
    tradeStatus('Logged ' + item + ' — ' + coinStr(price) + ' (' + (side === 'buy' ? 'buying' : 'selling') + '). ' + r.count + ' total.');
    $('trade-item').value = ''; $('trade-p').value = ''; $('trade-g').value = ''; $('trade-s').value = ''; $('trade-c').value = '';
    $('trade-item').focus();
  } else {
    tradeStatus((r && r.error) || 'Could not log that trade.');
  }
});

// Compact coin string for the confirmation line (base-100)
function coinStr(c) {
  c = Math.round(c);
  const p = Math.floor(c / 1000000); c %= 1000000;
  const g = Math.floor(c / 10000); c %= 10000;
  const s = Math.floor(c / 100); const cp = c % 100;
  return [p && p + 'p', g && g + 'g', s && s + 's', cp && cp + 'c'].filter(Boolean).join(' ') || '0c';
}

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
  const probe = data.zones.find((z) => z.id === characterZoneId) || currentZone();
  if (!probe) return null;
  for (const [code, grp] of Object.entries(MULTI_MAP)) {
    const names = grp.maps.map((m) => m.name.toLowerCase());
    if (probe.gameName === code || names.includes(probe.name.toLowerCase())) {
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
    btn.className = 'map-toggle ' + (curIdx === 0 ? 'fill-left' : 'fill-right');
    btn.textContent = 'Show ' + other.name;
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
  wikiStatus(got ? name + ' map ready.' : name + ' added — use Import Map from Wiki if the map is missing.');
}

(async function init() {
  if (isOverlay) document.body.classList.add('overlay');

  // Restore the saved sidebar collapsed/expanded state
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === '1') document.body.classList.add('sidebar-collapsed');
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
    MULTI_MAP = (aliases && aliases.zones) || {};
    for (const [code, grp] of Object.entries(MULTI_MAP)) {
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

  // Open on whatever zone the player was last in, according to the game log
  appReady = true;
  const startZone = pendingGameZone || (await window.mapAPI.currentGameZone());
  if (startZone) handleGameZone(startZone);
})();
