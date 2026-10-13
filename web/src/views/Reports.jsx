import { useState } from 'react';
import { api, download } from '../api.js';
import { addDays, fmtDate, fmtDateTime, int, money, money2, plural, todayYmd, weekStart, METHOD_ORDER } from '../format.js';
import { Field, Loading, MethodChip, useApp, useData } from '../components/ui.jsx';

export default function Reports() {
  const { toast } = useApp();
  const thisWeek = weekStart(todayYmd());
  const [from, setFrom] = useState(thisWeek);
  const [to, setTo] = useState(addDays(thisWeek, 6));
  const [busy, setBusy] = useState(false);
  const rep = useData(() => api.get(`/api/reports/period?from=${from}&to=${to}`), [from, to]);

  const preset = (f, t) => { setFrom(f); setTo(t); };
  const today = todayYmd();
  const month = `${today.slice(0, 8)}01`;

  const xlsx = async () => {
    setBusy(true);
    try { await download(`/api/reports/period.xlsx?from=${from}&to=${to}`, `MrCook_Resumen_${from}_${to}.xlsx`); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const r = rep.data;
  const T = r?.totals;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Reportes</h1>
        <button className="btn" onClick={xlsx} disabled={busy || !r}>{busy ? 'Generando…' : 'Descargar Excel del período'}</button>
      </div>

      <div className="card stack">
        <div className="row wrap">
          <button className="btn small ghost" onClick={() => preset(today, today)}>Hoy</button>
          <button className="btn small ghost" onClick={() => preset(thisWeek, addDays(thisWeek, 6))}>Esta semana</button>
          <button className="btn small ghost" onClick={() => preset(addDays(thisWeek, -7), addDays(thisWeek, -1))}>Semana pasada</button>
          <button className="btn small ghost" onClick={() => preset(month, today)}>Este mes</button>
          <span className="grow" />
          <Field label="Desde">{(id) => <input id={id} type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Hasta">{(id) => <input id={id} type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
      </div>

      {!r ? <Loading error={rep.error} /> : (
        <>
          <div className="grid cols-4">
            <div className="stat yellow"><div className="k">Total ingresado</div><div className="v">{money(T.totalCents)}</div></div>
            <div className="stat"><div className="k">Ventas</div><div className="v">{int(T.salesCount)}</div></div>
            <div className="stat"><div className="k">Digital</div><div className="v">{money(T.digitalCents)}</div></div>
            <div className="stat"><div className="k">Efectivo</div><div className="v">{money(T.cashCents)}</div></div>
          </div>

          <div className="card stack">
            <h2>Por medio de pago</h2>
            <div className="grid cols-4">
              {METHOD_ORDER.map((m) => <div className="stat" key={m}><div className="k"><MethodChip method={m} /> {plural(T.countByMethod[m], 'cobro', 'cobros')}</div><div className="v">{money(T.byMethod[m])}</div></div>)}
            </div>
            {r.mpEnabled && T.manualConfirmations.count > 0 && <div className="notice red">{T.manualConfirmations.count} cobro(s) por {money(T.manualConfirmations.cents)} se confirmaron a mano. Verificalos contra Mercado Pago.</div>}
          </div>

          <div className="card stack">
            <h2>Ventas por día</h2>
            {r.daily.length === 0 ? <div className="empty">No hubo ventas en el período.</div> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Día</th><th className="num">Ventas</th><th className="num">Efectivo</th><th className="num">Transferencia</th><th className="num">Débito</th><th className="num">Crédito</th><th className="num">Total</th></tr></thead>
                <tbody>{r.daily.map((d) => <tr key={d.day}><td>{d.day.split('-').reverse().join('/')}</td><td className="num">{int(d.salesCount)}</td><td className="num">{money(d.efectivo)}</td><td className="num">{money(d.transferencia)}</td><td className="num">{money(d.debito)}</td><td className="num">{money(d.credito)}</td><td className="num"><b>{money(d.totalCents)}</b></td></tr>)}</tbody>
                <tfoot><tr><td>TOTAL</td><td className="num">{int(T.salesCount)}</td>{METHOD_ORDER.map((m) => <td className="num" key={m}>{money(T.byMethod[m])}</td>)}<td className="num">{money(T.totalCents)}</td></tr></tfoot>
              </table></div>
            )}
          </div>

          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            <div className="card stack">
              <h2>Productos vendidos</h2>
              {T.products.length === 0 ? <div className="empty">Sin ventas.</div> : (
                <div className="table-wrap"><table className="t">
                  <thead><tr><th>Producto</th><th className="num">Sueltas</th><th className="num">En promos</th><th className="num">Total</th></tr></thead>
                  <tbody>{T.products.map((p) => <tr key={p.productId}><td><b>{p.name}</b></td><td className="num">{int(p.unitsLoose)}</td><td className="num">{int(p.unitsPromo)}</td><td className="num"><b>{int(p.unitsTotal)}</b></td></tr>)}</tbody>
                </table></div>
              )}
            </div>
            <div className="card stack">
              <h2>Stock del período</h2>
              {r.inventory.length === 0 ? <div className="empty">Sin movimientos.</div> : (
                <div className="table-wrap"><table className="t">
                  <thead><tr><th>Producto</th><th className="num">Inicial</th><th className="num">Ingresos</th><th className="num">Vendido</th><th className="num">Ajustes</th><th className="num">Final</th></tr></thead>
                  <tbody>{r.inventory.map((i) => <tr key={i.productId}><td><b>{i.name}</b></td><td className="num">{int(i.start)}</td><td className="num">{int(i.restock)}</td><td className="num">{int(i.sold)}</td><td className="num">{int(i.adjustments)}</td><td className="num"><b>{int(i.end)}</b></td></tr>)}</tbody>
                </table></div>
              )}
            </div>
          </div>

          <div className="card stack">
            <h2>Turnos del período</h2>
            {r.shifts.length === 0 ? <div className="empty">No hubo turnos.</div> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>N°</th><th>Apertura</th><th>Cierre</th><th>Encargado</th><th className="num">Ventas</th><th className="num">Total</th><th className="num">Dif. caja</th><th /></tr></thead>
                <tbody>{r.shifts.map((s) => <tr key={s.id}><td>#{s.id}</td><td>{fmtDateTime(s.openedAt)}</td><td>{s.closedAt ? fmtDateTime(s.closedAt) : <span className="chip ok">Abierto</span>}</td><td>{s.openedBy}</td><td className="num">{int(s.salesCount)}</td><td className="num">{money(s.totalCents)}</td><td className={`num ${s.cashDiffCents < 0 ? 'neg' : ''}`}>{s.cashDiffCents == null ? '—' : money2(s.cashDiffCents)}</td><td><a className="btn small ghost" href={`#/caja/turno/${s.id}`}>Ver</a></td></tr>)}</tbody>
              </table></div>
            )}
          </div>

          <div className="muted small">Período: {fmtDate(r.from)} al {fmtDate(r.to - 1)}</div>
        </>
      )}
    </div>
  );
}
