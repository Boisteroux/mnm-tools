// Tiny dependency-free static server for the auction POC dashboard. Runs detached
// alongside the capture loop so http://localhost:<port> stays up on its own (survives
// this Claude session; stops only when the PC is off or the process is killed).
// Serves Desktop\mnm-auction-poc (index.html + the live *.json data files).
//
//   node tracker/serve-poc.js        (POC_DIR / POC_PORT env-overridable)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.POC_DIR || 'C:\\Users\\zacha\\Desktop\\mnm-auction-poc';
const PORT = +process.env.POC_PORT || 5610;
const MIME = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript' };

http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); } // no path traversal
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => {
  try { fs.writeFileSync(path.join(ROOT, 'server-pid.txt'), String(process.pid)); } catch {}
  console.log('serving ' + ROOT + ' on http://localhost:' + PORT);
});
