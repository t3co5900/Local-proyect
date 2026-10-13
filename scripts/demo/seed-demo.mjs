// Genera una base de datos de DEMOSTRACIÓN con una semana completa de un local:
// usuarios, catálogo, ingresos de mercadería, turnos, ventas, fichajes y mermas.
// Incluye "el miércoles" del pedido original: entran 300 empanadas, 20 pizzas,
// 200 alfajores, 250 medialunas y 125 chipás; se venden 134, 5, 67, 190 y 100.
//
//   node scripts/demo/seed-demo.mjs --out=<carpeta> [--today=open|none] [--now=<ms epoch>]
//
// Es determinista (mismo resultado cada vez). Escribe <carpeta>/demo-users.json
// (usuarios y códigos) y <carpeta>/demo-facts.json (cifras para documentar).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/config.js';
import { createContext } from '../../server/context.js';
import { all, get, openDb, run } from '../../server/db.js';
import * as catalog from '../../server/services/catalog.js';
import { adjust, restock } from '../../server/services/inventory.js';
import { periodReport, shiftReport } from '../../server/services/reports.js';
import { createSale } from '../../server/services/sales.js';
import { setSetting } from '../../server/services/settings.js';
import { addCashMovement, cashFigures, closeShift, openShift } from '../../server/services/shifts.js';
import { punch } from '../../server/services/timeclock.js';
import { createUser } from '../../server/services/users.js';
import { endOfWeek, startOfWeek, ymd } from '../../server/util/time.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const outDir = path.resolve(args.out || 'demo-data');
const todayMode = args.today || 'open';
const NOW = Number(args.now || Date.now());
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const config = loadConfig({ MRCOOK_DATA_DIR: outDir });
const tz = config.timezone;
const clock = { t: NOW };
const ctx = createContext({ config, db: openDb(config.dbFile), now: () => clock.t });
const HOUR = 3600 * 1000;

// ---- azar determinista
let seed = 20261007;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pickW = (list) => { let r = rnd() * list.reduce((s, x) => s + x.w, 0); for (const x of list) { r -= x.w; if (r <= 0) return x; } return list[0]; };

// ---- instante local (hora de Argentina) de un día + hora:min
const localMidnight = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) + 3 * HOUR; }; // ART = UTC-3 sin horario de verano
const at = (day, hh, mm = 0) => localMidnight(day) + hh * HOUR + mm * 60000;
const addDay = (day, n) => ymd(localMidnight(day) + n * 24 * HOUR + 12 * HOUR, tz);

// ---- usuarios y catálogo
clock.t = NOW - 20 * 24 * HOUR;
const users = {};
const pins = {};
for (const [key, name, role] of [['laura', 'Laura Giménez', 'admin'], ['martin', 'Martín Sosa', 'cajero'], ['camila', 'Camila Ríos', 'cajero']]) {
  const r = createUser(ctx, null, { fullName: name, role });
  users[key] = get(ctx.db, 'SELECT * FROM users WHERE id = ?', r.user.id);
  pins[key] = { name, role, pin: r.pin };
}
catalog.seedCatalog(ctx);
setSetting(ctx, 'catalog.pricesConfirmed', true);
const P = Object.fromEntries(all(ctx.db, 'SELECT id, name, price_cents FROM products').map((p) => [p.name, p]));
const PROMO = Object.fromEntries(all(ctx.db, 'SELECT id, name, price_cents FROM promos').map((p) => [p.name, p]));
const promoItems = (id) => all(ctx.db, 'SELECT p.name, pi.qty FROM promo_items pi JOIN products p ON p.id = pi.product_id WHERE pi.promo_id = ?', id);
const PRODUCT_NAMES = Object.keys(P);

