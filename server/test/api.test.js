import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import ExcelJS from 'exceljs';
import { get } from '../db.js';
import { restock } from '../services/inventory.js';
import { jsonResponse, startServer, testContext, tmpDir } from './helpers.js';

const pesos = (n) => n * 100;

describe('API: arranque, login y permisos', () => {
  let t; let srv;
  before(async () => {
    t = testContext({ seed: false });
    srv = await startServer(t);
  });
  after(() => srv.close());

  test('el setup crea el primer administrador una sola vez', async () => {
    // testContext ya creó 2 usuarios: simulamos instalación limpia con otra base
    const fresh = testContext({ seed: false });
    get(fresh.ctx.db, 'SELECT 1');
    fresh.ctx.db.exec('DELETE FROM user_login_keys; DELETE FROM users;');
    const s2 = await startServer(fresh);
    try {
      const c = s2.client();
      assert.equal((await c.get('/api/bootstrap')).json.needsSetup, true);
      const r = await c.post('/api/setup', { fullName: 'Dueño del Local' });
      assert.equal(r.status, 201);
      assert.match(r.json.pin, /^\d{4}$/);
      assert.equal(r.json.user.role, 'admin');
      assert.equal((await c.post('/api/setup', { fullName: 'Otro Tipo' })).status, 409);
      assert.equal((await c.get('/api/bootstrap')).json.needsSetup, false);
      // el catálogo de ejemplo quedó cargado
      const login = await c.login('Dueño del Local', r.json.pin);
      assert.equal(login.status, 200);
      assert.ok((await c.get('/api/catalog')).json.products.length >= 7);
    } finally { await s2.close(); }
  });

  test('rutas protegidas piden sesión', async () => {
    const c = srv.client();
    assert.equal((await c.get('/api/catalog')).status, 401);
    assert.equal((await c.get('/api/users')).status, 401);
  });

  test('se puede ingresar con nombre completo o inicial + apellido, sin tildes ni mayúsculas', async () => {
    for (const name of ['Carlos Pérez', 'carlos perez', 'CPEREZ', 'C. Perez', 'c perez']) {
      const r = await srv.client().login(name, t.cajeroPin);
      assert.equal(r.status, 200, name);
      assert.equal(r.json.user.fullName, 'Carlos Pérez');
    }
  });

  test('credenciales incorrectas dan el mismo mensaje exista o no el usuario', async () => {
    const a = await srv.client().login('Carlos Pérez', '0000');
    const b = await srv.client().login('Nadie Existe', '0000');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.error.message, b.json.error.message);
  });

  test('5 PIN incorrectos bloquean al usuario aunque después acierte', async () => {
    const lockT = testContext({ seed: false });
    const s = await startServer(lockT);
    try {
      const wrong = lockT.cajeroPin === '2580' ? '2581' : '2580';
      let last;
      for (let i = 0; i < 5; i++) last = await s.client().login('Carlos Pérez', wrong);
      assert.equal(last.status, 401);
      const locked = await s.client().login('Carlos Pérez', lockT.cajeroPin);
      assert.equal(locked.status, 429);
      assert.match(locked.json.error.message, /bloqueado/);
      lockT.advance(6 * 60 * 1000); // pasan 6 minutos
      assert.equal((await s.client().login('Carlos Pérez', lockT.cajeroPin)).status, 200);
    } finally { await s.close(); }
  });

  test('un cajero no puede usar rutas de encargado', async () => {
    const c = srv.client();
    await c.login('Carlos Pérez', t.cajeroPin);
    assert.equal((await c.get('/api/users')).status, 403);
    assert.equal((await c.get('/api/settings')).status, 403);
    assert.equal((await c.post('/api/admin/products', { categoryId: 1, name: 'X', priceCents: 100 })).status, 403);
    assert.equal((await c.get('/api/reports/period')).status, 403);
  });

  test('pedidos que cambian datos desde otro origen se rechazan', async () => {
    const c = srv.client();
    const r = await c.post('/api/auth/login', { username: 'Carlos Pérez', pin: t.cajeroPin }, { Origin: 'http://sitio-malicioso.example' });
    assert.equal(r.status, 403);
  });

  test('la sesión caduca por inactividad, no por antigüedad (un turno largo no se corta)', async () => {
    const st = testContext({ seed: false });
    const s = await startServer(st);
    try {
      const c = s.client();
      await c.login('Carlos Pérez', st.cajeroPin);
      for (let i = 0; i < 4; i++) { // 4 × 11 h = 44 h de turno con actividad cada 11 h
        st.advance(11 * 3600 * 1000);
        assert.equal((await c.get('/api/auth/me')).status, 200, `a las ${(i + 1) * 11} h`);
      }
      st.advance(13 * 3600 * 1000); // 13 h sin actividad
      assert.equal((await c.get('/api/auth/me')).status, 401);
    } finally { await s.close(); }
  });

  test('la cookie de sesión es HttpOnly y SameSite=Strict', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Ana Admin', pin: t.adminPin }),
    });
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
  });

  test('admin crea usuarios con PIN aleatorio de 4 dígitos y puede regenerarlo', async () => {
    const c = srv.client();
    await c.login('Ana Admin', t.adminPin);
    const r = await c.post('/api/users', { fullName: 'María Laura Gómez', role: 'cajero' });
    assert.equal(r.status, 201);
    assert.match(r.json.pin, /^\d{4}$/);
    assert.equal((await srv.client().login('mgomez', r.json.pin)).status, 200);
    const reset = await c.post(`/api/users/${r.json.user.id}/reset-pin`);
    assert.match(reset.json.pin, /^\d{4}$/);
    assert.equal((await srv.client().login('mgomez', r.json.pin)).status, reset.json.pin === r.json.pin ? 200 : 401);
    // no se puede quedar sin administradores
    const me = (await c.get('/api/auth/me')).json.user;
    assert.equal((await c.patch(`/api/users/${me.id}`, { role: 'cajero' })).status, 409);
    // dos personas con la misma inicial+apellido: la segunda debe usar su nombre completo
    const dup = await c.post('/api/users', { fullName: 'Carla Pérez', role: 'cajero' });
    assert.equal(dup.status, 201);
    assert.ok(dup.json.warnings.length >= 1);
    assert.equal((await srv.client().login('carla perez', dup.json.pin)).status, 200);
    assert.equal((await srv.client().login('cperez', t.cajeroPin)).status, 200); // sigue siendo de Carlos
  });
});

