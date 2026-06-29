// MnMdb submission API — a Cloudflare Worker.
//
// Receives community marker submissions, holds them in a moderation queue, and serves
// the approved ones back to the static site. Bound to a D1 database (binding "DB").
//
// Secrets / vars (set with `wrangler secret put NAME`, or in wrangler.toml [vars]):
//   ADMIN_TOKEN          (secret)        bearer token for the /admin endpoints — you set this
//   TURNSTILE_SECRET     (secret, opt.)  Cloudflare Turnstile secret; the bot check is SKIPPED
//                                        when unset (skipped anyway for signed-in Discord users)
//   DISCORD_CLIENT_SECRET (secret, opt.) Discord OAuth client secret (for "Sign in with Discord")
//   SESSION_SECRET       (secret, opt.)  signs the login session tokens
//   ALLOWED_ORIGIN       (var)           the site origin allowed to call this API
//   DISCORD_CLIENT_ID    (var, opt.)     Discord OAuth client id (public)
//   TRUSTED_DISCORD_IDS  (var, opt.)     comma-separated Discord user ids whose markers auto-approve
//   ADMIN_DISCORD_IDS    (var, opt.)     comma-separated Discord user ids who are full admins (seed;
//                                        the self-service `admins` table is the usual way to manage them)
//
// Bindings: DB (D1 database), MAPS_BUCKET (R2 bucket "mnmdb-maps" for community map images).

const DEFAULT_ORIGIN = 'https://mnm-db.com';
const MAX_LABEL = 80;
const RATE_WINDOW_MIN = 10; // per-IP sliding window
const RATE_MAX = 8;         // max submissions allowed in that window
const MAX_MAP_BYTES = 10 * 1024 * 1024;      // 10 MB cap on a submitted map image
const MAP_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PENDING_MAPS = 8;                  // per user, so the queue can't be flooded

const mapSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'zone';

// Magic-byte sniff so a renamed/disguised non-image can't be stored. Returns the real mime or null.
function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

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

// ---- Login sessions (stateless, signed) + Discord OAuth ----
const b64url = {
  enc: (str) => { const by = new TextEncoder().encode(str); let bin = ''; for (const b of by) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: (s) => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); },
};
async function hmacHex(payload, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// A session token is base64url(JSON{id,name,exp}) + '.' + hmac. No DB needed — the
// signature proves it was minted by us and hasn't been tampered with.
async function makeSession(user, secret) {
  const payload = b64url.enc(JSON.stringify({ id: user.id, name: user.name, exp: Date.now() + 30 * 86400000 }));
  return payload + '.' + (await hmacHex(payload, secret));
}
async function readSession(token, secret) {
  if (!token || !secret) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig || (await hmacHex(payload, secret)) !== sig) return null;
  let d; try { d = JSON.parse(b64url.dec(payload)); } catch { return null; }
  if (!d.exp || d.exp < Date.now()) return null;
  return { id: String(d.id), name: String(d.name || '') };
}
const getCookie = (request, name) => {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
};

