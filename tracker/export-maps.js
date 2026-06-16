// Export the app's curated zone maps (images + markers) into the MnMdb site so
// a read-only web viewer can show them. Pure Node so main.js can call it on
// Publish, and it can be run standalone.

const fs = require('fs');
const path = require('path');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Marker categories — kept in step with renderer/app.js CATEGORIES.
const CATEGORIES = [
  { id: 'ore', name: 'Ore', color: '#c0784a', icon: '⛏️' },
  { id: 'herb', name: 'Herbs', color: '#3c8f43', icon: '🌿' },
  { id: 'wood', name: 'Wood', color: '#8a5a2b', icon: '🪵' },
  { id: 'fishing', name: 'Fish', color: '#4fc3f7', icon: '🎣' },
  { id: 'crafting', name: 'Crafting', color: '#f06292', icon: '🔨' },
  { id: 'quest', name: 'Quest NPCs', color: '#fff176', icon: '❗️' },
  { id: 'misc', name: 'Other', color: '#b0bec5', icon: '📍' },
];

// Read map-data.json, copy each zone's image into <destDir>/maps, and write
// <destDir>/maps.json with zones + markers (ids stripped). Returns a summary.
function exportMaps(mapDataFile, destDir) {
  const data = JSON.parse(fs.readFileSync(mapDataFile, 'utf8'));
  const mapsOut = path.join(destDir, 'maps');
  fs.mkdirSync(mapsOut, { recursive: true });

  const zones = [];
  for (const z of data.zones || []) {
    if (!z.image || !fs.existsSync(z.image)) continue;
    const ext = (path.extname(z.image) || '.png').toLowerCase();
    const fname = slug(z.name) + ext;
    fs.copyFileSync(z.image, path.join(mapsOut, fname));
    zones.push({
      name: z.name,
      image: fname,
      markers: (z.markers || []).map((m) => ({
        x: Math.round(m.x), y: Math.round(m.y),
        label: m.label || '', category: m.category || 'misc', notes: m.notes || '',
      })),
    });
  }
  zones.sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(
    path.join(destDir, 'maps.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), categories: CATEGORIES, zones }, null, 2)
  );
  return { zones: zones.length, markers: zones.reduce((s, z) => s + z.markers.length, 0) };
}

module.exports = { exportMaps, CATEGORIES };

if (require.main === module) {
  const userData = path.join(process.env.APPDATA || '', 'mnm-minimap');
  const r = exportMaps(path.join(userData, 'map-data.json'), path.join(__dirname, '..', 'mnmdb'));
  console.log('exported maps:', JSON.stringify(r));
}
