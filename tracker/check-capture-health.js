// Daily health check of the auction capture, run by .github/workflows/capture-health.yml.
// Reads the published mnmdb/auctions.json and exits non-zero (→ the workflow fails →
// GitHub emails the repo owner) when:
//   - the 6-hourly publish hasn't run for over 8 hours, or
//   - the stream was live but the capture read no auction lines for an hour or more
//     (e.g. the streamer moved the chat box and the crop no longer matches).
//
//   node tracker/check-capture-health.js

const fs = require('fs');
const path = require('path');

const BLIND_LIMIT_MIN = +process.env.MNM_BLIND_LIMIT_MIN || 60;
const STALE_LIMIT_H = +process.env.MNM_STALE_LIMIT_H || 8;

const a = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mnmdb', 'auctions.json'), 'utf8'));
const ageH = (Date.now() - new Date(a.generatedAt).getTime()) / 3600000;
const c = a.capture;
const problems = [];

if (!(ageH < STALE_LIMIT_H)) problems.push(`auctions.json was last published ${ageH.toFixed(1)}h ago — the VPS's 6-hourly mnm-publish run hasn't pushed (check mnm-publish.timer / publish-log.txt).`);
if (!c) problems.push('auctions.json has no capture-health summary — the VPS is running an older capture/publish (git pull + restart mnm-capture).');
else if (c.longestBlindMin >= BLIND_LIMIT_MIN) {
  problems.push(`the stream was live but the capture read 0 auction lines for ${c.longestBlindMin} min in the last 24h` +
    (c.blindNowMin ? ` (still blind at publish time, for ${c.blindNowMin} min)` : '') +
    ` — last good read ${c.lastLinesAt || 'unknown'}. Likely the stream layout moved: compare auction-data/frame.png with PANELS in tracker/capture-auctions.js.`);
}

console.log(`published ${ageH.toFixed(1)}h ago · capture last 24h: ${c ? `${c.readingCycles24h}/${c.liveCycles24h} live cycles read lines, ${c.offlineCycles24h} offline, longest blind ${c.longestBlindMin} min, last read ${c.lastLinesAt}` : 'no summary'}`);
if (problems.length) {
  for (const p of problems) console.log(`::error title=Auction capture needs attention::${p}`);
  process.exit(1);
}
console.log('Auction capture healthy.');