// ---- canastas
// cada plantilla devuelve [{ kind, name, qty }]
const TEMPLATES = [
  { w: 16, f: () => [{ kind: 'product', name: 'Empanada', qty: ri(2, 8) }] },
  { w: 7, f: () => [{ kind: 'product', name: 'Empanada', qty: ri(2, 5) }, { kind: 'product', name: 'Gaseosa', qty: 1 }] },
  { w: 6, f: () => [{ kind: 'promo', name: 'Combo 3 empanadas + gaseosa', qty: ri(1, 2) }] },
  { w: 5, f: () => [{ kind: 'promo', name: 'Docena de empanadas', qty: 1 }] },
  { w: 4, f: () => [{ kind: 'promo', name: 'Media docena de empanadas', qty: ri(1, 2) }] },
  { w: 8, f: () => [{ kind: 'promo', name: 'Combo 3 medialunas', qty: ri(1, 3) }] },
  { w: 12, f: () => [{ kind: 'product', name: 'Medialuna', qty: ri(3, 9) }] },
  { w: 3, f: () => [{ kind: 'product', name: 'Pizza', qty: 1 }] },
  { w: 8, f: () => [{ kind: 'product', name: 'Chipá', qty: ri(3, 10) }] },
  { w: 5, f: () => [{ kind: 'product', name: 'Criollito', qty: ri(3, 6) }] },
  { w: 6, f: () => [{ kind: 'product', name: 'Alfajor', qty: ri(1, 4) }] },
  { w: 4, f: () => [{ kind: 'product', name: 'Agua', qty: 1 }, { kind: 'product', name: 'Medialuna', qty: ri(2, 4) }] },
];
const unitsOf = (lines) => {
  const u = {};
  for (const l of lines) {
    if (l.kind === 'product') u[l.name] = (u[l.name] || 0) + l.qty;
    else for (const it of promoItems(PROMO[l.name].id)) u[it.name] = (u[it.name] || 0) + it.qty * l.qty;
  }
  return u;
};
const fits = (u, rem) => Object.entries(u).every(([n, q]) => q <= (rem[n] || 0));

/** Arma canastas que suman EXACTAMENTE las unidades pedidas por producto. */
function planExact(target) {
  const rem = { ...target };
  const baskets = [];
  while (Object.values(rem).some((v) => v > 0)) {
    let done = false;
    for (let tries = 0; tries < 60 && !done; tries++) {
      const lines = pickW(TEMPLATES).f();
      const u = unitsOf(lines);
      if (fits(u, rem)) { for (const [n, q] of Object.entries(u)) rem[n] -= q; baskets.push(lines); done = true; }
    }
    if (!done) { // lo que sobra se completa con ventas sueltas
      const name = Object.keys(rem).filter((n) => rem[n] > 0).sort((a, b) => rem[b] - rem[a])[0];
      const q = Math.min(rem[name], ri(1, 4));
      rem[name] -= q;
      baskets.push([{ kind: 'product', name, qty: q }]);
    }
  }
  for (let i = baskets.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [baskets[i], baskets[j]] = [baskets[j], baskets[i]]; }
  return baskets;
}

const basketTotal = (lines) => lines.reduce((a, l) => a + (l.kind === 'product' ? P[l.name].price_cents : PROMO[l.name].price_cents) * l.qty, 0);

function paymentsFor(total) {
  const r = rnd();
  const method = r < 0.42 ? 'efectivo' : r < 0.68 ? 'transferencia' : r < 0.86 ? 'debito' : 'credito';
  const cashPay = (amount) => {
    const bills = [1000, 2000, 5000, 10000, 20000].map((b) => b * 100).filter((b) => b >= amount);
    const exact = rnd() < 0.25 || !bills.length;
    const next = Math.ceil(amount / 100000) * 100000;
    return { method: 'efectivo', amountCents: amount, tenderedCents: exact ? amount : (rnd() < 0.5 ? next : bills[0]) };
  };
  if (total >= 600000 && rnd() < 0.18) { // pago mixto
    const cash = Math.floor((total * 0.4) / 100000) * 100000 || 100000;
    return [cashPay(cash), { method: rnd() < 0.5 ? 'debito' : 'transferencia', amountCents: total - cash }];
  }
  return method === 'efectivo' ? [cashPay(total)] : [{ method, amountCents: total }];
}

// ---- un día de trabajo
const DAY = { state: {} };
function sellBasket(user, lines) {
  const items = lines.map((l) => ({ kind: l.kind, id: (l.kind === 'product' ? P[l.name] : PROMO[l.name]).id, qty: l.qty }));
  return createSale(ctx, user, { items, payments: paymentsFor(basketTotal(lines)) });
}

function stockOf(name) { return get(ctx.db, 'SELECT stock FROM products WHERE name = ?', name).stock; }

