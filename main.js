const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, crashReporter, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const ledgerParser = require('./tracker/ledger-parser');
const { execFile } = require('child_process');

let win;
let isToggling = false; // true while we deliberately recreate the window (overlay swap)

// Native crash capture — writes minidumps for GPU/driver-level crashes that
// JavaScript handlers can never see. Dumps land in <userData>/Crashpad.
crashReporter.start({ submitURL: '', uploadToServer: false });

// Transparent, always-on-top overlay windows can crash the GPU process on some
// Windows graphics drivers, taking the whole app down with no JS error. Running
// the map on the CPU avoids that; a 2D canvas map doesn't need the GPU anyway.
// Must be called before the app is ready.
app.disableHardwareAcceleration();

// Crash diagnostics — surface the reason if the app dies unexpectedly, written
// both to stdout and a log file in the app's data folder.
function logCrash(tag, info) {
  const line = '[' + new Date().toISOString() + '] ' + tag + ' ' + JSON.stringify(info || {}) + '\n';
  console.error(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line);
  } catch (e) {
    console.error('LOG WRITE FAILED:', e.message); // surface broken logging instead of swallowing it
  }
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', { message: err.message, stack: err.stack }));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', { reason: String(reason) }));
app.on('render-process-gone', (e, wc, details) => logCrash('render-process-gone', details));
app.on('child-process-gone', (e, details) => logCrash('child-process-gone', details));

// Lifecycle trail — if the app shuts down in an orderly way, these leave a
// record. A "random close" that leaves NO quit/close line here was a hard
// native crash (see the Crashpad dumps); one that DOES log was a real window close.
app.on('before-quit', () => logCrash('app-before-quit'));
app.on('will-quit', () => logCrash('app-will-quit'));
app.on('quit', (e, code) => logCrash('app-quit', { code }));

// ---- Discord sign-in via the mnmmap:// deep link ----
// The renderer opens the system browser to the Worker's OAuth start (?client=app);
// when Discord login finishes the Worker 302s to mnmmap://auth/?login=<session>, which
// the OS routes back to this running instance. Single-instance so the link lands on the
// app that opened it, not a second copy.
const DISCORD_AUTH_START = 'https://mnmdb-api.boisteroux.workers.dev/auth/discord/start?client=app';

function handleAuthDeepLink(url) {
  if (!url || !url.startsWith('mnmmap://')) return;
  let session = null, error = null;
  try { const u = new URL(url); session = u.searchParams.get('login'); error = u.searchParams.get('login_error'); } catch {}
  const send = () => { if (win && !win.isDestroyed()) win.webContents.send('discord-auth', { session, error }); };
  if (win && !win.isDestroyed()) { win.webContents.isLoading() ? win.webContents.once('did-finish-load', send) : send(); }
}

// Register mnmmap:// as our protocol (in dev, Electron needs the exec path + script).
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('mnmmap', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('mnmmap');
}
const gotSingleLock = app.requestSingleInstanceLock();
app.on('second-instance', (event, argv) => {
  const link = argv.find((a) => typeof a === 'string' && a.startsWith('mnmmap://'));
  if (link) handleAuthDeepLink(link);
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('open-url', (event, url) => { event.preventDefault(); handleAuthDeepLink(url); }); // macOS

ipcMain.handle('discord-login', () => { shell.openExternal(DISCORD_AUTH_START); return true; });

let overlayMode = false;
let clickThrough = false;
let overlayFull = false;
let compactBounds = null; // remembers the floating-panel size while in full-screen

const dataFile = () => path.join(app.getPath('userData'), 'map-data.json');
const mapsDir = () => path.join(app.getPath('userData'), 'maps');

// ---- Drop / vendor tracker ----
// Parses the game's Ledger files into an aggregated dataset (drops, kill
// counts, vendor prices, harvest) saved locally and exportable for the website.
const trackerFile = () => path.join(app.getPath('userData'), 'tracker-data.json');
const tradesFile = () => path.join(app.getPath('userData'), 'trades.json');

function readTrades(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : (j.trades || []);
  } catch { return []; }
}

// Map each resource to its gather skill (from the wiki) so harvest nodes can split
// herbs/fish out by skill+zone. Read from mnmdb/wiki.json; empty if unavailable.
function harvestSkillOpts() {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(__dirname, 'mnmdb', 'wiki.json'), 'utf8'));
    const map = {};
    for (const [n, it] of Object.entries(w.items || {})) if (it && it.harvestedBy) map[n] = it.harvestedBy;
    return { skillOf: (n) => map[n] || null };
  } catch { return {}; }
}

