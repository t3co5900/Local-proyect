import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import { audit } from './audit.js';
import { getOpenShift, requireOpenShift } from './common.js';
import { applyMovement } from './inventory.js';

const isCents = (n) => Number.isInteger(n) && n >= 0;

function cleanCounts(ctx, stockCounts) {
  const out = new Map();
  for (const c of stockCounts ?? []) {
    if (c.qty === '' || c.qty == null) continue; // sin cargar = no contado
    const qty = Number(c.qty);
    if (!Number.isInteger(qty) || qty < 0) throw badRequest('Las cantidades contadas deben ser enteros de 0 o más.');
    const p = get(ctx.db, 'SELECT id, track_stock FROM products WHERE id = ?', c.productId);
    if (!p || !p.track_stock) continue;
    out.set(p.id, qty);
  }
  return out;
}

/** Efectivo que debería haber en la caja: fondo + ventas en efectivo + ingresos − retiros. */
export function cashFigures(ctx, shiftId) {
  const shift = get(ctx.db, 'SELECT * FROM shifts WHERE id = ?', shiftId);
  const cashSales = get(
    ctx.db,
    `SELECT COALESCE(SUM(p.amount_cents), 0) AS n
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.shift_id = ? AND s.status = 'paid' AND p.method = 'efectivo'`,
    shiftId,
  ).n;
  const mv = (type) =>
    get(ctx.db, `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM cash_movements WHERE shift_id = ? AND type = ?`, shiftId, type).n;
  const deposits = mv('in');
  const withdrawals = mv('out');
  return {
    openingCents: shift.opening_cash_cents,
    cashSalesCents: cashSales,
    depositsCents: deposits,
    withdrawalsCents: withdrawals,
    expectedCents: shift.opening_cash_cents + cashSales + deposits - withdrawals,
  };
}

export function openShift(ctx, user, { openingCashCents, stockCounts = [], notes = null }) {
  if (!isCents(openingCashCents)) throw badRequest('Indicá con cuánto efectivo arranca la caja (puede ser 0).');
  return tx(ctx.db, () => {
    const existing = getOpenShift(ctx);
    if (existing) throw conflict('Ya hay un turno abierto.', 'shift_already_open', { shiftId: existing.id });
    const counts = cleanCounts(ctx, stockCounts);
    const info = run(
      ctx.db,
      `INSERT INTO shifts(status, opened_by, opened_at, opening_cash_cents, opening_notes)
       VALUES ('open', ?, ?, ?, ?)`,
      user.id,
      ctx.now(),
      openingCashCents,
      notes?.trim() || null,
    );
    const shiftId = Number(info.lastInsertRowid);
    // si el que abre contó distinto al sistema, manda lo contado: "con cuánto empecé" es el conteo real
    for (const [productId, qty] of counts) {
      const cur = get(ctx.db, 'SELECT stock FROM products WHERE id = ?', productId).stock;
      if (qty !== cur) {
        applyMovement(ctx, { productId, type: 'count_open', qty: qty - cur, reason: 'Conteo al abrir el turno', userId: user.id, shiftId });
      }
    }
    run(
      ctx.db,
      `INSERT INTO shift_stock(shift_id, product_id, opening_qty)
       SELECT ?, id, stock FROM products WHERE track_stock = 1`,
      shiftId,
    );
    audit(ctx, user.id, 'shift.open', 'shift', shiftId, { openingCashCents });
    return { id: shiftId };
  });
}

