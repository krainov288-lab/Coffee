'use strict';
/* Pure business rules: pricing, loyalty, validation, seed data. The server is the only authority for them. */

class HttpError extends Error {
  constructor(status, code, msg, extra) { super(msg || code); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (what) => new HttpError(400, 'invalid', 'Некорректные данные: ' + what);

/* ---------- small validators ---------- */
const str = (v, min, max, what) => {
  if (typeof v !== 'string') throw bad(what || 'text');
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length < min || s.length > max) throw bad(what || 'text length');
  return s;
};
const int = (v, min, max, what) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw bad(what || 'number');
  return n;
};
const bool = (v) => !!v;
const oneOf = (v, list, what) => { if (!list.includes(v)) throw bad(what || 'choice'); return v; };

/* ---------- drink options (must match the client) ---------- */
const SZ = [{ id: 'S', d: -30 }, { id: 'M', d: 0 }, { id: 'L', d: 40 }];
const SZ_ESP = [{ id: 'S', d: 0 }, { id: 'M', d: 60 }];
const SZ_L = { S: 'S', M: 'M', L: 'L' };
const OPT = {
  temp: [{ id: 'hot', l: 'Горячее' }, { id: 'warm', l: 'Тёплое' }],
  ice: [{ id: 'ice', l: 'Много льда' }, { id: 'less', l: 'Меньше льда' }, { id: 'none', l: 'Без льда' }],
  strength: [{ id: 'soft', l: 'Мягче' }, { id: 'classic', l: 'Классика' }, { id: 'strong', l: 'Крепче', d: 60 }],
  balance: [{ id: 'coffee', l: 'Больше кофе' }, { id: 'classic', l: 'Поровну' }, { id: 'milk', l: 'Больше молока' }],
  milk: [{ id: 'std', l: 'Обычное' }, { id: 'oat', l: 'Овсяное', d: 30 }, { id: 'alm', l: 'Миндальное', d: 40 }, { id: 'lf', l: 'Безлактозное', d: 20 }],
  texture: [{ id: 'light', l: 'Лёгкая пена' }, { id: 'thick', l: 'Густое, сливочное' }, { id: 'nofoam', l: 'Без пены' }],
  syrup: [{ id: 'none', l: 'Без сиропа' }, { id: 'vanilla', l: 'Ваниль', d: 25 }, { id: 'caramel', l: 'Карамель', d: 25 }, { id: 'hazel', l: 'Фундук', d: 25 }, { id: 'coconut', l: 'Кокос', d: 25 }],
  topping: [{ id: 'none', l: 'Без присыпки' }, { id: 'cinnamon', l: 'Корица' }, { id: 'choco', l: 'Шоколадная присыпка' }, { id: 'cocoa', l: 'Какао' }],
  sugar: [{ id: 0, l: 'Без сахара' }, { id: 1, l: '1 ложка' }, { id: 2, l: '2 ложки' }]
};
const opt = (k, id) => OPT[k].find(o => String(o.id) === String(id)) || OPT[k][0];
const sizesOf = (it) => it.sz === 'esp' ? SZ_ESP : SZ;
const sizeOf = (it, cfg) => sizesOf(it).find(s => s.id === cfg.size) || sizesOf(it)[0];
const defCfg = (it) => ({ size: it.def || 'M', temp: it.cold ? 'ice' : 'hot', strength: 'classic', balance: 'classic', milk: 'std', texture: 'light', syrup: 'none', topping: 'none', sugar: 0, note: '' });