function simulateDay(day, { target, opener, closer, evening, fixedRestock = null, buffer = 0, openOnly = false, until = null, openCash = 2000000, cashDiff = 0, closeNote = null, mermas = [], movements = [], punches = true, lowTweaks = false }) {
  const baskets = planExact(target);
  // 1) ingreso de mercadería 07:30 (lo que falta para vender el día, o lo indicado)
  clock.t = at(day, 7, 30);
  const lost = (n) => mermas.filter((m) => m.name === n).reduce((a, m) => a + Math.abs(m.qty), 0);
  const items = PRODUCT_NAMES.map((n) => {
    const need = fixedRestock ? (fixedRestock[n] || 0) : Math.max(0, (target[n] || 0) + lost(n) - stockOf(n)) + (target[n] ? buffer : 0);
    return need > 0 ? { productId: P[n].id, qty: need } : null;
  }).filter(Boolean);
  if (items.length) restock(ctx, opener, { items, supplier: 'Fábrica central', note: `Remito del ${day.split('-').reverse().join('/')}` });
  if (punches) { clock.t = at(day, 7, 55); punch(ctx, opener, 'in'); }
  // 2) apertura
  clock.t = at(day, 8, 0);
  openShift(ctx, opener, { openingCashCents: openCash });
  // 3) ventas repartidas durante el día
  const startT = at(day, 8, 20);
  const endT = openOnly ? until : at(day, 20, 30);
  const span = endT - startT;
  const count = openOnly ? Math.round((baskets.length * (until - startT)) / (at(day, 20, 30) - startT)) : baskets.length;
  const times = Array.from({ length: count }, () => startT + rnd() * span).sort((a, b) => a - b);
  const switchAt = at(day, 15, 0);
  let movDone = 0;
  times.forEach((t, i) => {
    clock.t = t;
    if (punches && openOnly && !DAY.eveningIn && t >= at(day, 12, 0)) { punch(ctx, evening, 'in'); DAY.eveningIn = true; }
    const seller = t < switchAt ? opener : evening;
    sellBasket(seller, baskets[i]);
    while (movDone < movements.length && t >= at(day, movements[movDone].h, movements[movDone].m)) {
      const mv = movements[movDone++];
      clock.t = at(day, mv.h, mv.m);
      addCashMovement(ctx, seller, { type: mv.type, amountCents: mv.cents, reason: mv.reason });
      clock.t = t;
    }
  });
  for (const m of mermas) { clock.t = at(day, m.h, m.m); adjust(ctx, opener, { productId: P[m.name].id, qty: m.qty, reason: m.reason, kind: m.kind || 'waste' }); }
  const shiftId = get(ctx.db, `SELECT id FROM shifts WHERE status='open'`).id;
  if (openOnly) {
    if (lowTweaks) { // para mostrar "Stock bajo" en el inventario
      const agua = stockOf('Agua');
      run(ctx.db, 'UPDATE products SET low_stock_threshold = ? WHERE name = ?', agua + 3, 'Agua');
    }
    return { shiftId, salesCount: count };
  }
  // 4) cierre 21:00 (cuenta de efectivo y de stock)
  clock.t = at(day, 21, 0);
  const expected = cashFigures(ctx, shiftId).expectedCents;
  const counts = all(ctx.db, 'SELECT id, stock FROM products WHERE track_stock = 1').map((p) => ({ productId: p.id, qty: p.stock }));
  closeShift(ctx, closer, { countedCashCents: expected + cashDiff, stockCounts: counts, notes: closeNote });
  if (punches) { // fichajes del día: los timestamps de fichaje no dependen del resto, se puede retroceder el reloj
    clock.t = at(day, 16, 5); punch(ctx, opener, 'out');
    clock.t = at(day, 15, 55); punch(ctx, evening, 'in');
    clock.t = at(day, 21, 8); punch(ctx, evening, 'out');
    clock.t = at(day, 21, 0);
  }
  return { shiftId, salesCount: count };
}

// ---- calendario: semana pasada completa + lunes de esta semana + hoy
const thisMon = ymd(startOfWeek(NOW, tz), tz);
const prevMon = addDay(thisMon, -7);
const todayDay = ymd(NOW, tz);
const days = [];
for (let i = 0; i < 7; i++) days.push(addDay(prevMon, i));
for (let d = thisMon; d < todayDay; d = addDay(d, 1)) days.push(d);

