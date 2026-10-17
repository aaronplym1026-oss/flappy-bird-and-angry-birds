'use strict';
/* Monster Pop TD server: serves the game and keeps player accounts + saves.
   No npm dependencies: Node's own http, crypto and zlib, plus pg-lite.js.
   Env: DATABASE_URL (needed for accounts), PORT (Render sets it).
   Without a working database the game is still served, but accounts are
   offline (the API answers 503) until the database can be reached. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { PgPool, describeUrl } = require('./pg-lite');

const PORT = +process.env.PORT || 3000;
let db = null, dbReady = false;
if (process.env.DATABASE_URL) {
  try { console.log('database: ' + describeUrl(process.env.DATABASE_URL)); db = new PgPool(process.env.DATABASE_URL, { max: 5 }); }
  catch (e) { console.error('DATABASE_URL problem: ' + e.message + '. Accounts are offline until it is fixed.'); }
}
const errText = e => e.message || e.code || (e.errors && e.errors.map(x => x.message).join('; ')) || String(e);

const SESSION_DAYS = 60, MAX_SAVE = 600 * 1024, MAX_BODY = 700 * 1024;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;

/* ---------------- database ---------------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, recovery_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS saves (user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, ts BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
];
/* Keeps trying (backing off to once a minute) so a database that is briefly
   down, or still being set up, never takes the game offline. */
async function migrate() {
  for (let i = 0; ; i++) {
    try { for (const s of SCHEMA) await db.query(s); dbReady = true; console.log('database ready, accounts are online'); return; }
    catch (e) { console.log('database not ready (' + errText(e) + '), retrying'); await new Promise(r => setTimeout(r, Math.min(60000, 2000 * (i + 1)))); }
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

/* ---------------- static files: the game page and its app files ---------------- */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
function asset(file, type, cache, extra, edit) {
  let body = fs.readFileSync(path.join(__dirname, 'public', file)); if (edit) body = Buffer.from(edit(body.toString('utf8')));
  const zip = /^(text|application)\//.test(type), gz = zip ? zlib.gzipSync(body, { level: 9 }) : null;
  return { body, gz, type, cache, extra: extra || {}, tag: '"' + sha(body).slice(0, 16) + '"' };
}
const PAGE = asset('index.html', 'text/html; charset=utf-8', 'no-cache', { 'Content-Security-Policy': CSP });
const BUILD = PAGE.tag.slice(1, 13);
const ICON = f => asset('icons/' + f, 'image/png', 'public, max-age=604800');
const FILES = {
  '/': PAGE, '/index.html': PAGE,
  '/manifest.webmanifest': asset('manifest.webmanifest', 'application/manifest+json', 'public, max-age=3600'),
  '/sw.js': asset('sw.js', 'text/javascript; charset=utf-8', 'no-cache', null, s => s.replace('__BUILD__', BUILD)),
  '/icons/icon-192.png': ICON('icon-192.png'), '/icons/icon-512.png': ICON('icon-512.png'), '/icons/maskable-512.png': ICON('maskable-512.png'),
  '/icons/apple-touch-icon.png': ICON('apple-touch-icon.png'), '/apple-touch-icon.png': ICON('apple-touch-icon.png'),
  '/icons/favicon-32.png': ICON('favicon-32.png'), '/favicon.ico': ICON('favicon-32.png')
};
function sendAsset(req, res, a) {
  if (req.headers['if-none-match'] === a.tag) { res.writeHead(304, { ETag: a.tag, 'Cache-Control': a.cache }); return res.end(); }
  const gz = a.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || ''), body = gz ? a.gz : a.body;
  res.writeHead(200, Object.assign({ 'Content-Type': a.type, 'Content-Length': body.length, 'Cache-Control': a.cache, ETag: a.tag }, a.gz ? { Vary: 'Accept-Encoding' } : {}, gz ? { 'Content-Encoding': 'gzip' } : {}, a.extra));
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  baseHeaders(req, res);
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) return dbReady ? await api(req, res, url.slice(5)) : fail(res, 503, 'Accounts are offline right now.');
    if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if ((req.method === 'GET' || req.method === 'HEAD') && Object.prototype.hasOwnProperty.call(FILES, url)) return sendAsset(req, res, FILES[url]);
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    if (e.status) return fail(res, e.status, e.status === 413 ? 'Too big.' : 'Bad request.');
    console.error(e); if (!res.headersSent) fail(res, 500, 'Something went wrong. Try again.'); else res.end();
  }
});
server.headersTimeout = 20000; server.requestTimeout = 30000;

server.listen(PORT, () => console.log('Monster Pop TD listening on ' + PORT + (db ? '' : ' (no database, accounts offline)')));
if (db) migrate().then(() => {
  setInterval(() => db.query('DELETE FROM sessions WHERE expires_at < now()').catch(e => console.error(errText(e))), 3600e3).unref();
});
