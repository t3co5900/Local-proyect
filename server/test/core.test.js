import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from '../db.js';
import { restock, adjust } from '../services/inventory.js';
import { openShift, closeShift, addCashMovement } from '../services/shifts.js';
import { createSale, voidSale } from '../services/sales.js';
import { shiftReport } from '../services/reports.js';
import { testContext } from './helpers.js';

const pesos = (n) => n * 100;

// El escenario del pedido: "un miércoles me entran 300 empanadas, 20 pizzas,
// 200 alfajores, 250 medialunas, 125 chipás; vendo 134, 5, 67, 190 y 100".
test('escenario del miércoles: inicio, ventas y stock final cuadran', () => {
  const t = testContext();
  const { ctx, cajero } = t;
  const emp = t.product('Empanada');
  const piz = t.product('Pizza');
  const alf = t.product('Alfajor');
  const med = t.product('Medialuna');
  const chi = t.product('Chipá');

  restock(ctx, cajero, {
    supplier: 'Fábrica',
    items: [
      { productId: emp.id, qty: 300 },
      { productId: piz.id, qty: 20 },
      { productId: alf.id, qty: 200 },
      { productId: med.id, qty: 250 },
      { productId: chi.id, qty: 125 },
    ],
  });

  openShift(ctx, cajero, { openingCashCents: pesos(20000) });

  const docena = t.promo('Docena de empanadas');
  // 134 empanadas = 10 docenas (promo) + 14 sueltas
  createSale(ctx, cajero, {
    items: [{ kind: 'promo', id: docena.id, qty: 10 }, { kind: 'product', id: emp.id, qty: 14 }],
    payments: [{ method: 'efectivo', amountCents: pesos(24000 * 10 + 2200 * 14), tenderedCents: pesos(300000) }],
  });
  createSale(ctx, cajero, {
    items: [{ kind: 'product', id: piz.id, qty: 5 }],
    payments: [{ method: 'debito', amountCents: pesos(13500 * 5) }],
  });
  createSale(ctx, cajero, {
    items: [{ kind: 'product', id: alf.id, qty: 67 }],
    payments: [{ method: 'transferencia', amountCents: pesos(1500 * 67) }],
  });
  createSale(ctx, cajero, {
    items: [{ kind: 'product', id: med.id, qty: 190 }],
    payments: [{ method: 'credito', amountCents: pesos(900 * 190) }],
  });
  createSale(ctx, cajero, {
    items: [{ kind: 'product', id: chi.id, qty: 100 }],
    payments: [
      { method: 'efectivo', amountCents: pesos(30000) },
      { method: 'transferencia', amountCents: pesos(40000) },
    ],
  });

  const shiftId = get(ctx.db, 'SELECT id FROM shifts').id;
  closeShift(ctx, cajero, { countedCashCents: 0 + pesos(20000 + 24000 * 10 + 2200 * 14 + 30000) });

  const r = shiftReport(ctx, shiftId);
  const inv = Object.fromEntries(r.inventory.map((i) => [i.name, i]));

  assert.deepEqual(
    ['Empanada', 'Pizza', 'Alfajor', 'Medialuna', 'Chipá'].map((n) => [inv[n].opening, inv[n].sold, inv[n].closingSystem]),
    [[300, 134, 166], [20, 5, 15], [200, 67, 133], [250, 190, 60], [125, 100, 25]],
  );
  // inicio + ingresos − vendido + ajustes == final, para todos los productos
  for (const i of r.inventory) assert.equal(i.opening + i.restock - i.sold + i.adjustments, i.closingSystem, i.name);

  const t0 = r.totals;
  const expectedTotal = 24000 * 10 + 2200 * 14 + 13500 * 5 + 1500 * 67 + 900 * 190 + 700 * 100;
  assert.equal(t0.totalCents, pesos(expectedTotal));
  assert.equal(t0.byMethod.efectivo, pesos(24000 * 10 + 2200 * 14 + 30000));
  assert.equal(t0.byMethod.debito, pesos(13500 * 5));
  assert.equal(t0.byMethod.credito, pesos(900 * 190));
  assert.equal(t0.byMethod.transferencia, pesos(1500 * 67 + 40000));
  // suma de los medios == total, y digital + efectivo == total
  assert.equal(t0.digitalCents + t0.cashCents, t0.totalCents);

  // unidades vendidas por producto (incluyendo las que fueron dentro de promos)
  const pe = t0.products.find((p) => p.name === 'Empanada');
  assert.equal(pe.unitsLoose, 14);
  assert.equal(pe.unitsPromo, 120);
  assert.equal(pe.unitsTotal, 134);
  assert.equal(t0.promos[0].qty, 10);

  // el efectivo esperado es fondo + ventas en efectivo; contado == esperado => diferencia 0
  assert.equal(r.cash.diffCents, 0);
  assert.equal(r.shift.status, 'closed');
});