/* a client may only send option ids we know; anything else falls back to the default */
function cleanCfg(it, cfg) {
  const out = defCfg(it);
  if (!cfg || typeof cfg !== 'object') return out;
  const pick = (k, list) => { if (list.some(o => String(o.id) === String(cfg[k]))) out[k] = typeof list[0].id === 'number' ? Number(cfg[k]) : String(cfg[k]); };
  if (sizesOf(it).some(s => s.id === cfg.size)) out.size = cfg.size;
  pick('temp', it.cold ? OPT.ice : OPT.temp);
  pick('strength', OPT.strength); pick('balance', OPT.balance); pick('milk', OPT.milk);
  pick('texture', OPT.texture); pick('syrup', OPT.syrup); pick('topping', OPT.topping); pick('sugar', OPT.sugar);
  out.note = typeof cfg.note === 'string' ? cfg.note.replace(/[\u0000-\u001f]/g, ' ').slice(0, 100) : '';
  return out;
}
function unit(it, drink, cfg) {
  if (!drink) return it.price;
  let p = it.price + sizeOf(it, cfg).d;
  if (cfg.strength === 'strong') p += 60;
  if (it.milk) p += (opt('milk', cfg.milk).d || 0);
  p += (opt('syrup', cfg.syrup).d || 0);
  return p;
}
function cfgText(it, cfg) {
  const sl = { S: it.sz === 'esp' ? 'Соло' : 'S', M: it.sz === 'esp' ? 'Дабл' : 'M', L: 'L' };
  const p = [sl[sizeOf(it, cfg).id]];
  p.push(it.cold ? opt('ice', cfg.temp).l : opt('temp', cfg.temp).l);
  if (cfg.strength !== 'classic') p.push(opt('strength', cfg.strength).l + ' кофе');
  if (it.milk) {
    if (cfg.balance !== 'classic') p.push(opt('balance', cfg.balance).l.toLowerCase());
    if (cfg.milk !== 'std') p.push(opt('milk', cfg.milk).l + ' молоко');
    if (cfg.texture !== 'light') p.push(opt('texture', cfg.texture).l.toLowerCase());
  }
  if (cfg.syrup !== 'none') p.push('сироп: ' + opt('syrup', cfg.syrup).l.toLowerCase());
  if (cfg.topping !== 'none') p.push(opt('topping', cfg.topping).l.toLowerCase());
  if (Number(cfg.sugar) > 0) p.push('сахар: ' + cfg.sugar);
  return p.join(' · ');
}

/* ---------- loyalty ---------- */
const tierIdx = (u, loy) => { let k = 0; loy.tiers.forEach((t, i) => { if (u.spent >= t.min) k = i; }); return k; };
const multNow = (loy) => (loy.bonusDay >= 0 && new Date().getDay() === loy.bonusDay) ? loy.bonusMult : 1;
function addStamps(u, n, every) {
  if (n < 0) { u.stamps = Math.max(0, u.stamps + n); return; }
  u.stamps += n;
  if (every > 0) while (u.stamps >= every) { u.stamps -= every; u.freeDrinks += 1; }
}
function calcPay(u, lines, loy, usePts, useFree, tip) {
  const base = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  let cheap = null;
  lines.forEach(l => { if (l.drink && (cheap === null || l.unit < cheap)) cheap = l.unit; });
  const freeOk = u.freeDrinks > 0 && cheap !== null && loy.freeEvery > 0;
  const free = (useFree && freeOk) ? (loy.freeCap > 0 ? Math.min(cheap, loy.freeCap) : cheap) : 0;
  const after = base - free;
  const maxPts = Math.max(0, Math.min(u.points, Math.floor(after * loy.maxPayPct / 100)));
  const pts = usePts ? maxPts : 0;
  const cash = after - pts, tier = loy.tiers[tierIdx(u, loy)], mult = multNow(loy);
  const earn = Math.floor(cash * tier.pct / 100 * mult);
  return { base, free, pts, cash, tip, pay: cash + tip, earn };
}

