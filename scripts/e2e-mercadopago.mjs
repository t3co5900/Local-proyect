// Prueba en navegador del cobro automático con un Mercado Pago SIMULADO.
//   npm run build && node scripts/e2e-mercadopago.mjs [carpeta-de-capturas]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const shots = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'mrcook-shots-mp'));
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrcook-e2e-mp-'));
const APP = 3797;
const FAKE = 3898;
const base = `http://127.0.0.1:${APP}`;
const chromePath = process.env.CHROMIUM_PATH || [
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

// ---- Mercado Pago simulado ----
const payments = [];
let nextId = 5000;
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer APP_USR-fake-token' && !url.pathname.startsWith('/__')) return json({}, 401);
  if (url.pathname === '/users/me') return json({ id: 1, nickname: 'MRCOOK_SIMULADO', email: 'local@example.com' });
  if (url.pathname === '/v1/payments/search') return json({ results: [...payments].reverse() });
  if (url.pathname === '/__pay') {
    const amount = Number(url.searchParams.get('amount'));
    const type = url.searchParams.get('type') || 'account_money';
    const now = new Date().toISOString();
    payments.push({ id: nextId++, status: 'approved', transaction_amount: amount, payment_type_id: type, payment_method_id: type === 'credit_card' ? 'visa' : 'account_money', date_created: now, date_approved: now, payer: { first_name: 'Lucía', last_name: 'Gómez' } });
    return json({ ok: true });
  }
  return json({}, 404);
});
await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));
const pay = (amount, type) => fetch(`http://127.0.0.1:${FAKE}/__pay?amount=${amount}&type=${type || ''}`);

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  env: { ...process.env, PORT: String(APP), MRCOOK_DATA_DIR: dataDir, MP_API_BASE: `http://127.0.0.1:${FAKE}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const check = (c, m) => { if (!c) throw new Error(`FALLÓ: ${m}`); console.log(`  ✔ ${m}`); };
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/bootstrap`)).ok) break; } catch { /* aún no */ } await new Promise((r) => setTimeout(r, 200)); }

  // preparación por API: encargado, Mercado Pago activado, stock y turno abierto
  let cookie = '';
  const api = async (m, u, b) => {
    const r = await fetch(base + u, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json();
  };
  const { pin } = await api('POST', '/api/setup', { fullName: 'Dueño del Local' });
  await api('POST', '/api/auth/login', { username: 'Dueño del Local', pin });
  await api('PUT', '/api/settings', { values: { 'mp.enabled': true, 'mp.accessToken': 'APP_USR-fake-token' } });
  const test = await api('POST', '/api/settings/test-mp', {});
  check(test.ok && test.account.nickname === 'MRCOOK_SIMULADO', 'Probar conexión reconoce la cuenta de Mercado Pago');
  const cat = await api('GET', '/api/catalog');
  const emp = cat.products.find((p) => p.name === 'Empanada');
  await api('POST', '/api/inventory/restock', { items: [{ productId: emp.id, qty: 100 }] });
  await api('POST', '/api/shifts/open', { openingCashCents: 0 });

  browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 820 }, locale: 'es-AR' })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|409)/.test(m.text())) errors.push(m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });

  await page.goto(base);
  await page.getByLabel('Usuario').fill('Dueño del Local');
  await page.getByLabel('Usuario').press('Enter');
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await page.locator('.pos').waitFor();
  const tile = page.locator('.tile:not(.promo) .nm', { hasText: /^Empanada$/ });

  console.log('QR: el cobro espera y se confirma solo');
  for (let i = 0; i < 3; i++) await tile.click();
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByRole('button', { name: /^Transferencia/ }).click();
  await page.getByRole('button', { name: /Cobrar .* · Transferencia/ }).click();
  await page.getByText(/Esperando el pago de/).waitFor();
  await shot('mp-1-esperando');
  check(true, 'la venta queda esperando el pago de $6.600');
  await new Promise((r) => setTimeout(r, 3500));
  check(await page.getByText(/Esperando el pago de/).isVisible(), 'sin pago en Mercado Pago, sigue esperando');
  await pay(6600);
  await page.getByText('Venta #1 registrada').waitFor({ timeout: 15000 });
  await shot('mp-2-confirmado');
  check(await page.locator('.paid-item, .modal').getByText('Transferencia').first().isVisible(), 'se confirmó solo y quedó como Transferencia');
  await page.getByRole('button', { name: /Listo/ }).click();
  const chip = page.locator('.recent-item').first().locator('.chip.m-transferencia');
  await chip.waitFor({ timeout: 8000 });
  check(!(await chip.innerText()).includes('✋'), 'aparece la tarjetita Transferencia, sin marca de "a mano"');
  await shot('mp-3-tarjetita');

  console.log('Tarjeta: el crédito lo define Mercado Pago, no el botón');
  await tile.click();
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByRole('button', { name: /^Débito/ }).click(); // la persona toca Débito...
  await page.getByRole('button', { name: /Cobrar .* · Débito/ }).click();
  await page.getByText(/Esperando el pago de/).waitFor();
  await pay(2200, 'credit_card'); // ...pero el cliente pagó con crédito
  await page.getByText('Venta #2 registrada').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Listo/ }).click();
  await page.locator('.recent-item').first().locator('.chip.m-credito').waitFor({ timeout: 8000 });
  check(true, 'la venta quedó como Crédito (lo que dijo Mercado Pago)');

  console.log('Sin internet: confirmar a mano');
  await new Promise((r) => fake.close(r));
  fake.closeAllConnections?.();
  await tile.click();
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
  await page.getByRole('button', { name: /^Transferencia/ }).click();
  await page.getByRole('button', { name: /Cobrar .* · Transferencia/ }).click();
  await page.getByText(/Sin conexión con Mercado Pago/).waitFor({ timeout: 15000 });
  await shot('mp-4-sin-internet');
  check(true, 'avisa que no hay conexión con Mercado Pago');
  await page.getByRole('button', { name: 'Confirmar a mano' }).click();
  await shot('mp-5-confirmar-a-mano');
  await page.getByRole('button', { name: 'Sí, ya llegó' }).click();
  await page.getByText('Venta #3 registrada').waitFor();
  await page.getByRole('button', { name: /Listo/ }).click();
  await page.locator('.recent-item', { hasText: '#3' }).locator('.chip', { hasText: '✋' }).waitFor({ timeout: 8000 });
  check(true, 'la venta manual queda marcada con ✋ en los últimos cobros');
  await shot('mp-6-marca-manual');

  check(errors.length === 0, `sin errores de consola/JS${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`\nTodo OK. Capturas en ${shots}`);
} catch (e) {
  console.error(`\n${e.message}\n--- log del servidor ---\n${serverLog}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
