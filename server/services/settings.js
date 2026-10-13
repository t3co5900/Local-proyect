import { all, get, run } from '../db.js';

// Valores por defecto. Los "secretos" nunca se devuelven al navegador.
export const DEFAULTS = {
  'business.name': 'Mr.Cook',
  'stock.blockOnNoStock': false,
  'catalog.pricesConfirmed': false,
  'mp.enabled': false,
  'mp.accessToken': '',
  'mp.lookbackSeconds': 180,
  'backup.localDir': '',
  'backup.keep': 12,
  'backup.drive.enabled': false,
  'backup.drive.clientId': '',
  'backup.drive.clientSecret': '',
  'backup.drive.refreshToken': '',
  'backup.drive.folderId': '',
};

export const SECRET_KEYS = new Set([
  'mp.accessToken',
  'backup.drive.clientSecret',
  'backup.drive.refreshToken',
]);

// Variables de entorno que pisan lo guardado (útil para Docker/VPS).
const ENV_OVERRIDES = {
  'mp.accessToken': 'MP_ACCESS_TOKEN',
  'backup.drive.clientId': 'GDRIVE_CLIENT_ID',
  'backup.drive.clientSecret': 'GDRIVE_CLIENT_SECRET',
  'backup.drive.refreshToken': 'GDRIVE_REFRESH_TOKEN',
  'backup.drive.folderId': 'GDRIVE_FOLDER_ID',
};

export function getSetting(ctx, key) {
  const envName = ENV_OVERRIDES[key];
  if (envName && process.env[envName]) return process.env[envName];
  const row = get(ctx.db, 'SELECT value FROM settings WHERE key = ?', key);
  if (row) return JSON.parse(row.value);
  if (key === 'backup.localDir') return ctx.config.backupDir;
  return DEFAULTS[key];
}

export function setSetting(ctx, key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Ajuste desconocido: ${key}`);
  run(
    ctx.db,
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

/** Ajustes visibles para cualquier usuario logueado (sin secretos). */
export function publicSettings(ctx) {
  return {
    businessName: getSetting(ctx, 'business.name'),
    timezone: ctx.timezone,
    blockOnNoStock: !!getSetting(ctx, 'stock.blockOnNoStock'),
    pricesConfirmed: !!getSetting(ctx, 'catalog.pricesConfirmed'),
    mercadoPagoEnabled: !!getSetting(ctx, 'mp.enabled') && !!getSetting(ctx, 'mp.accessToken'),
  };
}

/** Todos los ajustes para la pantalla de administración (secretos enmascarados). */
export function adminSettings(ctx) {
  const out = {};
  const secretsSet = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = getSetting(ctx, key);
    if (SECRET_KEYS.has(key)) {
      secretsSet[key] = !!value;
      out[key] = '';
    } else {
      out[key] = value;
    }
  }
  const stored = all(ctx.db, 'SELECT key FROM settings').map((r) => r.key);
  return { values: out, secretsSet, storedKeys: stored };
}

export function updateSettings(ctx, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    // un secreto vacío o ausente significa "no tocar"; para borrarlo se usa clearSecret
    if (SECRET_KEYS.has(key) && (value === '' || value == null)) continue;
    const expected = typeof DEFAULTS[key];
    if (typeof value !== expected) continue;
    setSetting(ctx, key, value);
  }
}

export function clearSecret(ctx, key) {
  if (!SECRET_KEYS.has(key)) return;
  setSetting(ctx, key, '');
}