function scanTracker() {
  const files = ledgerParser.findLedgerFiles();
  const agg = ledgerParser.parseLedgers(files, harvestSkillOpts());
  const items = ledgerParser.buildItemReport(agg);
  const dataset = {
    generatedAt: new Date().toISOString(),
    source: 'mnm-tools',
    ledgerFiles: agg.fileCount,
    events: agg.events,
    mobs: agg.mobs,
    items,
    harvest: agg.harvest,
    harvestNodes: agg.harvestNodes,
  };
  fs.writeFileSync(trackerFile(), JSON.stringify(dataset, null, 2));
  return {
    ledgerFiles: agg.fileCount,
    events: agg.events,
    mobs: Object.keys(agg.mobs).length,
    items: items.length,
    harvest: Object.keys(agg.harvest).length,
    generatedAt: dataset.generatedAt,
  };
}

ipcMain.handle('tracker-scan', () => {
  try { return scanTracker(); } catch (e) { return { error: e.message }; }
});

// Log a player trade price to a local file. Merged into the site on Publish.
ipcMain.handle('trade-log', (event, rec) => {
  try {
    if (!rec || !rec.item || !(rec.price > 0)) return { error: 'Need an item name and a price.' };
    const trades = readTrades(tradesFile());
    trades.push({
      item: String(rec.item).trim(),
      price: Math.round(rec.price),
      side: rec.side === 'buy' ? 'buy' : 'sell',
      date: new Date().toISOString().slice(0, 10),
      who: rec.who ? String(rec.who).trim() : '',
      src: 'app',
    });
    fs.writeFileSync(tradesFile(), JSON.stringify({ trades }, null, 2));
    return { ok: true, count: trades.length };
  } catch (e) { return { error: e.message }; }
});

// Item names for the logger's autocomplete (from what you've collected so far).
ipcMain.handle('trade-item-names', () => {
  try {
    const j = JSON.parse(fs.readFileSync(trackerFile(), 'utf8'));
    const names = new Set();
    (j.items || []).forEach((i) => i.name && names.add(i.name));
    Object.keys(j.harvest || {}).forEach((n) => names.add(n));
    return [...names].sort();
  } catch { return []; }
});

// Session Replay — group the ledger into play sessions and recap each one.
const sessionEndsFile = () => path.join(app.getPath('userData'), 'session-ends.json');
function readSessionEnds() {
  try { return JSON.parse(fs.readFileSync(sessionEndsFile(), 'utf8')).ends || []; } catch { return []; }
}
// The character whose Character ledger was written most recently = who you last played.
function mostRecentCharacter(files) {
  let best = null, bestT = -1;
  for (const f of files) {
    const m = path.basename(f).match(/^(.+?)_Character_/i);
    if (!m) continue;
    let t = 0; try { t = fs.statSync(f).mtimeMs; } catch {}
    if (t > bestT) { bestT = t; best = m[1]; }
  }
  return best;
}

ipcMain.handle('session-replay', (event, opts = {}) => {
  try {
    const files = ledgerParser.findLedgerFiles();
    // Build all sessions so the "today" rollup can span however many there were,
    // then show only the 3 most recent as individually browsable. Manual "end
    // session" markers force a boundary so an ended session isn't shown as live.
    // opts.character restricts to one character; opts.defaultRecent picks the most
    // recently played character when none is specified (the recap's open default).
    const characters = ledgerParser.charactersFromFiles(files);
    let character = opts.character || null;
    if (!character && opts.defaultRecent && characters.length > 1) character = mostRecentCharacter(files) || null;
    const all = ledgerParser.buildSessions(files, { ends: readSessionEnds(), character });
    return { sessions: all.slice(0, 3), today: ledgerParser.todayRollup(all), characters, character };
  } catch (e) { return { error: e.message }; }
});

