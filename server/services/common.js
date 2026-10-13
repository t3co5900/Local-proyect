import { get } from '../db.js';
import { conflict } from '../util/errors.js';

/** El turno abierto (hay una sola caja) o null. */
export function getOpenShift(ctx) {
  return get(ctx.db, `SELECT * FROM shifts WHERE status = 'open'`) || null;
}

export function requireOpenShift(ctx) {
  const shift = getOpenShift(ctx);
  if (!shift) throw conflict('No hay un turno abierto. Abrí el turno para vender.', 'no_open_shift');
  return shift;
}