describe('API: venta completa, anulación y exportaciones', () => {
  let t; let srv; let cajero; let admin; let emp; let docena;
  before(async () => {
    t = testContext();
    srv = await startServer(t);
    cajero = srv.client();
    admin = srv.client();
    await cajero.login('Carlos Pérez', t.cajeroPin);
    await admin.login('Ana Admin', t.adminPin);
    emp = t.product('Empanada');
    docena = t.promo('Docena de empanadas');
  });
  after(() => srv.close());

  test('no se puede vender sin turno abierto', async () => {
    const r = await cajero.post('/api/sales', {
      items: [{ kind: 'product', id: emp.id, qty: 1 }],
      payments: [{ method: 'efectivo', amountCents: pesos(2200) }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'no_open_shift');
  });

  test('abrir turno, vender, anular con encargado y cerrar', async () => {
    restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 100 }] });
    const open = await cajero.post('/api/shifts/open', { openingCashCents: pesos(10000), stockCounts: [{ productId: emp.id, qty: 100 }] });
    assert.equal(open.status, 201);
    assert.equal((await admin.post('/api/shifts/open', { openingCashCents: 0 })).status, 409);

    const s1 = await cajero.post('/api/sales', {
      items: [{ kind: 'promo', id: docena.id, qty: 1 }],
      payments: [{ method: 'efectivo', amountCents: pesos(24000), tenderedCents: pesos(25000) }],
    });
    assert.equal(s1.status, 201);
    assert.equal(s1.json.payments[0].changeCents, pesos(1000));
    const s2 = await cajero.post('/api/sales', {
      items: [{ kind: 'product', id: emp.id, qty: 3 }],
      payments: [{ method: 'transferencia', amountCents: pesos(6600) }],
    });
    assert.equal(s2.status, 201);

    const live = (await cajero.get('/api/shift/current')).json;
    assert.equal(live.live.totals.totalCents, pesos(30600));
    assert.equal(live.live.cash.expectedCents, null, 'el cajero no ve el efectivo esperado con el turno abierto');
    assert.equal((await admin.get('/api/shift/current')).json.live.cash.expectedCents, pesos(10000 + 24000), 'la encargada sí lo ve');
    assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id=?', emp.id).stock, 85);

    // cajero solo, no puede anular
    let v = await cajero.post(`/api/sales/${s2.json.id}/void`, { reason: 'Error de carga' });
    assert.equal(v.status, 403);
    assert.equal(v.json.error.code, 'needs_supervisor');
    // con el PIN equivocado del encargado, tampoco
    v = await cajero.post(`/api/sales/${s2.json.id}/void`, { reason: 'Error de carga', supervisor: { username: 'Ana Admin', pin: '0000' } });
    assert.equal(v.status, 401);
    // con el encargado correcto, sí
    v = await cajero.post(`/api/sales/${s2.json.id}/void`, { reason: 'Error de carga', supervisor: { username: 'Ana Admin', pin: t.adminPin } });
    assert.equal(v.status, 200);
    assert.equal(v.json.status, 'void');
    assert.match(v.json.refundNote, /Mercado Pago/);
    assert.equal(get(t.ctx.db, 'SELECT stock FROM products WHERE id=?', emp.id).stock, 88);
    // un cajero normal no puede usar a otro cajero como supervisor
    const nonAdmin = await cajero.post(`/api/sales/${s1.json.id}/void`, { reason: 'x y z', supervisor: { username: 'Carlos Pérez', pin: t.cajeroPin } });
    assert.equal(nonAdmin.status, 403);

    const close = await cajero.post('/api/shifts/close', { countedCashCents: pesos(34000) });
    assert.equal(close.status, 200);
    assert.equal((await cajero.post('/api/sales', {
      items: [{ kind: 'product', id: emp.id, qty: 1 }], payments: [{ method: 'efectivo', amountCents: pesos(2200) }],
    })).status, 409);
  });

  test('el efectivo esperado no se muestra a un cajero mientras el turno está abierto, y sí tras el cierre', async () => {
    const st = testContext();
    const s2 = await startServer(st);
    try {
      const caj = s2.client(); const adm = s2.client();
      await caj.login('Carlos Pérez', st.cajeroPin);
      await adm.login('Ana Admin', st.adminPin);
      await caj.post('/api/shifts/open', { openingCashCents: pesos(10000) });
      const shiftId = get(st.ctx.db, 'SELECT id FROM shifts').id;
      // cajero: ni el resumen en vivo, ni el reporte, ni los archivos del turno abierto muestran el esperado
      assert.equal((await caj.get('/api/shift/current')).json.live.cash.expectedCents, null);
      assert.equal((await caj.get(`/api/shifts/${shiftId}/report`)).json.cash.expectedCents, null);
      assert.equal((await caj.get(`/api/shifts/${shiftId}/export.pdf`)).status, 403);
      assert.equal((await caj.get(`/api/shifts/${shiftId}/export.xlsx`)).status, 403);
      // encargada: lo ve siempre
      assert.equal((await adm.get('/api/shift/current')).json.live.cash.expectedCents, pesos(10000));
      assert.equal((await adm.get(`/api/shifts/${shiftId}/export.xlsx`)).status, 200);
      // tras el cierre, el cajero que lo cerró ve el resultado completo
      await caj.post('/api/shifts/close', { countedCashCents: pesos(9800) });
      const rep = (await caj.get(`/api/shifts/${shiftId}/report`)).json;
      assert.equal(rep.cash.expectedCents, pesos(10000));
      assert.equal(rep.cash.diffCents, -pesos(200));
      assert.equal((await caj.get(`/api/shifts/${shiftId}/export.pdf`)).status, 200);
    } finally { await s2.close(); }
  });

  test('Excel del cierre: hojas, valores y fórmulas', async () => {
    const shiftId = get(t.ctx.db, 'SELECT id FROM shifts').id;
    const r = await cajero.get(`/api/shifts/${shiftId}/export.xlsx`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /Cierre-turno-\d+\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Cierre', 'Productos vendidos', 'Inventario', 'Detalle de ventas', 'Movimientos de caja']);
    const cierre = wb.getWorksheet('Cierre');
    const flat = [];
    cierre.eachRow((row) => flat.push(row.values.slice(1)));
    const find = (label) => flat.find((v) => v[0] === label);
    assert.equal(find('Encargado (abrió el turno)')[1], 'Carlos Pérez');
    assert.equal(find('Efectivo')[1], 24000);
    assert.equal(find('Transferencia / QR')[1], 0); // la venta por transferencia fue anulada
    assert.equal(find('TOTAL VENDIDO')[1].result, 24000);
    assert.equal(find('TOTAL VENDIDO')[1].formula.startsWith('B'), true);
    const diffCell = find('Diferencia (contado − esperado)')[1];
    assert.ok(diffCell.formula, 'la diferencia es una fórmula');
    assert.equal(diffCell.result ?? 0, 0); // exceljs omite el 0 al leer, aunque el archivo lo trae
    const inv = wb.getWorksheet('Inventario');
    let row; inv.eachRow((rw) => { if (rw.getCell(1).value === 'Empanada') row = rw; });
    // columnas: Producto, Categoría, Inicio, Ingresos, Vendido, Ajustes, Final(sistema)
    // inicio 100, vendió 1 docena (la venta de 3 sueltas se anuló), final 88
    assert.deepEqual([3, 4, 5, 6].map((c) => row.getCell(c).value), [100, 0, 12, 0]);
    assert.equal(row.getCell(7).result ?? row.getCell(7).value, 88);
  });

  test('PDF del cierre es un PDF válido', async () => {
    const shiftId = get(t.ctx.db, 'SELECT id FROM shifts').id;
    const r = await cajero.get(`/api/shifts/${shiftId}/export.pdf?detail=1`);
    assert.equal(r.status, 200);
    assert.equal(r.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(r.buffer.length > 10_000);
  });

  test('un cajero no ve turnos que no abrió ni cerró', async () => {
    const other = srv.client();
    await other.login('Ana Admin', t.adminPin);
    await other.post('/api/shifts/open', { openingCashCents: 0 });
    await other.post('/api/shifts/close', { countedCashCents: 0 });
    const ids = (await other.get('/api/shifts')).json.shifts.map((s) => s.id);
    assert.equal(ids.length, 2);
    const mine = (await cajero.get('/api/shifts')).json.shifts;
    assert.equal(mine.length, 1);
    const foreign = ids.find((i) => !mine.some((m) => m.id === i));
    assert.equal((await cajero.get(`/api/shifts/${foreign}/report`)).status, 403);
  });
});