// Manually close out the current session (records "now" as a session boundary).
ipcMain.handle('session-end', () => {
  try {
    const ends = readSessionEnds();
    ends.push(Date.now());
    fs.writeFileSync(sessionEndsFile(), JSON.stringify({ ends }, null, 2));
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// Auto-rescan: watch the game folder and re-parse a few seconds after the game
// writes a ledger file, so the app's data stays current with no manual step.
let trackerWatcher = null;
let trackerWatchTimer = null;

function startTrackerWatch() {
  if (trackerWatcher || !fs.existsSync(ledgerParser.GAME_BASE)) return;
  try {
    trackerWatcher = fs.watch(ledgerParser.GAME_BASE, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const f = String(filename);
      // Only react to ledger files — ignore Player.log and other constant writes
      if (!/_(Character|Social)_/i.test(f) && !/Ledger/i.test(f)) return;
      clearTimeout(trackerWatchTimer);
      trackerWatchTimer = setTimeout(() => {
        try {
          const summary = scanTracker();
          if (win && !win.isDestroyed()) win.webContents.send('tracker-updated', summary);
        } catch {}
      }, 4000);
    });
  } catch {}
}

function stopTrackerWatch() {
  if (trackerWatcher) { try { trackerWatcher.close(); } catch {} trackerWatcher = null; }
  clearTimeout(trackerWatchTimer);
}

ipcMain.handle('tracker-set-enabled', (event, enabled) => {
  if (enabled) {
    let summary;
    try { summary = scanTracker(); } catch (e) { return { error: e.message }; }
    startTrackerWatch();
    return summary;
  }
  stopTrackerWatch();
  return { disabled: true };
});

// Owner-only: regenerate the MnMdb dataset from the ledger and push it to GitHub.
// This needs the repo checkout + an authenticated git, so it only exists in the
// dev build (npm start). The packaged app shared with testers never sees it.
const isDev = !app.isPackaged;
const REPO_ROOT = __dirname;

function gitRun(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), out: (stdout || '') + (stderr || '') });
    });
  });
}

// Zones that share one game zone-code but have multiple maps (e.g. a city above
// ground and the wilderness below). The renderer uses this to offer a manual
// map switch. Bundled with the app; edit zone-aliases.json to add cases.
ipcMain.handle('zone-aliases', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'zone-aliases.json'), 'utf8'));
  } catch {
    return { zones: {} };
  }
});

