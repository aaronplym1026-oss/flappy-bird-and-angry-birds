'use strict';
/* A small, dependency-free PostgreSQL client: just enough for this game's
   server. Extended-query protocol only (every value is a bound parameter,
   never pasted into SQL text), SCRAM-SHA-256 / MD5 / cleartext auth, optional
   TLS, and a tiny connection pool. */
const net = require('net'), tls = require('tls'), crypto = require('crypto');

/* Forgive the usual copy/paste slips: spaces, quotes, a "DATABASE_URL=" prefix,
   or a missing slash after the scheme. */
function cleanUrl(raw) {
  let s = String(raw || '').trim().replace(/^DATABASE_URL\s*=\s*/i, '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/^postgres(ql)?:\/*/i, 'postgresql://');
  return s;
}
function parseUrl(raw) {
  const url = cleanUrl(raw);
  if (!/^postgresql:\/\//i.test(url)) {
    // Say what it looks like instead (only the part before the first ":", never the rest).
    const m = /^([A-Za-z][A-Za-z0-9+.\-_]{0,60}):/.exec(url);
    throw new Error('DATABASE_URL must start with postgresql:// (paste the Internal Database URL); the saved value is ' + url.length + ' characters' + (m ? ' and starts with "' + m[1] + ':"' : ''));
  }
  let u; try { u = new URL(url); } catch (e) { throw new Error('DATABASE_URL is not a valid connection string'); }
  if (!u.hostname) throw new Error('DATABASE_URL has no host name in it');
  const ssl = (u.searchParams.get('sslmode') || process.env.PGSSLMODE || (/\.render\.com$/.test(u.hostname) ? 'require' : 'disable')).toLowerCase();
  return {
    host: u.hostname, port: +u.port || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username), ssl: ssl !== 'disable' && ssl !== 'allow' ? ssl : null
  };
}

const TYPE = { 16: v => v === 't', 20: v => Number(v), 21: Number, 23: Number, 700: Number, 701: Number, 1700: Number, 114: JSON.parse, 3802: JSON.parse };

class PgError extends Error { constructor(fields) { super(fields.M || 'database error'); this.code = fields.C; this.detail = fields.D; this.fields = fields; } }

