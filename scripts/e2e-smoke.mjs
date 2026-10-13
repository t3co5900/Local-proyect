// Prueba de humo de punta a punta con un navegador real (Chromium).
//
//   npm run build && node scripts/e2e-smoke.mjs [carpeta-de-capturas]
//
// Levanta el servidor con una base de datos temporal, recorre el flujo completo
// (instalación, login con PIN, stock, turno, ventas, cierre, descargas) y guarda
// capturas. Variables: CHROMIUM_PATH (ruta al ejecutable de Chromium).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const shots = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'mrcook-shots'));
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrcook-e2e-'));
const PORT = 3799;
const base = `http://127.0.0.1:${PORT}`;
const chromePath = process.env.CHROMIUM_PATH || [
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  env: { ...process.env, PORT: String(PORT), MRCOOK_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => { if (!cond) fail(`FALLÓ: ${msg}`); console.log(`  ✔ ${msg}`); };

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/bootstrap`)).ok) return; } catch { /* todavía no */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`el servidor no arrancó:\n${serverLog}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, acceptDownloads: true, locale: 'es-AR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // los 401 de "consulta de sesión sin loguear" y "PIN incorrecto a propósito" son esperados
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`console: ${m.text()}`); });
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(shots, `${name}.png`), ...opts });

  console.log('Instalación inicial');
  await page.goto(base);
  await page.getByText('primera configuración').waitFor();
  await shot('01-setup');
  await page.getByLabel('Nombre y apellido del encargado').fill('Dueño del Local');
  await page.getByRole('button', { name: 'Crear encargado' }).click();
  await page.locator('.big-pin').waitFor();
  const pin = (await page.locator('.big-pin').innerText()).trim();
  check(/^\d{4}$/.test(pin), `el sistema asignó un código de 4 dígitos (${pin})`);
  await shot('02-pin-asignado');
  await page.getByRole('button', { name: 'Ir al ingreso' }).click();

  console.log('Login con usuario + PIN');
  await page.getByLabel('Usuario').fill('dueno del local');
  await page.getByLabel('Usuario').press('Enter');
  await page.keyboard.type('0000'); // PIN incorrecto
  await page.keyboard.press('Enter');
  await page.getByText('Usuario o código incorrecto').waitFor();
  check(true, 'un PIN incorrecto se rechaza con mensaje claro');
  await shot('03-login');
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Abrir turno' }).waitFor();
  check(true, 'sin turno abierto, el ingreso lleva a "Abrir turno"');

  console.log('Ingreso de mercadería');
  await page.getByRole('link', { name: 'Inventario' }).click();
  await page.getByRole('button', { name: '+ Ingreso de mercadería' }).click();
  for (const [label, qty] of [['Empanada', 300], ['Pizza', 20], ['Alfajor', 200], ['Medialuna', 250], ['Chipá', 125]]) {
    await page.getByLabel(`Entra: ${label}`, { exact: true }).fill(String(qty));
  }
  await page.getByLabel('Proveedor / origen (opcional)').fill('Fábrica central');
  await shot('04-restock');
  await page.getByRole('button', { name: 'Registrar ingreso' }).click();
  await page.getByText('Stock actual').first().waitFor();
  await page.locator('tr', { hasText: 'Empanada' }).first().getByText('300').waitFor();
  check(true, 'el stock refleja las 300 empanadas ingresadas');
  await shot('05-inventario');

  console.log('Apertura de turno');
  await page.getByRole('link', { name: 'Caja' }).click();
  await page.getByLabel('Efectivo inicial en la caja (fondo de cambio)').fill('20000');
  await shot('06-abrir-turno', { fullPage: true });
  await page.getByRole('button', { name: 'Abrir turno' }).click();
  await page.locator('.pos').waitFor();
  check(true, 'turno abierto y pantalla de venta lista');

  console.log('Venta 1: promo + sueltas, efectivo con vuelto');
  await page.locator('.tile.promo', { has: page.locator('.nm', { hasText: /^Docena de empanadas$/ }) }).click();
  await page.locator('.tile:not(.promo) .nm', { hasText: /^Empanada$/ }).click();
  await page.locator('.tile:not(.promo) .nm', { hasText: /^Empanada$/ }).click();
  await shot('07-pos-carrito');
  check((await page.locator('.cart-total .v').innerText()).includes('28.400'), 'total = docena $24.000 + 2 empanadas $4.400 = $28.400');
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByRole('button', { name: /^Efectivo/ }).click();
  await page.getByLabel('¿Con cuánto paga el cliente?').fill('30000');
  await page.locator('.change-box .v').waitFor();
  check((await page.locator('.change-box .v').innerText()).includes('1.600'), 'vuelto calculado: $1.600');
  await shot('08-cobro-efectivo');
  await page.getByRole('button', { name: /Cobrar .* en efectivo/ }).click();
  await page.getByText('Venta #1 registrada').waitFor();
  check((await page.locator('.change-box .v').innerText()).includes('1.600'), 'la venta muestra el vuelto para el cliente');
  await shot('09-venta-lista');
  await page.getByRole('button', { name: /Listo/ }).click();

  console.log('Venta 2: transferencia (confirmación manual, Mercado Pago apagado)');
  await page.locator('.tile:not(.promo) .nm', { hasText: /^Pizza$/ }).click();
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByRole('button', { name: /^Transferencia/ }).click();
  await shot('10-cobro-transferencia');
  await page.getByRole('button', { name: /Confirmo que cobré/ }).click();
  await page.getByText('Venta #2 registrada').waitFor();
  await page.getByRole('button', { name: /Listo/ }).click();

  console.log('Venta 3: pago mixto (efectivo + débito)');
  await page.locator('.tile:not(.promo) .nm', { hasText: /^Alfajor$/ }).click();
  await page.locator('.tile:not(.promo) .nm', { hasText: /^Alfajor$/ }).click();
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByRole('button', { name: /^Efectivo/ }).click();
  await page.getByLabel(/Monto/).fill('1000');
  await page.getByRole('button', { name: /Cobrar .* en efectivo/ }).click();
  await page.getByText(/Por cobrar/).waitFor();
  await page.getByRole('button', { name: /^Débito/ }).click();
  await shot('11-cobro-mixto');
  await page.getByRole('button', { name: /Confirmo que cobré/ }).click();
  await page.getByText('Venta #3 registrada').waitFor();
  await page.getByRole('button', { name: /Listo/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.recent-item').length === 3, null, { timeout: 8000 });
  check((await page.locator('.recent-item').count()) === 3, 'los últimos cobros listan las 3 ventas');
  check((await page.locator('.recent-item .chip.m-efectivo').count()) >= 2 && (await page.locator('.recent-item .chip.m-transferencia').count()) === 1 && (await page.locator('.recent-item .chip.m-debito').count()) === 1, 'cada venta muestra su tarjetita de medio de pago');
  await shot('12-pos-ultimos-cobros');

  console.log('Anular una venta como encargado');
  await page.locator('.recent-item', { hasText: '#2' }).getByText('anular').click();
  await page.getByLabel('Motivo').fill('Error de carga');
  await page.getByRole('button', { name: 'Anular venta' }).click();
  await page.locator('.recent-item.void').waitFor();
  check(true, 'la venta #2 quedó anulada');

  console.log('Caja y cierre de turno');
  await page.getByRole('link', { name: 'Caja' }).click();
  await page.getByText('Cobros por medio de pago').waitFor();
  await shot('13-caja-turno-abierto', { fullPage: true });
  await page.getByRole('button', { name: 'Cerrar turno' }).click();
  await page.getByLabel('Efectivo contado en la caja').fill('50700'); // 20000 + 28400 + 1000 + 1300... ajustado abajo
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Contado: Empanada', { exact: true }).fill('165');
  await shot('14-cierre-paso-2');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Observaciones (opcional)').fill('Prueba de cierre');
  await page.getByRole('button', { name: /Cerrar turno definitivamente/ }).click();
  await page.getByRole('heading', { name: /Cierre de turno #1/ }).waitFor();
  await shot('15-reporte-cierre', { fullPage: true });
  const reportText = await page.locator('main').innerText();
  check(reportText.includes('Dueño del Local'), 'el cierre indica quién fue el encargado');
  check(/Efectivo/.test(reportText) && /Transferencia/.test(reportText) && /Débito/.test(reportText) && /Crédito/.test(reportText), 'el cierre desglosa efectivo, transferencia, débito y crédito');
  check(/Subtotal digital/.test(reportText) && /TOTAL VENDIDO/.test(reportText), 'el cierre muestra subtotal digital, efectivo y total');
  check(/Inventario del turno/.test(reportText) && /Final \(contado\)/.test(reportText), 'el cierre incluye el inventario con inicio, vendido y final');

  console.log('Descargas');
  for (const [label, ext] of [['Descargar Excel', 'xlsx'], ['Descargar PDF', 'pdf']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label }).click()]);
    const file = path.join(shots, `descarga.${ext}`);
    await dl.saveAs(file);
    const size = fs.statSync(file).size;
    check(size > 5000 && dl.suggestedFilename().endsWith(ext), `${label}: ${dl.suggestedFilename()} (${size} bytes)`);
  }

  console.log('Pantallas de administración');
  await page.getByRole('link', { name: 'Administración' }).click();
  await shot('16-admin-usuarios');
  await page.getByRole('tab', { name: 'Productos' }).click();
  await page.getByText('Los precios cargados son de ejemplo').first().waitFor();
  await shot('17-admin-productos', { fullPage: true });
  await page.getByRole('tab', { name: 'Promos' }).click();
  await shot('18-admin-promos');
  await page.getByRole('tab', { name: 'Configuración' }).click();
  await page.getByText('Mercado Pago (cobros automáticos)').waitFor();
  await shot('19-admin-config', { fullPage: true });
  await page.getByRole('link', { name: 'Reportes' }).click();
  await page.getByText('Ventas por día').waitFor();
  await shot('20-reportes', { fullPage: true });
  await page.getByRole('link', { name: 'Fichaje' }).click();
  await shot('21-fichaje');

  console.log('Pantalla de venta en tablet');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('link', { name: 'Vender' }).click();
  await shot('22-pos-tablet');

  check(errors.length === 0, `sin errores de consola/JS${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nTodo OK. Capturas en ${shots}`);
} catch (e) {
  console.error(`\n${e.message}`);
  console.error('--- log del servidor ---\n' + serverLog);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
