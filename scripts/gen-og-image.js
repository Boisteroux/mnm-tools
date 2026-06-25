// Renders the social share card (mnmdb/og-image.png, 1200x630) from the Sunset
// light-theme palette. Run from the repo root:  node scripts/gen-og-image.js
const sharp = require('sharp');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'mnmdb', 'og-image.png');
const serif = "Georgia, 'Times New Roman', serif";
const sans = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="sun" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#b8531a"/>
      <stop offset="0.55" stop-color="#c2622b"/>
      <stop offset="1" stop-color="#b07d1c"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1200" height="630" fill="#f6ecd2"/>
  <rect x="24" y="24" width="1152" height="582" fill="none" stroke="#cbb27e" stroke-width="2.5"/>
  <rect x="34" y="34" width="1132" height="562" fill="none" stroke="#ddc794" stroke-width="1"/>
  <circle cx="600" cy="168" r="66" fill="#241405"/>
  <circle cx="600" cy="168" r="54" fill="#ef9f27"/>
  <text x="600" y="168" text-anchor="middle" dominant-baseline="central" font-family="${serif}" font-weight="700" font-size="70" fill="#241405">M</text>
  <text x="600" y="320" text-anchor="middle" font-family="${serif}" font-size="40" letter-spacing="12" fill="#6e562c">MONSTERS &amp; MEMORIES</text>
  <text x="600" y="412" text-anchor="middle" font-family="${serif}" font-weight="700" font-size="92" fill="url(#sun)">Economy Database</text>
  <text x="600" y="476" text-anchor="middle" font-family="${sans}" font-size="30" fill="#3a2a18">Drop rates &#183; vendor &amp; trade prices &#183; recipes &#183; maps &#8212; from real play</text>
  <text x="600" y="548" text-anchor="middle" font-family="${sans}" font-weight="700" font-size="29" letter-spacing="1" fill="#9e5010">mnm-db.com</text>
</svg>`;

sharp(Buffer.from(svg)).png().toFile(OUT).then((info) => {
  console.log('wrote', OUT, info.width + 'x' + info.height, Math.round(info.size / 1024) + 'KB');
}).catch((e) => { console.error(e); process.exit(1); });