/* ---------- seed data (first start only) ---------- */
const DEFSECS = [{ id: 'coffee', name: 'Кофе', kind: 'drink' }, { id: 'dessert', name: 'Десерты', kind: 'food' }, { id: 'pastry', name: 'Выпечка', kind: 'food' }, { id: 'sand', name: 'Сэндвичи', kind: 'food' }];
const PREP = { espresso: 2, americano: 3, cappuccino: 5, latte: 5, flat: 5, raf: 6, mocha: 6, iced: 4, tiramisu: 1, cheesecake: 1, croissant: 2, cinroll: 2, ham: 4, avo: 4 };
const COSTR = { espresso: .22, americano: .2, cappuccino: .28, latte: .3, flat: .3, raf: .34, mocha: .33, iced: .3, tiramisu: .42, cheesecake: .4, croissant: .38, cinroll: .36, ham: .45, avo: .5 };
const artFor = (sec, cold) => sec === 'coffee' ? (cold ? 'glass' : 'cup') : sec === 'dessert' ? 'cake' : sec === 'pastry' ? 'croissant' : sec === 'sand' ? 'sand' : 'cake';
function M(id, sec, name, desc, price, o) {
  const it = Object.assign({ id, sec, name, desc, price, milk: false, cold: false, sz: 'std', def: 'M', on: true, art: artFor(sec, false), time: '5–7 мин', kcal: 0, img: '' }, o || {});
  it.cost = Math.round(price * (COSTR[id] || .33));
  it.prep = PREP[id] || 3; it.promoItem = false;
  return it;
}
function seedMenu() {
  return [
    M('espresso', 'coffee', 'Эспрессо', 'Короткий и насыщенный', 150, { art: 'small', sz: 'esp', def: 'S', time: '2–3 мин', kcal: 5 }),
    M('americano', 'coffee', 'Американо', 'Эспрессо с горячей водой', 170, { time: '3–4 мин', kcal: 10 }),
    M('cappuccino', 'coffee', 'Капучино', 'Эспрессо, молоко и плотная пена', 220, { milk: true, kcal: 120 }),
    M('latte', 'coffee', 'Латте', 'Мягкий вкус, много молока', 230, { milk: true, kcal: 150 }),
    M('flat', 'coffee', 'Флэт уайт', 'Двойной эспрессо и бархатное молоко', 240, { milk: true, art: 'small', kcal: 130 }),
    M('raf', 'coffee', 'Раф ванильный', 'Сливки, эспрессо и ваниль', 270, { milk: true, time: '6–8 мин', kcal: 210 }),
    M('mocha', 'coffee', 'Мокко', 'Кофе, молоко и шоколад', 260, { milk: true, time: '6–8 мин', kcal: 230 }),
    M('iced', 'coffee', 'Айс-латте', 'Эспрессо, холодное молоко и лёд', 260, { milk: true, cold: true, art: 'glass', time: '4–6 мин', kcal: 160 }),
    M('tiramisu', 'dessert', 'Тирамису', 'Маскарпоне, савоярди, какао', 290, { time: '1–2 мин', kcal: 380 }),
    M('cheesecake', 'dessert', 'Чизкейк', 'Нежный, на песочной основе', 270, { time: '1–2 мин', kcal: 360 }),
    M('croissant', 'pastry', 'Круассан', 'Слоёный, масляный', 190, { time: '2–3 мин', kcal: 300 }),
    M('cinroll', 'pastry', 'Булочка с корицей', 'Тёплая, с сахарной глазурью', 210, { art: 'roll', time: '2–3 мин', kcal: 340 }),
    M('ham', 'sand', 'Сэндвич с ветчиной', 'Ветчина, сыр, свежие овощи', 320, { time: '4–5 мин', kcal: 420 }),
    M('avo', 'sand', 'Сэндвич с авокадо', 'Авокадо, яйцо, зелень', 340, { time: '4–5 мин', kcal: 380 })
  ];
}
function seedPromos(now) {
  const z = { views: 0, clicks: 0, orders: 0, rev: 0 };
  return [
    Object.assign({ id: 'p1', title: 'Утреннее комбо', text: 'Кофе и круассан вместе со скидкой', kind: 'promo', from: now - 864e5, to: now + 3 * 864e5, timer: true, active: true }, z),
    Object.assign({ id: 'p2', title: 'Овсяное без доплаты', text: 'По вторникам для всех напитков', kind: 'promo', from: null, to: null, timer: false, active: true }, z),
    Object.assign({ id: 'p3', title: 'Сезонный раф', text: 'Попробуйте новый вкус до конца месяца', kind: 'ad', from: null, to: null, timer: false, active: true }, z)
  ];
}
const seedLoy = () => ({ welcome: 100, tiers: [{ name: 'Базовый', min: 0, pct: 3 }, { name: 'Серебряный', min: 3000, pct: 5 }, { name: 'Золотой', min: 10000, pct: 7 }], freeEvery: 9, freeCap: 300, maxPayPct: 30, bonusDay: 2, bonusMult: 2 });

