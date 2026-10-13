import { useState } from 'react';
import { api, download } from '../api.js';
import { fmtDateTime, fmtTime, int, money, money2, plural, METHOD_ORDER } from '../format.js';
import { Loading, MethodChip, useApp, useData } from '../components/ui.jsx';

function Kv({ rows }) {
  return (
    <div className="kv">
      {rows.flatMap(([label, value, cls], i) => [
        <div key={`l${i}`} className={cls}>{label}</div>,
        <div key={`v${i}`} className={cls}>{value}</div>,
      ])}
    </div>
  );
}

export default function ShiftReport({ id }) {
  const { toast, settings } = useApp();
  const rep = useData(() => api.get(`/api/shifts/${id}/report`), [id]);
  const [busy, setBusy] = useState('');

  if (!rep.data) return <Loading error={rep.error} />;
  const r = rep.data;
  const s = r.shift;
  const T = r.totals;
  const open = s.status === 'open';

  const dl = async (kind) => {
    setBusy(kind);
    try {
      await (kind === 'xlsx'
        ? download(`/api/shifts/${id}/export.xlsx`, `MrCook_Cierre-turno-${id}.xlsx`)
        : download(`/api/shifts/${id}/export.pdf?detail=1`, `MrCook_Cierre-turno-${id}.pdf`));
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(''); }
  };

  return (
    <div className="stack">
      <div className="row between wrap no-print">
        <a href="#/caja" className="btn ghost small">← Caja</a>
        <div className="row wrap">
          <button className="btn" onClick={() => dl('xlsx')} disabled={!!busy || (open && r.cash.expectedCents == null)} title={open && r.cash.expectedCents == null ? 'Se puede descargar al cerrar el turno' : undefined}>{busy === 'xlsx' ? 'Generando…' : 'Descargar Excel'}</button>
          <button className="btn" onClick={() => dl('pdf')} disabled={!!busy || (open && r.cash.expectedCents == null)} title={open && r.cash.expectedCents == null ? 'Se puede descargar al cerrar el turno' : undefined}>{busy === 'pdf' ? 'Generando…' : 'Descargar PDF'}</button>
          <button className="btn dark" onClick={() => window.print()}>Imprimir</button>
        </div>
      </div>

      <div className="report-head">
        <img src="/logo-white.png" alt="" />
        <div className="grow">
          <h1>{open ? 'Resumen del turno en curso' : 'Cierre de turno'} #{s.id}</h1>
          <div className="meta">
            Encargado: <b>{s.openedBy}</b> · {fmtDateTime(s.openedAt)}{s.closedAt ? ` a ${fmtDateTime(s.closedAt)}` : ' (turno abierto)'}
            {s.closedBy && s.closedBy !== s.openedBy ? ` · Cerró: ${s.closedBy}` : ''}
          </div>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="stat yellow"><div className="k">Total vendido</div><div className="v">{money(T.totalCents)}</div></div>
        <div className="stat"><div className="k">Ventas</div><div className="v">{int(T.salesCount)}</div></div>
        <div className="stat"><div className="k">Digital</div><div className="v">{money(T.digitalCents)}</div></div>
        <div className="stat"><div className="k">Efectivo</div><div className="v">{money(T.cashCents)}</div></div>
      </div>

      <div className="grid cols-2">
        <div className="card stack">
          <h2>Cobros por medio de pago</h2>
          <Kv rows={[
            ...METHOD_ORDER.map((m) => [<span key={m} className="row"><MethodChip method={m} /> {plural(T.countByMethod[m], 'cobro', 'cobros')}</span>, money2(T.byMethod[m])]),
            ['Subtotal digital (transferencia + débito + crédito)', money2(T.digitalCents), 'hl'],
            ['Subtotal efectivo', money2(T.cashCents), 'hl'],
            ['TOTAL VENDIDO', money2(T.totalCents), 'hl'],
          ]} />
          {settings.mercadoPagoEnabled && T.manualConfirmations.count > 0 && (
            <div className="notice red">{T.manualConfirmations.count} cobro(s) por {money(T.manualConfirmations.cents)} se confirmaron <b>a mano</b>: verificalos contra Mercado Pago.</div>
          )}
          {T.voidedCount > 0 && <div className="muted small">{T.voidedCount} venta(s) anulada(s) por {money(T.voidedCents)} (no cuentan en los totales).</div>}
        </div>

        <div className="card stack">
          <h2>Control de caja (efectivo)</h2>
          <Kv rows={[
            ['Efectivo inicial (fondo de caja)', money2(r.cash.openingCents)],
            ['+ Ventas en efectivo', money2(r.cash.cashSalesCents)],
            ['+ Ingresos de efectivo', money2(r.cash.depositsCents)],
            ['− Retiros de efectivo', money2(r.cash.withdrawalsCents)],
            ['Efectivo esperado en caja', r.cash.expectedCents == null ? 'Se muestra al cerrar el turno' : money2(r.cash.expectedCents), 'hl'],
            ...(open ? [['Efectivo contado', 'Turno abierto']] : [
              ['Efectivo contado al cerrar', money2(r.cash.countedCents)],
              ['Diferencia (contado − esperado)', money2(r.cash.diffCents), `hl ${r.cash.diffCents < 0 ? 'neg' : ''}`],
            ]),
          ]} />
          {!open && r.cash.diffCents !== 0 && (
            <div className={`notice ${r.cash.diffCents < 0 ? 'red' : ''}`}>{r.cash.diffCents < 0 ? 'Faltante' : 'Sobrante'} de {money(Math.abs(r.cash.diffCents))} en la caja.</div>
          )}
          {s.closingNotes && <div className="notice">Observaciones: {s.closingNotes}</div>}
        </div>
      </div>

      <div className="card stack">
        <h2>Productos vendidos</h2>
        <p className="muted small" style={{ margin: 0 }}>Unidades totales, incluyendo las que salieron dentro de promos.</p>
        {T.products.length === 0 ? <div className="empty">No hubo ventas en este turno.</div> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Producto</th><th>Categoría</th><th className="num">Sueltas</th><th className="num">En promos</th><th className="num">Total unidades</th><th className="num">Importe suelto</th></tr></thead>
              <tbody>
                {T.products.map((p) => (
                  <tr key={p.productId}><td><b>{p.name}</b></td><td>{p.category}</td><td className="num">{int(p.unitsLoose)}</td><td className="num">{int(p.unitsPromo)}</td><td className="num"><b>{int(p.unitsTotal)}</b></td><td className="num">{money2(p.revenueLooseCents)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td colSpan={2}>TOTAL</td>
                <td className="num">{int(T.products.reduce((a, p) => a + p.unitsLoose, 0))}</td>
                <td className="num">{int(T.products.reduce((a, p) => a + p.unitsPromo, 0))}</td>
                <td className="num">{int(T.products.reduce((a, p) => a + p.unitsTotal, 0))}</td>
                <td className="num">{money2(T.products.reduce((a, p) => a + p.revenueLooseCents, 0))}</td>
              </tr></tfoot>
            </table>
          </div>
        )}
        {T.promos.length > 0 && (
          <>
            <h3>Promos vendidas</h3>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Promo</th><th className="num">Cantidad</th><th className="num">Importe</th></tr></thead>
                <tbody>{T.promos.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{int(p.qty)}</td><td className="num">{money2(p.revenueCents)}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card stack">
        <h2>Inventario del turno</h2>
        <p className="muted small" style={{ margin: 0 }}>Inicio + ingresos − vendido ± ajustes = final (sistema). Si se contó al cerrar, se muestra lo contado y la diferencia.</p>
        {r.inventory.length === 0 ? <div className="empty">Sin movimientos de stock.</div> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Producto</th><th className="num">Inicio</th><th className="num">Ingresos</th><th className="num">Vendido</th><th className="num">Ajustes / mermas</th><th className="num">Final (sistema)</th><th className="num">Final (contado)</th><th className="num">Diferencia</th></tr></thead>
              <tbody>
                {r.inventory.map((i) => (
                  <tr key={i.productId}>
                    <td><b>{i.name}</b></td>
                    <td className="num">{int(i.opening)}</td><td className="num">{int(i.restock)}</td><td className="num">{int(i.sold)}</td><td className="num">{int(i.adjustments)}</td>
                    <td className="num"><b>{int(i.closingSystem)}</b></td>
                    <td className="num">{i.closingCounted == null ? '—' : int(i.closingCounted)}</td>
                    <td className={`num ${i.difference < 0 ? 'neg' : ''}`}>{i.difference == null ? '—' : int(i.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card stack">
        <h2>Detalle de ventas</h2>
        {r.sales.length === 0 ? <div className="empty">No hubo ventas.</div> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>N°</th><th>Hora</th><th>Cajero</th><th>Detalle</th><th>Pago</th><th className="num">Total</th></tr></thead>
              <tbody>
                {r.sales.map((x) => (
                  <tr key={x.id} className={x.status === 'void' ? 'dim' : ''}>
                    <td>#{x.number}</td><td>{fmtTime(x.createdAt)}</td><td>{x.userName}</td><td>{x.summary}</td>
                    <td><span className="row wrap" style={{ gap: 4 }}>{x.payments.map((p, i) => <MethodChip key={i} method={p.method} manual={p.confirmation === 'manual' && r.mpEnabled} />)}</span></td>
                    <td className="num">{x.status === 'void' ? <span className="chip bad" title={x.voidReason}>Anulada</span> : money2(x.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="print-only" style={{ marginTop: 60, display: 'flex', gap: 60 }}>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4, textAlign: 'center', fontSize: 12 }}>Encargado del turno</div>
        <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4, textAlign: 'center', fontSize: 12 }}>Controló</div>
      </div>
    </div>
  );
}

