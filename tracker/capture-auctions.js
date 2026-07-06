// ---------------------------------------------------------------
// Auction capture loop — PROOF OF CONCEPT, safe to leave unattended.
//
// Every INTERVAL it grabs one frame from the LiveMMCam Twitch stream, OCRs the two
// auction panels (Tesseract), parses them, and accumulates DEDUPED listings into a
// local data folder. Runs until a hard deadline, then exits by itself.
//
// Safety: local files only — no git, no network writes, no site changes. Watches a
// public stream read-only. Every cycle is wrapped in try/catch so a stream blip or
// OCR miss never crashes the loop. Resume-safe (reloads its aggregate on restart).
//
// Run one test cycle:   MNM_ONCE=1 node tracker/capture-auctions.js
// Run the real loop:    MNM_HOURS=12 node tracker/capture-auctions.js   (launch detached)
// ---------------------------------------------------------------

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const P = require('./parse-auctions.js');

const STREAM = 'https://www.twitch.tv/livemmcam';
const INTERVAL_MS = (+process.env.MNM_INTERVAL || 120) * 1000; // 2 min
const HOURS = +process.env.MNM_HOURS || 12;
const ONCE = !!process.env.MNM_ONCE;
const DEADLINE = Date.now() + HOURS * 3600 * 1000;
const DATA = process.env.MNM_DATA || 'C:\\Users\\zacha\\Desktop\\mnm-auction-poc';

// Tool paths discovered on this machine (env-overridable).
const FF = process.env.MNM_FFMPEG || 'C:\\Users\\zacha\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe';
const SL = process.env.MNM_STREAMLINK || 'C:\\Users\\zacha\\AppData\\Local\\Programs\\Streamlink\\bin\\streamlink.exe';
const TESS = process.env.MNM_TESSERACT || 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';

const PANELS = { PvP: 'crop=930:410:25:650', PvE: 'crop=930:410:975:650' };
const PRE = 'scale=iw*2:ih*2:flags=lanczos,format=gray,negate,eq=contrast=1.3';

fs.mkdirSync(DATA, { recursive: true });
const framePng = path.join(DATA, 'frame.png');
const p = (f) => path.join(DATA, f);
const log = (m) => { try { fs.appendFileSync(p('log.txt'), `[${new Date().toISOString()}] ${m}\n`); } catch {} };

// Load glossary + item index once (parser would otherwise re-read wiki.json each cycle).
const glossary = P.loadGlossary();
const itemIndex = P.loadItemIndex();

// Resume-safe aggregates keyed by signature.
const loadMap = (f, key) => { const m = {}; try { for (const r of JSON.parse(fs.readFileSync(p(f), 'utf8'))) m[r[key]] = r; } catch {} return m; };
const agg = loadMap('listings.json', 'sig');
const requests = loadMap('requests.json', 'sig');
const reviewMap = loadMap('review.json', 'key');
const enrichSet = new Set(); try { for (const n of JSON.parse(fs.readFileSync(p('enrich.json'), 'utf8'))) enrichSet.add(n); } catch {}

const sig = (l) => [l.server, l.player, l.intent || '', l.item, l.priceCopper == null ? 'na' : l.priceCopper].join('|').toLowerCase();

function sh(exe, args, wantOut) {
  return execFileSync(exe, args, { timeout: 60000, encoding: wantOut ? 'utf8' : undefined, stdio: wantOut ? ['ignore', 'pipe', 'ignore'] : 'ignore' });
}
function streamUrl() {
  const out = sh(SL, ['--twitch-disable-ads', '--stream-url', STREAM, 'best'], true);
  const u = out.split(/\r?\n/).filter((s) => /^https/.test(s)).pop();
  if (!u) throw new Error('no stream url (stream offline?)');
  return u;
}
function ocrPanel(server) {
  const png = p(server.toLowerCase() + '.png');
  sh(FF, ['-y', '-loglevel', 'error', '-i', framePng, '-vf', `${PANELS[server]},${PRE}`, png], false);
  return sh(TESS, [png, '-', '--psm', '6', '-l', 'eng'], true);
}

function persist() {
  fs.writeFileSync(p('listings.json'), JSON.stringify(Object.values(agg), null, 2));
  fs.writeFileSync(p('requests.json'), JSON.stringify(Object.values(requests), null, 2));
  fs.writeFileSync(p('review.json'), JSON.stringify(Object.values(reviewMap), null, 2));
  fs.writeFileSync(p('enrich.json'), JSON.stringify([...enrichSet].sort(), null, 2));
}

let cycles = 0, errors = 0;
function runCycle() {
  const now = new Date().toISOString();
  const url = streamUrl();
  sh(FF, ['-y', '-loglevel', 'error', '-i', url, '-frames:v', '1', '-q:v', '2', framePng], false);
  const rows = [];
  for (const server of ['PvP', 'PvE']) {
    let txt = '';
    try { txt = ocrPanel(server); } catch (e) { log(`  ocr ${server} skipped: ${e.message}`); continue; }
    for (const line of P.foldOcrLines(txt)) rows.push({ server, line });
  }
  const { listings, requests: reqs, review, enrich } = P.parseAuctions(rows, { glossary, itemIndex });
  let added = 0;
  for (const l of listings) {
    const s = sig(l);
    if (agg[s]) { agg[s].count++; agg[s].lastSeen = now; }
    else { agg[s] = { sig: s, server: l.server, intent: l.intent, item: l.item, matched: l.matched, priceCopper: l.priceCopper, price: l.priceCopper == null ? null : P.copperToStr(l.priceCopper), qty: l.qty || null, player: l.player, firstSeen: now, lastSeen: now, count: 1 }; added++; }
  }
  for (const r of reqs) { const s = ['req', r.server, r.player, r.text].join('|').toLowerCase(); if (requests[s]) { requests[s].count++; requests[s].lastSeen = now; } else { requests[s] = Object.assign({ sig: s, firstSeen: now, lastSeen: now, count: 1 }, r); } }
  for (const r of review) { const k = [r.reason, r.detail].join('|'); if (!reviewMap[k]) reviewMap[k] = Object.assign({ key: k, firstSeen: now }, r); }
  for (const n of enrich) enrichSet.add(n);
  persist();
  log(`cycle ${cycles}: ${rows.length} lines · +${added} new (total ${Object.keys(agg).length} listings, ${Object.keys(requests).length} requests) · review ${Object.keys(reviewMap).length} · enrich ${enrichSet.size}`);
}

function loop() {
  if (!ONCE && Date.now() >= DEADLINE) {
    log(`DONE: ${cycles} cycles, ${Object.keys(agg).length} unique listings, ${Object.keys(requests).length} requests, ${enrichSet.size} items to enrich, ${Object.keys(reviewMap).length} review items. Exiting cleanly.`);
    process.exit(0);
  }
  cycles++;
  try { runCycle(); } catch (e) { errors++; log(`cycle ${cycles} error (skipped): ${e.message}`); }
  if (ONCE) { log('ONCE mode — one cycle done, exiting.'); process.exit(0); }
  setTimeout(loop, INTERVAL_MS);
}

fs.writeFileSync(p('pid.txt'), String(process.pid));
log(`START: interval ${INTERVAL_MS / 1000}s · ${HOURS}h (until ${new Date(DEADLINE).toISOString()}) · pid ${process.pid} · data ${DATA}`);
loop();