ipcMain.handle('publish-mnmdb', async () => {
  if (!isDev) return { error: 'Publishing is only available in the owner (dev) build.' };
  try {
    // 1. Regenerate mnmdb/data.json from the latest ledger, pooling any trusted-
    //    friend contributions dropped into contributions/*.json. Counts are summed
    //    (mergeAggs) before rates are computed, so everyone's corpses add up.
    const files = ledgerParser.findLedgerFiles();
    const aggs = [ledgerParser.parseLedgers(files, harvestSkillOpts())];
    const contributors = [];
    let contribTrades = [];
    try {
      const contribDir = path.join(REPO_ROOT, 'contributions');
      for (const f of fs.readdirSync(contribDir)) {
        if (!/\.json$/i.test(f) || /^README/i.test(f)) continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(contribDir, f), 'utf8'));
          if (c && c.agg) {
            aggs.push(c.agg);
            contributors.push({ character: c.character || f.replace(/\.json$/i, ''), events: c.events || 0 });
            if (Array.isArray(c.trades)) contribTrades = contribTrades.concat(c.trades);
          }
        } catch {}
      }
    } catch {}
    const agg = aggs.length > 1 ? ledgerParser.mergeAggs(aggs) : aggs[0];
    const items = ledgerParser.buildItemReport(agg);
    const dataset = {
      generatedAt: new Date().toISOString(),
      source: 'mnm-tools',
      ledgerFiles: agg.fileCount,
      events: agg.events,
      contributors,
      mobs: agg.mobs,
      items,
      harvest: agg.harvest,
      harvestNodes: agg.harvestNodes,
    };
    fs.writeFileSync(path.join(REPO_ROOT, 'mnmdb', 'data.json'), JSON.stringify(dataset, null, 2));

    // 2. Merge any locally-logged trades into the site's trades.json (dedup).
    const siteTradesPath = path.join(REPO_ROOT, 'mnmdb', 'trades.json');
    let siteTrades = {};
    try { siteTrades = JSON.parse(fs.readFileSync(siteTradesPath, 'utf8')); } catch {}
    const existing = siteTrades.trades || [];
    const seen = new Set(existing.map((t) => [t.item, t.price, t.side, t.date].join('|')));
    let added = 0;
    for (const t of [...readTrades(tradesFile()), ...contribTrades]) {
      const key = [t.item, t.price, t.side, t.date].join('|');
      if (!seen.has(key)) { existing.push(t); seen.add(key); added++; }
    }
    siteTrades.trades = existing;
    fs.writeFileSync(siteTradesPath, JSON.stringify(siteTrades, null, 2));

    // NB: maps are intentionally NOT exported here. The packaged app has no
    // sharp/jimp, so exporting would recompress every map back to raw/JPEG and
    // wipe the full-res AVIF versions. Maps change rarely and are published
    // separately via `node tracker/export-maps.js` in the dev environment.

    // 3. Commit + push.
    await gitRun(['add', 'mnmdb/data.json', 'mnmdb/trades.json', 'contributions']);
    const tradeNote = added ? ` + ${added} trade${added === 1 ? '' : 's'}` : '';
    const contribNote = contributors.length ? ` + ${contributors.length} contributor${contributors.length === 1 ? '' : 's'}` : '';
    const commit = await gitRun(['commit', '-m', `Publish play data (${agg.events} events, ${items.length} items${tradeNote}${contribNote})`]);
    if (commit.code !== 0) {
      if (/nothing to commit/i.test(commit.out)) {
        return { ok: true, message: 'Already up to date — no new data since last publish.' };
      }
      return { error: 'Commit failed: ' + commit.out.trim().slice(0, 200) };
    }
    const push = await gitRun(['push']);
    if (push.code !== 0) return { error: 'Push failed: ' + push.out.trim().slice(0, 200) };
    return { ok: true, message: `Published ${items.length} items · ${agg.events} events${contributors.length ? ' · ' + contributors.length + ' contributor' + (contributors.length === 1 ? '' : 's') : ''}${added ? ' · ' + added + ' new trade' + (added === 1 ? '' : 's') : ''}. Live on MnMdb in ~30s.` };
  } catch (e) {
    return { error: e.message };
  }
});

// Where the overlay first appears: a corner of a second monitor if there is
// one (so it never fights the game's screen), otherwise the primary display.
function overlayStartBounds() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const target = displays.find((d) => d.id !== primary.id) || primary;
  const wa = target.workArea;
  const w = 440, h = 340, margin = 24;
  return { x: wa.x + wa.width - w - margin, y: wa.y + margin, width: w, height: h };
}

// Remember where the user last put each window so it reappears there next time.
const overlayBoundsFile = () => path.join(app.getPath('userData'), 'overlay-bounds.json');
const desktopBoundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');

function loadBounds(file) {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return null; }
}
function saveBounds(file, b) {
  try { fs.writeFileSync(file(), JSON.stringify(b)); } catch {}
}
const loadOverlayBounds = () => loadBounds(overlayBoundsFile);
const saveOverlayBounds = (b) => saveBounds(overlayBoundsFile, b);
const loadDesktopBounds = () => loadBounds(desktopBoundsFile);
const saveDesktopBounds = (b) => saveBounds(desktopBoundsFile, b);

// Reject saved bounds that would land off every monitor (e.g. a screen was unplugged)
function boundsOnScreen(b) {
  if (!b || typeof b.x !== 'number' || typeof b.width !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const r = d.bounds;
    return b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
  });
}

