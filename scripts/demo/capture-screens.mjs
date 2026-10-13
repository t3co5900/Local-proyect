// Captura las pantallas reales del programa con datos de demostración, para la
// presentación. Genera <salida>/shots/*.png, <salida>/exports/* y <salida>/manifest.json
//
//   node scripts/demo/capture-screens.mjs <carpeta-de-salida>
//
// Requiere: npm run build, Chromium (CHROMIUM_PATH) y que existan <salida>/demoA y <salida>/demoB
// (se crean con seed-demo.mjs: demoA --today=none, demoB --today=open).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const out = path.resolve(process.argv[2] || 'deck-assets');
const shotsDir = path.join(out, 'shots');
const expDir = path.join(out, 'exports');
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(expDir, { recursive: true });
const chromePath = process.env.CHROMIUM_PATH || [
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

const manifest = [];
const note = (id, description) => manifest.push({ id, file: `shots/${id}.png`, description });

// ---------- Mercado Pago simulado ----------
const payments = [];
let nextId = 9000;
let fake;
const startFake = () => new Promise((resolve) => {
  fake = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!url.pathname.startsWith('/__') && req.headers.authorization !== 'Bearer APP_USR-demo-token') return json({}, 401);
    if (url.pathname === '/users/me') return json({ id: 7, nickname: 'MRCOOK.LOCAL', email: 'cuenta@mrcook.example' });
    if (url.pathname === '/v1/payments/search') return json({ results: [...payments].reverse() });
    if (url.pathname === '/__pay') {
      const now = new Date().toISOString();
      const type = url.searchParams.get('type') || 'account_money';
      payments.push({ id: nextId++, status: 'approved', transaction_amount: Number(url.searchParams.get('amount')), payment_type_id: type, payment_method_id: type === 'credit_card' ? 'visa' : type === 'debit_card' ? 'debmaster' : 'account_money', date_created: now, date_approved: now, payer: { first_name: 'Lucía', last_name: 'Gómez' } });
      return json({ ok: true });
    }
    return json({}, 404);
  });
  fake.listen(3891, '127.0.0.1', resolve);
});
const pay = (amount, type) => fetch(`http://127.0.0.1:3891/__pay?amount=${amount}&type=${type || ''}`);

// ---------- servidores ----------
function startApp(dir, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(port), MRCOOK_DATA_DIR: dir, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d; });
  child.stderr.on('data', (d) => { child.log += d; });
  return child;
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).ok) return; } catch { /* aún no */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`el servidor del puerto ${port} no arrancó`);
}

const users = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'demo-users.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(out, 'demoB', 'demo-facts.json'), 'utf8'));

