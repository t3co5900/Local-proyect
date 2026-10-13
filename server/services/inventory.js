import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../util/errors.js';
import { audit } from './audit.js';
import { getOpenShift } from './common.js';

/**
 * Único punto por el que cambia el stock: actualiza products.stock y deja el
 * renglón en el libro de movimientos. Así el stock siempre se puede reconstruir.
 */
export function applyMovement(ctx, m) {
  if (!Number.isInteger(m.qty) || m.qty === 0) return;
  run(ctx.db, 'UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?', m.qty, ctx.now(), m.productId);
  run(
    ctx.db,
    `INSERT INTO stock_movements(product_id, type, qty, reason, user_id, shift_id, sale_id, restock_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    m.productId,
    m.type,
    m.qty,
    m.reason ?? null,
    m.userId ?? null,
    m.shiftId ?? null,
    m.saleId ?? null,
    m.restockId ?? null,
    ctx.now(),
  );
}

function trackedProduct(ctx, productId) {
  const p = get(ctx.db, 'SELECT * FROM products WHERE id = ?', productId);
  if (!p) throw notFound('Producto no encontrado.');
  if (!p.track_stock) throw badRequest(`"${p.name}" no maneja stock.`);
  return p;
}

/** Ingreso de mercadería (lo que llega del proveedor/fábrica). */
export function restock(ctx, user, { items, supplier = null, note = null }) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Cargá al menos un producto.');
  return tx(ctx.db, () => {
    const shift = getOpenShift(ctx);
    const info = run(
      ctx.db,
      'INSERT INTO restocks(user_id, shift_id, supplier, note, created_at) VALUES (?,?,?,?,?)',
      user.id,
      shift?.id ?? null,
      supplier?.trim() || null,
      note?.trim() || null,
      ctx.now(),
    );
    const restockId = Number(info.lastInsertRowid);
    const merged = new Map();
    for (const it of items) {
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Las cantidades deben ser números enteros mayores a 0.');
      merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
    }
    for (const [productId, qty] of merged) {
      trackedProduct(ctx, productId);
      applyMovement(ctx, { productId, type: 'restock', qty, userId: user.id, shiftId: shift?.id, restockId, reason: supplier?.trim() || null });
    }
    audit(ctx, user.id, 'stock.restock', 'restock', restockId, { lines: merged.size });
    return { id: restockId };
  });
}

/** Ajuste manual (corrección) o merma (producto tirado/vencido). `qty` es el cambio, con signo. */
export function adjust(ctx, user, { productId, qty, reason, kind = 'adjustment' }) {
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty === 0) throw badRequest('La cantidad debe ser un entero distinto de 0.');
  if (!reason || !String(reason).trim()) throw badRequest('Indicá el motivo del ajuste.');
  if (!['adjustment', 'waste'].includes(kind)) throw badRequest('Tipo de ajuste inválido.');
  if (kind === 'waste') qty = -Math.abs(qty);
  return tx(ctx.db, () => {
    const p = trackedProduct(ctx, productId);
    const shift = getOpenShift(ctx);
    applyMovement(ctx, { productId, type: kind, qty, reason: String(reason).trim(), userId: user.id, shiftId: shift?.id });
    audit(ctx, user.id, `stock.${kind}`, 'product', productId, { qty, reason, product: p.name });
    return { stock: get(ctx.db, 'SELECT stock FROM products WHERE id = ?', productId).stock };
  });
}

export function listStock(ctx) {
  return all(
    ctx.db,
    `SELECT p.id, p.name, p.stock, p.low_stock_threshold, p.active, c.name AS category
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.track_stock = 1
      ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
  ).map((r) => ({
    productId: r.id,
    name: r.name,
    category: r.category,
    stock: r.stock,
    lowStockThreshold: r.low_stock_threshold,
    active: !!r.active,
    low: r.stock <= r.low_stock_threshold,
  }));
}

export function listMovements(ctx, { from, to, productId, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (from != null) { where.push('m.created_at >= ?'); params.push(from); }
  if (to != null) { where.push('m.created_at < ?'); params.push(to); }
  if (productId) { where.push('m.product_id = ?'); params.push(productId); }
  return all(
    ctx.db,
    `SELECT m.id, m.created_at, m.type, m.qty, m.reason, m.shift_id, m.sale_id,
            p.name AS product, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.id DESC LIMIT ?`,
    ...params,
    limit,
  );
}

/** Stock de cada producto en el instante `t`, reconstruido desde el libro de movimientos. */
export function stockAt(ctx, t) {
  const rows = all(
    ctx.db,
    `SELECT p.id AS product_id, p.stock - COALESCE((
              SELECT SUM(m.qty) FROM stock_movements m
               WHERE m.product_id = p.id AND m.created_at >= ?), 0) AS qty
       FROM products p WHERE p.track_stock = 1`,
    t,
  );
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}