test('un solo turno abierto a la vez', () => {
  const t = testContext();
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  assert.throws(() => openShift(t.ctx, t.admin, { openingCashCents: 0 }), /Ya hay un turno abierto/);
});

test('no se vende sin turno abierto', () => {
  const t = testContext();
  assert.throws(
    () => createSale(t.ctx, t.cajero, {
      items: [{ kind: 'product', id: t.product('Empanada').id, qty: 1 }],
      payments: [{ method: 'efectivo', amountCents: 2200_00 / 100 * 100 }],
    }),
    /No hay un turno abierto/,
  );
});

test('los pagos tienen que sumar el total', () => {
  const t = testContext();
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  assert.throws(
    () => createSale(t.ctx, t.cajero, {
      items: [{ kind: 'product', id: t.product('Empanada').id, qty: 2 }],
      payments: [{ method: 'efectivo', amountCents: pesos(1000) }],
    }),
    /no suman el total/,
  );
});

test('una venta fallida no deja stock ni ventas a medias (transacción)', () => {
  const t = testContext();
  const emp = t.product('Empanada');
  restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 10 }] });
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  assert.throws(() =>
    createSale(t.ctx, t.cajero, {
      items: [{ kind: 'product', id: emp.id, qty: 3 }],
      payments: [{ method: 'efectivo', amountCents: pesos(2200 * 3), tenderedCents: pesos(100) }], // no alcanza
    }),
  );
  assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id = ?', emp.id).stock, 10);
  assert.equal(get(t.ctx.db, 'SELECT COUNT(*) AS n FROM sales').n, 0);
});

test('anular una venta devuelve el stock y la saca de los totales', () => {
  const t = testContext();
  const emp = t.product('Empanada');
  restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 10 }] });
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  const sale = createSale(t.ctx, t.cajero, {
    items: [{ kind: 'product', id: emp.id, qty: 4 }],
    payments: [{ method: 'efectivo', amountCents: pesos(2200 * 4) }],
  });
  assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id = ?', emp.id).stock, 6);
  // un cajero no puede aprobar su propia anulación
  assert.throws(() => voidSale(t.ctx, t.cajero, t.cajero, sale.id, 'error'), /encargado/);
  voidSale(t.ctx, t.cajero, t.admin, sale.id, 'Se equivocó de producto');
  assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id = ?', emp.id).stock, 10);
  const shiftId = get(t.ctx.db, 'SELECT id FROM shifts').id;
  const r = shiftReport(t.ctx, shiftId);
  assert.equal(r.totals.totalCents, 0);
  assert.equal(r.totals.voidedCount, 1);
  assert.equal(r.cash.expectedCents, 0);
  assert.equal(r.inventory.find((i) => i.name === 'Empanada').sold, 0);
  assert.throws(() => voidSale(t.ctx, t.cajero, t.admin, sale.id, 'otra vez'), /ya estaba anulada/);
});