let browser;
const procs = [];
try {
  browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
  const newContext = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, deviceScaleFactor: 1.5, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', acceptDownloads: true });
    await ctx.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.toasts{display:none!important}.topbar{position:static!important}'; document.head.appendChild(s); }); });
    return ctx;
  };
  const snap = async (page, id, description, opts = {}) => {
    const file = path.join(shotsDir, `${id}.png`);
    if (opts.el) await opts.el.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: !!opts.full, clip: opts.clip });
    note(id, description);
    console.log(`  📷 ${id}`);
  };
  const login = async (page, base, who) => {
    await page.goto(base);
    await page.getByLabel('Usuario').fill(who.name);
    await page.getByLabel('Usuario').press('Enter');
    await page.keyboard.type(who.pin);
    await page.keyboard.press('Enter');
    await page.locator('.topbar').waitFor();
  };

  // las rutas del servidor de demostración se muestran como en la instalación recomendada en Windows
  const winPath = async (page, dir) => page.evaluate((d) => {
    const fix = (t) => t.split(d).join('C:\\MrCook\\datos\\backups').replace(/(C:\\MrCook\\datos\\backups)([^\s·]*)/g, (m, a, b) => a + b.replace(/\//g, '\\'));
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(d)) n.nodeValue = fix(n.nodeValue);
    document.querySelectorAll('input').forEach((i) => { if (i.value.includes(d)) i.value = fix(i.value); });
  }, dir);
  const nav = async (page, label) => { await page.locator('.nav').getByRole('link', { name: label }).click(); await page.waitForTimeout(500); };

  // =========================================================== FASE A: sin turno abierto
  console.log('Fase A: antes de abrir el turno');
  const dirA = path.join(out, 'demoA');
  const appA = startApp(dirA, 3791); procs.push(appA); await waitUp(3791);
  const baseA = 'http://127.0.0.1:3791';
  const uA = users(dirA);
  {
    const ctx = await newContext(); const page = await ctx.newPage();
    await page.goto(baseA);
    await page.getByLabel('Usuario').waitFor();
    await snap(page, 'login-vacio', 'Pantalla de ingreso: usuario y teclado numérico para el código de 4 dígitos.');
    await page.getByLabel('Usuario').fill('Laura Giménez');
    await page.getByLabel('Usuario').press('Enter');
    await page.keyboard.type('52');
    await snap(page, 'login-pin', 'Ingreso con el nombre de la persona y los primeros dígitos de su código (los puntos se van llenando).');
    await page.getByRole('link', { name: 'Fichar entrada / salida' }).click();
    await page.getByLabel('Usuario').fill('Martín Sosa');
    await page.getByLabel('Usuario').press('Enter');
    await page.keyboard.type('015');
    await snap(page, 'fichar-publico', 'Pantalla de fichaje (entrada/salida), a la que se llega sin abrir turno.');
    await ctx.close();

    const ctx2 = await newContext(); const p2 = await ctx2.newPage();
    await login(p2, baseA, uA.laura);
    await p2.locator('h1', { hasText: 'Abrir turno' }).waitFor();
    await p2.getByLabel('Efectivo inicial en la caja (fondo de cambio)').fill('20000');
    for (const n of ['Empanada', 'Pizza', 'Medialuna']) {
      const row = p2.locator('tr', { has: p2.locator('td', { hasText: new RegExp(`^${n}$`) }) });
      const sys = (await row.locator('td').nth(1).innerText()).replace(/\D/g, '');
      await row.locator('input').fill(sys);
    }
    await p2.getByLabel('Observaciones (opcional)').fill('');
    await snap(p2, 'abrir-turno', 'Abrir turno: quién lo abre, con cuánto efectivo arranca la caja y (opcional) el conteo de stock.', {});
    await ctx2.close();
  }
  appA.kill('SIGTERM'); procs.splice(procs.indexOf(appA), 1);

  // =========================================================== FASE B: día en curso
  console.log('Fase B: turno abierto con ventas');
  await startFake();
  const dirB = path.join(out, 'demoB');
  const appB = startApp(dirB, 3792, { MP_API_BASE: 'http://127.0.0.1:3891' }); procs.push(appB); await waitUp(3792);
  const baseB = 'http://127.0.0.1:3792';
  const uB = users(dirB);

  // Mercado Pago activado por API (como lo haría la encargada en Configuración)
  const adminApi = await (await newContext()).request;
  const lg = await adminApi.post(`${baseB}/api/auth/login`, { data: { username: uB.laura.name, pin: uB.laura.pin }, headers: { Origin: baseB } });
  if (!lg.ok()) throw new Error('no se pudo iniciar sesión por API');
  await adminApi.put(`${baseB}/api/settings`, { data: { values: { 'mp.enabled': true, 'mp.accessToken': 'APP_USR-demo-token' } }, headers: { Origin: baseB } });

  // ---------- cajero (Martín): venta y cobro
  {
    const ctx = await newContext(); const page = await ctx.newPage();
    await login(page, baseB, uB.martin);
    await page.locator('.pos').waitFor();
    await page.waitForTimeout(600);
    const tile = (n) => page.locator('.tile:not(.promo) .nm', { hasText: new RegExp(`^${n}$`) });
    const promo = (n) => page.locator('.tile.promo', { has: page.locator('.nm', { hasText: new RegExp(`^${n}$`) }) });

    await snap(page, 'pos-inicio', 'Pantalla de venta: promos arriba, productos con su stock, y a la derecha el carrito y los últimos cobros.');
    await page.getByRole('tab', { name: '★ Promos' }).click();
    await snap(page, 'pos-promos', 'Solapa de promos: combos a precio fijo, con lo que incluye cada uno.');
    await page.getByRole('tab', { name: 'Todo' }).click();

    // venta 1: efectivo con vuelto
    for (let i = 0; i < 4; i++) await tile('Empanada').click();
    await tile('Gaseosa').click();
    await snap(page, 'pos-carrito', 'Carrito armado: 4 empanadas y una gaseosa, con el total abajo y el botón Cobrar.');
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    await page.getByRole('button', { name: /^Efectivo/ }).click();
    await snap(page, 'cobro-metodos', 'Ventana de cobro: los cuatro medios de pago (Efectivo, Transferencia/QR, Débito, Crédito).');
    await page.getByLabel('¿Con cuánto paga el cliente?').fill('20000');
    await page.locator('.change-box .v').waitFor();
    await snap(page, 'cobro-efectivo', 'Cobro en efectivo: se escribe con cuánto paga el cliente y el sistema calcula el vuelto.');
    await page.getByRole('button', { name: /Cobrar .* en efectivo/ }).click();
    await page.getByText(/Venta #\d+ registrada/).waitFor();
    await snap(page, 'venta-lista', 'Venta registrada: muestra el total, cómo se pagó y el vuelto que hay que dar.');
    await page.getByRole('button', { name: /Listo/ }).click();

    // venta 2: pago mixto
    await tile('Pizza').click();
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    await page.getByRole('button', { name: /^Efectivo/ }).click();
    await page.getByLabel(/Monto/).fill('5000');
    await page.getByRole('button', { name: /Cobrar .* en efectivo/ }).click();
    await page.getByText(/Por cobrar/).waitFor();
    await page.getByRole('button', { name: /^Débito/ }).click();
    await snap(page, 'cobro-mixto', 'Pago mixto: ya se cobraron $5.000 en efectivo y falta el resto, que se paga con débito.');
    await page.getByRole('button', { name: /Cobrar .* · Débito/ }).click();
    await page.getByText(/Esperando el pago de/).waitFor();
    await snap(page, 'mp-esperando', 'Cobro con tarjeta o QR: la venta queda esperando que Mercado Pago confirme el pago.');
    await pay(8500, 'debit_card');
    await page.getByText(/Venta #\d+ registrada/).waitFor({ timeout: 20000 });
    await snap(page, 'mp-confirmado', 'El pago llegó solo: la venta se completó con las tarjetitas Efectivo y Débito.');
    await page.getByRole('button', { name: /Listo/ }).click();

    // venta 3: QR
    await promo('Combo 3 empanadas \\+ gaseosa').click();
    await promo('Combo 3 empanadas \\+ gaseosa').click();
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    await page.getByRole('button', { name: /^Transferencia/ }).click();
    await page.getByRole('button', { name: /Cobrar .* · Transferencia/ }).click();
    await page.getByText(/Esperando el pago de/).waitFor();
    await pay(17200, 'account_money');
    await page.getByText(/Venta #\d+ registrada/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: /Listo/ }).click();
    await page.waitForTimeout(1200);
    await snap(page, 'pos-ultimos-cobros', 'Últimos cobros del turno: cada venta con su tarjetita (Efectivo, Transferencia, Débito, Crédito).', { el: page.locator('aside.cart') });

    // anular (cajero necesita encargado)
    await page.locator('.recent-item').first().getByText('anular').click();
    await page.getByLabel('Motivo').fill('Se equivocó de producto');
    await page.getByLabel('Usuario del encargado').fill('Laura Giménez');
    await page.keyboard.type('05');
    await snap(page, 'anular-cajero', 'Anular una venta: el cajero necesita que la encargada ponga su usuario y su código.');
    await page.getByRole('button', { name: 'No anular' }).click();

    // sin internet
    await new Promise((r) => fake.close(r));
    fake.closeAllConnections?.();
    await tile('Alfajor').click();
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    await page.getByRole('button', { name: /^Transferencia/ }).click();
    await page.getByRole('button', { name: /Cobrar .* · Transferencia/ }).click();
    await page.getByText(/Sin conexión con Mercado Pago/).waitFor({ timeout: 20000 });
    await snap(page, 'mp-sin-internet', 'Si se cae internet: la pantalla avisa y permite confirmar el cobro a mano.');
    await page.getByRole('button', { name: 'Confirmar a mano' }).click();
    await snap(page, 'mp-confirmar-mano', 'Confirmar a mano: se pide estar segura de que el pago llegó.');
    await page.getByRole('button', { name: 'Sí, ya llegó' }).click();
    await page.getByText(/Venta #\d+ registrada/).waitFor();
    await page.getByRole('button', { name: /Listo/ }).click();
    await page.waitForTimeout(1200);
    await snap(page, 'pos-cobro-manual', 'Un cobro confirmado a mano queda marcado con una manito para revisarlo después.', { el: page.locator('aside.cart') });

    await nav(page, 'Caja');
    await page.locator('h1', { hasText: /Turno #\d+ abierto/ }).waitFor();
    await page.waitForTimeout(500);
    await snap(page, 'caja-cajero', 'La Caja vista por una cajera: ve lo vendido por medio de pago, pero no el efectivo que debería haber.');
    await ctx.close();
  }

  // ---------- encargada (Laura): caja, cierre, stock, reportes, administración
  {
    const ctx = await newContext(); const page = await ctx.newPage();
    await login(page, baseB, uB.laura);
    await page.locator('.pos').waitFor();

    await nav(page, 'Caja');
    await page.locator('h1', { hasText: /Turno #\d+ abierto/ }).waitFor();
    await page.waitForTimeout(500);
    await snap(page, 'caja-encargada', 'La Caja vista por la encargada: total vendido, cobros por medio de pago y el efectivo esperado en la caja.');
    await page.getByRole('button', { name: 'Retiro / ingreso de efectivo' }).click();
    await page.getByLabel('Monto').fill('3000');
    await page.getByLabel(/Motivo/).fill('Compra de servilletas');
    await snap(page, 'caja-retiro', 'Registrar un retiro de efectivo con su motivo, para que el cierre no dé faltante.');
    await page.getByRole('button', { name: 'Cancelar' }).click();

    await page.getByRole('button', { name: 'Cerrar turno' }).click();
    await page.getByLabel('Efectivo contado en la caja').fill('185400');
    await snap(page, 'cerrar-1', 'Cerrar turno, paso 1: contar el efectivo de la caja (sin ver cuánto "debería" haber).');
    await page.getByRole('button', { name: 'Siguiente' }).click();
    for (const n of ['Empanada', 'Pizza', 'Medialuna', 'Chipá']) {
      const row = page.locator('tr', { has: page.locator('td', { hasText: new RegExp(`^${n}$`) }) });
      const sys = (await row.locator('td').nth(1).innerText()).replace(/\D/g, '');
      await row.locator('input').fill(sys);
    }
    await snap(page, 'cerrar-2', 'Cerrar turno, paso 2: contar el stock que quedó (opcional pero recomendado).');
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await page.getByLabel('Observaciones (opcional)').fill('Todo en orden.');
    await snap(page, 'cerrar-3', 'Cerrar turno, paso 3: observaciones y confirmación final.');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // cierre del miércoles (el del ejemplo)
    await page.goto(`${baseB}/#/caja/turno/${facts.wedShiftId}`);
    await page.getByRole('heading', { name: /Cierre de turno #/ }).waitFor();
    await page.waitForTimeout(600);
    await snap(page, 'cierre-pantalla', 'Cierre de turno completo en pantalla (con botones Excel, PDF e Imprimir).', { full: true });
    await page.addStyleTag({ content: '.grid.cols-2{align-items:start!important}' });
    const card = (h) => page.locator('.card', { has: page.locator('h2', { hasText: h }) }).first();
    const head = await page.locator('.report-head').boundingBox();
    const stats = await page.locator('.grid.cols-4').first().boundingBox();
    await page.screenshot({ path: path.join(shotsDir, 'cierre-encabezado.png'), clip: { x: head.x, y: head.y - 0, width: head.width, height: stats.y + stats.height - head.y } });
    note('cierre-encabezado', 'Encabezado del cierre: quién fue el encargado, horarios y los cuatro números grandes (total, ventas, digital, efectivo).');
    await snap(page, 'cierre-cobros', 'Cierre: cobros por medio de pago, con subtotal digital, subtotal efectivo y total vendido.', { el: card('Cobros por medio de pago') });
    await snap(page, 'cierre-caja', 'Cierre: control de caja (efectivo inicial + ventas en efectivo − retiros = esperado; contado y diferencia).', { el: card('Control de caja') });
    await snap(page, 'cierre-productos', 'Cierre: unidades vendidas por producto, sueltas y dentro de promos, y promos vendidas.', { el: card('Productos vendidos') });
    await snap(page, 'cierre-inventario', 'Cierre: inventario del turno con inicio, ingresos, vendido, final según sistema y final contado.', { el: card('Inventario del turno') });
    const det = await card('Detalle de ventas').evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width }; });
    await page.screenshot({ path: path.join(shotsDir, 'cierre-detalle.png'), fullPage: true, clip: { x: det.x, y: det.y, width: det.width, height: 440 } });
    note('cierre-detalle', 'Cierre: detalle de ventas una por una (primeras filas), con hora, cajero, qué se vendió y cómo se pagó.');

    // exportaciones del cierre
    for (const [url, name] of [[`/api/shifts/${facts.wedShiftId}/export.pdf?detail=0`, 'cierre-miercoles.pdf'], [`/api/shifts/${facts.wedShiftId}/export.xlsx`, 'cierre-miercoles.xlsx']]) {
      const r = await ctx.request.get(baseB + url);
      fs.writeFileSync(path.join(expDir, name), await r.body());
    }

    await nav(page, 'Inventario');
    await page.locator('table.t').first().waitFor();
    await snap(page, 'inventario-stock', 'Inventario: stock actual de cada producto, con aviso de stock bajo.');
    await page.getByRole('button', { name: '+ Ingreso de mercadería' }).click();
    for (const [label, qty] of [['Empanada', 300], ['Pizza', 20], ['Alfajor', 200], ['Medialuna', 250], ['Chipá', 125]]) await page.getByLabel(`Entra: ${label}`, { exact: true }).fill(String(qty));
    await page.getByLabel('Proveedor / origen (opcional)').fill('Fábrica central');
    await page.getByLabel('Nota (opcional)').fill('Remito 0001-4521');
    await snap(page, 'inventario-ingreso', 'Ingreso de mercadería: se anota cuánto entró de cada producto, de quién y con qué remito.');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Ajuste / merma' }).click();
    const emp = await page.locator('select option', { hasText: /^Empanada/ }).first().getAttribute('value');
    await page.getByLabel('Producto', { exact: true }).selectOption(emp);
    await page.getByLabel('Cantidad', { exact: true }).fill('2');
    await page.getByLabel(/Motivo/).fill('Se cayeron al piso');
    await snap(page, 'inventario-merma', 'Registrar una merma (producto tirado o caído) con su motivo obligatorio.');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Movimientos' }).click();
    await page.locator('table.t').first().waitFor();
    await snap(page, 'inventario-movimientos', 'Movimientos de stock: cada ingreso, venta, merma o ajuste queda anotado con fecha y persona.');

    await nav(page, 'Fichaje');
    await page.getByText('Ahora en el local').waitFor();
    await page.getByLabel('Usuario').fill('Camila Ríos');
    await page.getByLabel('Usuario').press('Enter');
    await page.keyboard.type('81');
    await snap(page, 'fichaje', 'Fichaje: cada persona ficha su entrada y su salida con su código, y se ve quién está en el local.');
    await snap(page, 'fichaje-horas', 'Horas trabajadas por persona en la semana, y cada fichaje (la encargada puede corregirlos).', { el: page.locator('.card', { has: page.locator('h2', { hasText: 'Horas trabajadas' }) }) });

    await nav(page, 'Reportes');
    await page.getByText('Ventas por día').waitFor();
    const dFrom = page.getByLabel('Desde'); const dTo = page.getByLabel('Hasta');
    await dFrom.fill(facts.prevWeek.fromYmd); await dTo.fill(facts.prevWeek.toYmd);
    await page.waitForTimeout(900);
    await snap(page, 'reportes-semana', 'Reportes: ventas de toda una semana por día, por medio de pago, productos y stock.', { full: true });

    await nav(page, 'Administración');
    await page.getByRole('tab', { name: 'Usuarios' }).waitFor();
    await snap(page, 'admin-usuarios', 'Administración → Usuarios: el personal, su rol, y el botón para dar un código nuevo.');
    await page.getByRole('button', { name: '+ Nuevo usuario' }).click();
    await page.getByLabel('Nombre y apellido').fill('Sofía Paz');
    await snap(page, 'admin-nuevo-usuario', 'Crear una persona nueva: nombre y rol; el código de 4 dígitos lo asigna el sistema.');
    await page.getByRole('button', { name: /Crear y generar código/ }).click();
    await page.locator('.big-pin').waitFor();
    await snap(page, 'admin-codigo', 'El sistema muestra una sola vez el código de 4 dígitos al azar para entregárselo a la persona.');
    await page.getByRole('button', { name: 'Ya lo anoté' }).click();
    await page.getByRole('tab', { name: 'Productos' }).click();
    await page.getByText('Empanadas').first().waitFor();
    await snap(page, 'admin-productos', 'Administración → Productos: precios, control de stock y avisos de stock bajo.');
    await page.locator('tr', { has: page.locator('td', { hasText: /^Empanada$/ }) }).getByRole('button', { name: 'Editar' }).click();
    await snap(page, 'admin-producto-editar', 'Editar un producto: nombre, categoría, precio y si controla stock.');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('tab', { name: 'Promos' }).click();
    await page.getByText('Docena de empanadas').first().waitFor();
    await snap(page, 'admin-promos', 'Administración → Promos: combos a precio fijo, con cuánto ahorra el cliente.');
    await page.locator('tr', { has: page.locator('td', { hasText: /^Docena de empanadas$/ }) }).getByRole('button', { name: 'Editar' }).click();
    await snap(page, 'admin-promo-editar', 'Editar una promo: qué incluye y a qué precio, comparado con comprarlo suelto.');
    await page.getByRole('button', { name: 'Cancelar' }).click();

    await page.getByRole('tab', { name: 'Configuración' }).click();
    await page.getByText('Mercado Pago (cobros automáticos)').waitFor();
    await startFake(); // en la fase del cajero se apagó para mostrar el corte de internet
    await page.getByRole('button', { name: 'Probar conexión' }).click();
    await page.getByText(/Conexión correcta/).waitFor();
    await snap(page, 'admin-config-mp', 'Configuración de Mercado Pago: se pega el código de la cuenta y el botón "Probar conexión" confirma que funciona.', { el: page.locator('.card', { has: page.locator('h2', { hasText: 'Mercado Pago (cobros' }) }) });
    await winPath(page, path.join(dirB, 'backups'));
    await snap(page, 'admin-config-respaldos', 'Configuración de respaldos: carpeta en la PC y (opcional) conexión con Google Drive.', { el: page.locator('.card', { has: page.locator('h2', { hasText: 'Respaldos y Google Drive' }) }) });

    // respaldo de la semana pasada
    await ctx.request.post(`${baseB}/api/backups/run`, { data: { date: facts.prevWeek.fromYmd }, headers: { Origin: baseB } });
    await page.getByRole('tab', { name: 'Respaldos' }).click();
    await page.getByText('Respaldos semanales').waitFor();
    await page.waitForTimeout(600);
    await winPath(page, path.join(dirB, 'backups'));
    await snap(page, 'admin-respaldos', 'Administración → Respaldos: cada semana se guarda un Excel y una copia de la base de datos.');
    await page.getByRole('tab', { name: 'Auditoría' }).click();
    await page.getByText('Registro de acciones').waitFor();
    await page.waitForTimeout(500);
    await snap(page, 'admin-auditoria', 'Auditoría: quién hizo qué en las operaciones sensibles (anulaciones, cambios de precio, ajustes de stock).');
    await ctx.close();
  }

  // respaldo semanal generado: copiarlo como ejemplo
  const wk = fs.readdirSync(path.join(dirB, 'backups')).find((n) => /^\d{4}-W\d{2}$/.test(n) && fs.readdirSync(path.join(dirB, 'backups', n)).some((f) => f.endsWith('.xlsx')));
  if (wk) for (const f of fs.readdirSync(path.join(dirB, 'backups', wk))) if (f.endsWith('.xlsx')) fs.copyFileSync(path.join(dirB, 'backups', wk, f), path.join(expDir, 'resumen-semanal.xlsx'));
  appB.kill('SIGTERM');
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nListo: ${manifest.length} capturas en ${shotsDir}`);
} catch (e) {
  console.error(`\nFALLÓ: ${e.stack || e.message}`);
  for (const p of procs) console.error(p.log?.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const p of procs) p.kill('SIGTERM');
  fake?.close();
}
