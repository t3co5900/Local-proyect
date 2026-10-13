import { all, get } from '../db.js';
import { ymd } from '../util/time.js';
import { getSetting } from './settings.js';
import { getProvider } from './payments/charges.js';
import { stockAt } from './inventory.js';
import { cashFigures, getShift, listCashMovements } from './shifts.js';
import { listSales } from './sales.js';
import { hoursSummary } from './timeclock.js';

const METHODS = ['efectivo', 'transferencia', 'debito', 'credito'];

function scopeSql(scope) {
  if (scope.shiftId != null) return { sql: 's.shift_id = ?', params: [scope.shiftId] };
  return { sql: 's.created_at >= ? AND s.created_at < ?', params: [scope.from, scope.to] };
}

/** Totales, medios de pago, productos y promos de un conjunto de ventas. */
export function aggregateSales(ctx, scope) {
  const { sql: w, params } = scopeSql(scope);
  const paid = `s.status = 'paid' AND ${w}`;

  const totals = get(ctx.db, `SELECT COUNT(*) AS n, COALESCE(SUM(s.total_cents),0) AS total FROM sales s WHERE ${paid}`, ...params);
  const voided = get(ctx.db, `SELECT COUNT(*) AS n, COALESCE(SUM(s.total_cents),0) AS total FROM sales s WHERE s.status = 'void' AND ${w}`, ...params);

  const methodRows = all(
    ctx.db,
    `SELECT p.method, SUM(p.amount_cents) AS amount, COUNT(*) AS n,
            SUM(CASE WHEN p.confirmation = 'manual' THEN 1 ELSE 0 END) AS manual_n,
            SUM(CASE WHEN p.confirmation = 'manual' THEN p.amount_cents ELSE 0 END) AS manual_amount
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id
      WHERE ${paid} GROUP BY p.method`,
    ...params,
  );
  const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const countByMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  let manualCount = 0;
  let manualCents = 0;
  for (const r of methodRows) {
    byMethod[r.method] = r.amount;
    countByMethod[r.method] = r.n;
    manualCount += r.manual_n;
    manualCents += r.manual_amount;
  }
  const digitalCents = byMethod.transferencia + byMethod.debito + byMethod.credito;

  const loose = all(
    ctx.db,
    `SELECT si.product_id, SUM(si.qty) AS units, SUM(si.total_cents) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE si.kind = 'product' AND ${paid} GROUP BY si.product_id`,
    ...params,
  );
  const inPromos = all(
    ctx.db,
    `SELECT sc.product_id, SUM(sc.qty) AS units
       FROM sale_components sc JOIN sale_items si ON si.id = sc.sale_item_id JOIN sales s ON s.id = sc.sale_id
      WHERE si.kind = 'promo' AND ${paid} GROUP BY sc.product_id`,
    ...params,
  );
  const pmap = new Map();
  const slot = (id) => {
    if (!pmap.has(id)) pmap.set(id, { productId: id, unitsLoose: 0, unitsPromo: 0, revenueLooseCents: 0 });
    return pmap.get(id);
  };
  for (const r of loose) { const s = slot(r.product_id); s.unitsLoose = r.units; s.revenueLooseCents = r.revenue; }
  for (const r of inPromos) slot(r.product_id).unitsPromo = r.units;
  const names = new Map(
    all(ctx.db, `SELECT p.id, p.name, c.name AS category, c.sort_order AS cat_order, p.sort_order FROM products p JOIN categories c ON c.id = p.category_id`)
      .map((r) => [r.id, r]),
  );
  const products = [...pmap.values()]
    .map((s) => {
      const meta = names.get(s.productId);
      return {
        ...s,
        name: meta.name,
        category: meta.category,
        unitsTotal: s.unitsLoose + s.unitsPromo,
        _o: [meta.cat_order, meta.category, meta.sort_order, meta.name],
      };
    })
    .sort((a, b) => a._o[0] - b._o[0] || a._o[1].localeCompare(b._o[1], 'es') || a._o[2] - b._o[2] || a._o[3].localeCompare(b._o[3], 'es'))
    .map(({ _o, ...rest }) => rest);

  const promos = all(
    ctx.db,
    `SELECT si.name, SUM(si.qty) AS qty, SUM(si.total_cents) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE si.kind = 'promo' AND ${paid} GROUP BY si.promo_id, si.name ORDER BY si.name`,
    ...params,
  ).map((r) => ({ name: r.name, qty: r.qty, revenueCents: r.revenue }));

  const unitsByCategory = new Map();
  for (const p of products) unitsByCategory.set(p.category, (unitsByCategory.get(p.category) || 0) + p.unitsTotal);

  return {
    salesCount: totals.n,
    totalCents: totals.total,
    avgTicketCents: totals.n ? Math.round(totals.total / totals.n) : 0,
    voidedCount: voided.n,
    voidedCents: voided.total,
    byMethod,
    countByMethod,
    digitalCents,
    cashCents: byMethod.efectivo,
    manualConfirmations: { count: manualCount, cents: manualCents },
    products,
    promos,
    unitsByCategory: [...unitsByCategory].map(([category, units]) => ({ category, units })),
  };
}