export function closeShift(ctx, user, { countedCashCents, stockCounts = [], notes = null }) {
  if (!isCents(countedCashCents)) throw badRequest('Indicá cuánto efectivo contaste en la caja (puede ser 0).');
  return tx(ctx.db, () => {
    const shift = requireOpenShift(ctx);
    const counts = cleanCounts(ctx, stockCounts);
    const cash = cashFigures(ctx, shift.id);

    // nada de cobros a medio hacer en un turno cerrado
    run(ctx.db, `UPDATE payment_charges SET status = 'cancelled' WHERE shift_id = ? AND status = 'pending'`, shift.id);

    // productos creados durante el turno: arrancaron en 0
    run(
      ctx.db,
      `INSERT OR IGNORE INTO shift_stock(shift_id, product_id, opening_qty)
       SELECT ?, id, 0 FROM products WHERE track_stock = 1`,
      shift.id,
    );
    run(
      ctx.db,
      `UPDATE shift_stock SET closing_system_qty = (SELECT stock FROM products WHERE id = shift_stock.product_id)
        WHERE shift_id = ?`,
      shift.id,
    );
    for (const [productId, qty] of counts) {
      const cur = get(ctx.db, 'SELECT stock FROM products WHERE id = ?', productId).stock;
      run(ctx.db, 'UPDATE shift_stock SET closing_counted_qty = ? WHERE shift_id = ? AND product_id = ?', qty, shift.id, productId);
      if (qty !== cur) {
        applyMovement(ctx, { productId, type: 'count_close', qty: qty - cur, reason: 'Conteo al cerrar el turno', userId: user.id, shiftId: shift.id });
      }
    }
    run(
      ctx.db,
      `UPDATE shifts SET status='closed', closed_by=?, closed_at=?, counted_cash_cents=?,
              expected_cash_cents=?, cash_diff_cents=?, closing_notes=? WHERE id=?`,
      user.id,
      ctx.now(),
      countedCashCents,
      cash.expectedCents,
      countedCashCents - cash.expectedCents,
      notes?.trim() || null,
      shift.id,
    );
    audit(ctx, user.id, 'shift.close', 'shift', shift.id, {
      expectedCents: cash.expectedCents,
      countedCashCents,
      diffCents: countedCashCents - cash.expectedCents,
    });
    return { id: shift.id };
  });
}

export function addCashMovement(ctx, user, { type, amountCents, reason }) {
  if (!['in', 'out'].includes(type)) throw badRequest('Tipo de movimiento inválido.');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequest('El monto debe ser mayor a 0.');
  if (!reason || !String(reason).trim()) throw badRequest('Indicá el motivo (ej: pago a proveedor, cambio).');
  const shift = requireOpenShift(ctx);
  const info = run(
    ctx.db,
    'INSERT INTO cash_movements(shift_id, user_id, type, amount_cents, reason, created_at) VALUES (?,?,?,?,?,?)',
    shift.id,
    user.id,
    type,
    amountCents,
    String(reason).trim(),
    ctx.now(),
  );
  audit(ctx, user.id, 'cash.movement', 'shift', shift.id, { type, amountCents, reason });
  return { id: Number(info.lastInsertRowid) };
}

export function listCashMovements(ctx, shiftId) {
  return all(
    ctx.db,
    `SELECT m.id, m.type, m.amount_cents, m.reason, m.created_at, u.full_name AS user_name
       FROM cash_movements m JOIN users u ON u.id = m.user_id
      WHERE m.shift_id = ? ORDER BY m.id`,
    shiftId,
  ).map((m) => ({
    id: m.id,
    type: m.type,
    amountCents: m.amount_cents,
    reason: m.reason,
    createdAt: m.created_at,
    userName: m.user_name,
  }));
}

export function listShifts(ctx, { limit = 60, offset = 0 } = {}) {
  return all(
    ctx.db,
    `SELECT s.*, o.full_name AS opened_name, c.full_name AS closed_name,
            (SELECT COALESCE(SUM(total_cents),0) FROM sales WHERE shift_id = s.id AND status = 'paid') AS total_cents,
            (SELECT COUNT(*) FROM sales WHERE shift_id = s.id AND status = 'paid') AS sales_count
       FROM shifts s
       JOIN users o ON o.id = s.opened_by
       LEFT JOIN users c ON c.id = s.closed_by
      ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    limit,
    offset,
  ).map((s) => ({
    id: s.id,
    status: s.status,
    openedAt: s.opened_at,
    openedBy: s.opened_name,
    openedById: s.opened_by,
    closedAt: s.closed_at,
    closedBy: s.closed_name,
    closedById: s.closed_by,
    totalCents: s.total_cents,
    salesCount: s.sales_count,
    cashDiffCents: s.cash_diff_cents,
  }));
}

export function getShift(ctx, id) {
  const s = get(
    ctx.db,
    `SELECT s.*, o.full_name AS opened_name, c.full_name AS closed_name
       FROM shifts s JOIN users o ON o.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by
      WHERE s.id = ?`,
    id,
  );
  if (!s) throw notFound('Turno no encontrado.');
  return s;
}