describe('Fichaje', () => {
  test('entrada, salida y errores', async () => {
    const t = testContext();
    const srv = await startServer(t);
    try {
      const c = srv.client(); // sin sesión: se ficha con usuario + código
      let r = await c.post('/api/timeclock/punch', { username: 'Carlos Pérez', pin: t.cajeroPin, action: 'in' });
      assert.equal(r.status, 200);
      assert.equal((await c.post('/api/timeclock/punch', { username: 'Carlos Pérez', pin: t.cajeroPin, action: 'in' })).status, 409);
      assert.equal((await c.post('/api/timeclock/punch', { username: 'Carlos Pérez', pin: '9999', action: 'out' })).status, 401);
      t.advance(7.5 * 3600 * 1000);
      r = await c.post('/api/timeclock/punch', { username: 'Carlos Pérez', pin: t.cajeroPin, action: 'out' });
      assert.equal(r.status, 200);
      assert.equal(r.json.workedMs, 7.5 * 3600 * 1000);
      assert.equal((await c.post('/api/timeclock/punch', { username: 'Carlos Pérez', pin: t.cajeroPin, action: 'out' })).status, 409);

      const a = srv.client();
      await a.login('Ana Admin', t.adminPin);
      const list = (await a.get('/api/timeclock?from=2026-10-12&to=2026-10-18')).json;
      assert.equal(list.hours.find((h) => h.userName === 'Carlos Pérez').hours, 7.5);
    } finally { await srv.close(); }
  });
});

