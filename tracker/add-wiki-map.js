// Add or replace ONE zone's map on the site straight from the community wiki, without
// re-exporting every map from the desktop app (export-maps.js rebuilds maps.json from
// the app's local data, which would drop the curated markers on a machine that doesn't
// have them). Existing markers on the zone are kept; a zone that was "coming soon"
// becomes a mapped one.
//
//   node tracker/add-wiki-map.js "Rothold" "Rothold map by skoop.png"
//   node tracker/add-wiki-map.js --remove "Wyrmsbanetomb"     (drop a stray zone entry)
//
// Note: replacing a map that already has markers will misplace them unless the new
// image has the same framing — markers are stored in image pixels.

const fs = require('fs');
const path = require('path');
const { webImage, slug, imageSize } = require('./export-maps.js');

const WIKI_API = 'https://monstersandmemories.miraheze.org/w/api.php';
const UA = { 'User-Agent': 'MnM-Map-Companion/0.1 (personal fan-made map tool)' }; // the wiki rejects default agents
const SITE = path.join(__dirname, '..', 'mnmdb');
const mapsFile = path.join(SITE, 'maps.json');
const save = (maps) => {
  maps.zones.sort((a, b) => (!!a.comingSoon - !!b.comingSoon) || a.name.localeCompare(b.name));
  fs.writeFileSync(mapsFile, JSON.stringify(maps, null, 2));
};

(async () => {
  const maps = JSON.parse(fs.readFileSync(mapsFile, 'utf8'));
  const args = process.argv.slice(2);
  if (args[0] === '--stamp-sizes') { // record each published image's pixel size on its zone
    for (const z of maps.zones) if (z.image) Object.assign(z, await imageSize(fs.readFileSync(path.join(SITE, 'maps', z.image))));
    save(maps);
    return console.log('sizes recorded for ' + maps.zones.filter((z) => z.width).length + ' zone maps');
  }
  if (args[0] === '--remove') {
    const before = maps.zones.length;
    maps.zones = maps.zones.filter((z) => z.name !== args[1] || (z.markers || []).length); // never drop a zone that has markers
    save(maps);
    return console.log(before === maps.zones.length ? `"${args[1]}" not removed (missing, or it has markers)` : `removed "${args[1]}"`);
  }
  const [zone, file] = args;
  if (!zone || !file) { console.error('usage: node tracker/add-wiki-map.js "<Zone>" "<wiki file name>"'); process.exit(1); }

  const q = await (await fetch(WIKI_API + '?' + new URLSearchParams({ format: 'json', action: 'query', titles: 'File:' + file, prop: 'imageinfo', iiprop: 'url|size', iiurlwidth: '4096' }), { headers: UA })).json();
  const info = (Object.values(q.query.pages)[0].imageinfo || [])[0];
  if (!info) throw new Error('no such file on the wiki: ' + file);
  const url = info.thumburl || info.url;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
  const src = Buffer.from(await res.arrayBuffer());
  const out = await webImage(src, (path.extname(url.split('?')[0]) || '.png').toLowerCase());

  let z = maps.zones.find((x) => x.name === zone);
  if (!z) { z = { name: zone, markers: [] }; maps.zones.push(z); }
  if (z.image && (z.markers || []).length) console.warn(`warning: ${zone} already has ${z.markers.length} markers placed on the old image`);
  const fname = slug(zone) + out.ext;
  if (z.image && z.image !== fname) { try { fs.unlinkSync(path.join(SITE, 'maps', z.image)); } catch {} }
  fs.writeFileSync(path.join(SITE, 'maps', fname), out.buf);
  z.image = fname; delete z.comingSoon; z.markers = z.markers || [];
  Object.assign(z, await imageSize(out.buf));
  z.source = 'wiki: ' + file;
  save(maps);
  console.log(`${zone}: ${file} (${info.width}x${info.height}) → maps/${fname} (${Math.round(out.buf.length / 1024)} KB)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
