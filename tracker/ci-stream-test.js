// One-shot stream test for CI — proves whether Twitch serves the real auction
// panels from a datacenter IP (GitHub Actions). Resolves the stream, grabs a
// frame, OCRs both panels, parses, and prints a clear PASS/FAIL verdict. No
// state, no commits — just a smoke test.
//
//   MNM_DATA=/tmp node tracker/ci-stream-test.js

const { execFileSync } = require('child_process');
const path = require('path');
const P = require('./parse-auctions.js');

const STREAM = process.env.MNM_STREAM || 'https://www.twitch.tv/livemnm';
const FF = process.env.MNM_FFMPEG || 'ffmpeg';
const SL = process.env.MNM_STREAMLINK || 'streamlink';
const TESS = process.env.MNM_TESSERACT || 'tesseract';
const PANELS = { PvP: 'crop=930:410:25:650', PvE: 'crop=930:410:975:650' };
const PRE = 'scale=iw*2:ih*2:flags=lanczos,format=gray,negate,eq=contrast=1.3';
const OUT = process.env.MNM_DATA || '.';
const p = (f) => path.join(OUT, f);
const framePng = p('frame.png');

const sh = (exe, args, wantOut) => execFileSync(exe, args, { timeout: 90000, encoding: wantOut ? 'utf8' : undefined, stdio: wantOut ? ['ignore', 'pipe', 'pipe'] : 'inherit' });

function streamUrl() {
  const out = sh(SL, ['--twitch-disable-ads', '--stream-url', STREAM, 'best'], true);
  const u = out.split(/\r?\n/).filter((s) => /^https/.test(s)).pop();
  if (!u) throw new Error('no HLS url — Twitch may be blocking datacenter IPs, requiring auth, or the stream is offline');
  return u;
}
function ocrPanel(server) {
  const png = p(server.toLowerCase() + '.png');
  sh(FF, ['-y', '-loglevel', 'error', '-i', framePng, '-vf', `${PANELS[server]},${PRE}`, png], false);
  return sh(TESS, [png, '-', '--psm', '6', '-l', 'eng'], true);
}

(async () => {
  console.log(`Resolving stream from ${STREAM} …`);
  const url = streamUrl();
  console.log('✓ Got an HLS playlist URL. Grabbing one frame…');
  sh(FF, ['-y', '-loglevel', 'error', '-i', url, '-frames:v', '1', '-q:v', '2', framePng], false);

  const glossary = P.loadGlossary();
  const itemIndex = P.loadItemIndex();
  const rows = [];
  for (const server of ['PvP', 'PvE']) {
    let txt = '';
    try { txt = ocrPanel(server); } catch (e) { console.log(`OCR ${server} failed: ${e.message}`); continue; }
    const lines = P.foldOcrLines(txt);
    console.log(`\n===== ${server} OCR (${lines.length} lines) =====`);
    lines.slice(0, 15).forEach((l) => console.log('  ' + l));
    for (const line of lines) rows.push({ server, line });
  }
  const { listings, requests } = P.parseAuctions(rows, { glossary, itemIndex });
  console.log(`\n===== PARSED: ${listings.length} listings, ${requests.length} requests =====`);
  listings.slice(0, 12).forEach((l) => console.log(`  [${l.server}] ${l.intent || '?'} ${l.item}${l.priceCopper != null ? ' @ ' + P.copperToStr(l.priceCopper) : ''} — ${l.player}`));

  const ok = listings.length >= 3;
  console.log(`\n===== VERDICT: ${ok ? 'PASS — Twitch served the real auction panels from GitHub.' : 'FAIL — no real listings read (ads / auth wall / offline / crop mismatch).'} =====`);
  if (!ok) process.exit(1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