test('efectivo esperado = fondo + ventas en efectivo + ingresos − retiros; diferencia al contar', () => {
  const t = testContext();
  const emp = t.product('Empanada');
  restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 50 }] });
  openShift(t.ctx, t.cajero, { openingCashCents: pesos(10000) });
  createSale(t.ctx, t.cajero, {
    items: [{ kind: 'product', id: emp.id, qty: 5 }],
    payments: [{ method: 'efectivo', amountCents: pesos(11000), tenderedCents: pesos(20000) }],
  });
  createSale(t.ctx, t.cajero, {
    items: [{ kind: 'product', id: emp.id, qty: 5 }],
    payments: [{ method: 'transferencia', amountCents: pesos(11000) }],
  });
  addCashMovement(t.ctx, t.cajero, { type: 'out', amountCents: pesos(3000), reason: 'Pago a proveedor de hielo' });
  addCashMovement(t.ctx, t.cajero, { type: 'in', amountCents: pesos(500), reason: 'Cambio' });
  closeShift(t.ctx, t.cajero, { countedCashCents: pesos(10000 + 11000 - 3000 + 500 - 200) });
  const s = get(t.ctx.db, 'SELECT * FROM shifts');
  assert.equal(s.expected_cash_cents, pesos(10000 + 11000 - 3000 + 500));
  assert.equal(s.cash_diff_cents, -pesos(200)); // faltaron $200
});

test('conteo al cerrar ajusta el stock y queda como diferencia, no como venta', () => {
  const t = testContext();
  const emp = t.product('Empanada');
  restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 100 }] });
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  createSale(t.ctx, t.cajero, {
    items: [{ kind: 'product', id: emp.id, qty: 30 }],
    payments: [{ method: 'efectivo', amountCents: pesos(2200 * 30) }],
  });
  const shiftId = get(t.ctx.db, 'SELECT id FROM shifts').id;
  closeShift(t.ctx, t.cajero, { countedCashCents: pesos(2200 * 30), stockCounts: [{ productId: emp.id, qty: 68 }] });
  const row = shiftReport(t.ctx, shiftId).inventory.find((i) => i.name === 'Empanada');
  assert.equal(row.closingSystem, 70);
  assert.equal(row.closingCounted, 68);
  assert.equal(row.difference, -2);
  assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id = ?', emp.id).stock, 68);
});

test('conteo al abrir pisa el stock del sistema ("con cuánto empecé")', () => {
  const t = testContext();
  const emp = t.product('Empanada');
  restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 40 }] });
  openShift(t.ctx, t.cajero, { openingCashCents: 0, stockCounts: [{ productId: emp.id, qty: 37 }] });
  const shiftId = get(t.ctx.db, 'SELECT id FROM shifts').id;
  const row = shiftReport(t.ctx, shiftId).inventory.find((i) => i.name === 'Empanada');
  assert.equal(row.opening, 37);
});

test('ingreso de mercadería durante el turno aparece como ingreso', () => {
  const t = testContext();
  const med = t.product('Medialuna');
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  restock(t.ctx, t.cajero, { items: [{ productId: med.id, qty: 250 }] });
  createSale(t.ctx, t.cajero, {
    items: [{ kind: 'product', id: med.id, qty: 190 }],
    payments: [{ method: 'efectivo', amountCents: pesos(900 * 190) }],
  });
  const shiftId = get(t.ctx.db, 'SELECT id FROM shifts').id;
  const row = shiftReport(t.ctx, shiftId).inventory.find((i) => i.name === 'Medialuna');
  assert.deepEqual([row.opening, row.restock, row.sold, row.closingSystem], [0, 250, 190, 60]);
});

test('ajuste y merma exigen motivo; merma siempre resta', () => {
  const t = testContext();
  const emp = t.product('Empanada');
  restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 10 }] });
  assert.throws(() => adjust(t.ctx, t.cajero, { productId: emp.id, qty: -1, reason: '' }), /motivo/);
  adjust(t.ctx, t.cajero, { productId: emp.id, qty: 3, reason: 'Se cayeron', kind: 'waste' });
  assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id = ?', emp.id).stock, 7);
});

test('bloquear venta sin stock (opcional)', async () => {
  const { setSetting } = await import('../services/settings.js');
  const t = testContext();
  const emp = t.product('Empanada');
  openShift(t.ctx, t.cajero, { openingCashCents: 0 });
  const sale = () => createSale(t.ctx, t.cajero, {
    items: [{ kind: 'product', id: emp.id, qty: 1 }],
    payments: [{ method: 'efectivo', amountCents: pesos(2200) }],
  });
  sale(); // por defecto se permite (stock queda negativo y se ve en el reporte)
  assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id = ?', emp.id).stock, -1);
  setSetting(t.ctx, 'stock.blockOnNoStock', true);
  assert.throws(sale, /No hay stock suficiente/);
});