/* ---------- sanitizers for staff-editable data ---------- */
const ART = ['cup', 'glass', 'small', 'roll', 'cake', 'croissant', 'sand'];
function cleanImg(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 160000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) throw bad('image');
  return v;
}
function cleanItem(raw, old, role, secIds) {
  if (!raw || typeof raw !== 'object') throw bad('item');
  const id = old ? old.id : String(raw.id || '');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw bad('item id');
  if (!secIds.has(raw.sec)) throw bad('section');
  return {
    id, sec: raw.sec,
    name: str(raw.name, 1, 60, 'name'), desc: str(raw.desc == null ? '' : raw.desc, 0, 160, 'description'),
    price: int(raw.price, 1, 99999, 'price'),
    milk: bool(raw.milk), cold: bool(raw.cold), on: bool(raw.on),
    art: oneOf(raw.art, ART, 'art'), sz: oneOf(raw.sz || 'std', ['std', 'esp'], 'size type'), def: oneOf(raw.def || 'M', ['S', 'M', 'L'], 'default size'),
    time: str(raw.time == null ? '' : raw.time, 0, 20, 'time'), kcal: int(raw.kcal || 0, 0, 5000, 'kcal'),
    cost: role === 'admin' ? int(raw.cost == null ? (old ? old.cost : 0) : raw.cost, 0, 99999, 'cost') : (old ? old.cost : Math.round(int(raw.price, 1, 99999) * .33)),
    img: cleanImg(raw.img),
    prep: role === 'admin' ? int(raw.prep == null ? (old && old.prep != null ? old.prep : 3) : raw.prep, 0, 180, 'prep') : (old && old.prep != null ? old.prep : 3),
    promoItem: bool(raw.promoItem)
  };
}
function cleanPromo(raw, old) {
  if (!raw || typeof raw !== 'object') throw bad('promo');
  const id = old ? old.id : String(raw.id || '');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw bad('promo id');
  const ts = (v) => v == null ? null : int(v, 0, 4102444800000, 'date');
  const from = ts(raw.from), to = ts(raw.to);
  if (from && to && to <= from) throw bad('dates');
  return {
    id, title: str(raw.title, 1, 80, 'title'), text: str(raw.text == null ? '' : raw.text, 0, 200, 'text'),
    kind: oneOf(raw.kind, ['ad', 'promo'], 'kind'), from, to, timer: bool(raw.timer), active: bool(raw.active),
    views: old ? old.views : 0, clicks: old ? old.clicks : 0, orders: old ? old.orders : 0, rev: old ? old.rev : 0
  };
}
function cleanSec(raw, old) {
  const id = old ? old.id : String(raw.id || '');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw bad('section id');
  return { id, name: str(raw.name, 2, 30, 'section name'), kind: old ? old.kind : oneOf(raw.kind, ['drink', 'food'], 'section kind') };
}
function cleanLoy(raw) {
  if (!raw || !Array.isArray(raw.tiers) || raw.tiers.length < 1 || raw.tiers.length > 10) throw bad('tiers');
  const tiers = raw.tiers.map(t => ({ name: str(t.name, 1, 30, 'tier name'), min: int(t.min, 0, 1e8, 'tier min'), pct: int(t.pct, 0, 100, 'tier pct') })).sort((a, b) => a.min - b.min);
  tiers[0].min = 0;
  for (let i = 1; i < tiers.length; i++) if (tiers[i].min === tiers[i - 1].min) throw bad('tier thresholds');
  const bm = Number(raw.bonusMult);
  if (!(bm >= 1 && bm <= 10)) throw bad('multiplier');
  return {
    welcome: int(raw.welcome, 0, 100000, 'welcome'), tiers, freeEvery: int(raw.freeEvery, 0, 100, 'free every'), freeCap: int(raw.freeCap, 0, 10000, 'free cap'),
    maxPayPct: int(raw.maxPayPct, 0, 100, 'max pay'), bonusDay: int(raw.bonusDay, -1, 6, 'bonus day'), bonusMult: bm
  };
}
function cleanTables(raw) {
  const count = int(raw && raw.count, 1, 60, 'tables count');
  const codes = {}, seen = new Set();
  for (let n = 1; n <= count; n++) {
    const c = str(String((raw.codes || {})[n] || ''), 3, 200, 'table code');
    if (seen.has(c.toLowerCase())) throw bad('duplicate table code');
    seen.add(c.toLowerCase()); codes[n] = c;
  }
  return { count, codes };
}
function cleanExpense(raw) {
  if (!raw || typeof raw !== 'object') throw bad('expense');
  const id = String(raw.id || '');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw bad('expense id');
  return { id, ts: int(raw.ts, 0, 4102444800000, 'date'), cat: str(raw.cat, 1, 30, 'category'), text: str(raw.text == null ? '' : raw.text, 0, 80, 'text'), sum: int(raw.sum, 1, 1e9, 'sum') };
}
function cleanSelf(raw, old) {
  const prefs = raw && raw.prefs || {}, q = prefs.quiet || {};
  const favs = Array.isArray(raw.favs) ? raw.favs.slice(0, 50).map(f => {
    if (!f || typeof f.id !== 'string' || f.id.length > 40) throw bad('favorite');
    if (JSON.stringify(f.cfg || null).length > 600) throw bad('favorite config');
    return { id: f.id, cfg: f.cfg || null, qty: int(f.qty || 1, 1, 9, 'qty') };
  }) : old.favs;
  const lastCfg = {};
  Object.keys(raw.lastCfg || {}).slice(0, 80).forEach(k => { if (/^[a-zA-Z0-9_-]{1,40}$/.test(k) && JSON.stringify(raw.lastCfg[k]).length < 600) lastCfg[k] = raw.lastCfg[k]; });
  return {
    name: str(raw.name, 1, 40, 'name'), favs, lastCfg,
    prefs: { table: int(prefs.table || old.prefs.table, 1, 60, 'table'), quiet: { notif: bool(q.notif), vibe: bool(q.vibe), remember: bool(q.remember), oneclick: bool(q.oneclick) } }
  };
}

