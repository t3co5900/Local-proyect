import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { formatDate, formatDateTime, formatTime } from '../util/time.js';
import { METHOD_LABEL, METHOD_ORDER, MOVEMENT_LABEL } from './labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOGO = path.join(here, '..', 'assets', 'logo-white.png');

const YELLOW = 'FFFFCB05';
const INK = 'FF181816';
const SOFT = 'FFFFF4C2';
const ZEBRA = 'FFF7F6F2';
const LINE = 'FFD6D4CC';
const RED = 'FFB42318';

const MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00';
const INT = '#,##0;[Red]-#,##0';

const $ = (cents) => (cents == null ? null : cents / 100);

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: LINE } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

const colLetter = (n) => {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

function newWorkbook(business) {
  const wb = new ExcelJS.Workbook();
  wb.creator = business;
  wb.created = new Date();
  wb.logoId = fs.existsSync(LOGO) ? wb.addImage({ filename: LOGO, extension: 'png' }) : null;
  return wb;
}

/** Hoja con banda negra: logo + título + subtítulo. `widths` define las columnas. */
function addSheet(wb, name, { title, subtitle, widths, landscape = false }) {
  const ws = wb.addWorksheet(name, {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: landscape ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L&8${wb.creator}&C&8${name}&R&8Página &P de &N` },
  });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const last = widths.length;
  ws.getRow(1).height = 34;
  ws.getRow(2).height = 24;
  for (let r = 1; r <= 2; r++) for (let c = 1; c <= last; c++) ws.getCell(r, c).fill = fill(INK);
  ws.mergeCells(1, 2, 1, last);
  ws.mergeCells(2, 2, 2, last);
  const t = ws.getCell(1, 2);
  t.value = title;
  t.font = { name: 'Calibri', size: 18, bold: true, color: { argb: YELLOW } };
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  const s = ws.getCell(2, 2);
  s.value = subtitle || '';
  s.font = { name: 'Calibri', size: 10.5, color: { argb: 'FFFFFFFF' } };
  s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  if (wb.logoId != null) ws.addImage(wb.logoId, { tl: { col: 0.12, row: 0.1 }, ext: { width: 58, height: 49 } });
  ws.lastCol = last;
  return ws;
}

function section(ws, row, text) {
  ws.mergeCells(row, 1, row, ws.lastCol);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { bold: true, size: 12, color: { argb: INK } };
  c.fill = fill(YELLOW);
  c.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(row).height = 22;
  return row + 1;
}

/** Fila "etiqueta : valor" (para bloques de datos). */
function kv(ws, row, label, value, { fmt, bold = false, color, valueCol = 2 } = {}) {
  const a = ws.getCell(row, 1);
  a.value = label;
  a.font = { bold };
  a.border = box;
  a.alignment = { indent: 1 };
  const b = ws.getCell(row, valueCol);
  b.value = value;
  b.border = box;
  b.font = { bold, color: color ? { argb: color } : undefined };
  const numeric = typeof value === 'number' || (value && typeof value === 'object' && 'formula' in value);
  b.alignment = { horizontal: numeric ? 'right' : 'left', indent: numeric ? 0 : 1 };
  if (fmt) b.numFmt = fmt;
  if (bold) { a.fill = fill(SOFT); b.fill = fill(SOFT); }
  return row + 1;
}

const TYPES = {
  text: { fmt: undefined, align: 'left' },
  center: { fmt: undefined, align: 'center' },
  int: { fmt: INT, align: 'right' },
  money: { fmt: MONEY, align: 'right' },
  hours: { fmt: '0.00', align: 'right' },
};

/**
 * Tabla con encabezado amarillo, filas cebradas y (opcional) fila de totales
 * con fórmulas SUM reales. Devuelve la próxima fila libre.
 */
function table(ws, row, cols, rows, { totals = false, totalLabel = 'TOTAL' } = {}) {
  cols.forEach((col, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = col.header;
    c.font = { bold: true, color: { argb: INK } };
    c.fill = fill(YELLOW);
    c.border = box;
    c.alignment = { vertical: 'middle', horizontal: col.type === 'text' || !col.type ? 'left' : 'center', wrapText: true, indent: col.type === 'text' || !col.type ? 1 : 0 };
  });
  ws.getRow(row).height = 24;
  const first = row + 1;
  rows.forEach((r, ri) => {
    const rr = first + ri;
    cols.forEach((col, ci) => {
      const t = TYPES[col.type || 'text'];
      const c = ws.getCell(rr, ci + 1);
      c.value = r[col.key] ?? null;
      c.border = box;
      c.alignment = { horizontal: t.align, vertical: 'middle', indent: t.align === 'left' ? 1 : 0, wrapText: !!col.wrap };
      if (t.fmt) c.numFmt = t.fmt;
      if (ri % 2 === 1) c.fill = fill(ZEBRA);
      if (col.danger && typeof c.value === 'number' && c.value < 0) c.font = { color: { argb: RED }, bold: true };
    });
  });
  let next = first + rows.length;
  if (totals && rows.length) {
    cols.forEach((col, ci) => {
      const c = ws.getCell(next, ci + 1);
      c.fill = fill(SOFT);
      c.border = { ...box, top: { style: 'medium', color: { argb: INK } } };
      c.font = { bold: true };
      const t = TYPES[col.type || 'text'];
      c.alignment = { horizontal: t.align, indent: t.align === 'left' ? 1 : 0 };
      if (ci === 0) c.value = totalLabel;
      if (col.total) {
        const L = colLetter(ci + 1);
        const sum = rows.reduce((a, r) => a + (Number(r[col.key]) || 0), 0);
        c.value = { formula: `SUM(${L}${first}:${L}${first + rows.length - 1})`, result: sum };
        if (t.fmt) c.numFmt = t.fmt;
      }
    });
    next += 1;
  }
  return next + 1;
}

function note(ws, row, text) {
  ws.mergeCells(row, 1, row, ws.lastCol);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { italic: true, size: 10, color: { argb: 'FF6B6B66' } };
  c.alignment = { wrapText: true, vertical: 'top', indent: 1 };
  ws.getRow(row).height = 28;
  return row + 2;
}

function emptyNote(ws, row, text) {
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { italic: true, color: { argb: 'FF6B6B66' } };
  return row + 2;
}

const period = (rep) => `${formatDate(rep.from, rep.timezone)} al ${formatDate(rep.to - 1, rep.timezone)}`;

// ---------------------------------------------------------------------------
// Cierre de turno
// ---------------------------------------------------------------------------

export async function shiftWorkbook(rep) {
  const tz = rep.timezone;
  const s = rep.shift;
  const wb = newWorkbook(rep.business);
  const subtitle = `Turno #${s.id} · Encargado: ${s.openedBy} · ${formatDateTime(s.openedAt, tz)}${s.closedAt ? ' → ' + formatDateTime(s.closedAt, tz) : ' (turno abierto)'}`;

  // ---- Hoja 1: Cierre
  const ws = addSheet(wb, 'Cierre', { title: `Cierre de turno #${s.id}`, subtitle, widths: [52, 24, 46] });
  let r = 4;
  r = section(ws, r, 'Datos del turno');
  r = kv(ws, r, 'Encargado (abrió el turno)', s.openedBy);
  r = kv(ws, r, 'Apertura', formatDateTime(s.openedAt, tz));
  r = kv(ws, r, 'Cerró el turno', s.closedBy || '—');
  r = kv(ws, r, 'Cierre', s.closedAt ? formatDateTime(s.closedAt, tz) : 'Turno abierto');
  r = kv(ws, r, 'Cantidad de ventas', rep.totals.salesCount, { fmt: INT });
  r = kv(ws, r, 'Ventas anuladas', rep.totals.voidedCount, { fmt: INT });
  r = kv(ws, r, 'Ticket promedio', $(rep.totals.avgTicketCents), { fmt: MONEY });
  r += 1;

  r = section(ws, r, 'Cobros por medio de pago');
  for (const m of METHOD_ORDER) r = kv(ws, r, METHOD_LABEL[m], $(rep.totals.byMethod[m]), { fmt: MONEY });
  const firstMethod = r - METHOD_ORDER.length;
  const L = (i) => `B${firstMethod + i}`; // 0 efectivo,1 transf,2 deb,3 cred
  r = kv(ws, r, 'Subtotal digital (transferencia + débito + crédito)',
    { formula: `${L(1)}+${L(2)}+${L(3)}`, result: $(rep.totals.digitalCents) }, { fmt: MONEY, bold: true });
  r = kv(ws, r, 'Subtotal efectivo', { formula: L(0), result: $(rep.totals.cashCents) }, { fmt: MONEY, bold: true });
  r = kv(ws, r, 'TOTAL VENDIDO', { formula: `B${r - 2}+B${r - 1}`, result: $(rep.totals.totalCents) }, { fmt: MONEY, bold: true });
  if (rep.mpEnabled && rep.totals.manualConfirmations.count) {
    r = kv(ws, r, 'Cobros no efectivo confirmados a mano', `${rep.totals.manualConfirmations.count} por ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format($(rep.totals.manualConfirmations.cents))}`, { color: RED });
    ws.getCell(r - 1, 3).value = 'Verificar contra Mercado Pago / posnet.';
    ws.getCell(r - 1, 3).font = { italic: true, color: { argb: RED } };
  }
  r += 1;

  r = section(ws, r, 'Control de caja (solo efectivo)');
  const c0 = r;
  r = kv(ws, r, 'Efectivo inicial (fondo de caja)', $(rep.cash.openingCents), { fmt: MONEY });
  r = kv(ws, r, '+ Ventas en efectivo', $(rep.cash.cashSalesCents), { fmt: MONEY });
  r = kv(ws, r, '+ Ingresos de efectivo', $(rep.cash.depositsCents), { fmt: MONEY });
  r = kv(ws, r, '− Retiros de efectivo', $(rep.cash.withdrawalsCents), { fmt: MONEY });
  r = kv(ws, r, 'Efectivo esperado en caja',
    { formula: `B${c0}+B${c0 + 1}+B${c0 + 2}-B${c0 + 3}`, result: $(rep.cash.expectedCents) }, { fmt: MONEY, bold: true });
  if (s.status === 'closed') {
    r = kv(ws, r, 'Efectivo contado al cerrar', $(rep.cash.countedCents), { fmt: MONEY });
    r = kv(ws, r, 'Diferencia (contado − esperado)',
      { formula: `B${r - 1}-B${r - 2}`, result: $(rep.cash.diffCents) }, { fmt: MONEY, bold: true, color: rep.cash.diffCents < 0 ? RED : undefined });
    ws.getCell(r - 1, 3).value = rep.cash.diffCents === 0 ? 'La caja cierra justa.' : rep.cash.diffCents < 0 ? 'Faltante en caja.' : 'Sobrante en caja.';
  } else {
    r = kv(ws, r, 'Efectivo contado al cerrar', 'Turno todavía abierto');
  }
  if (s.closingNotes) { r += 1; r = kv(ws, r, 'Observaciones', s.closingNotes); }
  ws.pageSetup.printArea = `A1:C${r}`;

  // ---- Hoja 2: Productos vendidos
  const w2 = addSheet(wb, 'Productos vendidos', {
    title: 'Productos vendidos', subtitle, widths: [30, 18, 14, 14, 14, 18],
  });
  let r2 = 4;
  r2 = section(w2, r2, 'Unidades vendidas por producto');
  r2 = note(w2, r2, 'Incluye las unidades que salieron dentro de promos.');
  if (rep.totals.products.length) {
    r2 = table(w2, r2, [
      { header: 'Producto', key: 'name', type: 'text' },
      { header: 'Categoría', key: 'category', type: 'text' },
      { header: 'Sueltas', key: 'unitsLoose', type: 'int', total: true },
      { header: 'En promos', key: 'unitsPromo', type: 'int', total: true },
      { header: 'Total unidades', key: 'unitsTotal', type: 'int', total: true },
      { header: 'Importe vendido suelto', key: 'revenue', type: 'money', total: true },
    ], rep.totals.products.map((p) => ({ ...p, revenue: $(p.revenueLooseCents) })), { totals: true });
  } else r2 = emptyNote(w2, r2, 'No hubo ventas en este turno.');
  r2 = section(w2, r2, 'Promos vendidas');
  if (rep.totals.promos.length) {
    r2 = table(w2, r2, [
      { header: 'Promo', key: 'name', type: 'text' },
      { header: '', key: 'x', type: 'text' },
      { header: 'Cantidad', key: 'qty', type: 'int', total: true },
      { header: '', key: 'y', type: 'text' },
      { header: '', key: 'z', type: 'text' },
      { header: 'Importe', key: 'revenue', type: 'money', total: true },
    ], rep.totals.promos.map((p) => ({ ...p, revenue: $(p.revenueCents) })), { totals: true });
  } else r2 = emptyNote(w2, r2, 'No se vendieron promos.');
  r2 = section(w2, r2, 'Unidades por categoría');
  r2 = table(w2, r2, [
    { header: 'Categoría', key: 'category', type: 'text' },
    { header: '', key: 'x', type: 'text' },
    { header: 'Unidades', key: 'units', type: 'int', total: true },
  ], rep.totals.unitsByCategory, { totals: true });
  w2.views = [{ showGridLines: false }];

  // ---- Hoja 3: Inventario
  const w3 = addSheet(wb, 'Inventario', {
    title: 'Inventario del turno', subtitle, landscape: true,
    widths: [28, 18, 12, 12, 12, 16, 15, 15, 14],
  });
  let r3 = 4;
  r3 = section(w3, r3, 'Inventario del turno');
  r3 = note(w3, r3, 'Inicio + ingresos − vendido ± ajustes = final (según sistema). Si se contó al cerrar, se muestra lo contado y la diferencia.');
  r3 = table(w3, r3, [
    { header: 'Producto', key: 'name', type: 'text' },
    { header: 'Categoría', key: 'category', type: 'text' },
    { header: 'Inicio', key: 'opening', type: 'int', total: true },
    { header: 'Ingresos', key: 'restock', type: 'int', total: true },
    { header: 'Vendido', key: 'sold', type: 'int', total: true },
    { header: 'Ajustes / mermas', key: 'adjustments', type: 'int', total: true },
    { header: 'Final (sistema)', key: 'closingSystem', type: 'int', total: true },
    { header: 'Final (contado)', key: 'closingCounted', type: 'int' },
    { header: 'Diferencia', key: 'difference', type: 'int', danger: true },
  ], rep.inventory, { totals: true });

  // ---- Hoja 4: Detalle de ventas
  const w4 = addSheet(wb, 'Detalle de ventas', {
    title: 'Detalle de ventas', subtitle, landscape: true, widths: [10, 10, 22, 54, 34, 16, 12],
  });
  let r4 = 4;
  const saleRows = rep.sales.map((x) => ({
    number: x.number,
    time: formatTime(x.createdAt, tz),
    user: x.userName,
    summary: x.summary,
    pay: x.payments.map((p) => `${METHOD_LABEL[p.method]} ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(p.amountCents / 100)}${p.confirmation === 'manual' ? ' (a mano)' : ''}`).join(' + '),
    total: x.status === 'void' ? 0 : $(x.totalCents),
    status: x.status === 'void' ? `ANULADA${x.voidReason ? ': ' + x.voidReason : ''}` : 'OK',
  }));
  if (saleRows.length) {
    r4 = table(w4, r4, [
      { header: 'N°', key: 'number', type: 'center' },
      { header: 'Hora', key: 'time', type: 'center' },
      { header: 'Cajero', key: 'user', type: 'text' },
      { header: 'Detalle', key: 'summary', type: 'text', wrap: true },
      { header: 'Medios de pago', key: 'pay', type: 'text', wrap: true },
      { header: 'Total', key: 'total', type: 'money', total: true },
      { header: 'Estado', key: 'status', type: 'text', wrap: true },
    ], saleRows, { totals: true });
  } else r4 = emptyNote(w4, r4, 'No hubo ventas en este turno.');

  // ---- Hoja 5: Movimientos de caja
  const w5 = addSheet(wb, 'Movimientos de caja', {
    title: 'Ingresos y retiros de efectivo', subtitle, widths: [12, 18, 14, 50, 22],
  });
  let r5 = 4;
  if (rep.cashMovements.length) {
    r5 = table(w5, r5, [
      { header: 'Hora', key: 'time', type: 'center' },
      { header: 'Tipo', key: 'type', type: 'text' },
      { header: 'Monto', key: 'amount', type: 'money' },
      { header: 'Motivo', key: 'reason', type: 'text', wrap: true },
      { header: 'Registró', key: 'user', type: 'text' },
    ], rep.cashMovements.map((m) => ({
      time: formatTime(m.createdAt, tz), type: m.type === 'in' ? 'Ingreso' : 'Retiro',
      amount: $(m.amountCents), reason: m.reason, user: m.userName,
    })));
  } else r5 = emptyNote(w5, r5, 'No hubo ingresos ni retiros de efectivo.');

  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// Resumen de período (semanal)
// ---------------------------------------------------------------------------

export async function periodWorkbook(rep, { titlePrefix = 'Resumen semanal' } = {}) {
  const tz = rep.timezone;
  const wb = newWorkbook(rep.business);
  const subtitle = `Período: ${period(rep)}`;
  const T = rep.totals;

  const ws = addSheet(wb, 'Resumen', { title: titlePrefix, subtitle, widths: [52, 24, 40] });
  let r = 4;
  r = section(ws, r, 'Ingresos de dinero');
  const m0 = r;
  for (const m of METHOD_ORDER) r = kv(ws, r, METHOD_LABEL[m], $(T.byMethod[m]), { fmt: MONEY });
  r = kv(ws, r, 'Subtotal digital (transferencia + débito + crédito)',
    { formula: `B${m0 + 1}+B${m0 + 2}+B${m0 + 3}`, result: $(T.digitalCents) }, { fmt: MONEY, bold: true });
  r = kv(ws, r, 'Subtotal efectivo', { formula: `B${m0}`, result: $(T.cashCents) }, { fmt: MONEY, bold: true });
  r = kv(ws, r, 'TOTAL INGRESADO', { formula: `B${r - 2}+B${r - 1}`, result: $(T.totalCents) }, { fmt: MONEY, bold: true });
  r += 1;
  r = section(ws, r, 'Actividad');
  r = kv(ws, r, 'Cantidad de ventas', T.salesCount, { fmt: INT });
  r = kv(ws, r, 'Ticket promedio', $(T.avgTicketCents), { fmt: MONEY });
  r = kv(ws, r, 'Ventas anuladas', T.voidedCount, { fmt: INT });
  r = kv(ws, r, 'Turnos del período', rep.shifts.length, { fmt: INT });
  const restockUnits = rep.restockLines.reduce((a, l) => a + l.qty, 0);
  r = kv(ws, r, 'Unidades ingresadas (stock)', restockUnits, { fmt: INT });
  r = kv(ws, r, 'Unidades vendidas', T.products.reduce((a, p) => a + p.unitsTotal, 0), { fmt: INT });
  if (rep.mpEnabled && T.manualConfirmations.count) {
    r = kv(ws, r, 'Cobros no efectivo confirmados a mano', T.manualConfirmations.count, { fmt: INT, color: RED });
    ws.getCell(r - 1, 3).value = 'Verificar contra Mercado Pago / posnet.';
    ws.getCell(r - 1, 3).font = { italic: true, color: { argb: RED } };
  }
  ws.pageSetup.printArea = `A1:C${r}`;

  // Por día
  const wd = addSheet(wb, 'Por día', { title: 'Ventas por día', subtitle, landscape: true, widths: [14, 10, 16, 18, 16, 16, 18] });
  let rd = 4;
  if (rep.daily.length) {
    rd = table(wd, rd, [
      { header: 'Día', key: 'day', type: 'text' },
      { header: 'Ventas', key: 'salesCount', type: 'int', total: true },
      { header: 'Efectivo', key: 'efectivo', type: 'money', total: true },
      { header: 'Transferencia / QR', key: 'transferencia', type: 'money', total: true },
      { header: 'Débito', key: 'debito', type: 'money', total: true },
      { header: 'Crédito', key: 'credito', type: 'money', total: true },
      { header: 'Total', key: 'total', type: 'money', total: true },
    ], rep.daily.map((d) => ({
      ...d,
      day: d.day.split('-').reverse().join('/'),
      efectivo: $(d.efectivo), transferencia: $(d.transferencia), debito: $(d.debito), credito: $(d.credito), total: $(d.totalCents),
    })), { totals: true });
  } else rd = emptyNote(wd, rd, 'No hubo ventas en el período.');

  // Productos
  const wp = addSheet(wb, 'Productos', { title: 'Productos vendidos', subtitle, widths: [30, 18, 14, 14, 14, 18] });
  let rp = 4;
  rp = section(wp, rp, 'Unidades vendidas por producto');
  rp = note(wp, rp, 'Incluye las unidades que salieron dentro de promos.');
  if (T.products.length) {
    rp = table(wp, rp, [
      { header: 'Producto', key: 'name', type: 'text' },
      { header: 'Categoría', key: 'category', type: 'text' },
      { header: 'Sueltas', key: 'unitsLoose', type: 'int', total: true },
      { header: 'En promos', key: 'unitsPromo', type: 'int', total: true },
      { header: 'Total unidades', key: 'unitsTotal', type: 'int', total: true },
      { header: 'Importe vendido suelto', key: 'revenue', type: 'money', total: true },
    ], T.products.map((p) => ({ ...p, revenue: $(p.revenueLooseCents) })), { totals: true });
  } else rp = emptyNote(wp, rp, 'No hubo ventas en el período.');
  rp = section(wp, rp, 'Promos vendidas');
  if (T.promos.length) {
    rp = table(wp, rp, [
      { header: 'Promo', key: 'name', type: 'text' },
      { header: '', key: 'x', type: 'text' },
      { header: 'Cantidad', key: 'qty', type: 'int', total: true },
      { header: '', key: 'y', type: 'text' },
      { header: '', key: 'z', type: 'text' },
      { header: 'Importe', key: 'revenue', type: 'money', total: true },
    ], T.promos.map((p) => ({ ...p, revenue: $(p.revenueCents) })), { totals: true });
  } else rp = emptyNote(wp, rp, 'No se vendieron promos.');

  // Stock
  const wsk = addSheet(wb, 'Stock', { title: 'Stock del período', subtitle, landscape: true, widths: [28, 18, 16, 16, 16, 18, 16] });
  let rs = 4;
  rs = section(wsk, rs, 'Stock del período');
  rs = note(wsk, rs, 'Stock inicial + ingresos − vendido ± ajustes = stock final.');
  rs = table(wsk, rs, [
    { header: 'Producto', key: 'name', type: 'text' },
    { header: 'Categoría', key: 'category', type: 'text' },
    { header: 'Stock inicial', key: 'start', type: 'int', total: true },
    { header: 'Ingresos', key: 'restock', type: 'int', total: true },
    { header: 'Vendido', key: 'sold', type: 'int', total: true },
    { header: 'Ajustes / mermas / conteos', key: 'adjustments', type: 'int', total: true },
    { header: 'Stock final', key: 'end', type: 'int', total: true },
  ], rep.inventory, { totals: true });

  // Ingresos de mercadería
  const wr = addSheet(wb, 'Ingresos de mercadería', { title: 'Ingresos de mercadería', subtitle, landscape: true, widths: [18, 28, 12, 24, 24, 34] });
  let rr = 4;
  if (rep.restockLines.length) {
    rr = table(wr, rr, [
      { header: 'Fecha y hora', key: 'at', type: 'text' },
      { header: 'Producto', key: 'product', type: 'text' },
      { header: 'Cantidad', key: 'qty', type: 'int', total: true },
      { header: 'Proveedor', key: 'supplier', type: 'text' },
      { header: 'Registró', key: 'user', type: 'text' },
      { header: 'Nota', key: 'note', type: 'text', wrap: true },
    ], rep.restockLines.map((l) => ({
      at: formatDateTime(l.created_at, tz), product: l.product, qty: l.qty, supplier: l.supplier || '', user: l.user_name || '', note: l.note || '',
    })), { totals: true });
  } else rr = emptyNote(wr, rr, 'No hubo ingresos de mercadería en el período.');

  // Turnos
  const wt = addSheet(wb, 'Turnos', { title: 'Turnos del período', subtitle, landscape: true, widths: [8, 18, 18, 22, 22, 10, 16, 16, 16, 16] });
  let rt = 4;
  if (rep.shifts.length) {
    rt = table(wt, rt, [
      { header: 'N°', key: 'id', type: 'center' },
      { header: 'Apertura', key: 'openedAt', type: 'text' },
      { header: 'Cierre', key: 'closedAt', type: 'text' },
      { header: 'Encargado', key: 'openedBy', type: 'text' },
      { header: 'Cerró', key: 'closedBy', type: 'text' },
      { header: 'Ventas', key: 'salesCount', type: 'int', total: true },
      { header: 'Total vendido', key: 'total', type: 'money', total: true },
      { header: 'Efectivo esperado', key: 'expected', type: 'money' },
      { header: 'Efectivo contado', key: 'counted', type: 'money' },
      { header: 'Diferencia', key: 'diff', type: 'money', total: true, danger: true },
    ], rep.shifts.map((s) => ({
      id: s.id, openedAt: formatDateTime(s.openedAt, tz), closedAt: s.closedAt ? formatDateTime(s.closedAt, tz) : 'Abierto',
      openedBy: s.openedBy, closedBy: s.closedBy || '', salesCount: s.salesCount, total: $(s.totalCents),
      expected: $(s.expectedCashCents), counted: $(s.countedCashCents), diff: $(s.cashDiffCents),
    })), { totals: true });
  } else rt = emptyNote(wt, rt, 'No hubo turnos en el período.');

  // Fichajes
  const wf = addSheet(wb, 'Fichajes', { title: 'Horas trabajadas', subtitle, widths: [30, 14, 14, 24] });
  let rf = 4;
  if (rep.hours.length) {
    rf = table(wf, rf, [
      { header: 'Persona', key: 'userName', type: 'text' },
      { header: 'Fichajes', key: 'entries', type: 'int', total: true },
      { header: 'Horas', key: 'hours', type: 'hours', total: true },
      { header: 'Sin salida fichada', key: 'incomplete', type: 'int' },
    ], rep.hours, { totals: true });
  } else rf = emptyNote(wf, rf, 'No hubo fichajes en el período.');

  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// Inventario actual + movimientos
// ---------------------------------------------------------------------------

export async function inventoryWorkbook({ business, timezone, stock, movements, now }) {
  const wb = newWorkbook(business);
  const subtitle = `Al ${formatDateTime(now, timezone)}`;
  const ws = addSheet(wb, 'Stock actual', { title: 'Inventario / stock actual', subtitle, widths: [30, 20, 14, 16, 16] });
  const rows = stock.map((s) => ({ ...s, state: s.stock < 0 ? 'NEGATIVO' : s.low ? 'Stock bajo' : 'OK' }));
  table(ws, 4, [
    { header: 'Producto', key: 'name', type: 'text' },
    { header: 'Categoría', key: 'category', type: 'text' },
    { header: 'Stock', key: 'stock', type: 'int', total: true, danger: true },
    { header: 'Aviso a partir de', key: 'lowStockThreshold', type: 'int' },
    { header: 'Estado', key: 'state', type: 'center' },
  ], rows, { totals: true });

  const wm = addSheet(wb, 'Movimientos', { title: 'Movimientos de stock', subtitle, landscape: true, widths: [18, 28, 26, 12, 24, 40] });
  if (movements.length) {
    table(wm, 4, [
      { header: 'Fecha y hora', key: 'at', type: 'text' },
      { header: 'Producto', key: 'product', type: 'text' },
      { header: 'Tipo', key: 'type', type: 'text' },
      { header: 'Cantidad', key: 'qty', type: 'int', danger: true },
      { header: 'Registró', key: 'user', type: 'text' },
      { header: 'Motivo', key: 'reason', type: 'text', wrap: true },
    ], movements.map((m) => ({
      at: formatDateTime(m.created_at, timezone), product: m.product, type: MOVEMENT_LABEL[m.type] || m.type,
      qty: m.qty, user: m.user_name || '', reason: m.reason || '',
    })));
  } else emptyNote(wm, 4, 'No hay movimientos en el período.');
  return wb.xlsx.writeBuffer();
}

