import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { get } from './db.js';
import { inventoryWorkbook, periodWorkbook, shiftWorkbook } from './exports/xlsx.js';
import { shiftPdf } from './exports/pdf.js';
import { HttpError, badRequest, forbidden, notFound, unauthorized } from './util/errors.js';
import { endOfWeek, parseYmd, startOfNextDay, startOfWeek, isoWeekLabel } from './util/time.js';
import { listAudit } from './services/audit.js';
import { driveConfigured, listBackupRuns, runWeeklyBackup } from './services/backup.js';
import * as catalog from './services/catalog.js';
import { buildAuthUrl, createDriveClient, exchangeCode } from './services/drive.js';
import * as inventory from './services/inventory.js';
import * as charges from './services/payments/charges.js';
import { createMercadoPagoProvider } from './services/payments/mercadopago.js';
import { liveSummary, periodReport, shiftReport } from './services/reports.js';
import * as sales from './services/sales.js';
import { adminSettings, clearSecret, getSetting, publicSettings, setSetting, updateSettings } from './services/settings.js';
import * as shifts from './services/shifts.js';
import * as timeclock from './services/timeclock.js';
import * as users from './services/users.js';
import { getOpenShift } from './services/common.js';

const COOKIE = 'mrcook_sid';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------- utilidades HTTP ----------

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue.path.join('.') || 'datos';
    throw badRequest(`Dato inválido (${field}): ${issue.message}`, 'validation');
  }
  return r.data;
}

const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Identificador inválido.');
  return n;
};

function download(res, { buffer, filename, type }) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(buffer));
}

/** Límite simple por IP en memoria (anti fuerza bruta de PIN). */
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (req, _res, next) => {
    const key = req.ip;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) return next(new HttpError(429, 'Demasiados intentos. Esperá un minuto.', 'rate_limited'));
    next();
  };
}

const cents = z.number().int().min(0).max(1_000_000_000_00);
const posCents = z.number().int().min(1).max(1_000_000_000_00);
const qty = z.number().int().min(1).max(100000);
const ymdStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'usá el formato AAAA-MM-DD');

// ---------- app ----------

