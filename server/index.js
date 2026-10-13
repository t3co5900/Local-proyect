import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { openDb } from './db.js';
import { checkWeeklyBackup, ensureDailySnapshot } from './services/backup.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

const db = openDb(config.dbFile);
const ctx = createContext({ config, db });
const app = createApp(ctx);

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('  Mr.Cook POS');
  console.log(`  Abrí:  http://${shown}:${config.port}`);
  console.log(`  Datos: ${config.dataDir}`);
  if (!fs.existsSync(config.webDir)) {
    console.log(`  (No se encontró la interfaz compilada en ${config.webDir}: corré "npm run build")`);
  }
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`El puerto ${config.port} ya está en uso. Probablemente Mr.Cook ya está abierto: entrá a http://localhost:${config.port}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

// Respaldos: al arrancar (con un respiro) y cada 30 minutos.
// El respaldo semanal se pone al día solo si la PC estuvo apagada el lunes.
async function maintenance() {
  try {
    const file = ensureDailySnapshot(ctx);
    if (file) console.log(`[respaldo] copia diaria: ${file}`);
    const weekly = await checkWeeklyBackup(ctx);
    if (weekly) console.log(`[respaldo] semana ${weekly.label}: ${weekly.status} — ${weekly.message}`);
  } catch (e) {
    console.error('[respaldo] error:', e.message);
  }
}
setTimeout(maintenance, 20_000).unref();
setInterval(maintenance, 30 * 60_000).unref();

function shutdown() {
  server.close(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
