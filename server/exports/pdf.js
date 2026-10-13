import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { formatDateTime, formatTime } from '../util/time.js';
import { METHOD_LABEL, METHOD_ORDER } from './labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '..', 'assets');
const FONT = (w) => path.join(ASSETS, 'fonts', `nunito-${w}.ttf`);
const LOGO = path.join(ASSETS, 'logo-white.png');

const YELLOW = '#FFCB05';
const INK = '#181816';
const SOFT = '#FFF4C2';
const ZEBRA = '#F7F6F2';
const LINE = '#D6D4CC';
const MUTED = '#6B6B66';
const RED = '#B42318';

const money = (cents) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format((cents ?? 0) / 100);
const int = (n) => new Intl.NumberFormat('es-AR').format(n ?? 0);

class Doc {
  constructor(title, subtitle) {
    this.doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: title } });
    const d = this.doc;
    d.registerFont('R', FONT(400));
    d.registerFont('B', FONT(700));
    d.registerFont('X', FONT(900));
    this.left = 40;
    this.width = d.page.width - 80;
    this.title = title;
    this.subtitle = subtitle;
    this.header();
  }

  header() {
    const d = this.doc;
    d.rect(0, 0, d.page.width, 78).fill(INK);
    if (fs.existsSync(LOGO)) d.image(LOGO, 40, 10, { height: 58 });
    d.fillColor(YELLOW).font('X').fontSize(19).text(this.title, 112, 17, { width: this.width - 72, lineBreak: false });
    d.fillColor('#FFFFFF').font('R').fontSize(9.5).text(this.subtitle, 112, 45, { width: this.width - 72 });
    d.fillColor(INK);
    d.y = 96;
  }

  ensure(h) {
    const d = this.doc;
    if (d.y + h > d.page.height - 56) {
      d.addPage();
      d.y = 40;
      return true;
    }
    return false;
  }

  section(text) {
    const d = this.doc;
    this.ensure(46);
    const y = d.y + 4;
    d.rect(this.left, y, this.width, 20).fill(YELLOW);
    d.fillColor(INK).font('B').fontSize(11).text(text, this.left + 8, y + 4.5, { width: this.width - 16, lineBreak: false });
    d.y = y + 24; // text() mueve el cursor: se fija a mano
  }

  note(text, color = MUTED) {
    const d = this.doc;
    this.ensure(18);
    d.fillColor(color).font('R').fontSize(9).text(text, this.left, d.y, { width: this.width });
    d.fillColor(INK);
    d.y += 6;
  }

  kv(label, value, { bold = false, color = INK, shade = false } = {}) {
    const d = this.doc;
    this.ensure(20);
    const y = d.y;
    if (shade) d.rect(this.left, y, this.width, 19).fill(SOFT);
    d.fillColor(INK).font(bold ? 'B' : 'R').fontSize(10).text(label, this.left + 8, y + 4, { width: this.width * 0.6, lineBreak: false });
    d.fillColor(color).font(bold ? 'B' : 'R').text(String(value), this.left + this.width * 0.55, y + 4, {
      width: this.width * 0.45 - 8,
      align: 'right',
      lineBreak: false,
    });
    d.moveTo(this.left, y + 19).lineTo(this.left + this.width, y + 19).lineWidth(0.5).strokeColor(LINE).stroke();
    d.fillColor(INK);
    d.y = y + 19;
  }

  /** cols: [{h, k, w (fracción), align, fmt}] */
  table(cols, rows, { totals = null, size = 9 } = {}) {
    const d = this.doc;
    const widths = cols.map((c) => c.w * this.width);
    const drawHeader = () => {
      this.ensure(40);
      const y = d.y;
      d.rect(this.left, y, this.width, 20).fill(YELLOW);
      let x = this.left;
      cols.forEach((c, i) => {
        d.fillColor(INK).font('B').fontSize(size).text(c.h, x + 4, y + 5.5, { width: widths[i] - 8, align: c.align || 'left', lineBreak: false });
        x += widths[i];
      });
      d.y = y + 20;
    };
    drawHeader();
    rows.forEach((r, ri) => {
      const cells = cols.map((c) => (c.fmt ? c.fmt(r[c.k], r) : r[c.k] ?? ''));
      d.font('R').fontSize(size);
      const h = Math.max(
        18,
        ...cells.map((t, i) => d.heightOfString(String(t), { width: widths[i] - 8 }) + 7),
      );
      if (this.ensure(h + 2)) drawHeader();
      const y = d.y;
      if (ri % 2 === 1) d.rect(this.left, y, this.width, h).fill(ZEBRA);
      let x = this.left;
      cells.forEach((t, i) => {
        const neg = typeof t === 'string' && t.startsWith('-') && cols[i].danger;
        d.fillColor(neg ? RED : INK).font(neg ? 'B' : 'R').fontSize(size).text(String(t), x + 4, y + 4, { width: widths[i] - 8, align: cols[i].align || 'left' });
        x += widths[i];
      });
      d.moveTo(this.left, y + h).lineTo(this.left + this.width, y + h).lineWidth(0.4).strokeColor(LINE).stroke();
      d.y = y + h;
    });
    if (totals) {
      this.ensure(22);
      const y = d.y;
      d.rect(this.left, y, this.width, 20).fill(SOFT);
      let x = this.left;
      cols.forEach((c, i) => {
        const t = totals[c.k];
        d.fillColor(INK).font('B').fontSize(size).text(t == null ? '' : String(t), x + 4, y + 5.5, { width: widths[i] - 8, align: c.align || 'left', lineBreak: false });
        x += widths[i];
      });
      d.y = y + 20;
    }
    d.fillColor(INK);
    d.y += 10;
  }

  signatures(labels) {
    const d = this.doc;
    this.ensure(70);
    d.y += 34;
    const w = (this.width - 40 * (labels.length - 1)) / labels.length;
    labels.forEach((l, i) => {
      const x = this.left + i * (w + 40);
      d.moveTo(x, d.y).lineTo(x + w, d.y).lineWidth(0.8).strokeColor(INK).stroke();
      d.fillColor(MUTED).font('R').fontSize(8.5).text(l, x, d.y + 4, { width: w, align: 'center' });
    });
    d.fillColor(INK);
  }

  finish(footerLeft) {
    const d = this.doc;
    const range = d.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      d.switchToPage(i);
      const m = d.page.margins.bottom;
      d.page.margins.bottom = 0;
      d.fillColor(MUTED).font('R').fontSize(8);
      d.text(footerLeft, 40, d.page.height - 30, { width: this.width / 2, lineBreak: false });
      d.text(`Página ${i + 1} de ${range.count}`, 40 + this.width / 2, d.page.height - 30, { width: this.width / 2, align: 'right', lineBreak: false });
      d.page.margins.bottom = m;
    }
    d.end();
    return new Promise((resolve, reject) => {
      const chunks = [];
      d.on('data', (c) => chunks.push(c));
      d.on('end', () => resolve(Buffer.concat(chunks)));
      d.on('error', reject);
    });
  }
}