function createWindow(overlay = false, fromOverlay = false) {
  overlayMode = overlay;
  clickThrough = false;
  overlayFull = false;

  const base = {
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  };

  if (overlay) {
    const saved = loadOverlayBounds();
    const b = boundsOnScreen(saved) ? saved : overlayStartBounds();
    compactBounds = b;
    win = new BrowserWindow({
      ...base,
      ...b,
      minWidth: 260,
      minHeight: 200,
      title: 'MnM Map (overlay)',
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
    });
    win.setAlwaysOnTop(true, 'screen-saver');

    // Persist the panel's position/size as the user moves or resizes it
    // (but not while expanded to full screen — that's not its "home" spot)
    const persist = () => {
      if (overlayMode && !overlayFull && win && !win.isDestroyed()) saveOverlayBounds(win.getBounds());
    };
    win.on('move', persist);
    win.on('resize', persist);
  } else {
    const saved = loadDesktopBounds();
    const useSaved = boundsOnScreen(saved);
    win = new BrowserWindow({
      ...base,
      ...(useSaved
        ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
        : { width: 1200, height: 800 }),
      minWidth: 800,
      minHeight: 500,
      title: 'MnM Map',
      backgroundColor: '#0c0d10',
    });
    if (useSaved && saved.maximized) win.maximize();

    // Remember the desktop window's position, size and maximized state
    const persist = () => {
      if (overlayMode || !win || win.isDestroyed() || win.isMinimized()) return;
      saveDesktopBounds({ ...win.getNormalBounds(), maximized: win.isMaximized() });
    };
    win.on('move', persist);
    win.on('resize', persist);
    win.on('maximize', persist);
    win.on('unmaximize', persist);
  }

  // Record any window close that ISN'T our deliberate overlay-swap, so a stray
  // close (mis-clicked ✕, OS action) shows up in the log.
  win.on('close', () => {
    if (!isToggling) logCrash('window-close', { overlay: overlayMode });
  });
  win.webContents.on('render-process-gone', (e, details) => logCrash('webcontents-gone', details));
  win.webContents.on('unresponsive', () => logCrash('window-unresponsive'));

  // Open external links (target="_blank") in the user's real browser, never
  // inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.setMenuBarVisibility(false);
  win.loadFile('renderer/index.html', { query: { overlay: overlay ? '1' : '0', dev: isDev ? '1' : '0', fromOverlay: fromOverlay ? '1' : '0', appVersion: app.getVersion() } });
}

// Swap between desktop and overlay modes by recreating the window (a window's
// transparency can't be changed once it exists). Create the replacement BEFORE
// destroying the old window, so there's never a zero-window moment that would
// trip Electron's "all windows closed -> quit".
function toggleOverlay() {
  const wasOverlay = overlayMode;
  const old = win;
  isToggling = true;
  try {
    // When leaving the overlay (wasOverlay), tell the new desktop window so it
    // always opens with the sidebar expanded, regardless of the overlay's state.
    createWindow(!wasOverlay, wasOverlay);
  } catch (err) {
    // If the overlay window failed to build, stay in the current window
    if (old && !old.isDestroyed()) win = old;
    isToggling = false;
    return;
  }
  if (old && !old.isDestroyed() && old !== win) old.destroy();
  isToggling = false;
}

function setClickThrough(on) {
  if (!overlayMode || !win || win.isDestroyed()) return;
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  win.webContents.send('overlay-state', { clickThrough, overlayFull });
}

function setOverlayFull(on) {
  if (!overlayMode || !win || win.isDestroyed()) return;
  overlayFull = on;
  if (on) {
    compactBounds = win.getBounds();
    const d = screen.getDisplayMatching(win.getBounds());
    win.setBounds(d.workArea);
  } else if (compactBounds) {
    win.setBounds(compactBounds);
  }
  win.webContents.send('overlay-state', { clickThrough, overlayFull });
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+M', toggleOverlay);
  globalShortcut.register('CommandOrControl+Shift+X', () => setClickThrough(!clickThrough));
}

ipcMain.handle('toggle-overlay', () => { toggleOverlay(); return true; });
ipcMain.handle('overlay-click-through', (event, on) => { setClickThrough(on); return clickThrough; });
ipcMain.handle('overlay-full', (event, on) => { setOverlayFull(on); return overlayFull; });
ipcMain.handle('overlay-exit', () => { if (overlayMode) toggleOverlay(); return true; });
ipcMain.handle('overlay-opacity', (event, value) => {
  if (win && !win.isDestroyed()) win.setOpacity(Math.max(0.1, Math.min(1, value)));
  return true;
});

// Lets the renderer briefly make the window clickable again (e.g. while the
// cursor is over the control bar) even though play mode is otherwise pass-through.
ipcMain.handle('overlay-set-ignore', (event, ignore) => {
  if (overlayMode && win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true });
  return true;
});
ipcMain.handle('window-minimize', () => { if (win && !win.isDestroyed()) win.minimize(); return true; });

