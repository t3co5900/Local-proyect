import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/**
 * Configuración por variables de entorno. Todo tiene un valor por defecto
 * razonable para correr en la PC del local sin tocar nada.
 */
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.MRCOOK_DATA_DIR || path.join(ROOT, 'data'));
  return {
    // 127.0.0.1 => solo accesible desde la propia PC. Para usar una tablet por
    // WiFi del local: HOST=0.0.0.0 (el login sigue siendo obligatorio).
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3737),
    dataDir,
    dbFile: path.join(dataDir, 'mrcook.sqlite'),
    backupDir: path.join(dataDir, 'backups'),
    webDir: path.resolve(env.MRCOOK_WEB_DIR || path.join(ROOT, 'web', 'dist')),
    timezone: env.TZ_NEGOCIO || 'America/Argentina/Buenos_Aires',
    sessionHours: Number(env.SESSION_HOURS || 12),
  };
}