// Is this Discord id a full admin? (env seed list OR the self-service `admins` table.)
async function isAdminId(id, env) {
  if (!id) return false;
  const seed = (env.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (seed.includes(String(id))) return true;
  return !!(await env.DB.prepare('SELECT 1 FROM admins WHERE discord_id=?').bind(String(id)).first());
}

// Who may edit/delete/move a marker: the super-admin (ADMIN_TOKEN bearer), a signed-in
// admin, or the signed-in user who submitted it. Returns { allowed, admin }.
async function authorizeMarker(request, env, body, markerId) {
  const adminTok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (env.ADMIN_TOKEN && adminTok === env.ADMIN_TOKEN) return { allowed: true, admin: true };
  const sess = await readSession(body.session, env.SESSION_SECRET);
  if (!sess) return { allowed: false };
  if (await isAdminId(sess.id, env)) return { allowed: true, admin: true };
  const row = await env.DB.prepare('SELECT discord_id FROM submissions WHERE id=?').bind(markerId).first();
  if (row && row.discord_id && row.discord_id === sess.id) return { allowed: true, admin: false };
  return { allowed: false };
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

    // --- Discord OAuth: step 1, send the user to Discord's consent screen ---
    if (url.pathname === '/auth/discord/start') {
      if (!env.DISCORD_CLIENT_ID) return json({ error: 'discord login not configured' }, 503, origin);
      const state = crypto.randomUUID().replace(/-/g, '');
      const authorize = 'https://discord.com/api/oauth2/authorize?' + new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID, redirect_uri: url.origin + '/auth/discord/callback',
        response_type: 'code', scope: 'identify', state,
      });
      return new Response(null, { status: 302, headers: {
        Location: authorize,
        'Set-Cookie': `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      } });
    }

    // --- Discord OAuth: step 2, Discord returns here with a code; we verify + mint a session ---
    if (url.pathname === '/auth/discord/callback') {
      const site = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
      const fail = (why) => new Response(null, { status: 302, headers: { Location: site + '/?login_error=' + encodeURIComponent(why) } });
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state || state !== getCookie(request, 'oauth_state')) return fail('state');
      let tok;
      try {
        const form = new URLSearchParams();
        form.set('client_id', env.DISCORD_CLIENT_ID);
        form.set('client_secret', env.DISCORD_CLIENT_SECRET);
        form.set('grant_type', 'authorization_code');
        form.set('code', code);
        form.set('redirect_uri', url.origin + '/auth/discord/callback');
        const r = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
        });
        tok = await r.json();
      } catch { return fail('token'); }
      if (!tok || !tok.access_token) return fail('token');
      let me;
      try {
        const r = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tok.access_token } });
        me = await r.json();
      } catch { return fail('identity'); }
      if (!me || !me.id) return fail('identity');
      const name = me.global_name || me.username || ('user' + String(me.id).slice(-4));
      const session = await makeSession({ id: me.id, name }, env.SESSION_SECRET);
      return new Response(null, { status: 302, headers: {
        Location: site + '/?login=' + encodeURIComponent(session),
        'Set-Cookie': 'oauth_state=; Path=/; Max-Age=0',
      } });
    }

    // Public: approved markers for the site to draw (edge-cached for 60s).
    if (request.method === 'GET' && url.pathname === '/markers') {
      const { results } = await env.DB.prepare(
        "SELECT id, zone, x, y, category, label, submitter, verified, created_at FROM submissions WHERE status='approved' ORDER BY created_at DESC"
      ).all();
      return json({ markers: results }, 200, origin, { 'Cache-Control': 'public, max-age=60' });
    }

    // Public: approved maps (optionally for one zone). Each gets a /map/img/<id> url.
    if (request.method === 'GET' && url.pathname === '/maps') {
      const zone = url.searchParams.get('zone');
      const stmt = zone
        ? env.DB.prepare("SELECT id, zone, label, width, height, submitter, created_at FROM maps WHERE status='approved' AND zone=? ORDER BY created_at ASC").bind(zone)
        : env.DB.prepare("SELECT id, zone, label, width, height, submitter, created_at FROM maps WHERE status='approved' ORDER BY zone, created_at ASC");
      const { results } = await stmt.all();
      const maps = (results || []).map((m) => ({ ...m, url: '/map/img/' + m.id }));
      return json({ maps }, 200, origin, { 'Cache-Control': 'public, max-age=60' });
    }

    // Public: serve a map image from R2 by id (bytes are immutable per id, so cache hard).
    const imgMatch = url.pathname.match(/^\/map\/img\/(\d+)$/);
    if (request.method === 'GET' && imgMatch) {
      const row = await env.DB.prepare('SELECT r2_key, mime FROM maps WHERE id=?').bind(parseInt(imgMatch[1], 10)).first();
      if (!row) return new Response('not found', { status: 404 });
      const obj = await env.MAPS_BUCKET.get(row.r2_key);
      if (!obj) return new Response('gone', { status: 404 });
      return new Response(obj.body, { headers: {
        'Content-Type': row.mime || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      } });
    }

    // Submit a map image -> R2 + a pending row. Signed-in (Discord) only — no anonymous
    // uploads. Trusted/admin auto-approve, like markers.
    if (request.method === 'POST' && url.pathname === '/map/submit') {
      if (!(request.headers.get('Content-Type') || '').includes('multipart/form-data')) return json({ error: 'expected multipart/form-data' }, 400, origin);
      const clen = parseInt(request.headers.get('Content-Length') || '0', 10);
      if (clen && clen > MAX_MAP_BYTES + 65536) return json({ error: 'file too large (max 10 MB)' }, 413, origin);
      let form; try { form = await request.formData(); } catch { return json({ error: 'bad form data' }, 400, origin); }
      const sess = await readSession(form.get('session'), env.SESSION_SECRET);
      if (!sess) return json({ error: 'sign in with Discord to submit a map' }, 401, origin);
      const zone = String(form.get('zone') || '').trim();
      if (!zone || zone.length > 60) return json({ error: 'zone required' }, 400, origin);
      const label = String(form.get('label') || '').trim().slice(0, 60);
      const width = parseInt(form.get('width'), 10) || null;
      const height = parseInt(form.get('height'), 10) || null;
      const file = form.get('image');
      if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ error: 'image required' }, 400, origin);
      if (file.size > MAX_MAP_BYTES) return json({ error: 'file too large (max 10 MB)' }, 413, origin);
      const buf = new Uint8Array(await file.arrayBuffer());
      const mime = sniffImage(buf);
      if (!mime) return json({ error: 'image must be JPG, PNG or WEBP' }, 400, origin);
      const pend = await env.DB.prepare("SELECT COUNT(*) AS n FROM maps WHERE discord_id=? AND status='pending'").bind(sess.id).first();
      if (pend && pend.n >= MAX_PENDING_MAPS) return json({ error: 'you already have several maps awaiting review' }, 429, origin);

      const key = 'maps/' + mapSlug(zone) + '/' + crypto.randomUUID() + '.' + MAP_TYPES[mime];
      await env.MAPS_BUCKET.put(key, buf, { httpMetadata: { contentType: mime } });

      let status = 'pending';
      if (await isAdminId(sess.id, env)) status = 'approved';
      else {
        const envTrusted = (env.TRUSTED_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (envTrusted.includes(sess.id) || (await env.DB.prepare('SELECT 1 FROM trusted WHERE discord_id=?').bind(sess.id).first())) status = 'approved';
      }
      const r = await env.DB.prepare(
        'INSERT INTO maps (zone, r2_key, label, mime, width, height, submitter, discord_id, status) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(zone, key, label || null, mime, width, height, sess.name.slice(0, 40), sess.id, status).run();
      return json({ ok: true, status, id: r.meta && r.meta.last_row_id }, 201, origin);
    }

    // Public: submit a marker -> lands in the pending queue.
    if (request.method === 'POST' && url.pathname === '/submit') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
      const zone = String(b.zone || '').trim();
      const category = String(b.category || '').trim();
      const label = String(b.label || '').trim();
      const x = Number(b.x), y = Number(b.y);
      if (!zone || zone.length > 60) return json({ error: 'zone required' }, 400, origin);
      if (!category || category.length > 30) return json({ error: 'category required' }, 400, origin);
      if (!label || label.length > MAX_LABEL) return json({ error: `label must be 1-${MAX_LABEL} chars` }, 400, origin);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return json({ error: 'x/y must be numbers' }, 400, origin);

      // A signed-in (Discord) user is verified: trust their name, skip the bot check + rate-limit.
      const sess = await readSession(b.session, env.SESSION_SECRET);
      const verified = sess ? 1 : 0;
      const discordId = sess ? sess.id : null;
      const submitter = sess ? sess.name.slice(0, 40) : (b.submitter ? String(b.submitter).trim().slice(0, 40) : null);

      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (!sess && !(await verifyTurnstile(b.turnstile, env.TURNSTILE_SECRET, ip))) {
        return json({ error: 'bot check failed' }, 403, origin);
      }
      const ipHash = ip ? await sha256(ip + '|mnmdb-salt') : null;
      if (!sess && ipHash) {
        const { results } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM submissions WHERE ip_hash=? AND created_at > datetime('now', ?)"
        ).bind(ipHash, `-${RATE_WINDOW_MIN} minutes`).all();
        if (results[0].n >= RATE_MAX) return json({ error: 'slow down — try again in a bit' }, 429, origin);
      }

      // Trusted users skip the queue entirely — either from the env seed list or the
      // self-service `trusted` table managed from the moderation page.
      let status = 'pending';
      if (sess) {
        const envTrusted = (env.TRUSTED_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (await isAdminId(sess.id, env) || envTrusted.includes(sess.id) || (await env.DB.prepare('SELECT 1 FROM trusted WHERE discord_id=?').bind(sess.id).first())) status = 'approved';
      }

      await env.DB.prepare(
        'INSERT INTO submissions (type, zone, x, y, category, label, submitter, ip_hash, verified, discord_id, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).bind('marker', zone, x, y, category, label, submitter, ipHash, verified, discordId, status).run();
      return json({ ok: true, status }, 201, origin);
    }

    // Edit / delete a single marker — admin, or the signed-in user who submitted it.
    if (request.method === 'POST' && (url.pathname === '/marker/edit' || url.pathname === '/marker/delete')) {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
      const id = parseInt(b.id, 10);
      if (!id) return json({ error: 'id required' }, 400, origin);
      const auth = await authorizeMarker(request, env, b, id);
      if (!auth.allowed) return json({ error: 'not allowed' }, 403, origin);
      if (url.pathname === '/marker/delete') {
        await env.DB.prepare('DELETE FROM submissions WHERE id=?').bind(id).run();
        return json({ ok: true }, 200, origin);
      }
      // Update any of: label, category, position (x,y). Each is optional so the map's
      // "drag to reposition" can send just {id, x, y} without touching label/category.
      const sets = [], binds = [];
      if (b.label !== undefined) {
        const label = String(b.label || '').trim();
        if (!label || label.length > MAX_LABEL) return json({ error: `label must be 1-${MAX_LABEL} chars` }, 400, origin);
        sets.push('label=?'); binds.push(label);
      }
      if (b.category !== undefined) {
        const category = String(b.category || '').trim();
        if (!category || category.length > 30) return json({ error: 'category required' }, 400, origin);
        sets.push('category=?'); binds.push(category);
      }
      if (b.x !== undefined && b.y !== undefined) {
        const x = Math.round(Number(b.x)), y = Math.round(Number(b.y));
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) return json({ error: 'bad coordinates' }, 400, origin);
        sets.push('x=?', 'y=?'); binds.push(x, y);
      }
      if (!sets.length) return json({ error: 'nothing to update' }, 400, origin);
      binds.push(id);
      await env.DB.prepare('UPDATE submissions SET ' + sets.join(', ') + ' WHERE id=?').bind(...binds).run();
      return json({ ok: true }, 200, origin);
    }

    // A signed-in user's own markers (any status), so they can manage them.
    if (request.method === 'POST' && url.pathname === '/my-markers') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
      const sess = await readSession(b.session, env.SESSION_SECRET);
      if (!sess) return json({ error: 'unauthorized' }, 401, origin);
      const { results } = await env.DB.prepare(
        'SELECT id, zone, x, y, category, label, status, created_at FROM submissions WHERE discord_id=? ORDER BY created_at DESC'
      ).bind(sess.id).all();
      return json({ markers: results }, 200, origin);
    }

    // A signed-in user's own powers, so the site can reveal admin tools to admins.
    if (request.method === 'POST' && url.pathname === '/me') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
      const sess = await readSession(b.session, env.SESSION_SECRET);
      if (!sess) return json({ error: 'unauthorized' }, 401, origin);
      const admin = await isAdminId(sess.id, env);
      const seedT = (env.TRUSTED_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const trusted = admin || seedT.includes(sess.id) || !!(await env.DB.prepare('SELECT 1 FROM trusted WHERE discord_id=?').bind(sess.id).first());
      return json({ id: sess.id, name: sess.name, admin, trusted }, 200, origin);
    }

    // Admin (moderation) — the ADMIN_TOKEN bearer (super-admin) OR a signed-in admin
    // (their session token sent as the bearer). Promote/demote below is super-only.
    if (url.pathname.startsWith('/admin/')) {
      const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const isSuper = !!env.ADMIN_TOKEN && bearer === env.ADMIN_TOKEN;
      let allowed = isSuper;
      if (!isSuper) { const s = await readSession(bearer, env.SESSION_SECRET); if (s && (await isAdminId(s.id, env))) allowed = true; }
      if (!allowed) return json({ error: 'unauthorized' }, 401, origin);

      if (request.method === 'GET' && url.pathname === '/admin/pending') {
        const { results } = await env.DB.prepare(
          "SELECT id, zone, x, y, category, label, submitter, verified, discord_id, created_at FROM submissions WHERE status='pending' ORDER BY created_at ASC"
        ).all();
        return json({ pending: results }, 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/markers') {
        const { results } = await env.DB.prepare(
          "SELECT id, zone, x, y, category, label, submitter, verified, discord_id, status, created_at FROM submissions WHERE status='approved' ORDER BY created_at DESC"
        ).all();
        return json({ markers: results }, 200, origin);
      }
      if (request.method === 'POST' && (url.pathname === '/admin/approve' || url.pathname === '/admin/reject')) {
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const id = parseInt(b.id, 10);
        if (!id) return json({ error: 'id required' }, 400, origin);
        const status = url.pathname.endsWith('approve') ? 'approved' : 'rejected';
        await env.DB.prepare("UPDATE submissions SET status=?, reviewed_at=datetime('now') WHERE id=?").bind(status, id).run();
        return json({ ok: true, id, status }, 200, origin);
      }

      // Self-service trusted-contributor list (managed from the moderation page).
      if (request.method === 'GET' && url.pathname === '/admin/trusted') {
        const { results } = await env.DB.prepare('SELECT discord_id, name, added_at FROM trusted ORDER BY added_at DESC').all();
        return json({ trusted: results }, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/admin/trust') {
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const did = String(b.discord_id || '').trim();
        if (!did) return json({ error: 'discord_id required' }, 400, origin);
        await env.DB.prepare("INSERT OR REPLACE INTO trusted (discord_id, name, added_at) VALUES (?,?,datetime('now'))").bind(did, String(b.name || '').slice(0, 60)).run();
        // trusting someone clears their existing pending backlog too
        await env.DB.prepare("UPDATE submissions SET status='approved', reviewed_at=datetime('now') WHERE discord_id=? AND status='pending'").bind(did).run();
        return json({ ok: true }, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/admin/untrust') {
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const did = String(b.discord_id || '').trim();
        if (did) await env.DB.prepare('DELETE FROM trusted WHERE discord_id=?').bind(did).run();
        return json({ ok: true }, 200, origin);
      }

      // Per-user admin list. Anyone with admin access can SEE it; only the super-admin
      // (ADMIN_TOKEN) may promote/demote, so an admin can't entrench or remove peers.
      if (request.method === 'GET' && url.pathname === '/admin/admins') {
        const { results } = await env.DB.prepare('SELECT discord_id, name, added_at FROM admins ORDER BY added_at DESC').all();
        return json({ admins: results, super: isSuper }, 200, origin);
      }
      if (request.method === 'POST' && (url.pathname === '/admin/promote' || url.pathname === '/admin/demote')) {
        if (!isSuper) return json({ error: 'super-admin only' }, 403, origin);
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const did = String(b.discord_id || '').trim();
        if (!did) return json({ error: 'discord_id required' }, 400, origin);
        if (url.pathname.endsWith('promote')) {
          await env.DB.prepare("INSERT OR REPLACE INTO admins (discord_id, name, added_at) VALUES (?,?,datetime('now'))").bind(did, String(b.name || '').slice(0, 60)).run();
          // a fresh admin's pending backlog (if any) clears too
          await env.DB.prepare("UPDATE submissions SET status='approved', reviewed_at=datetime('now') WHERE discord_id=? AND status='pending'").bind(did).run();
        } else {
          await env.DB.prepare('DELETE FROM admins WHERE discord_id=?').bind(did).run();
        }
        return json({ ok: true }, 200, origin);
      }

      // Map moderation (any admin). reject/delete both remove the row + the R2 object.
      if (request.method === 'GET' && url.pathname === '/admin/maps/pending') {
        const { results } = await env.DB.prepare("SELECT id, zone, label, width, height, submitter, discord_id, created_at FROM maps WHERE status='pending' ORDER BY created_at ASC").all();
        return json({ pending: (results || []).map((m) => ({ ...m, url: '/map/img/' + m.id })) }, 200, origin);
      }
      if (request.method === 'GET' && url.pathname === '/admin/maps') {
        const { results } = await env.DB.prepare("SELECT id, zone, label, width, height, submitter, discord_id, status, created_at FROM maps WHERE status='approved' ORDER BY zone, created_at ASC").all();
        return json({ maps: (results || []).map((m) => ({ ...m, url: '/map/img/' + m.id })) }, 200, origin);
      }
      if (request.method === 'POST' && url.pathname === '/admin/maps/approve') {
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const id = parseInt(b.id, 10); if (!id) return json({ error: 'id required' }, 400, origin);
        await env.DB.prepare("UPDATE maps SET status='approved', reviewed_at=datetime('now') WHERE id=?").bind(id).run();
        return json({ ok: true }, 200, origin);
      }
      if (request.method === 'POST' && (url.pathname === '/admin/maps/reject' || url.pathname === '/admin/maps/delete')) {
        let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, origin); }
        const id = parseInt(b.id, 10); if (!id) return json({ error: 'id required' }, 400, origin);
        const row = await env.DB.prepare('SELECT r2_key FROM maps WHERE id=?').bind(id).first();
        if (row) { try { await env.MAPS_BUCKET.delete(row.r2_key); } catch {} }
        await env.DB.prepare('DELETE FROM maps WHERE id=?').bind(id).run();
        return json({ ok: true }, 200, origin);
      }
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
