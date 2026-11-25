'use strict';
/* Abuse protection: rate limits, suspicion scoring, automatic freezes, IP-hopping detection.
   Tuned so that a normal person (even switching Wi-Fi <-> mobile data) never notices it. */
const net = require('node:net');

const HOUR = 36e5;
const CFG = {
  ipPerMin: +process.env.QC_IP_PER_MIN || 240,        // API requests per IP per minute
  userBurst10s: +process.env.QC_USER_BURST || 80,      // requests per account per 10 s
  userThreshold: 40,                                    // score that freezes an account
  ipThreshold: 80,                                      // score that blocks an IP
  decayPerSec: 0.1,                                     // 1 point every 10 s
  hopGroupsFreeze: 4,                                   // distinct networks within hopWindow
  hopWindow: 10 * 60e3,
  levels: [1 * HOUR, 6 * HOUR, 24 * HOUR],              // freeze length escalates with repeats
  levelWindow: 7 * 24 * HOUR
};

function expandV6(ip) {
  let [h, t] = ip.split('::');
  const a = h ? h.split(':') : [], b = t ? t.split(':') : [];
  while (a.length + b.length < 8) a.push('0');
  return a.concat(b).map(x => x.padStart(4, '0'));
}
function netGroup(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) return ip.split('.').slice(0, 3).join('.');
  if (net.isIPv6(ip)) return expandV6(ip).slice(0, 3).join(':');
  return ip || 'unknown';
}
function maskIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) { const p = ip.split('.'); return p[0] + '.' + p[1] + '.*.*'; }
  if (net.isIPv6(ip)) return expandV6(ip).slice(0, 2).join(':') + ':*';
  return '?';
}

class Guard {
  constructor(store, vault, audit) {
    this.store = store; this.v = vault; this.audit = audit;
    this.buckets = new Map();   // key -> {n, reset}
    this.scores = new Map();    // subject -> {s, t}
    this.hops = new Map();      // sid -> [{g, t}]
    this.frozen = new Map();    // subject -> freeze doc
    for (const r of store.all('freeze')) if (r.doc.until > Date.now()) this.frozen.set(r.id, r.doc);
    setInterval(() => this.sweep(), 60e3).unref();
  }

  /* ---- fixed-window counters ---- */
  hit(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.n++;
    return b.n <= limit;
  }
  peek(key) { const b = this.buckets.get(key); return b && b.reset > Date.now() ? b.n : 0; }

  /* ---- suspicion score ---- */
  score(subject, pts, reason, opts) {
    const now = Date.now();
    let e = this.scores.get(subject) || { s: 0, t: now };
    e.s = Math.max(0, e.s - (now - e.t) / 1000 * CFG.decayPerSec) + pts;
    e.t = now; e.reason = reason;
    this.scores.set(subject, e);
    const th = subject.startsWith('ip:') ? CFG.ipThreshold : CFG.userThreshold;
    if (e.s >= th && !(opts && opts.noFreeze)) { this.freeze(subject, reason); e.s = 0; return true; }
    return false;
  }

  /* ---- freezes ---- */
  freeze(subject, reason, ms) {
    const now = Date.now();
    const old = this.store.get('freeze', subject) || { history: [] };
    const recent = (old.history || []).filter(h => now - h.ts < CFG.levelWindow).length;
    const len = ms || CFG.levels[Math.min(recent, CFG.levels.length - 1)];
    const doc = { subject, until: now + len, reason, since: now, level: recent + 1, history: (old.history || []).concat([{ ts: now, reason }]).slice(-20) };
    this.store.put('freeze', subject, doc);
    this.frozen.set(subject, doc);
    this.audit('security', 'Заморозка ' + (subject.startsWith('ip:') ? 'IP' : 'аккаунта') + ' на ' + Math.round(len / 60000) + ' мин: ' + reason, { subject });
    return doc;
  }
  state(subject) {
    const f = this.frozen.get(subject);
    if (!f) return null;
    if (f.until <= Date.now()) { this.frozen.delete(subject); return null; }
    return f;
  }
  unfreeze(subject, by) {
    const had = this.frozen.get(subject) || this.store.get('freeze', subject);
    this.frozen.delete(subject);
    this.store.del('freeze', subject);
    this.scores.delete(subject);
    if (had) this.audit('security', 'Разморозка (' + (by || 'система') + ')', { subject });
    return !!had;
  }
  list() { const now = Date.now(); return [...this.frozen.values()].filter(f => f.until > now); }

  /* ---- IP hopping: how many different networks did one session use recently ---- */
  noteNet(sid, ip) {
    const now = Date.now(), g = netGroup(ip);
    let a = (this.hops.get(sid) || []).filter(x => now - x.t < CFG.hopWindow);
    const ex = a.find(x => x.g === g);
    if (ex) ex.t = now; else a.push({ g, t: now });
    this.hops.set(sid, a);
    return a.length;
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
    for (const [k, e] of this.scores) if (e.s - (now - e.t) / 1000 * CFG.decayPerSec <= 0) this.scores.delete(k);
    for (const [k, a] of this.hops) { const f = a.filter(x => now - x.t < CFG.hopWindow); if (f.length) this.hops.set(k, f); else this.hops.delete(k); }
    for (const [k, f] of this.frozen) if (f.until <= now) this.frozen.delete(k);
    if (this.buckets.size > 200000) this.buckets.clear();   // memory guard under flood
  }
}

module.exports = { Guard, CFG, netGroup, maskIp };