export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // sesión + defensa CSRF básica (la cookie es SameSite=Strict y además se valida Origin)
  app.use((req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.token = token || null;
    req.user = null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host;
        try { host = new URL(origin).host; } catch { host = null; }
        if (host !== req.headers.host) return next(forbidden('Origen no permitido.', 'bad_origin'));
      }
    }
    next();
  });

  const api = express.Router();
  const loginLimit = rateLimiter({ max: 40, windowMs: 60_000 });

  const auth = (req, _res, next) => {
    const u = users.userForToken(ctx, req.token);
    if (!u) return next(unauthorized());
    req.user = u;
    next();
  };
  const admin = (req, _res, next) => (req.user.role === 'admin' ? next() : next(forbidden('Solo un encargado puede hacer esto.')));

  // cookie de sesión del navegador (sin Max-Age: se borra al cerrar la ventana);
  // la caducidad por inactividad la controla el servidor
  const setCookie = (res, token, { clear = false } = {}) =>
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${clear ? '; Max-Age=0' : ''}`);

  const sessionInfo = (user) => ({
    user: { id: user.id, fullName: user.full_name, role: user.role },
    settings: publicSettings(ctx),
    shift: openShiftSummary(),
  });

  function openShiftSummary() {
    const s = getOpenShift(ctx);
    if (!s) return null;
    const opener = get(ctx.db, 'SELECT full_name FROM users WHERE id = ?', s.opened_by);
    return { id: s.id, openedAt: s.opened_at, openedBy: opener.full_name, openingCashCents: s.opening_cash_cents };
  }

  // ---------- público: arranque, setup, login, fichaje ----------

  api.get('/bootstrap', (_req, res) => {
    res.json({ needsSetup: users.countUsers(ctx) === 0, business: getSetting(ctx, 'business.name') });
  });

  api.post('/setup', (req, res) => {
    if (users.countUsers(ctx) > 0) throw new HttpError(409, 'La app ya está configurada.', 'already_setup');
    const body = parse(z.object({ fullName: z.string().min(3).max(80), alias: z.string().max(40).optional(), withSample: z.boolean().optional() }), req.body);
    const out = users.createUser(ctx, null, { fullName: body.fullName, role: 'admin', alias: body.alias });
    if (body.withSample !== false) catalog.seedCatalog(ctx);
    res.status(201).json({ user: out.user, pin: out.pin, warnings: out.warnings });
  });

  api.post('/auth/login', loginLimit, (req, res) => {
    const body = parse(z.object({ username: z.string().min(1).max(80), pin: z.string() }), req.body);
    const user = users.verifyCredentials(ctx, body);
    const s = users.createSession(ctx, user.id);
    setCookie(res, s.token);
    res.json(sessionInfo(user));
  });

  api.post('/auth/logout', (req, res) => {
    users.destroySession(ctx, req.token);
    setCookie(res, '', { clear: true });
    res.json({ ok: true });
  });

  api.get('/auth/me', auth, (req, res) => res.json(sessionInfo(req.user)));

  api.post('/timeclock/punch', loginLimit, (req, res) => {
    const body = parse(z.object({ username: z.string().min(1).max(80), pin: z.string(), action: z.enum(['in', 'out']) }), req.body);
    const user = users.verifyCredentials(ctx, body);
    res.json(timeclock.punch(ctx, user, body.action));
  });

  // ---------- a partir de acá hace falta sesión ----------
  api.use(auth);

  // usuarios
  api.get('/users', admin, (_req, res) => res.json({ users: users.listUsers(ctx) }));
  api.post('/users', admin, (req, res) => {
    const b = parse(z.object({ fullName: z.string().min(3).max(80), role: z.enum(['admin', 'cajero']).optional(), alias: z.string().max(40).nullable().optional() }), req.body);
    res.status(201).json(users.createUser(ctx, req.user.id, b));
  });
  api.patch('/users/:id', admin, (req, res) => {
    const b = parse(z.object({ fullName: z.string().min(3).max(80).optional(), role: z.enum(['admin', 'cajero']).optional(), alias: z.string().max(40).nullable().optional(), active: z.boolean().optional() }), req.body);
    res.json(users.updateUser(ctx, req.user.id, id(req.params.id), b));
  });
  api.post('/users/:id/reset-pin', admin, (req, res) => res.json(users.resetPin(ctx, req.user.id, id(req.params.id))));

  // catálogo
  api.get('/catalog', (_req, res) => res.json(catalog.posCatalog(ctx)));
  api.get('/admin/catalog', admin, (_req, res) => res.json(catalog.adminCatalog(ctx)));
  api.post('/admin/categories', admin, (req, res) => {
    const b = parse(z.object({ name: z.string().min(1).max(40), sortOrder: z.number().int().optional() }), req.body);
    res.status(201).json(catalog.createCategory(ctx, req.user, b));
  });
  api.patch('/admin/categories/:id', admin, (req, res) => {
    const b = parse(z.object({ name: z.string().min(1).max(40).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }), req.body);
    catalog.updateCategory(ctx, req.user, id(req.params.id), b);
    res.json({ ok: true });
  });
  const productBody = z.object({
    categoryId: z.number().int().positive(),
    name: z.string().min(1).max(60),
    priceCents: cents,
    trackStock: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
    sortOrder: z.number().int().optional(),
  });
  api.post('/admin/products', admin, (req, res) => res.status(201).json(catalog.createProduct(ctx, req.user, parse(productBody, req.body))));
  api.patch('/admin/products/:id', admin, (req, res) => {
    catalog.updateProduct(ctx, req.user, id(req.params.id), parse(productBody.partial().extend({ active: z.boolean().optional() }), req.body));
    res.json({ ok: true });
  });
  const promoItems = z.array(z.object({ productId: z.number().int().positive(), qty })).min(1);
  api.post('/admin/promos', admin, (req, res) => {
    const b = parse(z.object({ name: z.string().min(1).max(60), priceCents: cents, items: promoItems, sortOrder: z.number().int().optional() }), req.body);
    res.status(201).json(catalog.createPromo(ctx, req.user, b));
  });
  api.patch('/admin/promos/:id', admin, (req, res) => {
    const b = parse(z.object({ name: z.string().min(1).max(60).optional(), priceCents: cents.optional(), items: promoItems.optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() }), req.body);
    catalog.updatePromo(ctx, req.user, id(req.params.id), b);
    res.json({ ok: true });
  });
  api.post('/admin/confirm-prices', admin, (req, res) => {
    catalog.confirmPrices(ctx, req.user);
    res.json({ ok: true });
  });

  // turnos y caja
  api.get('/shift/current', (_req, res) => {
    const s = getOpenShift(ctx);
    res.json(s ? { shift: openShiftSummary(), live: liveSummary(ctx, s.id) } : { shift: null });
  });
  api.post('/shifts/open', (req, res) => {
    const b = parse(z.object({
      openingCashCents: cents,
      notes: z.string().max(300).nullable().optional(),
      stockCounts: z.array(z.object({ productId: z.number().int(), qty: z.union([z.number(), z.string(), z.null()]).optional() })).optional(),
    }), req.body);
    res.status(201).json(shifts.openShift(ctx, req.user, b));
  });
  api.post('/shifts/close', (req, res) => {
    const b = parse(z.object({
      countedCashCents: cents,
      notes: z.string().max(300).nullable().optional(),
      stockCounts: z.array(z.object({ productId: z.number().int(), qty: z.union([z.number(), z.string(), z.null()]).optional() })).optional(),
    }), req.body);
    res.json(shifts.closeShift(ctx, req.user, b));
  });
  api.post('/cash-movements', (req, res) => {
    const b = parse(z.object({ type: z.enum(['in', 'out']), amountCents: posCents, reason: z.string().min(2).max(120) }), req.body);
    res.status(201).json(shifts.addCashMovement(ctx, req.user, b));
  });

  const canViewShift = (user, shiftId) => {
    if (user.role === 'admin') return true;
    const s = shifts.getShift(ctx, shiftId);
    return s.status === 'open' || s.opened_by === user.id || s.closed_by === user.id;
  };
  const shiftAccess = (req, _res, next) => {
    const sid = id(req.params.id);
    shifts.getShift(ctx, sid); // 404 si no existe
    return canViewShift(req.user, sid) ? next() : next(forbidden('Solo podés ver los turnos que abriste o cerraste.'));
  };

  api.get('/shifts', (req, res) => {
    const all = shifts.listShifts(ctx, { limit: Math.min(Number(req.query.limit) || 60, 200) });
    const mine = req.user.role === 'admin' ? all : all.filter((s) => s.openedById === req.user.id || s.closedById === req.user.id);
    res.json({ shifts: mine });
  });
  api.get('/shifts/:id/report', shiftAccess, (req, res) => res.json(shiftReport(ctx, id(req.params.id))));
  api.get('/shifts/:id/export.xlsx', shiftAccess, async (req, res) => {
    const rep = shiftReport(ctx, id(req.params.id));
    download(res, { buffer: await shiftWorkbook(rep), type: XLSX, filename: `MrCook_Cierre-turno-${rep.shift.id}.xlsx` });
  });
  api.get('/shifts/:id/export.pdf', shiftAccess, async (req, res) => {
    const rep = shiftReport(ctx, id(req.params.id));
    download(res, { buffer: await shiftPdf(rep, { detail: req.query.detail === '1' }), type: 'application/pdf', filename: `MrCook_Cierre-turno-${rep.shift.id}.pdf` });
  });

  // ventas
  api.post('/sales', (req, res) => {
    const b = parse(z.object({
      items: z.array(z.object({ kind: z.enum(['product', 'promo']), id: z.number().int().positive(), qty })).min(1),
      payments: z.array(z.object({
        method: z.enum(sales.METHODS),
        amountCents: posCents,
        tenderedCents: cents.optional(),
        chargeId: z.number().int().positive().optional(),
      })).min(1),
      note: z.string().max(200).nullable().optional(),
    }), req.body);
    res.status(201).json(sales.createSale(ctx, req.user, b));
  });
  api.get('/sales', (req, res) => {
    let shiftId = null;
    if (req.query.shiftId === 'current') {
      shiftId = getOpenShift(ctx)?.id ?? -1;
    } else if (req.query.shiftId) {
      shiftId = id(req.query.shiftId);
      if (!canViewShift(req.user, shiftId)) throw forbidden();
    } else if (req.user.role !== 'admin') {
      throw forbidden('Indicá el turno.');
    }
    res.json({ sales: sales.listSales(ctx, { shiftId, limit: Math.min(Number(req.query.limit) || 100, 1000) }) });
  });
  api.get('/sales/:id', (req, res) => {
    const sale = sales.getSale(ctx, id(req.params.id));
    if (!canViewShift(req.user, sale.shiftId)) throw forbidden();
    res.json(sale);
  });
  api.post('/sales/:id/void', (req, res) => {
    const b = parse(z.object({
      reason: z.string().min(3).max(200),
      supervisor: z.object({ username: z.string(), pin: z.string() }).optional(),
    }), req.body);
    let approver = req.user;
    if (req.user.role !== 'admin') {
      if (!b.supervisor) throw forbidden('Pedile a un encargado que ingrese su usuario y código para anular.', 'needs_supervisor');
      approver = users.verifyCredentials(ctx, b.supervisor); // fuera de la transacción: el intento fallido debe quedar registrado
    }
    res.json(sales.voidSale(ctx, req.user, approver, id(req.params.id), b.reason));
  });

  // cobros electrónicos (Mercado Pago)
  api.post('/charges', (req, res) => {
    const b = parse(z.object({ kind: z.enum(['qr', 'tarjeta']), amountCents: posCents }), req.body);
    res.status(201).json(charges.createCharge(ctx, req.user, b));
  });
  api.get('/charges/:id', async (req, res) => res.json(await charges.refreshCharge(ctx, id(req.params.id))));
  api.post('/charges/:id/pick', (req, res) => {
    const b = parse(z.object({ paymentId: z.string().min(1) }), req.body);
    res.json(charges.pickCandidate(ctx, req.user, id(req.params.id), b.paymentId));
  });
  api.post('/charges/:id/cancel', (req, res) => res.json(charges.cancelCharge(ctx, id(req.params.id))));

  // inventario
  api.get('/inventory', (_req, res) => res.json({ stock: inventory.listStock(ctx) }));
  api.post('/inventory/restock', (req, res) => {
    const b = parse(z.object({
      items: z.array(z.object({ productId: z.number().int().positive(), qty })).min(1),
      supplier: z.string().max(80).nullable().optional(),
      note: z.string().max(200).nullable().optional(),
    }), req.body);
    res.status(201).json(inventory.restock(ctx, req.user, b));
  });
  api.post('/inventory/adjust', (req, res) => {
    const b = parse(z.object({
      productId: z.number().int().positive(),
      qty: z.number().int(),
      reason: z.string().min(2).max(160),
      kind: z.enum(['adjustment', 'waste']).optional(),
    }), req.body);
    res.json(inventory.adjust(ctx, req.user, b));
  });

  const range = (req, { defaultDays = 7 } = {}) => {
    const tz = ctx.timezone;
    const today = parseYmd(new Date(ctx.now()).toLocaleDateString('en-CA', { timeZone: tz }), tz);
    const fromYmd = req.query.from ? parse(ymdStr, req.query.from) : null;
    const toYmd = req.query.to ? parse(ymdStr, req.query.to) : null;
    const from = fromYmd ? parseYmd(fromYmd, tz) : today - (defaultDays - 1) * 86400000;
    const toDay = toYmd ? parseYmd(toYmd, tz) : today;
    const to = startOfNextDay(toDay, tz);
    if (to <= from) throw badRequest('La fecha "hasta" tiene que ser posterior a "desde".');
    if (to - from > 400 * 86400000) throw badRequest('El rango máximo es de 400 días.');
    return { from, to };
  };

  api.get('/inventory/movements', (req, res) => {
    const { from, to } = range(req, { defaultDays: 7 });
    res.json({ movements: inventory.listMovements(ctx, { from, to, productId: req.query.productId ? id(req.query.productId) : undefined }) });
  });
  api.get('/inventory/export.xlsx', async (req, res) => {
    const { from, to } = range(req, { defaultDays: 7 });
    const buffer = await inventoryWorkbook({
      business: getSetting(ctx, 'business.name'),
      timezone: ctx.timezone,
      stock: inventory.listStock(ctx),
      movements: inventory.listMovements(ctx, { from, to, limit: 20000 }).reverse(),
      now: ctx.now(),
    });
    download(res, { buffer, type: XLSX, filename: 'MrCook_Inventario.xlsx' });
  });

  // fichaje
  api.get('/timeclock/who-is-in', (_req, res) => res.json({ entries: timeclock.whoIsIn(ctx) }));
  api.get('/timeclock', admin, (req, res) => {
    const { from, to } = range(req, { defaultDays: 7 });
    res.json({ entries: timeclock.listEntries(ctx, { from, to }), hours: timeclock.hoursSummary(ctx, from, to), from, to });
  });
  api.patch('/timeclock/:id', admin, (req, res) => {
    const b = parse(z.object({ clockIn: z.number().int().optional(), clockOut: z.number().int().nullable().optional(), note: z.string().max(200).nullable().optional() }), req.body);
    timeclock.editEntry(ctx, req.user, id(req.params.id), b);
    res.json({ ok: true });
  });

  // reportes
  api.get('/reports/period', admin, (req, res) => {
    const { from, to } = range(req);
    res.json(periodReport(ctx, { from, to }));
  });
  api.get('/reports/period.xlsx', admin, async (req, res) => {
    const { from, to } = range(req);
    const rep = periodReport(ctx, { from, to });
    download(res, { buffer: await periodWorkbook(rep, { titlePrefix: 'Resumen de ventas y stock' }), type: XLSX, filename: `MrCook_Resumen_${req.query.from || 'semana'}_${req.query.to || ''}.xlsx` });
  });
  api.get('/reports/weekly.xlsx', admin, async (req, res) => {
    const tz = ctx.timezone;
    const anchor = req.query.date ? parseYmd(parse(ymdStr, req.query.date), tz) : ctx.now();
    const from = startOfWeek(anchor, tz);
    const rep = periodReport(ctx, { from, to: endOfWeek(from, tz) });
    download(res, { buffer: await periodWorkbook(rep, { titlePrefix: `Resumen semanal ${isoWeekLabel(from, tz)}` }), type: XLSX, filename: `MrCook_Resumen-semanal_${isoWeekLabel(from, tz)}.xlsx` });
  });

  // configuración
  api.get('/settings', admin, (_req, res) => res.json({ ...adminSettings(ctx), driveConnected: !!getSetting(ctx, 'backup.drive.refreshToken'), backupsConfigured: { drive: driveConfigured(ctx) } }));
  api.put('/settings', admin, (req, res) => {
    const b = parse(z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), clearSecrets: z.array(z.string()).optional() }), req.body);
    updateSettings(ctx, b.values || {});
    for (const k of b.clearSecrets || []) clearSecret(ctx, k);
    res.json(adminSettings(ctx));
  });
  api.post('/settings/test-mp', admin, async (req, res) => {
    const token = (typeof req.body?.accessToken === 'string' && req.body.accessToken) || getSetting(ctx, 'mp.accessToken');
    if (!token) throw badRequest('Primero pegá el Access Token de Mercado Pago.');
    try {
      const provider = createMercadoPagoProvider({ accessToken: token, fetchImpl: ctx.fetch });
      res.json({ ok: true, account: await provider.testConnection() });
    } catch (e) {
      res.json({ ok: false, message: e.message, code: e.code });
    }
  });

  // Google Drive (OAuth de usuario)
  api.post('/drive/connect', admin, (req, res) => {
    const clientId = getSetting(ctx, 'backup.drive.clientId');
    if (!clientId || !getSetting(ctx, 'backup.drive.clientSecret')) throw badRequest('Guardá primero el Client ID y el Client Secret de Google.');
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `http://${req.headers.host}/api/drive/callback`;
    for (const [k, v] of driveStates) if (v.exp < Date.now()) driveStates.delete(k);
    driveStates.set(state, { redirectUri, exp: Date.now() + 10 * 60_000, userId: req.user.id });
    res.json({ url: buildAuthUrl({ clientId, redirectUri, state }), redirectUri });
  });
  api.post('/drive/disconnect', admin, (_req, res) => {
    clearSecret(ctx, 'backup.drive.refreshToken');
    setSetting(ctx, 'backup.drive.enabled', false);
    res.json({ ok: true });
  });

  // respaldos
  api.get('/backups', admin, (_req, res) => {
    res.json({ runs: listBackupRuns(ctx), localDir: getSetting(ctx, 'backup.localDir') || ctx.config.backupDir, driveConfigured: driveConfigured(ctx) });
  });
  api.post('/backups/run', admin, async (req, res) => {
    const b = parse(z.object({ date: ymdStr.optional() }), req.body);
    const tz = ctx.timezone;
    const anchor = b.date ? parseYmd(b.date, tz) : ctx.now();
    res.json(await runWeeklyBackup(ctx, { weekStart: startOfWeek(anchor, tz), kind: 'manual' }));
  });

  api.get('/audit', admin, (_req, res) => res.json({ events: listAudit(ctx) }));

  api.use((_req, _res, next) => next(notFound('Ruta inexistente.', 'no_route')));
  // el callback de Google va ANTES del router /api (que exige sesión)
  const driveStates = (ctx.driveStates ||= new Map());
  // callback de Google (sin sesión: viene de un redirect de otro sitio; se valida `state`)
  app.get('/api/drive/callback', async (req, res) => {
    const st = driveStates.get(String(req.query.state || ''));
    driveStates.delete(String(req.query.state || ''));
    const back = (q) => res.redirect(`/#/admin/config?${q}`);
    if (!st || st.exp < Date.now()) return back('drive=error&msg=' + encodeURIComponent('El intento de conexión venció. Probá de nuevo.'));
    if (req.query.error) return back('drive=error&msg=' + encodeURIComponent(String(req.query.error)));
    try {
      const refreshToken = await exchangeCode({
        clientId: getSetting(ctx, 'backup.drive.clientId'),
        clientSecret: getSetting(ctx, 'backup.drive.clientSecret'),
        redirectUri: st.redirectUri,
        code: String(req.query.code),
        fetchImpl: ctx.fetch,
      });
      setSetting(ctx, 'backup.drive.refreshToken', refreshToken);
      setSetting(ctx, 'backup.drive.enabled', true);
      try {
        const folder = await createDriveClient({
          clientId: getSetting(ctx, 'backup.drive.clientId'),
          clientSecret: getSetting(ctx, 'backup.drive.clientSecret'),
          refreshToken,
          fetchImpl: ctx.fetch,
        }).ensureFolder();
        setSetting(ctx, 'backup.drive.folderId', folder);
      } catch { /* la carpeta se crea en el primer respaldo */ }
      return back('drive=ok');
    } catch (e) {
      return back('drive=error&msg=' + encodeURIComponent(e.message));
    }
  });

  app.use('/api', api);

  // ---------- frontend compilado ----------
  const webDir = ctx.config.webDir;
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.extra ? { extra: err.extra } : {}) } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'El pedido no es un JSON válido.' } });
    console.error('[error]', err);
    res.status(500).json({ error: { code: 'internal', message: 'Error interno. Revisá el registro del servidor.' } });
  });

  return app;
}