describe('Mercado Pago (respuestas simuladas)', () => {
  const mpPayment = (id, amount, extra = {}) => ({
    id, status: 'approved', transaction_amount: amount, payment_type_id: 'account_money',
    payment_method_id: 'account_money', date_created: new Date(Date.UTC(2026, 9, 14, 12, 0, 20)).toISOString(),
    date_approved: new Date(Date.UTC(2026, 9, 14, 12, 0, 22)).toISOString(), payer: { first_name: 'Lucía', last_name: 'Gómez' }, ...extra,
  });

  async function setup(fetchImpl) {
    const t = testContext();
    t.ctx.fetch = fetchImpl;
    const srv = await startServer(t);
    const admin = srv.client();
    await admin.login('Ana Admin', t.adminPin);
    await admin.put('/api/settings', { values: { 'mp.enabled': true, 'mp.accessToken': 'APP_USR-test-token' } });
    const cajero = srv.client();
    await cajero.login('Carlos Pérez', t.cajeroPin);
    await cajero.post('/api/shifts/open', { openingCashCents: 0 });
    return { t, srv, admin, cajero };
  }

  test('cobro QR: se confirma solo cuando aparece el pago por ese monto, y no se puede reutilizar', async () => {
    let payments = [];
    const calls = [];
    const { t, srv, cajero } = await setup(async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization });
      return jsonResponse({ results: payments });
    });
    try {
      const emp = t.product('Empanada');
      const ch = await cajero.post('/api/charges', { kind: 'qr', amountCents: pesos(6600) });
      assert.equal(ch.status, 201);
      let st = await cajero.get(`/api/charges/${ch.json.id}`);
      assert.equal(st.json.status, 'pending');
      assert.equal(calls[0].auth, 'Bearer APP_USR-test-token');
      assert.match(calls[0].url, /api\.mercadopago\.com\/v1\/payments\/search/);

      payments = [mpPayment(111, 3000), mpPayment(222, 6600)]; // solo el 222 coincide
      t.advance(3000);
      st = await cajero.get(`/api/charges/${ch.json.id}`);
      assert.equal(st.json.status, 'confirmed');
      assert.equal(st.json.mpPaymentId, '222');
      assert.equal(st.json.resolvedMethod, 'transferencia');
      assert.equal(st.json.matched.payer, 'Lucía Gómez');

      const sale = await cajero.post('/api/sales', {
        items: [{ kind: 'product', id: emp.id, qty: 3 }],
        payments: [{ method: 'transferencia', amountCents: pesos(6600), chargeId: ch.json.id }],
      });
      assert.equal(sale.status, 201);
      assert.equal(sale.json.payments[0].confirmation, 'auto');
      assert.equal(sale.json.payments[0].mpPaymentId, '222');

      // el mismo cobro no sirve para otra venta
      const again = await cajero.post('/api/sales', {
        items: [{ kind: 'product', id: emp.id, qty: 3 }],
        payments: [{ method: 'transferencia', amountCents: pesos(6600), chargeId: ch.json.id }],
      });
      assert.equal(again.status, 409);
      // y el pago 222 ya reclamado no confirma un cobro nuevo del mismo monto
      const ch2 = await cajero.post('/api/charges', { kind: 'qr', amountCents: pesos(6600) });
      t.advance(3000);
      assert.equal((await cajero.get(`/api/charges/${ch2.json.id}`)).json.status, 'pending');
    } finally { await srv.close(); }
  });

  test('con tarjeta, el débito/crédito lo define Mercado Pago, no el botón', async () => {
    const { t, srv, cajero } = await setup(async () => jsonResponse({
      results: [mpPayment(333, 2200, { payment_type_id: 'credit_card', payment_method_id: 'visa' })],
    }));
    try {
      const ch = await cajero.post('/api/charges', { kind: 'tarjeta', amountCents: pesos(2200) });
      t.advance(3000);
      const st = await cajero.get(`/api/charges/${ch.json.id}`);
      assert.equal(st.json.resolvedMethod, 'credito');
      const sale = await cajero.post('/api/sales', {
        items: [{ kind: 'product', id: t.product('Empanada').id, qty: 1 }],
        payments: [{ method: 'debito', amountCents: pesos(2200), chargeId: ch.json.id }], // el cajero tocó "débito"
      });
      assert.equal(sale.json.payments[0].method, 'credito');
    } finally { await srv.close(); }
  });

  test('dos pagos con el mismo monto: no adivina, deja elegir', async () => {
    const { t, srv, cajero } = await setup(async () => jsonResponse({ results: [mpPayment(1, 2200), mpPayment(2, 2200)] }));
    try {
      const ch = await cajero.post('/api/charges', { kind: 'qr', amountCents: pesos(2200) });
      t.advance(3000);
      const st = await cajero.get(`/api/charges/${ch.json.id}`);
      assert.equal(st.json.status, 'pending');
      assert.equal(st.json.candidates.length, 2);
      const picked = await cajero.post(`/api/charges/${ch.json.id}/pick`, { paymentId: '2' });
      assert.equal(picked.json.status, 'confirmed');
      assert.equal(picked.json.mpPaymentId, '2');
    } finally { await srv.close(); }
  });

  test('pagos viejos (fuera de la ventana) no se toman como el cobro actual', async () => {
    const old = mpPayment(9, 2200, { date_approved: new Date(Date.UTC(2026, 9, 14, 11, 0, 0)).toISOString() });
    const { t, srv, cajero } = await setup(async () => jsonResponse({ results: [old] }));
    try {
      const ch = await cajero.post('/api/charges', { kind: 'qr', amountCents: pesos(2200) });
      t.advance(3000);
      assert.equal((await cajero.get(`/api/charges/${ch.json.id}`)).json.status, 'pending');
    } finally { await srv.close(); }
  });

  test('sin internet: el cobro queda pendiente con aviso y se puede confirmar a mano', async () => {
    const { t, srv, cajero } = await setup(async () => { throw new TypeError('fetch failed'); });
    try {
      const ch = await cajero.post('/api/charges', { kind: 'qr', amountCents: pesos(2200) });
      const st = await cajero.get(`/api/charges/${ch.json.id}`);
      assert.equal(st.json.status, 'pending');
      assert.match(st.json.lastError, /Sin conexión/);
      await cajero.post(`/api/charges/${ch.json.id}/cancel`);
      const sale = await cajero.post('/api/sales', {
        items: [{ kind: 'product', id: t.product('Empanada').id, qty: 1 }],
        payments: [{ method: 'transferencia', amountCents: pesos(2200) }], // sin chargeId => manual
      });
      assert.equal(sale.status, 201);
      assert.equal(sale.json.payments[0].confirmation, 'manual');
    } finally { await srv.close(); }
  });

  test('token rechazado: error claro', async () => {
    const { srv, admin } = await setup(async () => new Response('{}', { status: 401 }));
    try {
      const r = await admin.post('/api/settings/test-mp', {});
      assert.equal(r.json.ok, false);
      assert.match(r.json.message, /rechaz/);
    } finally { await srv.close(); }
  });

  test('el Access Token no se devuelve nunca al navegador', async () => {
    const { srv, admin } = await setup(async () => jsonResponse({}));
    try {
      const r = await admin.get('/api/settings');
      assert.equal(r.json.values['mp.accessToken'], '');
      assert.equal(r.json.secretsSet['mp.accessToken'], true);
      assert.ok(!JSON.stringify(r.json).includes('APP_USR-test-token'));
    } finally { await srv.close(); }
  });

  test('sin Mercado Pago configurado, crear un cobro avisa que se confirme a mano', async () => {
    const t = testContext();
    const srv = await startServer(t);
    try {
      const c = srv.client();
      await c.login('Carlos Pérez', t.cajeroPin);
      await c.post('/api/shifts/open', { openingCashCents: 0 });
      const r = await c.post('/api/charges', { kind: 'qr', amountCents: 100 });
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'mp_disabled');
    } finally { await srv.close(); }
  });
});

