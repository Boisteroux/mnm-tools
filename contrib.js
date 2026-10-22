// Opt-in automatic sharing of play data with MnMdb (main process).
//
// When the player has said yes, every SHARE_EVERY_MIN minutes this rolls up their Early
// Access Ledger (the same counts "Export my data to share" writes: kills, drops,
// harvests, vendor prices — no chat, no personal files) and uploads it to the MnMdb
// API, replacing their previous upload so nothing is double-counted. The install gets
// an anonymous credential the first time; signing in with Discord (optional) links it,
// and trusted Discord users skip the approval queue. Settings live in userData.

const fs = require('fs');
const path = require('path');

const API = process.env.MNM_API || 'https://mnmdb-api.boisteroux.workers.dev';
const SHARE_EVERY_MIN = 30;
const FIRST_SHARE_DELAY_S = 90;

let deps = null;      // { app, ledgerParser, harvestSkillOpts, onChange }
let timer = null;
let busy = false;
let session = '';     // Discord session from the renderer (it owns sign-in)

const file = () => path.join(deps.app.getPath('userData'), 'contrib.json');
function load() {
  try { return Object.assign(defaults(), JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { return defaults(); }
}
function defaults() {
  // optIn: null = not asked yet, true = sharing, false = declined
  return { optIn: null, credit: false, token: null, status: null, lastSharedAt: null, lastEvents: 0, lastError: null, lastCheckedAt: null };
}
function save(s) { try { fs.writeFileSync(file(), JSON.stringify(s, null, 2)); } catch {} }
function update(patch) { const s = Object.assign(load(), patch); save(s); notify(s); return s; }
const publicState = (s) => {
  const { token, ...rest } = s; // the credential never leaves the main process
  return Object.assign(rest, { character: (characters()[0] || null), signedIn: !!session });
};
function notify(s) { if (deps && deps.onChange) deps.onChange(publicState(s || load())); }

function eaFiles() {
  return deps.ledgerParser.findLedgerFiles().filter((f) => deps.ledgerParser.ledgerEra(f) === 'early-access');
}
function characters() { try { return deps.ledgerParser.charactersFromFiles(eaFiles()); } catch { return []; } }

async function api(method, p, { token, body } = {}) {
  const r = await fetch(API + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

// Upload now if sharing is on and there's something new (or `force`).
async function shareNow({ force = false } = {}) {
  let s = load();
  if (s.optIn !== true || busy) return publicState(s);
  busy = true;
  try {
    const files = eaFiles();
    if (!files.length) return publicState(update({ lastError: 'No Early Access Ledger files yet — play a little first.' }));
    const agg = deps.ledgerParser.parseLedgers(files, deps.harvestSkillOpts());
    if (!force && s.status && agg.events === s.lastEvents) return publicState(update({ lastError: null, lastCheckedAt: new Date().toISOString() }));

    if (!s.token) {
      const reg = await api('POST', '/contrib/register');
      if (reg.status !== 201 || !reg.j.token) return publicState(update({ lastError: reg.j.error || 'Could not reach MnMdb (sign-up ' + reg.status + ').' }));
      s = update({ token: reg.j.token, status: 'pending' });
    }
    const chars = deps.ledgerParser.charactersFromFiles(files);
    const servers = [...new Set(files.map((f) => deps.ledgerParser.ledgerServer(f)))];
    const body = {
      agg: { mobs: agg.mobs, items: agg.items, harvest: agg.harvest, harvestZones: agg.harvestZones, harvestNodes: agg.harvestNodes, events: agg.events, fileCount: agg.fileCount },
      servers, characters: chars, credit: !!s.credit, creditName: s.credit ? (chars[0] || null) : null,
      session: session || undefined,
    };
    const up = await api('POST', '/contrib/upload', { token: s.token, body });
    if (up.status === 401) return publicState(update({ token: null, status: null, lastError: 'MnMdb no longer knows this install — it will sign up again next time.' }));
    if (up.status === 429) return publicState(update(Object.assign({ lastError: null, lastCheckedAt: new Date().toISOString() }, up.j.status ? { status: up.j.status } : {}))); // shared very recently
    if (up.status !== 200) return publicState(update({ lastError: up.j.error || 'Upload failed (' + up.status + ').' }));
    return publicState(update({ status: up.j.status, lastSharedAt: new Date().toISOString(), lastEvents: agg.events, lastError: null, lastCheckedAt: new Date().toISOString() }));
  } catch (e) {
    return publicState(update({ lastError: 'Could not reach MnMdb: ' + e.message }));
  } finally { busy = false; }
}

// Refresh the approval status without uploading (e.g. after an admin approves).
async function refreshStatus() {
  const s = load();
  if (!s.token) return publicState(s);
  try {
    const r = await api('GET', '/contrib/status', { token: s.token });
    if (r.status === 200) return publicState(update({ status: r.j.status }));
  } catch {}
  return publicState(s);
}

function schedule() {
  clearInterval(timer); timer = null;
  if (load().optIn !== true) return;
  setTimeout(() => { shareNow(); }, FIRST_SHARE_DELAY_S * 1000);
  timer = setInterval(() => { shareNow(); }, SHARE_EVERY_MIN * 60 * 1000);
}

async function setOptIn(on, { forget = false } = {}) {
  const s = load();
  if (on) { update({ optIn: true, lastError: null }); schedule(); return shareNow({ force: true }); }
  // Turning sharing off; optionally also delete what this install already shared.
  if (forget && s.token) { try { await api('POST', '/contrib/forget', { token: s.token }); } catch {} }
  const next = update(Object.assign({ optIn: false, lastError: null }, forget ? { token: null, status: null, lastSharedAt: null, lastEvents: 0 } : {}));
  schedule();
  return publicState(next);
}

async function setCredit(on) {
  update({ credit: !!on });
  return shareNow({ force: true }); // push the credit change through
}

function setSession(sess) {
  const had = !!session; session = sess || '';
  // Signing in can skip the approval queue for trusted users — share right away.
  if (session && !had && load().optIn === true) shareNow({ force: true });
  notify();
}

function init(d) {
  deps = d;
  schedule();
  const { ipcMain } = require('electron');
  ipcMain.handle('contrib-state', async () => (load().token ? refreshStatus() : publicState(load())));
  ipcMain.handle('contrib-set-optin', (e, on, opts) => setOptIn(!!on, opts || {}));
  ipcMain.handle('contrib-set-credit', (e, on) => setCredit(!!on));
  ipcMain.handle('contrib-share-now', () => shareNow({ force: true }));
  ipcMain.handle('contrib-session', (e, sess) => { setSession(sess); return true; });
}

module.exports = { init, shareNow, API };
