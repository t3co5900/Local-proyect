import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { openDb } from '../db.js';
import { seedCatalog } from '../services/catalog.js';
import { createUser } from '../services/users.js';
import { get } from '../db.js';

/** Contexto con base en memoria y reloj controlable. */
export function testContext({ start = Date.UTC(2026, 9, 14, 12, 0, 0), seed = true, overrides = {} } = {}) {
  const clock = { t: start };
  const config = { ...loadConfig({ MRCOOK_DATA_DIR: '/tmp/mrcook-test-unused' }), ...overrides };
  const ctx = createContext({ config, db: openDb(':memory:'), now: () => clock.t });
  if (seed) seedCatalog(ctx);
  const admin = createUser(ctx, null, { fullName: 'Ana Admin', role: 'admin' });
  const cajero = createUser(ctx, null, { fullName: 'Carlos Pérez', role: 'cajero' });
  const userRow = (id) => get(ctx.db, 'SELECT * FROM users WHERE id = ?', id);
  return {
    ctx,
    clock,
    advance: (ms) => { clock.t += ms; },
    admin: userRow(admin.user.id),
    adminPin: admin.pin,
    cajero: userRow(cajero.user.id),
    cajeroPin: cajero.pin,
    product: (name) => get(ctx.db, 'SELECT * FROM products WHERE name = ?', name),
    promo: (name) => get(ctx.db, 'SELECT * FROM promos WHERE name = ?', name),
  };
}


/** Servidor HTTP real en un puerto libre, con un cliente que maneja la cookie de sesión. */
export async function startServer(t) {
  const server = await new Promise((resolve) => {
    const app = createApp(t.ctx);
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    const call = async (method, url, body, extraHeaders = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
      const type = res.headers.get('content-type') || '';
      let json = null;
      let buffer = null;
      if (type.includes('application/json')) json = await res.json();
      else buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, json, buffer, headers: res.headers };
    };
    return {
      get: (u, h) => call('GET', u, undefined, h),
      post: (u, b, h) => call('POST', u, b ?? {}, h),
      patch: (u, b, h) => call('PATCH', u, b ?? {}, h),
      put: (u, b, h) => call('PUT', u, b ?? {}, h),
      async login(username, pin) {
        const r = await call('POST', '/api/auth/login', { username, pin });
        return r;
      },
    };
  }
  return { server, base, client, close: () => new Promise((r) => server.close(r)) };
}

export function tmpDir(prefix = 'mrcook-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
