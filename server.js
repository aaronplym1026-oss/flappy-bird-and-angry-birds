'use strict';
/* Monster Pop TD server: serves the game and keeps player accounts + saves.
   No npm dependencies: Node's own http, crypto and zlib, plus pg-lite.js.
   Env: DATABASE_URL (required), PORT (Render sets it). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { PgPool } = require('./pg-lite');

const PORT = +process.env.PORT || 3000;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const db = new PgPool(process.env.DATABASE_URL, { max: 5 });

const SESSION_DAYS = 60, MAX_SAVE = 600 * 1024, MAX_BODY = 700 * 1024;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;

/* ---------------- database ---------------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, recovery_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS saves (user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, ts BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
];
async function migrate() {
  for (let i = 0; ; i++) {
    try { for (const s of SCHEMA) await db.query(s); return; }
    catch (e) { if (i >= 30) throw e; console.log('database not ready (' + e.message + '), retrying'); await new Promise(r => setTimeout(r, 2000)); }
  }
}

/* ---------------- passwords + tokens ---------------- */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(pw, salt) { return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => e ? rej(e) : res(k))); }
async function hashSecret(pw) { const salt = crypto.randomBytes(16); const k = await scrypt(pw, salt); return 'scrypt$' + salt.toString('base64') + '$' + k.toString('base64'); }
async function checkSecret(pw, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) { await scrypt(pw, 'x'); return false; }
  const k = await scrypt(pw, Buffer.from(s, 'base64')), want = Buffer.from(h, 'base64');
  return k.length === want.length && crypto.timingSafeEqual(k, want);
}
const DUMMY = 'scrypt$' + crypto.randomBytes(16).toString('base64') + '$' + crypto.randomBytes(64).toString('base64');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const RC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function recoveryCode() { const b = crypto.randomBytes(16); let s = ''; for (let i = 0; i < 16; i++) s += RC[b[i] % RC.length]; return s.match(/.{4}/g).join('-'); }
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------------- rate limits (per process) ---------------- */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  if (a.length >= max) { hits.set(key, a); return true; }
  a.push(now); hits.set(key, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();

/* ---------------- http helpers ---------------- */
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
function baseHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}
function json(res, code, obj, extra) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' }, extra || {}));
  res.end(b);
}
const fail = (res, code, msg) => json(res, code, { error: msg });
function readBody(req) {
  return new Promise((res, rej) => {
    let n = 0, over = false; const parts = [];
    req.on('data', c => { n += c.length; if (over) return; if (n > MAX_BODY) { over = true; parts.length = 0; rej(Object.assign(new Error('too big'), { status: 413 })); } else parts.push(c); });
    req.on('end', () => { if (over) return; try { res(n ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { rej(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', rej);
  });
}
function cookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function sessionCookie(req, token, maxAge) { return 'mptd_sid=' + (token || '') + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (isHttps(req) ? '; Secure' : ''); }
/* state-changing calls must come from our own page: a custom header (forces a
   CORS preflight we never answer), JSON, and a matching Origin when sent */
function sameSite(req) {
  if (req.headers['x-mptd'] !== '1') return false;
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return false;
  const o = req.headers.origin; if (o) { try { if (new URL(o).host !== req.headers.host) return false; } catch (e) { return false; } }
  return true;
}

async function currentUser(req) {
  const t = cookies(req).mptd_sid; if (!t || t.length > 100) return null;
  const r = await db.query('SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [sha(t)]);
  if (!r.rows.length) return null;
  const u = r.rows[0];
  if (new Date(u.expires_at) - Date.now() < (SESSION_DAYS - 7) * 864e5) await db.query("UPDATE sessions SET expires_at = now() + interval '" + SESSION_DAYS + " days' WHERE token_hash = $1", [sha(t)]);
  return { id: u.id, name: u.username, token: t };
}
async function startSession(req, userId) {
  const t = crypto.randomBytes(32).toString('base64url');
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '" + SESSION_DAYS + " days')", [sha(t), userId]);
  return { 'Set-Cookie': sessionCookie(req, t, SESSION_DAYS * 86400) };
}

/* ---------------- api ---------------- */
async function api(req, res, route) {
  const m = req.method, ip = ipOf(req);
  if (m !== 'GET' && !sameSite(req)) return fail(res, 403, 'Blocked.');
  if (route === 'me' && m === 'GET') { const u = await currentUser(req); return json(res, 200, { user: u ? { name: u.name } : null }); }

  if (route === 'signup' && m === 'POST') {
    if (limited('su:' + ip, 10, 3600e3)) return fail(res, 429, 'Too many new accounts from here. Try later.');
    const b = await readBody(req), name = String(b.username || '').trim(), pw = String(b.password || '');
    if (!USER_RE.test(name)) return fail(res, 400, 'Usernames are 3-20 letters, numbers or _.');
    if (pw.length < 8 || pw.length > 100) return fail(res, 400, 'Passwords need at least 8 characters.');
    const code = recoveryCode();
    const [ph, rh] = await Promise.all([hashSecret(pw), hashSecret(normCode(code))]);
    let r;
    try { r = await db.query('INSERT INTO users (username, username_lc, pass_hash, recovery_hash) VALUES ($1, $2, $3, $4) RETURNING id', [name, name.toLowerCase(), ph, rh]); }
    catch (e) { if (e.code === '23505') return fail(res, 409, 'That username is taken.'); throw e; }
    return json(res, 200, { user: { name }, recovery: code }, await startSession(req, r.rows[0].id));
  }

  if (route === 'login' && m === 'POST') {
    const b = await readBody(req), name = String(b.username || '').trim(), pw = String(b.password || '');
    if (limited('li:' + ip, 30, 600e3) || limited('lu:' + name.toLowerCase(), 10, 900e3)) return fail(res, 429, 'Too many tries. Wait a few minutes.');
    const r = await db.query('SELECT id, username, pass_hash FROM users WHERE username_lc = $1', [name.toLowerCase()]);
    const ok = await checkSecret(pw, r.rows.length ? r.rows[0].pass_hash : DUMMY);
    if (!r.rows.length || !ok) return fail(res, 401, 'Wrong username or password.');
    return json(res, 200, { user: { name: r.rows[0].username } }, await startSession(req, r.rows[0].id));
  }

  if (route === 'logout' && m === 'POST') {
    const t = cookies(req).mptd_sid; if (t) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(t)]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (route === 'reset' && m === 'POST') {
    const b = await readBody(req), name = String(b.username || '').trim(), pw = String(b.password || ''), code = normCode(b.code);
    if (limited('ri:' + ip, 20, 900e3) || limited('ru:' + name.toLowerCase(), 6, 900e3)) return fail(res, 429, 'Too many tries. Wait a few minutes.');
    if (pw.length < 8 || pw.length > 100) return fail(res, 400, 'Passwords need at least 8 characters.');
    const r = await db.query('SELECT id, username, recovery_hash FROM users WHERE username_lc = $1', [name.toLowerCase()]);
    const ok = await checkSecret(code, r.rows.length ? r.rows[0].recovery_hash : DUMMY);
    if (!r.rows.length || !ok) return fail(res, 401, 'That username and recovery code do not match.');
    const fresh = recoveryCode(), [ph, rh] = await Promise.all([hashSecret(pw), hashSecret(normCode(fresh))]);
    await db.query('UPDATE users SET pass_hash = $1, recovery_hash = $2 WHERE id = $3', [ph, rh, r.rows[0].id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
    return json(res, 200, { user: { name: r.rows[0].username }, recovery: fresh }, await startSession(req, r.rows[0].id));
  }

  const u = await currentUser(req);
  if (!u) return fail(res, 401, 'Please log in.');

  if (route === 'save' && m === 'GET') {
    const r = await db.query('SELECT data, ts FROM saves WHERE user_id = $1', [u.id]);
    return json(res, 200, r.rows.length ? { data: JSON.parse(r.rows[0].data), ts: r.rows[0].ts } : { data: null, ts: 0 });
  }
  if (route === 'save' && m === 'PUT') {
    if (limited('sv:' + u.id, 40, 60e3)) return fail(res, 429, 'Saving too fast.');
    const b = await readBody(req), inc = b && b.data;
    if (!inc || typeof inc !== 'object') return fail(res, 400, 'Nothing to save.');
    /* merge into what is stored: the profile with the newer stamp wins (so a
       stale device can't roll back progress), the saved game is last-writer,
       best rounds keep the higher value per map */
    const cur = await db.query('SELECT data FROM saves WHERE user_id = $1', [u.id]);
    let d = {}; try { d = cur.rows.length ? JSON.parse(cur.rows[0].data) || {} : {}; } catch (e) { d = {}; }
    let newer = null;
    if (inc.profile && typeof inc.profile === 'object') { if (!d.profile || (+inc.profile.ts || 0) >= (+d.profile.ts || 0)) d.profile = inc.profile; else newer = d.profile; }
    if ('game' in inc) d.game = inc.game && typeof inc.game === 'object' ? inc.game : null;
    if (inc.best && typeof inc.best === 'object') { const best = d.best && typeof d.best === 'object' ? d.best : {}; for (const k of Object.keys(inc.best).slice(0, 200)) { const v = +inc.best[k] || 0; if (v > (+best[k] || 0)) best[k] = v; } d.best = best; }
    const s = JSON.stringify(d); if (s.length > MAX_SAVE) return fail(res, 413, 'Save is too big.');
    const ts = Date.now();
    await db.query('INSERT INTO saves (user_id, data, ts, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, ts = EXCLUDED.ts, updated_at = now()', [u.id, s, ts]);
    return json(res, 200, newer ? { ok: true, ts, profile: newer } : { ok: true, ts });
  }
  if (route === 'delete' && m === 'POST') {
    const b = await readBody(req);
    if (limited('dl:' + u.id, 6, 900e3)) return fail(res, 429, 'Too many tries. Wait a few minutes.');
    const r = await db.query('SELECT pass_hash FROM users WHERE id = $1', [u.id]);
    if (!r.rows.length || !await checkSecret(String(b.password || ''), r.rows[0].pass_hash)) return fail(res, 401, 'Wrong password.');
    await db.query('DELETE FROM users WHERE id = $1', [u.id]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  return fail(res, 404, 'Not found.');
}

/* ---------------- static game page ---------------- */
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html')), PAGE_GZ = zlib.gzipSync(PAGE, { level: 9 }), PAGE_TAG = '"' + sha(PAGE).slice(0, 16) + '"';
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
function page(req, res) {
  if (req.headers['if-none-match'] === PAGE_TAG) { res.writeHead(304, { ETag: PAGE_TAG }); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || ''), body = gz ? PAGE_GZ : PAGE;
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', ETag: PAGE_TAG, 'Content-Security-Policy': CSP, Vary: 'Accept-Encoding' }, gz ? { 'Content-Encoding': 'gzip' } : {}));
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  baseHeaders(req, res);
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) return await api(req, res, url.slice(5));
    if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/' || url === '/index.html')) return page(req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    if (e.status) return fail(res, e.status, e.status === 413 ? 'Too big.' : 'Bad request.');
    console.error(e); if (!res.headersSent) fail(res, 500, 'Something went wrong. Try again.'); else res.end();
  }
});
server.headersTimeout = 20000; server.requestTimeout = 30000;

migrate().then(() => {
  setInterval(() => db.query('DELETE FROM sessions WHERE expires_at < now()').catch(e => console.error(e)), 3600e3).unref();
  server.listen(PORT, () => console.log('Monster Pop TD listening on ' + PORT));
}).catch(e => { console.error('could not set up the database', e); process.exit(1); });
