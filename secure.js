'use strict';
/* Cryptography + encrypted SQLite store (zero dependencies: node:crypto, node:sqlite). */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/* ---------- keys ---------- */
function loadMaster(keyFile) {
  const env = process.env.QC_MASTER_KEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error('QC_MASTER_KEY must be 64 hex characters (32 bytes)');
    return Buffer.from(env, 'hex');
  }
  if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, k.toString('hex') + '\n', { mode: 0o600 });
  console.warn('[security] Generated a new master key at ' + keyFile + '. Back it up and keep it AWAY from the database file.');
  return k;
}
function hkdf(master, label) { return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'quiet-coffee/' + label, 32)); }

class Vault {
  constructor(master) {
    this.kEnc = hkdf(master, 'enc');
    this.kIdx = hkdf(master, 'index');
    this.kTok = hkdf(master, 'token');
  }
  /* AES-256-GCM, record bound to its location through AAD */
  seal(obj, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.kEnc, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  }
  open(buf, aad) {
    buf = Buffer.from(buf);
    if (buf[0] !== 1) throw new Error('bad record version');
    const d = crypto.createDecipheriv('aes-256-gcm', this.kEnc, buf.subarray(1, 13));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(buf.subarray(13, 29));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(29)), d.final()]).toString('utf8'));
  }
  /* blind index: lets us find a user by phone without storing the phone in the clear */
  idx(value) { return crypto.createHmac('sha256', this.kIdx).update(String(value)).digest('hex').slice(0, 32); }
  tok(value) { return crypto.createHmac('sha256', this.kTok).update(String(value)).digest('hex'); }
}

/* ---------- store ---------- */
class Store {
  constructor(file, vault) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.v = vault;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs(
      coll TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(coll,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS docs_upd ON docs(coll,updated);`);
    try { fs.chmodSync(file, 0o600); } catch (e) { /* ignore */ }
    this._get = this.db.prepare('SELECT data FROM docs WHERE coll=? AND id=?');
    this._put = this.db.prepare('INSERT INTO docs(coll,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data,updated=excluded.updated');
    this._del = this.db.prepare('DELETE FROM docs WHERE coll=? AND id=?');
    this._all = this.db.prepare('SELECT id,data FROM docs WHERE coll=? ORDER BY id');
    this._last = this.db.prepare('SELECT id,data FROM docs WHERE coll=? ORDER BY id DESC LIMIT ?');
    this._count = this.db.prepare('SELECT COUNT(*) n FROM docs WHERE coll=?');
    this._purge = this.db.prepare('DELETE FROM docs WHERE coll=? AND updated<?');
  }
  get(coll, id) { const r = this._get.get(coll, id); return r ? this.v.open(r.data, coll + ':' + id) : null; }
  put(coll, id, obj) { this._put.run(coll, id, this.v.seal(obj, coll + ':' + id), Date.now()); return obj; }
  del(coll, id) { this._del.run(coll, id); }
  all(coll) { return this._all.all(coll).map(r => ({ id: r.id, doc: this.v.open(r.data, coll + ':' + r.id) })); }
  last(coll, n) { return this._last.all(coll, n).map(r => ({ id: r.id, doc: this.v.open(r.data, coll + ':' + r.id) })); }
  count(coll) { return this._count.get(coll).n; }
  purge(coll, olderThan) { this._purge.run(coll, olderThan); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch (x) { /* ignore */ } throw e; }
  }
  close() { this.db.close(); }
}

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32dec(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; bits += i.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totpAt(secret, step) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(b).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
/* returns the matched step or -1; accepts ±1 step of clock drift */
function totpCheck(secret, code, now) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return -1;
  const cur = Math.floor((now || Date.now()) / 30000);
  for (let d = -1; d <= 1; d++) {
    const s = cur + d;
    const a = Buffer.from(totpAt(secret, s)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return -1;
}
function newTotpSecret() { return b32enc(crypto.randomBytes(20)); }

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { loadMaster, Vault, Store, totpCheck, totpAt, newTotpSecret, safeEq, b32enc };