export function shiftPdf(rep, { detail = false } = {}) {
  const tz = rep.timezone;
  const s = rep.shift;
  const T = rep.totals;
  const subtitle = `Turno #${s.id} · Encargado: ${s.openedBy}\n${formatDateTime(s.openedAt, tz)}${s.closedAt ? '  a  ' + formatDateTime(s.closedAt, tz) : '  (turno abierto)'}`;
  const pdf = new Doc(`${rep.business} · Cierre de turno`, subtitle);

  pdf.section('Datos del turno');
  pdf.kv('Encargado (abrió el turno)', s.openedBy);
  pdf.kv('Apertura', formatDateTime(s.openedAt, tz));
  pdf.kv('Cerró el turno', s.closedBy || '—');
  pdf.kv('Cierre', s.closedAt ? formatDateTime(s.closedAt, tz) : 'Turno abierto');
  pdf.kv('Cantidad de ventas', int(T.salesCount));
  pdf.kv('Ventas anuladas', int(T.voidedCount));

  pdf.section('Cobros por medio de pago');
  for (const m of METHOD_ORDER) pdf.kv(`${METHOD_LABEL[m]}  (${int(T.countByMethod[m])} ${T.countByMethod[m] === 1 ? 'cobro' : 'cobros'})`, money(T.byMethod[m]));
  pdf.kv('Subtotal digital (transferencia + débito + crédito)', money(T.digitalCents), { bold: true, shade: true });
  pdf.kv('Subtotal efectivo', money(T.cashCents), { bold: true, shade: true });
  pdf.kv('TOTAL VENDIDO', money(T.totalCents), { bold: true, shade: true });
  if (rep.mpEnabled && T.manualConfirmations.count) {
    pdf.note(`Atención: ${T.manualConfirmations.count} cobro(s) no efectivo por ${money(T.manualConfirmations.cents)} se confirmaron a mano. Verificar contra Mercado Pago / posnet.`, RED);
  }

  pdf.section('Control de caja (efectivo)');
  pdf.kv('Efectivo inicial (fondo de caja)', money(rep.cash.openingCents));
  pdf.kv('+ Ventas en efectivo', money(rep.cash.cashSalesCents));
  pdf.kv('+ Ingresos de efectivo', money(rep.cash.depositsCents));
  pdf.kv('− Retiros de efectivo', money(rep.cash.withdrawalsCents));
  pdf.kv('Efectivo esperado en caja', money(rep.cash.expectedCents), { bold: true, shade: true });
  if (s.status === 'closed') {
    pdf.kv('Efectivo contado al cerrar', money(rep.cash.countedCents));
    pdf.kv('Diferencia (contado − esperado)', money(rep.cash.diffCents), { bold: true, shade: true, color: rep.cash.diffCents < 0 ? RED : INK });
  } else {
    pdf.kv('Efectivo contado al cerrar', 'Turno todavía abierto');
  }
  if (s.closingNotes) pdf.note(`Observaciones: ${s.closingNotes}`);

  pdf.section('Productos vendidos');
  if (T.products.length) {
    const sum = (k) => T.products.reduce((a, p) => a + p[k], 0);
    pdf.table(
      [
        { h: 'Producto', k: 'name', w: 0.26 },
        { h: 'Categoría', k: 'category', w: 0.16 },
        { h: 'Sueltas', k: 'unitsLoose', w: 0.1, align: 'right' },
        { h: 'En promos', k: 'unitsPromo', w: 0.12, align: 'right' },
        { h: 'Total unid.', k: 'unitsTotal', w: 0.12, align: 'right' },
        { h: 'Importe suelto', k: 'revenueLooseCents', w: 0.24, align: 'right', fmt: money },
      ],
      T.products,
      { totals: { name: 'TOTAL', unitsLoose: int(sum('unitsLoose')), unitsPromo: int(sum('unitsPromo')), unitsTotal: int(sum('unitsTotal')), revenueLooseCents: money(sum('revenueLooseCents')) } },
    );
  } else pdf.note('No hubo ventas en este turno.');

  if (T.promos.length) {
    pdf.section('Promos vendidas');
    pdf.table(
      [
        { h: 'Promo', k: 'name', w: 0.62 },
        { h: 'Cantidad', k: 'qty', w: 0.14, align: 'right' },
        { h: 'Importe', k: 'revenueCents', w: 0.24, align: 'right', fmt: money },
      ],
      T.promos,
    );
  }

  pdf.section('Inventario del turno');
  pdf.note('Inicio + ingresos − vendido ± ajustes = final (sistema). Contado y diferencia solo si se contó al cerrar.');
  pdf.table(
    [
      { h: 'Producto', k: 'name', w: 0.27 },
      { h: 'Inicio', k: 'opening', w: 0.1, align: 'right' },
      { h: 'Ingresos', k: 'restock', w: 0.11, align: 'right' },
      { h: 'Vendido', k: 'sold', w: 0.1, align: 'right' },
      { h: 'Ajustes', k: 'adjustments', w: 0.1, align: 'right' },
      { h: 'Final sist.', k: 'closingSystem', w: 0.11, align: 'right' },
      { h: 'Contado', k: 'closingCounted', w: 0.11, align: 'right', fmt: (v) => (v == null ? '—' : v) },
      { h: 'Dif.', k: 'difference', w: 0.1, align: 'right', danger: true, fmt: (v) => (v == null ? '—' : v) },
    ],
    rep.inventory,
  );

  if (rep.cashMovements.length) {
    pdf.section('Ingresos y retiros de efectivo');
    pdf.table(
      [
        { h: 'Hora', k: 'createdAt', w: 0.1, fmt: (v) => formatTime(v, tz) },
        { h: 'Tipo', k: 'type', w: 0.12, fmt: (v) => (v === 'in' ? 'Ingreso' : 'Retiro') },
        { h: 'Monto', k: 'amountCents', w: 0.18, align: 'right', fmt: money },
        { h: 'Motivo', k: 'reason', w: 0.4 },
        { h: 'Registró', k: 'userName', w: 0.2 },
      ],
      rep.cashMovements,
    );
  }

  if (detail) {
    pdf.section('Detalle de ventas');
    pdf.table(
      [
        { h: 'N°', k: 'number', w: 0.07 },
        { h: 'Hora', k: 'createdAt', w: 0.09, fmt: (v) => formatTime(v, tz) },
        { h: 'Detalle', k: 'summary', w: 0.42 },
        { h: 'Pago', k: 'payments', w: 0.22, fmt: (v) => v.map((p) => METHOD_LABEL[p.method]).join(' + ') },
        { h: 'Total', k: 'totalCents', w: 0.2, align: 'right', fmt: (v, r) => (r.status === 'void' ? 'ANULADA' : money(v)) },
      ],
      rep.sales,
      { size: 8 },
    );
  }

  pdf.signatures(['Encargado del turno', 'Controló']);
  return pdf.finish(`${rep.business} · Turno #${s.id}`);
}