// ---------- reporte de turno ----------

function shiftInventory(ctx, shiftId) {
  const rows = all(
    ctx.db,
    `SELECT ss.product_id, p.name, p.active, p.stock AS current_stock, c.name AS category,
            ss.opening_qty, ss.closing_system_qty, ss.closing_counted_qty,
            COALESCE(m.restock, 0) AS restock, COALESCE(m.sold, 0) AS sold,
            COALESCE(m.void_return, 0) AS void_return, COALESCE(m.adjustments, 0) AS adjustments,
            COALESCE(m.waste, 0) AS waste
       FROM shift_stock ss
       JOIN products p ON p.id = ss.product_id
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN (
         SELECT product_id,
                SUM(CASE WHEN type = 'restock' THEN qty END) AS restock,
                -SUM(CASE WHEN type = 'sale' THEN qty END) AS sold,
                SUM(CASE WHEN type = 'void_return' THEN qty END) AS void_return,
                SUM(CASE WHEN type = 'adjustment' THEN qty END) AS adjustments,
                SUM(CASE WHEN type = 'waste' THEN qty END) AS waste
           FROM stock_movements WHERE shift_id = ? GROUP BY product_id
       ) m ON m.product_id = ss.product_id
      WHERE ss.shift_id = ?
      ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
    shiftId,
    shiftId,
  );
  return rows
    .map((r) => {
      const closingSystem = r.closing_system_qty ?? r.current_stock;
      const soldNet = r.sold - r.void_return;
      return {
        productId: r.product_id,
        name: r.name,
        category: r.category,
        opening: r.opening_qty,
        restock: r.restock,
        sold: soldNet,
        adjustments: r.adjustments + r.waste,
        closingSystem,
        closingCounted: r.closing_counted_qty,
        difference: r.closing_counted_qty == null ? null : r.closing_counted_qty - closingSystem,
        _active: !!r.active,
      };
    })
    .filter((r) => r.opening || r.restock || r.sold || r.adjustments || r.closingSystem || r.closingCounted)
    .map(({ _active, ...rest }) => rest);
}

export function shiftReport(ctx, shiftId) {
  const s = getShift(ctx, shiftId);
  const agg = aggregateSales(ctx, { shiftId });
  const cash = cashFigures(ctx, shiftId);
  return {
    business: getSetting(ctx, 'business.name'),
    timezone: ctx.timezone,
    mpEnabled: getProvider(ctx) != null,
    shift: {
      id: s.id,
      status: s.status,
      openedBy: s.opened_name,
      openedAt: s.opened_at,
      closedBy: s.closed_name,
      closedAt: s.closed_at,
      openingNotes: s.opening_notes,
      closingNotes: s.closing_notes,
    },
    cash: {
      ...cash,
      countedCents: s.counted_cash_cents,
      diffCents: s.cash_diff_cents,
    },
    totals: agg,
    cashMovements: listCashMovements(ctx, shiftId),
    inventory: shiftInventory(ctx, shiftId),
    sales: listSales(ctx, { shiftId, limit: 10000 }).reverse(),
  };
}

// ---------- reporte de período (semanal, mensual, etc.) ----------

function periodInventory(ctx, from, to) {
  const start = stockAt(ctx, from);
  const end = stockAt(ctx, to);
  const rows = all(
    ctx.db,
    `SELECT p.id AS product_id, p.name, p.active, c.name AS category,
            COALESCE(SUM(CASE WHEN m.type = 'restock' THEN m.qty END), 0) AS restock,
            -COALESCE(SUM(CASE WHEN m.type = 'sale' THEN m.qty END), 0) AS sold,
            COALESCE(SUM(CASE WHEN m.type = 'void_return' THEN m.qty END), 0) AS void_return,
            COALESCE(SUM(CASE WHEN m.type = 'adjustment' THEN m.qty END), 0) AS adjustments,
            COALESCE(SUM(CASE WHEN m.type = 'waste' THEN m.qty END), 0) AS waste,
            COALESCE(SUM(CASE WHEN m.type IN ('count_open','count_close') THEN m.qty END), 0) AS counts
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_movements m ON m.product_id = p.id AND m.created_at >= ? AND m.created_at < ?
      WHERE p.track_stock = 1
      GROUP BY p.id
      ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
    from,
    to,
  );
  return rows
    .map((r) => ({
      productId: r.product_id,
      name: r.name,
      category: r.category,
      start: start.get(r.product_id) ?? 0,
      restock: r.restock,
      sold: r.sold - r.void_return,
      adjustments: r.adjustments + r.waste + r.counts,
      end: end.get(r.product_id) ?? 0,
      _active: !!r.active,
    }))
    .filter((r) => r.start || r.restock || r.sold || r.adjustments || r.end)
    .map(({ _active, ...rest }) => rest);
}

