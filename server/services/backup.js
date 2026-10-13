import fs from 'node:fs';
import path from 'node:path';
import { all, get, run } from '../db.js';
import { periodWorkbook } from '../exports/xlsx.js';
import { endOfWeek, isoWeekLabel, startOfWeek, ymd } from '../util/time.js';
import { createDriveClient } from './drive.js';
import { periodReport } from './reports.js';
import { getSetting, setSetting } from './settings.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ATTEMPTS_PER_WEEK = 12;
const RETRY_AFTER_MS = 60 * 60 * 1000;

export function driveConfigured(ctx) {
  return !!(
    getSetting(ctx, 'backup.drive.enabled') &&
    getSetting(ctx, 'backup.drive.clientId') &&
    getSetting(ctx, 'backup.drive.clientSecret') &&
    getSetting(ctx, 'backup.drive.refreshToken')
  );
}

export function driveClient(ctx) {
  return createDriveClient({
    clientId: getSetting(ctx, 'backup.drive.clientId'),
    clientSecret: getSetting(ctx, 'backup.drive.clientSecret'),
    refreshToken: getSetting(ctx, 'backup.drive.refreshToken'),
    folderId: getSetting(ctx, 'backup.drive.folderId'),
    fetchImpl: ctx.fetch,
  });
}

/**
 * Genera el respaldo de una semana (lunes a domingo):
 *  - Excel con el resumen de ventas, cobros por medio, stock e ingresos
 *  - copia consistente de la base de datos (VACUUM INTO)
 * y, si Google Drive está configurado, los sube.
 * El respaldo local se guarda siempre, aunque falle Drive.
 */
export async function runWeeklyBackup(ctx, { weekStart, kind = 'weekly' }) {
  const tz = ctx.timezone;
  const from = startOfWeek(weekStart, tz);
  const to = endOfWeek(from, tz);
  const label = isoWeekLabel(from, tz);
  const baseDir = getSetting(ctx, 'backup.localDir') || ctx.config.backupDir;
  const dir = path.join(baseDir, label);
  fs.mkdirSync(dir, { recursive: true });

  const runId = Number(
    run(
      ctx.db,
      `INSERT INTO backup_runs(kind, period_start, period_end, started_at, status, local_dir) VALUES (?,?,?,?,'running',?)`,
      kind, from, to, ctx.now(), dir,
    ).lastInsertRowid,
  );

  const xlsxName = `MrCook_Resumen-semanal_${label}.xlsx`;
  const dbName = `MrCook_base-de-datos_${label}.sqlite`;
  const messages = [];
  let status = 'ok';
  let driveStatus = driveConfigured(ctx) ? 'pending' : 'disabled';

  try {
    const rep = periodReport(ctx, { from, to });
    const xlsx = Buffer.from(await periodWorkbook(rep, { titlePrefix: `Resumen semanal ${label}` }));
    fs.writeFileSync(path.join(dir, xlsxName), xlsx);

    const dbPath = path.join(dir, dbName);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
    ctx.db.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
    messages.push(`Guardado en ${dir}`);

    if (driveConfigured(ctx)) {
      try {
        const drive = driveClient(ctx);
        const folder = await drive.ensureFolder();
        if (folder !== getSetting(ctx, 'backup.drive.folderId')) setSetting(ctx, 'backup.drive.folderId', folder);
        await drive.upsertFile({ folder, name: xlsxName, mimeType: XLSX_MIME, data: xlsx });
        await drive.upsertFile({ folder, name: dbName, mimeType: 'application/vnd.sqlite3', data: fs.readFileSync(dbPath) });
        driveStatus = 'ok';
        messages.push('Subido a Google Drive');
      } catch (e) {
        driveStatus = 'error';
        status = 'partial';
        messages.push(`Google Drive: ${e.message}`);
      }
    }
    pruneOld(ctx, baseDir);
  } catch (e) {
    status = 'error';
    messages.push(`Error: ${e.message}`);
  }

  run(
    ctx.db,
    `UPDATE backup_runs SET finished_at=?, status=?, drive_status=?, message=? WHERE id=?`,
    ctx.now(), status, driveStatus, messages.join(' · '), runId,
  );
  return { id: runId, status, driveStatus, label, dir, message: messages.join(' · ') };
}

/** Deja solo las últimas N carpetas semanales locales (por defecto 12). */
function pruneOld(ctx, baseDir) {
  const keep = Math.max(2, Number(getSetting(ctx, 'backup.keep')) || 12);
  let entries;
  try {
    entries = fs.readdirSync(baseDir).filter((n) => /^\d{4}-W\d{2}$/.test(n)).sort();
  } catch {
    return;
  }
  for (const old of entries.slice(0, Math.max(0, entries.length - keep))) {
    fs.rmSync(path.join(baseDir, old), { recursive: true, force: true });
  }
}

/**
 * Se llama al arrancar y cada tanto. Si la semana anterior (ya terminada) no
 * tiene un respaldo exitoso, lo genera. Así, si la PC estaba apagada el lunes
 * a la madrugada, el respaldo se hace apenas se prende. Si Drive falló, reintenta
 * cada hora (hasta 12 veces) sin repetir el respaldo local.
 */
export async function checkWeeklyBackup(ctx) {
  const tz = ctx.timezone;
  const thisWeek = startOfWeek(ctx.now(), tz);
  const lastWeek = startOfWeek(thisWeek - 12 * 3600 * 1000, tz);
  const hadActivity = get(ctx.db, 'SELECT COUNT(*) AS n FROM shifts WHERE opened_at < ?', thisWeek).n;
  if (!hadActivity) return null;
  const runs = all(
    ctx.db,
    `SELECT status, started_at FROM backup_runs WHERE kind='weekly' AND period_start = ? ORDER BY id DESC`,
    lastWeek,
  );
  if (runs.some((r) => r.status === 'ok')) return null;
  if (runs.length >= MAX_ATTEMPTS_PER_WEEK) return null;
  if (runs[0] && ctx.now() - runs[0].started_at < RETRY_AFTER_MS) return null;
  return runWeeklyBackup(ctx, { weekStart: lastWeek, kind: 'weekly' });
}

export function listBackupRuns(ctx, limit = 30) {
  return all(ctx.db, 'SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?', limit).map((r) => ({
    id: r.id,
    kind: r.kind,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    driveStatus: r.drive_status,
    localDir: r.local_dir,
    message: r.message,
    label: isoWeekLabel(r.period_start, ctx.timezone),
  }));
}

/**
 * Copia diaria de la base de datos (últimos 14 días) en la carpeta de respaldos.
 * Es el seguro contra un disco roto o un archivo corrupto: sin esto, todo el
 * historial dependería de un único archivo en una única PC.
 */
export function ensureDailySnapshot(ctx) {
  const hasData = get(ctx.db, 'SELECT COUNT(*) AS n FROM shifts').n;
  if (!hasData) return null;
  const baseDir = getSetting(ctx, 'backup.localDir') || ctx.config.backupDir;
  const dir = path.join(baseDir, 'diario');
  const day = ymd(ctx.now(), ctx.timezone);
  const file = path.join(dir, `mrcook_${day}.sqlite`);
  if (fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter((n) => /^mrcook_\d{4}-\d{2}-\d{2}\.sqlite$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 14))) fs.rmSync(path.join(dir, n), { force: true });
  return file;
}
