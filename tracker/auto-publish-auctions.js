// Auto-publish loop — snapshots the local auction capture into mnmdb/auctions.json
// and pushes it live on a schedule, so the Auction House page stays current without
// anyone running a command. Robust: builds, only commits/pushes when auctions.json
// actually changed, rebases with --autostash so unrelated local edits don't block it,
// and never throws out of the loop.
//
//   one push:  MNM_PUBLISH_ONCE=1 node tracker/auto-publish-auctions.js
//   loop:      MNM_HOURS=24 node tracker/auto-publish-auctions.js   (launch detached)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.MNM_DATA || 'C:\\Users\\zacha\\Desktop\\mnm-auction-poc';
const INTERVAL = (+process.env.MNM_PUBLISH_INTERVAL || 1800) * 1000; // 30 min
const ONCE = !!process.env.MNM_PUBLISH_ONCE;
const HOURS = +process.env.MNM_HOURS || 24;
const DEADLINE = Date.now() + HOURS * 3600 * 1000;

const log = (m) => { const line = `[${new Date().toISOString()}] auto-publish: ${m}`; console.log(line); try { fs.appendFileSync(path.join(DATA, 'publish-log.txt'), line + '\n'); } catch {} };
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function publishOnce() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'publish-auctions.js')], { cwd: ROOT, env: Object.assign({}, process.env, { MNM_DATA: DATA }), stdio: 'ignore' });
  } catch (e) { log('build failed: ' + e.message); return; }
  // Early Access play data shared from MnM Map (approved contributors). Optional: needs
  // MNM_EXPORT_TOKEN; a failure here never blocks the auction publish.
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'build-ea-data.js')], { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (out.trim()) log(out.trim());
  } catch (e) { log('play-data build failed: ' + ((e.stderr || '') + e.message).trim().slice(0, 300)); }

  const FILES = ['mnmdb/auctions.json', 'mnmdb/data-ea.json'];
  let changed = '';
  try { changed = git(['status', '--porcelain', ...FILES]); } catch (e) { log('status failed: ' + e.message); return; }
  if (!changed.trim()) { log('no change — nothing to push'); return; }
  const what = /data-ea\.json/.test(changed) ? (/auctions\.json/.test(changed) ? 'auction prices + shared play data' : 'shared play data') : 'auction prices';

  try { git(['add', ...FILES]); git(['commit', '-m', 'Auto-publish ' + what]); }
  catch (e) { log('commit failed: ' + e.message); return; }

  try { git(['pull', '--rebase', '--autostash', 'origin', 'main']); }
  catch (e) { log('rebase failed, aborting: ' + (e.stderr || e.message)); try { git(['rebase', '--abort']); } catch {} return; }

  try { git(['push', 'origin', 'main']); log('published + pushed'); }
  catch (e) { log('push failed: ' + (e.stderr || e.message)); }
}

function loop() {
  if (!ONCE && Date.now() >= DEADLINE) { log('deadline reached — exiting'); process.exit(0); }
  publishOnce();
  if (ONCE) process.exit(0);
  setTimeout(loop, INTERVAL);
}

// MNM_PUBLISH_ONCE=1 publishes a single snapshot and exits — that's how the VPS runs it
// (a systemd timer fires it every 6 hours), so don't log a polling interval it won't use.
log(ONCE ? `START: one-shot publish (repo ${ROOT})` : `START: publish every ${INTERVAL / 1000}s for ${HOURS}h (repo ${ROOT})`);
loop();