// ventas objetivo por día (unidades). El miércoles es el del pedido original.
const WED = { Empanada: 134, Pizza: 5, Alfajor: 67, Medialuna: 190, 'Chipá': 100, Criollito: 40, Gaseosa: 14, Agua: 9 };
const scale = (f) => Object.fromEntries(Object.entries(WED).map(([k, v]) => [k, Math.max(1, Math.round(v * f))]));
const FACTORS = [0.82, 0.9, 1, 1.05, 1.28, 1.42, 1.1];
const rosters = [['laura', 'martin'], ['laura', 'camila'], ['laura', 'martin'], ['camila', 'martin'], ['laura', 'camila'], ['martin', 'camila'], ['laura', 'martin']];
const facts = { days: [] };
let wedShift = null;
days.forEach((day, i) => {
  const dow = i % 7;
  const isWed = day === addDay(prevMon, 2);
  const [a, b] = rosters[dow];
  const target = isWed ? WED : scale(i < 7 ? FACTORS[dow] : 0.95);
  const res = simulateDay(day, {
    target,
    opener: users[a],
    closer: users[b],
    evening: users[b],
    fixedRestock: isWed ? { Empanada: 300, Pizza: 20, Alfajor: 200, Medialuna: 250, 'Chipá': 125, Criollito: 150, Gaseosa: 36, Agua: 24 } : null,
    buffer: dow >= 3 ? ri(6, 20) : 0,
    cashDiff: isWed ? -50000 : [0, 0, -20000, 0, 10000, 0, 0][dow],
    closeNote: isWed ? 'Se dio vuelto de más en una venta. Faltaron $500.' : null,
    movements: [{ h: 11, m: 20, type: 'out', cents: 450000, reason: 'Hielo y bolsas' }, ...(dow % 2 === 0 ? [{ h: 17, m: 5, type: 'out', cents: 1200000, reason: 'Pago a proveedor de bebidas' }] : [])],
    mermas: dow === 0 ? [{ h: 14, m: 10, name: 'Empanada', qty: 2, reason: 'Se cayeron al piso' }] : dow === 4 ? [{ h: 19, m: 40, name: 'Pizza', qty: 1, reason: 'Se quemó en el horno' }] : [],
  });
  if (isWed) wedShift = res.shiftId;
  // salida del personal de la mañana
  facts.days.push({ day, ...res, opener: pins[a].name, closer: pins[b].name });
});
// ---- hoy
let todayInfo = null;
if (todayMode === 'open') {
  const target = scale(1.15);
  target.Pizza = 6;
  todayInfo = simulateDay(todayDay, {
    target, opener: users.laura, closer: users.martin, evening: users.martin, openOnly: true,
    until: NOW - 12 * 60000, buffer: 8, lowTweaks: true,
    movements: [{ h: 11, m: 20, type: 'out', cents: 450000, reason: 'Hielo y bolsas' }],
  });
} else {
  clock.t = NOW;
}

// con Mercado Pago activo, los cobros no efectivo se confirman solos: así queda la demo
run(ctx.db, `UPDATE sale_payments SET confirmation = 'auto' WHERE method <> 'efectivo'`);
clock.t = NOW;

// ---- cifras para documentar
const wed = shiftReport(ctx, wedShift);
const weekFrom = startOfWeek(at(prevMon, 12), tz);
const week = periodReport(ctx, { from: weekFrom, to: endOfWeek(weekFrom, tz) });
facts.wedShiftId = wedShift;
facts.wednesday = {
  day: addDay(prevMon, 2), shift: wed.shift, cash: wed.cash, inventory: wed.inventory,
  totals: { salesCount: wed.totals.salesCount, totalCents: wed.totals.totalCents, byMethod: wed.totals.byMethod, countByMethod: wed.totals.countByMethod, digitalCents: wed.totals.digitalCents, cashCents: wed.totals.cashCents, avgTicketCents: wed.totals.avgTicketCents, voidedCount: wed.totals.voidedCount, products: wed.totals.products, promos: wed.totals.promos },
  cashMovements: wed.cashMovements,
};
facts.prevWeek = { from: week.from, to: week.to, fromYmd: prevMon, toYmd: addDay(prevMon, 6), totals: { salesCount: week.totals.salesCount, totalCents: week.totals.totalCents, byMethod: week.totals.byMethod, digitalCents: week.totals.digitalCents, cashCents: week.totals.cashCents, products: week.totals.products, promos: week.totals.promos }, daily: week.daily, inventory: week.inventory, shifts: week.shifts, hours: week.hours };
facts.today = { day: todayDay, mode: todayMode, ...todayInfo };
facts.catalog = {
  products: all(ctx.db, 'SELECT p.name, c.name AS category, p.price_cents, p.low_stock_threshold FROM products p JOIN categories c ON c.id = p.category_id ORDER BY c.sort_order').map((p) => ({ ...p })),
  promos: Object.values(PROMO).map((p) => ({ name: p.name, price_cents: p.price_cents, items: promoItems(p.id).map((i) => ({ ...i })) })),
};
facts.stockNow = all(ctx.db, 'SELECT name, stock, low_stock_threshold FROM products').map((p) => ({ ...p }));
fs.writeFileSync(path.join(outDir, 'demo-users.json'), JSON.stringify(pins, null, 2));
fs.writeFileSync(path.join(outDir, 'demo-facts.json'), JSON.stringify(facts, null, 2));
ctx.db.close();
console.log(JSON.stringify({ out: outDir, wedShift, days: days.length, today: todayInfo, users: Object.fromEntries(Object.entries(pins).map(([k, v]) => [k, `${v.name} / ${v.pin}`])) }));
