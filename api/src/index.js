// MnMdb submission API — a Cloudflare Worker.
//
// Receives community marker submissions, holds them in a moderation queue, and serves
// the approved ones back to the static site. Bound to a D1 database (binding "DB").
//
// Secrets / vars (set with `wrangler secret put NAME`, or in wrangler.toml [vars]):
//   ADMIN_TOKEN       (secret)           bearer token for the /admin endpoints — you set this
//   TURNSTILE_SECRET  (secret, optional) Cloudflare Turnstile secret; the bot check is SKIPPED
//                                        when unset, so the pipe is testable before Turnstile is wired
//   ALLOWED_ORIGIN    (var)              the site origin allowed to call this API

const DEFAULT_ORIGIN = 'https://mnm-db.com';
const MAX_LABEL = 80;
const RATE_WINDOW_MIN = 10; // per-IP sliding window
const RATE_MAX = 8;         // max submissions allowed in that window

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});
const json = (data, status, origin, extra) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(extra || {}) },
  });

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Verify a Cloudflare Turnstile token. Returns true (allow) when no secret is configured yet.
async function verifyTurnstile(token, secret, ip) {
  if (!secret) return true;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token || '');
  if (ip) body.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const out = await r.json().catch(() => ({}));
  return !!out.success;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let origin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const reqOrigin = request.headers.get('Origin') || '';
    if (/^http:\/\/localhost(:\d+)?$/.test(reqOrigin)) origin = reqOrigin; // allow local dev

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    // Health check — the "is the pipe alive?" endpoint.
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'mnmdb-api', time: new Date().toISOString() }, 200, origin);
    }

    // Public: approved markers for the site to draw (edge-cached for 60s).
    if (request.method === 'GET' && url.pathname === '/markers') {
      const { results } = await env.DB.prepare(
        "SELECT id, zone, x, y, category, label, submitter, created_at FROM submissions WHERE status='approved' ORDER BY created_at DESC"
      ).all();
      return json({ markers: results }, 200, origin, { 'Cache-Control': 'public, max-age=60' });
    }

    // Public: submit a marker -> lands in the pending queue.
    if (request.method === 'POST' && url.pathname === '/submit') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
      const zone = String(b.zone || '').trim();
      const category = String(b.category || '').trim();
      const label = String(b.label || '').trim();
      const x = Number(b.x), y = Number(b.y);
      const submitter = b.submitter ? String(b.submitter).trim().slice(0, 40) : null;
      if (!zone || zone.length > 60) return json({ error: 'zone required' }, 400, origin);
      if (!category || category.length > 30) return json({ error: 'category required' }, 400, origin);
      if (!label || label.length > MAX_LABEL) return json({ error: `label must be 1-${MAX_LABEL} chars` }, 400, origin);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return json({ error: 'x/y must be numbers' }, 400, origin);

      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (!(await verifyTurnstile(b.turnstile, env.TURNSTILE_SECRET, ip))) {
        return json({ error: 'bot check failed' }, 403, origin);
      }

      const ipHash = ip ? await sha256(ip + '|mnmdb-salt') : null;
      if (ipHash) {
        const { results } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM submissions WHERE ip_hash=? AND created_at > datetime('now', ?)"
        ).bind(ipHash, `-${RATE_WINDOW_MIN} minutes`).all();
        if (results[0].n >= RATE_MAX) return json({ error: 'slow down — try again in a bit' }, 429, origin);
      }

      await env.DB.prepare(
        'INSERT INTO submissions (type, zone, x, y, category, label, submitter, ip_hash) VALUES (?,?,?,?,?,?,?,?)'
      ).bind('marker', zone, x, y, category, label, submitter, ipHash).run();
      return json({ ok: true, status: 'pending' }, 201, origin);
    }

    // Admin (moderation) — everything below requires the ADMIN_TOKEN bearer.
    if (url.pathname.startsWith('/admin/')) {
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401, origin);

      if (request.method === 'GET' && url.pathname === '/admin/pending') {
        const { results } = await env.DB.prepare(
          "SELECT id, zone, x, y, category, label, submitter, created_at FROM submissions WHERE status='pending' ORDER BY created_at ASC"
        ).all();
        return json({ pending: results }, 200, origin);
      }
      if (request.method === 'POST' && (url.pathname === '/admin/approve' || url.pathname === '/admin/reject')) {
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const id = parseInt(b.id, 10);
        if (!id) return json({ error: 'id required' }, 400, origin);
        const status = url.pathname.endsWith('approve') ? 'approved' : 'rejected';
        await env.DB.prepare("UPDATE submissions SET status=?, reviewed_at=datetime('now') WHERE id=?").bind(status, id).run();
        return json({ ok: true, id, status }, 200, origin);
      }
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
