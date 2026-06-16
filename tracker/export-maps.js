// Export the app's curated zone maps (images + markers) into the MnMdb site so
// a read-only web viewer can show them. Pure Node so main.js can call it on
// Publish, and it can be run standalone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Optional — only needed to downscale big maps for the web. Absent in the
// packaged app (it's a devDependency), in which case images are copied as-is.
let Jimp = null;
try { Jimp = require('jimp'); } catch {}
const MAX_WEB = 1600; // longest side, px — plenty for the web viewer + tagging

// Web-optimise one image buffer: shrink to MAX_WEB and recompress. Markers on
// the web are positioned by percentage, so resizing never misaligns them. The
// app keeps its full-res originals (its markers are in pixel coordinates).
async function webImage(buf, ext) {
  if (!Jimp || buf.length < 350 * 1024) return { buf, ext }; // small already — leave it
  try {
    const img = await Jimp.read(buf);
    const long = Math.max(img.bitmap.width, img.bitmap.height);
    if (long > MAX_WEB) img.scale(MAX_WEB / long);
    // Big maps recompress far smaller as JPEG (no transparency needed on a map).
    img.quality(82);
    return { buf: await img.getBufferAsync(Jimp.MIME_JPEG), ext: '.jpg' };
  } catch { return { buf, ext }; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// The wiki's generic "Phformaps.png" placeholder, by content hash — zones whose
// only map is this aren't really mapped, so we don't publish it.
const PLACEHOLDER_MD5 = '8d779540f4e2000004c82893a6ff622b';
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// Marker categories — kept in step with renderer/app.js CATEGORIES.
const CATEGORIES = [
  { id: 'ore', name: 'Ore', color: '#c0784a', icon: '⛏️' },
  { id: 'herb', name: 'Herbs', color: '#3c8f43', icon: '🌿' },
  { id: 'wood', name: 'Wood', color: '#8a5a2b', icon: '🪵' },
  { id: 'fishing', name: 'Fish', color: '#4fc3f7', icon: '🎣' },
  { id: 'crafting', name: 'Crafting', color: '#f06292', icon: '🔨' },
  { id: 'quest', name: 'Quest NPCs', color: '#fff176', icon: '❗️' },
  { id: 'town', name: 'Town / POI', color: '#d9b94a', icon: '🏛️' },
  { id: 'misc', name: 'Other', color: '#b0bec5', icon: '📍' },
];

// Read map-data.json, copy each zone's image into <destDir>/maps, and write
// <destDir>/maps.json with zones + markers (ids stripped). Returns a summary.
async function exportMaps(mapDataFile, destDir) {
  const data = JSON.parse(fs.readFileSync(mapDataFile, 'utf8'));
  const mapsOut = path.join(destDir, 'maps');
  fs.mkdirSync(mapsOut, { recursive: true });

  const zones = [];
  const kept = new Set();
  for (const z of data.zones || []) {
    let buf = null;
    if (z.image && fs.existsSync(z.image)) buf = fs.readFileSync(z.image);
    // No image, or only the wiki placeholder → "map coming soon".
    if (!buf || md5(buf) === PLACEHOLDER_MD5) {
      zones.push({ name: z.name, comingSoon: true, markers: [] });
      continue;
    }
    const srcExt = (path.extname(z.image) || '.png').toLowerCase();
    const out = await webImage(buf, srcExt);
    const fname = slug(z.name) + out.ext;
    fs.writeFileSync(path.join(mapsOut, fname), out.buf);
    kept.add(fname);
    zones.push({
      name: z.name,
      image: fname,
      markers: (z.markers || []).map((m) => ({
        x: Math.round(m.x), y: Math.round(m.y),
        label: m.label || '', category: m.category || 'misc', notes: m.notes || '',
      })),
    });
  }
  // Mapped zones first (alphabetical), then the "coming soon" ones.
  zones.sort((a, b) => (!!a.comingSoon - !!b.comingSoon) || a.name.localeCompare(b.name));

  // Remove images no longer referenced (e.g. a zone switched maps or lost one)
  for (const f of fs.readdirSync(mapsOut)) {
    if (!kept.has(f)) { try { fs.unlinkSync(path.join(mapsOut, f)); } catch {} }
  }

  fs.writeFileSync(
    path.join(destDir, 'maps.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), categories: CATEGORIES, zones }, null, 2)
  );
  return { zones: zones.length, markers: zones.reduce((s, z) => s + z.markers.length, 0) };
}

module.exports = { exportMaps, CATEGORIES };

if (require.main === module) {
  const userData = path.join(process.env.APPDATA || '', 'mnm-minimap');
  exportMaps(path.join(userData, 'map-data.json'), path.join(__dirname, '..', 'mnmdb'))
    .then((r) => console.log('exported maps:', JSON.stringify(r)))
    .catch((e) => { console.error(e); process.exit(1); });
}