app.whenReady().then(() => {
  if (!gotSingleLock) { app.quit(); return; } // another copy is already running; it got the deep link
  logCrash('app-start', { version: app.getVersion(), pid: process.pid });
  createWindow();
  registerShortcuts();
  startGameLogWatch();
  // Cold start via the deep link (Windows passes the URL in argv on first launch).
  const coldLink = process.argv.find((a) => typeof a === 'string' && a.startsWith('mnmmap://'));
  if (coldLink) handleAuthDeepLink(coldLink);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// ---- Game log watching ----
// MnM's Unity log records zone changes ("Start zoning process to <zone>").
// Poll for appended lines and tell the renderer when the player zones.

const GAME_LOG = path.join(
  process.env.USERPROFILE || '',
  'AppData', 'LocalLow', 'Niche Worlds Cult', 'Monsters and Memories', 'Player.log'
);

let lastGameZone = null;

// On startup, find the most recent zone line already in the logs
// (falls back to the previous session's log if the current one has none)
function scanLogsForLastZone() {
  for (const file of [GAME_LOG, GAME_LOG.replace('Player.log', 'Player-prev.log')]) {
    try {
      const matches = [...fs.readFileSync(file, 'utf8').matchAll(/Start zoning process to (\S+)/g)];
      if (matches.length) return matches[matches.length - 1][1];
    } catch {}
  }
  return null;
}

ipcMain.handle('current-game-zone', () => lastGameZone);

function startGameLogWatch() {
  if (!fs.existsSync(GAME_LOG)) return;
  let offset = fs.statSync(GAME_LOG).size;
  lastGameZone = scanLogsForLastZone();

  setInterval(() => {
    try {
      const size = fs.statSync(GAME_LOG).size;
      if (size < offset) offset = 0; // game restarted, log was reset
      if (size === offset) return;

      const fd = fs.openSync(GAME_LOG, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;

      const matches = [...buf.toString('utf8').matchAll(/Start zoning process to (\S+)/g)];
      if (matches.length) {
        lastGameZone = matches[matches.length - 1][1];
        if (win && !win.isDestroyed()) win.webContents.send('game-zone', lastGameZone);
      }
    } catch {
      // Game may be mid-write; try again on the next tick
    }
  }, 2000);
}

app.on('window-all-closed', () => {
  // Recreating the window for an overlay toggle briefly closes it; don't quit
  // if a replacement window already exists.
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (process.platform !== 'darwin') app.quit();
});

// ---- Data persistence ----

ipcMain.handle('load-data', () => {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return { zones: [] };
  }
});

ipcMain.handle('save-data', (event, data) => {
  fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf8');
  return true;
});

// ---- Map images ----
// Copies the chosen image into the app's own folder so the original
// can be moved or deleted without breaking the map.

ipcMain.handle('choose-map-image', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a map image for this zone',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  fs.mkdirSync(mapsDir(), { recursive: true });
  const src = result.filePaths[0];
  const dest = path.join(mapsDir(), Date.now() + '-' + path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
});

// ---- Sharing markers (and their maps) with friends ----
// Each zone's map image is embedded as base64 so a friend's markers land
// on the exact same picture they were drawn on.

ipcMain.handle('export-data', async (event, { scope, zones }) => {
  const outZones = zones.map((z) => {
    let image = null;
    if (z.image && fs.existsSync(z.image)) {
      try {
        const buf = fs.readFileSync(z.image);
        const ext = (z.image.match(/\.(png|jpe?g|webp|gif|bmp)/i) || [, 'jpg'])[1].toLowerCase();
        image = { ext, data: buf.toString('base64') };
      } catch {}
    }
    return { name: z.name, gameName: z.gameName || null, markers: z.markers, image };
  });

  const payload = { app: 'mnm-minimap', version: 2, zones: outZones };
  const base = (scope === 'all' ? 'all-zones' : (zones[0] && zones[0].name) || 'zone')
    .replace(/[^a-z0-9 _-]/gi, '');
  const result = await dialog.showSaveDialog(win, {
    title: 'Export markers and maps',
    defaultPath: base + '-mnmmap.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(payload), 'utf8');
  return true;
});

// Export this player's rolled-up play data so the owner can merge it into the
// shared site (the trusted-friend crowdsourcing flow). Contains only the same
// aggregated counts the parser already builds (drops, kills, harvests, vendor
// prices, logged trades) — no raw chat, no personal files, nothing uploaded.
ipcMain.handle('export-contribution', async () => {
  try {
    const files = ledgerParser.findLedgerFiles();
    if (!files.length) return { error: 'No Monsters & Memories Ledger files found yet — play a little first.' };
    const agg = ledgerParser.parseLedgers(files, harvestSkillOpts());
    const characters = ledgerParser.charactersFromFiles(files);
    const payload = {
      schema: 'mnm-contribution/1',
      character: characters[0] || 'unknown',
      characters,
      exportedAt: new Date().toISOString(),
      events: agg.events,
      agg: {
        mobs: agg.mobs, items: agg.items, harvest: agg.harvest,
        harvestZones: agg.harvestZones, harvestNodes: agg.harvestNodes,
        events: agg.events, fileCount: agg.fileCount,
      },
      trades: readTrades(tradesFile()),
    };
    const safe = (characters[0] || 'data').replace(/[^a-z0-9 _-]/gi, '') || 'data';
    const result = await dialog.showSaveDialog(win, {
      title: 'Export my play data to share',
      defaultPath: `mnm-data-${safe}-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload), 'utf8');
    return { ok: true, character: characters[0] || 'unknown', events: agg.events, mobs: Object.keys(agg.mobs).length, items: Object.keys(agg.items).length };
  } catch (e) {
    return { error: e.message };
  }
});

// ---- Wiki map import ----
// Talks to the community wiki's MediaWiki API to find each zone's map
// image, then downloads a 4096px version (full-size maps are 30MB+).

const WIKI_API = 'https://monstersandmemories.miraheze.org/w/api.php';
const WIKI_HEADERS = { 'User-Agent': 'MnM-Map-Companion/0.1 (personal fan-made map tool)' };

async function wikiJson(params) {
  const url = WIKI_API + '?' + new URLSearchParams({ format: 'json', ...params });
  const res = await fetch(url, { headers: WIKI_HEADERS });
  if (!res.ok) throw new Error('Wiki returned HTTP ' + res.status);
  return res.json();
}

ipcMain.handle('wiki-zone-list', async () => {
  try {
    const j = await wikiJson({ action: 'parse', page: 'Zones', prop: 'links' });
    return j.parse.links
      .map((l) => l['*'])
      .filter((n) => n && n !== 'Zone Connection Map');
  } catch (err) {
    return { error: 'Could not reach the wiki: ' + err.message };
  }
});

// Find the map-sized images on a zone's wiki page, with small preview thumbs.
// Sorted: "map"-named files first, then largest.
async function getMapCandidates(zoneName) {
  const parsed = await wikiJson({ action: 'parse', page: zoneName, prop: 'images' });
  if (parsed.error) return { error: 'No wiki page found for "' + zoneName + '"' };
  const images = (parsed.parse && parsed.parse.images) || [];
  if (images.length === 0) return { error: 'No images on the wiki page for "' + zoneName + '"' };

  const q = await wikiJson({
    action: 'query',
    titles: images.map((i) => 'File:' + i).join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size',
    iiurlwidth: '360', // small preview for the picker
  });
  const candidates = Object.values(q.query.pages)
    .filter((p) => p.imageinfo && p.imageinfo[0])
    .map((p) => ({ title: p.title, ...p.imageinfo[0] }))
    .filter((c) => c.width >= 600)                       // skip icons and banners
    .filter((c) => !/phformaps|phicon|placeholder/i.test(c.title)) // skip the wiki's "no map" placeholder
    .filter((c) => !/screenshot|screen[\s_-]?shot|\d{8}[\s_-]?\d{6}/i.test(c.title)); // skip screenshots / datestamped uploads

  if (candidates.length === 0) return { error: 'No real map found on the wiki for "' + zoneName + '" yet' };
  candidates.sort((a, b) => {
    const am = /map/i.test(a.title) ? 1 : 0, bm = /map/i.test(b.title) ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.width * b.height - a.width * a.height;
  });
  return { candidates };
}

// Download one chosen file at 4096px and save it into the app's maps folder
async function downloadMap(zoneName, fileTitle) {
  const q = await wikiJson({
    action: 'query', titles: fileTitle, prop: 'imageinfo', iiprop: 'url|size', iiurlwidth: '4096',
  });
  const page = Object.values(q.query.pages)[0];
  const info = page && page.imageinfo && page.imageinfo[0];
  if (!info) throw new Error('Could not resolve the chosen image');
  const dlUrl = info.thumburl || info.url;
  const res = await fetch(dlUrl, { headers: WIKI_HEADERS });
  if (!res.ok) throw new Error('Image download failed: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(mapsDir(), { recursive: true });
  const ext = (dlUrl.match(/\.(png|jpe?g|webp|gif)/i) || [, 'jpg'])[1];
  const dest = path.join(mapsDir(), zoneName.replace(/[^a-z0-9 _-]/gi, '') + '-wiki-' + Date.now() + '.' + ext);
  fs.writeFileSync(dest, buf);
  return { path: dest, source: fileTitle };
}

// Auto-pick (used by Import All and overlay mode — grabs the best candidate)
ipcMain.handle('wiki-fetch-map', async (event, zoneName) => {
  try {
    const r = await getMapCandidates(zoneName);
    if (r.error) return { error: r.error };
    return await downloadMap(zoneName, r.candidates[0].title);
  } catch (err) {
    return { error: 'Wiki import failed for "' + zoneName + '": ' + err.message };
  }
});

// List candidate maps for the picker (preview thumb + dimensions)
ipcMain.handle('wiki-list-maps', async (event, zoneName) => {
  try {
    const r = await getMapCandidates(zoneName);
    if (r.error) return { error: r.error };
    return {
      candidates: r.candidates.map((c) => ({
        title: c.title, preview: c.thumburl || c.url, width: c.width, height: c.height,
      })),
    };
  } catch (err) {
    return { error: 'Wiki lookup failed for "' + zoneName + '": ' + err.message };
  }
});

// Download the specific candidate the user chose
ipcMain.handle('wiki-download-map', async (event, { zoneName, title }) => {
  try { return await downloadMap(zoneName, title); }
  catch (err) { return { error: 'Download failed: ' + err.message }; }
});

// Import is two steps: open the file and report which zones it holds,
// then (after the user picks) write the chosen zones' images to disk.
let pendingImport = null;

ipcMain.handle('import-open', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Import markers',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  } catch {
    return { error: 'That file could not be read as a marker file.' };
  }
  if (!parsed || parsed.app !== 'mnm-minimap') {
    return { error: 'That file is not an MnM Map marker file.' };
  }

  // Normalize both the new (zones array) and old (single zone) formats
  let zones;
  if (Array.isArray(parsed.zones)) {
    zones = parsed.zones;
  } else if (Array.isArray(parsed.markers)) {
    zones = [{ name: parsed.zone, gameName: parsed.gameName, markers: parsed.markers, image: null }];
  } else {
    return { error: 'That file is not an MnM Map marker file.' };
  }

  pendingImport = zones;
  return {
    zones: zones.map((z) => ({
      name: z.name,
      markerCount: Array.isArray(z.markers) ? z.markers.length : 0,
      hasImage: !!(z.image && z.image.data),
    })),
  };
});

ipcMain.handle('import-commit', async (event, selectedNames) => {
  if (!pendingImport) return { error: 'Nothing to import.' };
  const pick = new Set((selectedNames || []).map((n) => String(n).toLowerCase()));
  const out = [];
  fs.mkdirSync(mapsDir(), { recursive: true });

  for (const z of pendingImport) {
    if (pick.size && !pick.has(String(z.name).toLowerCase())) continue;
    let imagePath = null;
    if (z.image && z.image.data) {
      try {
        const ext = (String(z.image.ext || 'jpg').replace(/[^a-z0-9]/gi, '')) || 'jpg';
        const dest = path.join(
          mapsDir(),
          String(z.name).replace(/[^a-z0-9 _-]/gi, '') + '-imported-' + Date.now() + '.' + ext
        );
        fs.writeFileSync(dest, Buffer.from(z.image.data, 'base64'));
        imagePath = dest;
      } catch {}
    }
    out.push({ name: z.name, gameName: z.gameName || null, markers: z.markers || [], image: imagePath });
  }
  pendingImport = null;
  return { zones: out };
});
