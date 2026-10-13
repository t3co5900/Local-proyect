import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import { audit } from './audit.js';
import { formatDateTime } from '../util/time.js';

// Una entrada abierta de más de 16 h se considera "olvidó fichar la salida".
const FORGOTTEN_MS = 16 * 60 * 60 * 1000;

export function openEntry(ctx, userId) {
  return get(ctx.db, 'SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC', userId) || null;
}

export function punch(ctx, user, action) {
  const now = ctx.now();
  const open = openEntry(ctx, user.id);
  if (action === 'in') {
    if (open) {
      throw conflict(
        `Ya fichaste la entrada (${formatDateTime(open.clock_in, ctx.timezone)}). Si te olvidaste de fichar la salida, avisale al encargado.`,
        'already_in',
      );
    }
    const info = run(ctx.db, 'INSERT INTO time_entries(user_id, clock_in) VALUES (?,?)', user.id, now);
    return { action: 'in', at: now, id: Number(info.lastInsertRowid), userName: user.full_name };
  }
  if (action === 'out') {
    if (!open) throw conflict('No tenés una entrada abierta. Fichá la entrada primero.', 'not_in');
    run(ctx.db, 'UPDATE time_entries SET clock_out = ? WHERE id = ?', now, open.id);
    return { action: 'out', at: now, id: open.id, userName: user.full_name, workedMs: now - open.clock_in };
  }
  throw badRequest('Acción inválida.');
}

export function whoIsIn(ctx) {
  return all(
    ctx.db,
    `SELECT t.id, t.clock_in, u.full_name FROM time_entries t JOIN users u ON u.id = t.user_id
      WHERE t.clock_out IS NULL ORDER BY t.clock_in`,
  ).map((r) => ({ id: r.id, since: r.clock_in, userName: r.full_name, forgotten: ctx.now() - r.clock_in > FORGOTTEN_MS }));
}

export function listEntries(ctx, { from, to, userId } = {}) {
  const where = [];
  const params = [];
  if (from != null) { where.push('t.clock_in >= ?'); params.push(from); }
  if (to != null) { where.push('t.clock_in < ?'); params.push(to); }
  if (userId) { where.push('t.user_id = ?'); params.push(userId); }
  return all(
    ctx.db,
    `SELECT t.*, u.full_name FROM time_entries t JOIN users u ON u.id = t.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.clock_in DESC LIMIT 1000`,
    ...params,
  ).map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.full_name,
    clockIn: r.clock_in,
    clockOut: r.clock_out,
    note: r.note,
    forgotten: r.clock_out == null && ctx.now() - r.clock_in > FORGOTTEN_MS,
  }));
}

/** Horas trabajadas por persona en [from, to). Las entradas olvidadas no suman (se corrigen a mano). */
export function hoursSummary(ctx, from, to) {
  const entries = listEntries(ctx, { from, to });
  const byUser = new Map();
  for (const e of entries) {
    const row = byUser.get(e.userId) || { userId: e.userId, userName: e.userName, ms: 0, entries: 0, incomplete: 0 };
    row.entries += 1;
    if (e.clockOut != null) row.ms += e.clockOut - e.clockIn;
    else if (!e.forgotten) row.ms += ctx.now() - e.clockIn;
    else row.incomplete += 1;
    byUser.set(e.userId, row);
  }
  return [...byUser.values()]
    .map((r) => ({ ...r, hours: Math.round((r.ms / 3600000) * 100) / 100 }))
    .sort((a, b) => a.userName.localeCompare(b.userName, 'es'));
}

export function editEntry(ctx, admin, id, { clockIn, clockOut, note }) {
  const e = get(ctx.db, 'SELECT * FROM time_entries WHERE id = ?', id);
  if (!e) throw notFound('Fichaje no encontrado.');
  const cin = clockIn ?? e.clock_in;
  const cout = clockOut === undefined ? e.clock_out : clockOut;
  if (cout != null && cout <= cin) throw badRequest('La salida tiene que ser posterior a la entrada.');
  run(ctx.db, 'UPDATE time_entries SET clock_in=?, clock_out=?, note=?, edited_by=? WHERE id=?', cin, cout, note ?? e.note, admin.id, id);
  audit(ctx, admin.id, 'timeclock.edit', 'time_entry', id, { from: [e.clock_in, e.clock_out], to: [cin, cout] });
}
