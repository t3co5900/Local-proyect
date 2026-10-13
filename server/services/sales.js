import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../util/errors.js';
import { audit } from './audit.js';
import { requireOpenShift } from './common.js';
import { applyMovement } from './inventory.js';
import { markChargeUsed, verifyChargeForSale } from './payments/charges.js';
import { getSetting } from './settings.js';

export const METHODS = ['efectivo', 'transferencia', 'debito', 'credito'];

/** Convierte lo que manda la pantalla en líneas con precio y consumo de stock. */
function buildLines(ctx, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw badRequest('Agregá al menos un producto a la venta.');
  const merged = new Map();
  for (const it of rawItems) {
    const qty = Number(it.qty);
    if (!['product', 'promo'].includes(it.kind)) throw badRequest('Tipo de ítem inválido.');
    if (!Number.isInteger(qty) || qty <= 0 || qty > 999) throw badRequest('Cantidad inválida.');
    const key = `${it.kind}:${it.id}`;
    merged.set(key, { kind: it.kind, id: Number(it.id), qty: (merged.get(key)?.qty || 0) + qty });
  }
  const lines = [];
  for (const { kind, id, qty } of merged.values()) {
    if (kind === 'product') {
      const p = get(
        ctx.db,
        `SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
        id,
      );
      if (!p || !p.active) throw badRequest('Un producto de la venta ya no está disponible.');
      lines.push({
        kind, productId: p.id, promoId: null, name: p.name, categoryName: p.category_name, qty,
        unitPriceCents: p.price_cents, totalCents: p.price_cents * qty,
        components: [{ productId: p.id, qty, track: !!p.track_stock, name: p.name, stock: p.stock }],
      });
    } else {
      const pr = get(ctx.db, 'SELECT * FROM promos WHERE id = ?', id);
      if (!pr || !pr.active) throw badRequest('Una promo de la venta ya no está disponible.');
      const items = all(
        ctx.db,
        `SELECT pi.product_id, pi.qty, p.name, p.track_stock, p.active, p.stock
           FROM promo_items pi JOIN products p ON p.id = pi.product_id WHERE pi.promo_id = ?`,
        id,
      );
      if (items.some((i) => !i.active)) throw badRequest(`La promo "${pr.name}" incluye un producto desactivado.`);
      lines.push({
        kind, productId: null, promoId: pr.id, name: pr.name, categoryName: 'Promos', qty,
        unitPriceCents: pr.price_cents, totalCents: pr.price_cents * qty,
        components: items.map((i) => ({ productId: i.product_id, qty: i.qty * qty, track: !!i.track_stock, name: i.name, stock: i.stock })),
      });
    }
  }
  return lines;
}

function normalizePayments(rawPayments, total) {
  if (!Array.isArray(rawPayments) || rawPayments.length === 0) throw badRequest('Elegí cómo se paga.');
  const out = [];
  for (const p of rawPayments) {
    if (!METHODS.includes(p.method)) throw badRequest('Medio de pago inválido.');
    const amount = Number(p.amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Monto de pago inválido.');
    out.push({ ...p, amountCents: amount });
  }
  const sum = out.reduce((a, p) => a + p.amountCents, 0);
  if (sum !== total) {
    throw badRequest('Los pagos no suman el total de la venta.', 'payments_mismatch', { totalCents: total, paidCents: sum });
  }
  return out;
}

export function createSale(ctx, user, { items, payments, note = null }) {
  return tx(ctx.db, () => {
    const shift = requireOpenShift(ctx);
    const lines = buildLines(ctx, items);
    const total = lines.reduce((a, l) => a + l.totalCents, 0);
    if (total <= 0) throw badRequest('El total de la venta debe ser mayor a 0.');
    const pays = normalizePayments(payments, total);

    // consumo total por producto (una promo puede repetir producto con otra línea)
    const consume = new Map();
    for (const l of lines) {
      for (const c of l.components) {
        const cur = consume.get(c.productId) || { qty: 0, track: c.track, name: c.name, stock: c.stock };
        cur.qty += c.qty;
        consume.set(c.productId, cur);
      }
    }
    if (getSetting(ctx, 'stock.blockOnNoStock')) {
      const short = [...consume.values()].filter((c) => c.track && c.stock < c.qty).map((c) => c.name);
      if (short.length) throw conflict(`No hay stock suficiente de: ${short.join(', ')}.`, 'no_stock', { products: short });
    }

    const number = (get(ctx.db, 'SELECT COALESCE(MAX(number), 0) AS n FROM sales').n || 0) + 1;
    const saleId = Number(
      run(
        ctx.db,
        `INSERT INTO sales(number, shift_id, user_id, created_at, total_cents, note) VALUES (?,?,?,?,?,?)`,
        number, shift.id, user.id, ctx.now(), total, note?.trim() || null,
      ).lastInsertRowid,
    );

    for (const l of lines) {
      const itemId = Number(
        run(
          ctx.db,
          `INSERT INTO sale_items(sale_id, kind, product_id, promo_id, name, category_name, qty, unit_price_cents, total_cents)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          saleId, l.kind, l.productId, l.promoId, l.name, l.categoryName, l.qty, l.unitPriceCents, l.totalCents,
        ).lastInsertRowid,
      );
      for (const c of l.components) {
        run(ctx.db, 'INSERT INTO sale_components(sale_item_id, sale_id, product_id, qty) VALUES (?,?,?,?)', itemId, saleId, c.productId, c.qty);
      }
    }

    for (const [productId, c] of consume) {
      if (c.track) {
        applyMovement(ctx, { productId, type: 'sale', qty: -c.qty, userId: user.id, shiftId: shift.id, saleId });
      }
    }

    for (const p of pays) {
      let method = p.method;
      let confirmation = 'manual';
      let chargeId = null;
      let mpPaymentId = null;
      let tendered = null;
      let change = null;
      if (method === 'efectivo') {
        confirmation = 'cash';
        if (p.tenderedCents != null) {
          tendered = Number(p.tenderedCents);
          if (!Number.isInteger(tendered) || tendered < p.amountCents) throw badRequest('El efectivo recibido no alcanza.');
          change = tendered - p.amountCents;
        }
      } else if (p.chargeId != null) {
        const ch = verifyChargeForSale(ctx, Number(p.chargeId), { shiftId: shift.id, amountCents: p.amountCents, method });
        method = ch.resolved_method || method;
        confirmation = 'auto';
        chargeId = ch.id;
        mpPaymentId = ch.mp_payment_id;
        markChargeUsed(ctx, ch.id, saleId);
      }
      run(
        ctx.db,
        `INSERT INTO sale_payments(sale_id, method, amount_cents, tendered_cents, change_cents, confirmation, charge_id, mp_payment_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        saleId, method, p.amountCents, tendered, change, confirmation, chargeId, mpPaymentId,
      );
    }
    return getSale(ctx, saleId);
  });
}

function mapSale(s) {
  return {
    id: s.id,
    number: s.number,
    shiftId: s.shift_id,
    userId: s.user_id,
    userName: s.user_name,
    createdAt: s.created_at,
    totalCents: s.total_cents,
    status: s.status,
    voidedAt: s.voided_at,
    voidReason: s.void_reason,
    note: s.note,
  };
}

export function getSale(ctx, id) {
  const s = get(
    ctx.db,
    `SELECT s.*, u.full_name AS user_name FROM sales s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    id,
  );
  if (!s) throw notFound('Venta no encontrada.');
  return {
    ...mapSale(s),
    items: all(ctx.db, 'SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', id).map((i) => ({
      id: i.id, kind: i.kind, name: i.name, qty: i.qty, unitPriceCents: i.unit_price_cents, totalCents: i.total_cents,
    })),
    payments: all(ctx.db, 'SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY id', id).map((p) => ({
      method: p.method, amountCents: p.amount_cents, tenderedCents: p.tendered_cents,
      changeCents: p.change_cents, confirmation: p.confirmation, mpPaymentId: p.mp_payment_id,
    })),
  };
}

export function listSales(ctx, { shiftId, from, to, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (shiftId) { where.push('s.shift_id = ?'); params.push(shiftId); }
  if (from != null) { where.push('s.created_at >= ?'); params.push(from); }
  if (to != null) { where.push('s.created_at < ?'); params.push(to); }
  const rows = all(
    ctx.db,
    `SELECT s.*, u.full_name AS user_name FROM sales s JOIN users u ON u.id = s.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.id DESC LIMIT ?`,
    ...params,
    limit,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const pays = all(ctx.db, `SELECT * FROM sale_payments WHERE sale_id IN (${marks})`, ...ids);
  const items = all(ctx.db, `SELECT sale_id, name, qty FROM sale_items WHERE sale_id IN (${marks}) ORDER BY id`, ...ids);
  return rows.map((r) => ({
    ...mapSale(r),
    payments: pays.filter((p) => p.sale_id === r.id).map((p) => ({
      method: p.method, amountCents: p.amount_cents, confirmation: p.confirmation,
    })),
    summary: items.filter((i) => i.sale_id === r.id).map((i) => `${i.qty}× ${i.name}`).join(', '),
  }));
}

/**
 * Anula una venta del turno abierto y devuelve el stock. `approver` es un
 * administrador (el propio usuario o un encargado que ingresó su código).
 */
export function voidSale(ctx, actor, approver, saleId, reason) {
  if (!reason || !String(reason).trim()) throw badRequest('Indicá el motivo de la anulación.');
  if (approver.role !== 'admin') throw forbidden('La anulación la tiene que autorizar un encargado.');
  return tx(ctx.db, () => {
    const sale = get(ctx.db, 'SELECT * FROM sales WHERE id = ?', saleId);
    if (!sale) throw notFound('Venta no encontrada.');
    if (sale.status === 'void') throw conflict('La venta ya estaba anulada.');
    const shift = requireOpenShift(ctx);
    if (sale.shift_id !== shift.id) {
      throw conflict('Solo se pueden anular ventas del turno abierto (el turno cerrado ya se informó).', 'shift_closed');
    }
    run(
      ctx.db,
      `UPDATE sales SET status='void', voided_at=?, voided_by=?, void_approved_by=?, void_reason=? WHERE id=?`,
      ctx.now(), actor.id, approver.id, String(reason).trim(), saleId,
    );
    const comps = all(
      ctx.db,
      `SELECT sc.product_id, SUM(sc.qty) AS qty, p.track_stock
         FROM sale_components sc JOIN products p ON p.id = sc.product_id
        WHERE sc.sale_id = ? GROUP BY sc.product_id`,
      saleId,
    );
    for (const c of comps) {
      if (c.track_stock) {
        applyMovement(ctx, { productId: c.product_id, type: 'void_return', qty: c.qty, reason: 'Venta anulada', userId: actor.id, shiftId: shift.id, saleId });
      }
    }
    const paidElectronically = get(
      ctx.db,
      `SELECT COUNT(*) AS n FROM sale_payments WHERE sale_id = ? AND method <> 'efectivo'`,
      saleId,
    ).n;
    audit(ctx, actor.id, 'sale.void', 'sale', saleId, {
      number: sale.number, totalCents: sale.total_cents, reason, approvedBy: approver.id,
    });
    return { ...getSale(ctx, saleId), refundNote: paidElectronically ? 'Había cobros por QR/tarjeta: la devolución del dinero al cliente se hace desde Mercado Pago o el posnet.' : null };
  });
}