module.exports = {
  HttpError, bad, str, int, bool, oneOf, OPT, opt, defCfg, cleanCfg, unit, cfgText, tierIdx, multNow, addStamps, calcPay,
  DEFSECS, seedMenu, seedPromos, seedLoy, cleanItem, cleanPromo, cleanSec, cleanLoy, cleanTables, cleanExpense, cleanSelf, artFor
};

/* ---------- staff: shifts, pay, Russian labour-law limits ---------- */
const H = 36e5, MINUTE = 6e4;
const LAW = { shiftMaxH: 12, weekPlannedMaxH: 40, otTwoDaysMaxMin: 240, otYearMaxMin: 7200 };
const seedPay = () => ({ hourRate: 250, orderPct: 2, promoPct: 6, waitLimit: 5 });
function cleanPay(raw) {
  if (!raw || typeof raw !== 'object') throw bad('pay');
  return { hourRate: int(raw.hourRate, 0, 20000, 'hour rate'), orderPct: Number(Math.min(50, Math.max(0, Number(raw.orderPct))).toFixed(2)), promoPct: Number(Math.min(50, Math.max(0, Number(raw.promoPct))).toFixed(2)), waitLimit: int(raw.waitLimit, 1, 60, 'wait limit') };
}
const effEnd = (s) => s.end + (s.ot || []).reduce((a, o) => a + o.min, 0) * MINUTE;
const dayNo = (t) => { const d = new Date(t); return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 864e5); };
const weekStart = (t) => { const d = new Date(t); const k = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - k).getTime(); };
function shiftCalc(s, pay, t) {
  const from = s.startedAt ? Math.max(s.startedAt, s.start) : 0;
  const to = s.startedAt ? Math.min(s.endedAt || t, effEnd(s)) : 0;
  const regular = from && to > from ? Math.max(0, Math.min(to, s.end) - from) : 0;
  const ot = from && to > from ? Math.max(0, to - Math.max(s.end, from)) : 0;
  const otH = ot / H;
  return { regularMs: regular, otMs: ot, basePay: Math.round(regular / H * pay.hourRate), otPay: Math.round(pay.hourRate * (Math.min(otH, 2) * 1.5 + Math.max(otH - 2, 0) * 2)) };
}
function checkPlan(all, phone, start, end, ignoreId) {
  if (!(end > start)) throw bad('время окончания раньше начала');
  if (end - start < 30 * MINUTE) throw bad('смена короче 30 минут');
  if (end - start > LAW.shiftMaxH * H) throw new HttpError(400, 'law', 'Смена не может быть длиннее ' + LAW.shiftMaxH + ' часов (ТК РФ).');
  const mine = all.filter(x => x.phone === phone && x.status !== 'deleted' && x.id !== ignoreId);
  if (mine.some(x => start < effEnd(x) && end > x.start)) throw new HttpError(409, 'overlap', 'У этого баристы уже есть смена в это время.');
  const w = weekStart(start), planned = mine.filter(x => weekStart(x.start) === w).reduce((a, x) => a + (x.end - x.start), 0) + (end - start);
  if (planned > LAW.weekPlannedMaxH * H) throw new HttpError(400, 'law', 'Больше ' + LAW.weekPlannedMaxH + ' часов в неделю планировать нельзя (ТК РФ, ст. 91). Сейчас получилось бы ' + Math.round(planned / H * 10) / 10 + ' ч.');
}
function checkOvertime(all, shift, addMin) {
  if (!(addMin >= 15 && addMin <= 240)) throw bad('овертайм от 15 минут до 4 часов');
  if (effEnd(shift) + addMin * MINUTE - shift.start > LAW.shiftMaxH * H) throw new HttpError(400, 'law', 'Вместе с овертаймом смена выйдет длиннее ' + LAW.shiftMaxH + ' часов. По закону так нельзя.');
  const mine = all.filter(x => x.phone === shift.phone && x.status !== 'deleted');
  const perDay = {};
  mine.forEach(x => { const m = (x.ot || []).reduce((a, o) => a + o.min, 0); if (m) perDay[dayNo(x.start)] = (perDay[dayNo(x.start)] || 0) + m; });
  const d = dayNo(shift.start); perDay[d] = (perDay[d] || 0) + addMin;
  for (const k of [d - 1, d]) if ((perDay[k] || 0) + (perDay[k + 1] || 0) > LAW.otTwoDaysMaxMin) throw new HttpError(400, 'law', 'Овертайм не может превышать 4 часа за два дня подряд (ТК РФ, ст. 99).');
  const y = new Date(shift.start).getFullYear();
  const year = mine.filter(x => new Date(x.start).getFullYear() === y).reduce((a, x) => a + (x.ot || []).reduce((b, o) => b + o.min, 0), 0) + addMin;
  if (year > LAW.otYearMaxMin) throw new HttpError(400, 'law', 'Овертайм за год не может превышать 120 часов (ТК РФ, ст. 99).');
}
Object.assign(module.exports, { PREP, LAW, seedPay, cleanPay, effEnd, shiftCalc, checkPlan, checkOvertime, dayNo, weekStart, MINUTE });