class Conn {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.dead = false; this.queue = Promise.resolve(); }

  async connect() {
    const cfg = this.cfg;
    let sock = await new Promise((res, rej) => { const s = net.connect(cfg.port, cfg.host, () => res(s)); s.once('error', rej); s.setTimeout(15000, () => s.destroy(new Error('connect timeout'))); });
    sock.setTimeout(0);
    if (cfg.ssl) {
      const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4); sock.write(req);
      const ans = await new Promise((res, rej) => { sock.once('data', d => res(d)); sock.once('error', rej); });
      if (ans[0] !== 0x53) throw new Error('server refused TLS');
      sock = await new Promise((res, rej) => {
        const t = tls.connect({ socket: sock, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.ssl === 'verify-full' || cfg.ssl === 'verify-ca' }, () => res(t));
        t.once('error', rej);
      });
    }
    this.sock = sock;
    sock.on('data', d => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.pump(); });
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new Error('connection closed')));
    // startup
    const params = Buffer.from('user\0' + cfg.user + '\0database\0' + cfg.database + '\0client_encoding\0UTF8\0\0', 'utf8');
    const start = Buffer.alloc(8 + params.length); start.writeInt32BE(start.length, 0); start.writeInt32BE(196608, 4); params.copy(start, 8);
    sock.write(start);
    let scram = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'R') {
        const kind = m.body.readInt32BE(0);
        if (kind === 0) continue;
        if (kind === 3) { this.send('p', Buffer.from(cfg.password + '\0', 'utf8')); continue; }
        if (kind === 5) {
          const md5 = s => crypto.createHash('md5').update(s).digest('hex');
          const inner = md5(cfg.password + cfg.user), salt = m.body.subarray(4, 8);
          this.send('p', Buffer.concat([Buffer.from('md5' + md5(Buffer.concat([Buffer.from(inner), salt])) + '\0')])); continue;
        }
        if (kind === 10) {
          const mechs = m.body.subarray(4).toString('utf8').split('\0');
          if (!mechs.includes('SCRAM-SHA-256')) throw new Error('no supported SASL mechanism');
          const nonce = crypto.randomBytes(18).toString('base64'), first = 'n=,r=' + nonce, msg = Buffer.from('n,,' + first, 'utf8');
          const mech = Buffer.from('SCRAM-SHA-256\0', 'utf8'), len = Buffer.alloc(4); len.writeInt32BE(msg.length, 0);
          this.send('p', Buffer.concat([mech, len, msg])); scram = { nonce, first }; continue;
        }
        if (kind === 11) {
          const sf = m.body.subarray(4).toString('utf8'), at = Object.fromEntries(sf.split(',').map(p => [p[0], p.slice(2)]));
          if (!at.r || !at.r.startsWith(scram.nonce)) throw new Error('bad SCRAM nonce');
          const salted = crypto.pbkdf2Sync(cfg.password.normalize('NFKC'), Buffer.from(at.s, 'base64'), +at.i, 32, 'sha256');
          const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
          const clientKey = hmac(salted, 'Client Key'), storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const without = 'c=biws,r=' + at.r, auth = scram.first + ',' + sf + ',' + without;
          const sig = hmac(storedKey, auth), proof = Buffer.alloc(clientKey.length); for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i] ^ sig[i];
          scram.expect = hmac(hmac(salted, 'Server Key'), auth).toString('base64');
          this.send('p', Buffer.from(without + ',p=' + proof.toString('base64'), 'utf8')); continue;
        }
        if (kind === 12) { const v = m.body.subarray(4).toString('utf8'); if (!scram || v !== 'v=' + scram.expect) throw new Error('server signature mismatch'); continue; }
        throw new Error('unsupported auth method ' + kind);
      }
      if (m.type === 'E') throw new PgError(fields(m.body));
      if (m.type === 'Z') break;
    }
    return this;
  }

  send(type, body) { const h = Buffer.alloc(5); h.write(type, 0, 'latin1'); h.writeInt32BE(body.length + 4, 1); this.sock.write(Buffer.concat([h, body])); }
  pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1); if (this.buf.length < len + 1) break;
      const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) }; this.buf = this.buf.subarray(len + 1);
      if (msg.type === 'N' || msg.type === 'S' || msg.type === 'K' || msg.type === 'A') continue;
      const w = this.waiters.shift(); if (w) w.res(msg); else (this.early || (this.early = [])).push(msg);
    }
  }
  next() { if (this.early && this.early.length) return Promise.resolve(this.early.shift()); if (this.dead) return Promise.reject(this.dead); return new Promise((res, rej) => this.waiters.push({ res, rej })); }
  fail(e) { if (this.dead) return; this.dead = e; for (const w of this.waiters.splice(0)) w.rej(e); try { this.sock && this.sock.destroy(); } catch (x) { } }

  query(text, values) { const run = () => this.run(text, values || []); const p = this.queue.then(run, run); this.queue = p.catch(() => { }); return p; }
  async run(text, values) {
    if (this.dead) throw this.dead;
    const cstr = s => Buffer.from(s + '\0', 'utf8');
    const parse = Buffer.concat([cstr(''), cstr(text), Buffer.from([0, 0])]);
    const parts = [cstr(''), cstr(''), Buffer.from([0, 0]), int16(values.length)];
    for (const v of values) {
      if (v === null || v === undefined) parts.push(int32(-1));
      else { const s = Buffer.from(typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v), 'utf8'); parts.push(int32(s.length), s); }
    }
    parts.push(int16(0));
    this.send('P', parse); this.send('B', Buffer.concat(parts)); this.send('D', Buffer.from('P\0', 'latin1')); this.send('E', Buffer.concat([cstr(''), int32(0)])); this.send('S', Buffer.alloc(0));
    let cols = null, err = null; const rows = []; let count = 0;
    for (;;) {
      const m = await this.next();
      if (m.type === 'T') { cols = []; const n = m.body.readInt16BE(0); let o = 2; for (let i = 0; i < n; i++) { const e = m.body.indexOf(0, o); const name = m.body.toString('utf8', o, e); o = e + 1; const oid = m.body.readInt32BE(o + 6); o += 18; cols.push({ name, oid }); } }
      else if (m.type === 'D') { const n = m.body.readInt16BE(0); let o = 2; const row = {}; for (let i = 0; i < n; i++) { const l = m.body.readInt32BE(o); o += 4; let v = null; if (l >= 0) { v = m.body.toString('utf8', o, o + l); o += l; const c = cols[i], f = TYPE[c.oid]; if (f) v = f(v); } row[cols[i].name] = v; } rows.push(row); }
      else if (m.type === 'C') { const t = m.body.toString('utf8', 0, m.body.length - 1).split(' '); count = +t[t.length - 1] || 0; }
      else if (m.type === 'E') err = new PgError(fields(m.body));
      else if (m.type === 'Z') break;
    }
    if (err) throw err;
    return { rows, rowCount: count };
  }
  end() { try { this.send('X', Buffer.alloc(0)); } catch (e) { } this.fail(new Error('closed')); }
}
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }
function fields(body) { const f = {}; let o = 0; while (o < body.length && body[o] !== 0) { const k = String.fromCharCode(body[o]); const e = body.indexOf(0, o + 1); f[k] = body.toString('utf8', o + 1, e); o = e + 1; } return f; }

class PgPool {
  constructor(url, opts) { this.cfg = parseUrl(url); this.max = (opts && opts.max) || 4; this.idle = []; this.count = 0; this.waiting = []; }
  async acquire() {
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.count--; }
    if (this.count < this.max) { this.count++; try { return await new Conn(this.cfg).connect(); } catch (e) { this.count--; throw e; } }
    return new Promise(res => this.waiting.push(res));
  }
  release(c) { if (c.dead) { this.count--; const w = this.waiting.shift(); if (w) this.acquire().then(w, () => w(null)); return; } const w = this.waiting.shift(); if (w) w(c); else this.idle.push(c); }
  async query(text, values) {
    let c = await this.acquire(); if (!c) c = await this.acquire();
    try { return await c.query(text, values); }
    catch (e) { if (!(e instanceof PgError)) c.fail(e); throw e; }
    finally { this.release(c); }
  }
  async end() { for (const c of this.idle.splice(0)) c.end(); }
}
/* Where a URL points, for logs. Never includes the password. */
function describeUrl(raw) {
  const c = parseUrl(raw);
  return 'host=' + c.host + ' port=' + c.port + ' db=' + c.database + ' user=' + c.user + ' ssl=' + (c.ssl || 'off') + ' password=' + (c.password ? 'set' : 'MISSING');
}
module.exports = { PgPool, PgError, describeUrl };