describe('Reportes y respaldos', () => {
  test('ventas del período se agrupan por día en horario de Argentina', async () => {
    const t = testContext({ start: Date.UTC(2026, 9, 14, 12, 0, 0) });
    const srv = await startServer(t);
    try {
      const c = srv.client();
      await c.login('Carlos Pérez', t.cajeroPin);
      const emp = t.product('Empanada');
      await c.post('/api/shifts/open', { openingCashCents: 0 });
      const sell = async () => {
        const r = await c.post('/api/sales', { items: [{ kind: 'product', id: emp.id, qty: 1 }], payments: [{ method: 'efectivo', amountCents: pesos(2200) }] });
        assert.equal(r.status, 201, JSON.stringify(r.json));
      };
      await sell(); // 14/10 09:00 ART
      t.clock.t = Date.UTC(2026, 9, 15, 2, 30, 0); // 14/10 23:30 ART (ya es 15/10 en UTC)
      await c.login('Carlos Pérez', t.cajeroPin); // pasaron >12 h sin actividad: la sesión venció
      await sell();
      t.clock.t = Date.UTC(2026, 9, 15, 3, 30, 0); // 15/10 00:30 ART
      await sell();
      const a = srv.client();
      await a.login('Ana Admin', t.adminPin);
      const rep = (await a.get('/api/reports/period?from=2026-10-12&to=2026-10-18')).json;
      assert.deepEqual(rep.daily.map((d) => [d.day, d.salesCount]), [['2026-10-14', 2], ['2026-10-15', 1]]);
      assert.equal(rep.totals.totalCents, pesos(6600));
    } finally { await srv.close(); }
  });

  test('stock del período se reconstruye: inicio + ingresos − vendido = final', async () => {
    const t = testContext({ start: Date.UTC(2026, 9, 14, 12, 0, 0) });
    const srv = await startServer(t);
    try {
      const emp = t.product('Empanada');
      restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 50 }] }); // antes del período
      t.clock.t = Date.UTC(2026, 9, 19, 12, 0, 0); // lunes 19/10: arranca la semana 43
      const c = srv.client();
      await c.login('Carlos Pérez', t.cajeroPin);
      await c.post('/api/shifts/open', { openingCashCents: 0 });
      restock(t.ctx, t.cajero, { items: [{ productId: emp.id, qty: 300 }] });
      await c.post('/api/sales', { items: [{ kind: 'product', id: emp.id, qty: 134 }], payments: [{ method: 'efectivo', amountCents: pesos(2200 * 134) }] });
      const a = srv.client();
      await a.login('Ana Admin', t.adminPin);
      const rep = (await a.get('/api/reports/period?from=2026-10-19&to=2026-10-25')).json;
      const row = rep.inventory.find((i) => i.name === 'Empanada');
      assert.deepEqual([row.start, row.restock, row.sold, row.end], [50, 300, 134, 216]);
    } finally { await srv.close(); }
  });

  test('respaldo semanal: Excel + copia de la base en disco, y se puede abrir', async () => {
    const dir = tmpDir();
    const t = testContext({ overrides: { backupDir: dir } });
    const srv = await startServer(t);
    try {
      const c = srv.client();
      await c.login('Carlos Pérez', t.cajeroPin);
      await c.post('/api/shifts/open', { openingCashCents: 0 });
      await c.post('/api/sales', { items: [{ kind: 'product', id: t.product('Pizza').id, qty: 2 }], payments: [{ method: 'debito', amountCents: pesos(27000) }] });
      const a = srv.client();
      await a.login('Ana Admin', t.adminPin);
      const r = await a.post('/api/backups/run', { date: '2026-10-14' });
      assert.equal(r.json.status, 'ok');
      assert.equal(r.json.label, '2026-W42');
      const fs = await import('node:fs');
      const files = fs.readdirSync(`${dir}/2026-W42`).sort();
      assert.deepEqual(files, ['MrCook_Resumen-semanal_2026-W42.xlsx', 'MrCook_base-de-datos_2026-W42.sqlite']);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(`${dir}/2026-W42/${files[0]}`);
      assert.ok(wb.getWorksheet('Resumen') && wb.getWorksheet('Stock') && wb.getWorksheet('Ingresos de mercadería'));
      const { DatabaseSync } = await import('node:sqlite');
      const copy = new DatabaseSync(`${dir}/2026-W42/${files[1]}`);
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
      copy.close();
    } finally { await srv.close(); }
  });

  test('Google Drive: sube a la carpeta propia; si falla, el respaldo local queda igual (parcial)', async () => {
    const calls = [];
    const driveFetch = async (url, init = {}) => {
      const u = String(url);
      calls.push(`${init.method || 'GET'} ${u.replace(/\?.*/, '')}`);
      if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'at', expires_in: 3600 });
      if (u.includes('/drive/v3/files?q=') && u.includes('mimeType')) return jsonResponse({ files: [] });
      if (u.includes('/drive/v3/files?q=')) return jsonResponse({ files: [] });
      if (u.includes('/drive/v3/files?fields')) return jsonResponse({ id: 'FOLDER1' });
      if (u.includes('/upload/drive/v3/files')) return jsonResponse({ id: 'FILE' + calls.length });
      return jsonResponse({}, 404);
    };
    const dir = tmpDir();
    const t = testContext({ overrides: { backupDir: dir } });
    t.ctx.fetch = driveFetch;
    const srv = await startServer(t);
    try {
      const a = srv.client();
      await a.login('Ana Admin', t.adminPin);
      await a.put('/api/settings', { values: {
        'backup.drive.enabled': true, 'backup.drive.clientId': 'cid', 'backup.drive.clientSecret': 'secret', 'backup.drive.refreshToken': 'rt',
      } });
      const c = srv.client();
      await c.login('Carlos Pérez', t.cajeroPin);
      await c.post('/api/shifts/open', { openingCashCents: 0 });
      const ok = (await a.post('/api/backups/run', { date: '2026-10-14' })).json;
      assert.equal(ok.status, 'ok');
      assert.equal(ok.driveStatus, 'ok');
      assert.equal(calls.filter((x) => x.startsWith('POST') && x.includes('/upload/drive/v3/files')).length, 2); // xlsx + sqlite
      assert.equal(get(t.ctx.db, `SELECT value FROM settings WHERE key='backup.drive.folderId'`).value, '"FOLDER1"');

      t.ctx.fetch = async () => { throw new TypeError('fetch failed'); }; // se cae internet
      const bad = (await a.post('/api/backups/run', { date: '2026-10-14' })).json;
      assert.equal(bad.status, 'partial');
      const fs = await import('node:fs');
      assert.equal(fs.readdirSync(`${dir}/2026-W42`).length, 2, 'el respaldo local no depende de Drive');
    } finally { await srv.close(); }
  });

  test('el respaldo semanal automático se pone al día solo si falta, y no se repite', async () => {
    const { checkWeeklyBackup } = await import('../services/backup.js');
    const dir = tmpDir();
    const t = testContext({ start: Date.UTC(2026, 9, 14, 12, 0, 0), overrides: { backupDir: dir } });
    const { openShift } = await import('../services/shifts.js');
    openShift(t.ctx, t.cajero, { openingCashCents: 0 }); // hay actividad en la semana 42
    t.clock.t = Date.UTC(2026, 9, 18, 12, 0, 0); // domingo 18/10: todavía es la semana 42
    assert.equal(await checkWeeklyBackup(t.ctx), null);
    t.clock.t = Date.UTC(2026, 9, 19, 12, 0, 0); // lunes 19/10: la semana 42 terminó
    const first = await checkWeeklyBackup(t.ctx);
    assert.equal(first.status, 'ok');
    assert.equal(first.label, '2026-W42');
    assert.equal(await checkWeeklyBackup(t.ctx), null);
  });
});