export function periodReport(ctx, { from, to }) {
  const agg = aggregateSales(ctx, { from, to });

  const dailyMap = new Map();
  const payRows = all(
    ctx.db,
    `SELECT s.created_at, p.method, p.amount_cents
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.status = 'paid' AND s.created_at >= ? AND s.created_at < ?`,
    from,
    to,
  );
  const saleRows = all(ctx.db, `SELECT created_at FROM sales WHERE status = 'paid' AND created_at >= ? AND created_at < ?`, from, to);
  const dayRow = (day) => {
    if (!dailyMap.has(day)) dailyMap.set(day, { day, salesCount: 0, efectivo: 0, transferencia: 0, debito: 0, credito: 0, totalCents: 0 });
    return dailyMap.get(day);
  };
  for (const r of saleRows) dayRow(ymd(r.created_at, ctx.timezone)).salesCount += 1;
  for (const r of payRows) {
    const d = dayRow(ymd(r.created_at, ctx.timezone));
    d[r.method] += r.amount_cents;
    d.totalCents += r.amount_cents;
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const shifts = all(
    ctx.db,
    `SELECT s.*, o.full_name AS opened_name, c.full_name AS closed_name,
            (SELECT COALESCE(SUM(total_cents),0) FROM sales WHERE shift_id = s.id AND status='paid') AS total_cents,
            (SELECT COUNT(*) FROM sales WHERE shift_id = s.id AND status='paid') AS sales_count
       FROM shifts s JOIN users o ON o.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by
      WHERE s.opened_at >= ? AND s.opened_at < ? ORDER BY s.id`,
    from,
    to,
  ).map((s) => ({
    id: s.id,
    openedAt: s.opened_at,
    closedAt: s.closed_at,
    openedBy: s.opened_name,
    closedBy: s.closed_name,
    salesCount: s.sales_count,
    totalCents: s.total_cents,
    openingCashCents: s.opening_cash_cents,
    expectedCashCents: s.expected_cash_cents,
    countedCashCents: s.counted_cash_cents,
    cashDiffCents: s.cash_diff_cents,
  }));

  const restockLines = all(
    ctx.db,
    `SELECT m.created_at, p.name AS product, m.qty, r.supplier, r.note, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN restocks r ON r.id = m.restock_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.type = 'restock' AND m.created_at >= ? AND m.created_at < ?
      ORDER BY m.created_at, m.id`,
    from,
    to,
  );

  return {
    business: getSetting(ctx, 'business.name'),
    timezone: ctx.timezone,
    mpEnabled: getProvider(ctx) != null,
    from,
    to,
    totals: agg,
    daily,
    shifts,
    inventory: periodInventory(ctx, from, to),
    restockLines,
    hours: hoursSummary(ctx, from, to),
  };
}

/** Datos en vivo del turno abierto para la pantalla de caja. */
export function liveSummary(ctx, shiftId) {
  const agg = aggregateSales(ctx, { shiftId });
  return { totals: agg, cash: cashFigures(ctx, shiftId) };
}
