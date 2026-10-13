import { useState } from 'react';
import { api } from '../api.js';
import { fmtDateTime, fmtTime, int, money, money2, plural, METHOD_ORDER } from '../format.js';
import { go } from '../nav.js';
import { Field, Loading, MethodChip, Modal, MoneyInput, useApp, useData } from '../components/ui.jsx';

export default function ShiftPage() {
  const { shift } = useApp();
  return shift ? <LiveShift /> : <OpenShift />;
}

// ---------------------------------------------------------------- abrir turno

/** Tabla para contar stock (opcional). `counts` es { productId: texto }. */
function StockCountTable({ stock, counts, setCounts, label }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
      <table className="t">
        <thead><tr><th>Producto</th><th className="num">Según sistema</th><th className="num">{label}</th></tr></thead>
        <tbody>
          {stock.map((s) => (
            <tr key={s.productId}>
              <td>{s.name}</td>
              <td className={`num ${s.stock < 0 ? 'neg' : ''}`}>{int(s.stock)}</td>
              <td className="num" style={{ width: 130 }}>
                <input
                  className="input"
                  inputMode="numeric"
                  style={{ textAlign: 'right' }}
                  placeholder="—"
                  value={counts[s.productId] ?? ''}
                  onChange={(e) => setCounts({ ...counts, [s.productId]: e.target.value.replace(/\D/g, '') })}
                  aria-label={`${label}: ${s.name}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const toCounts = (counts) => Object.entries(counts).filter(([, v]) => v !== '' && v != null).map(([productId, qty]) => ({ productId: Number(productId), qty: Number(qty) }));

function OpenShift() {
  const { user, refresh, toast } = useApp();
  const inv = useData(() => api.get('/api/inventory'), []);
  const hist = useData(() => api.get('/api/shifts?limit=10'), []);
  const [cash, setCash] = useState(null);
  const [counts, setCounts] = useState({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (cash == null) { setError('Indicá con cuánto efectivo arranca la caja (si es 0, escribí 0).'); return; }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/shifts/open', { openingCashCents: cash, notes: notes || null, stockCounts: toCounts(counts) });
      await refresh();
      toast('Turno abierto. ¡A vender!', 'ok');
      go('/vender');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="page-head"><h1>Abrir turno</h1></div>
      <form className="card stack" onSubmit={submit}>
        <div className="notice dark">Vas a abrir el turno como <b>{user.fullName}</b>. Quedás registrado como encargado de este turno.</div>
        <Field label="Efectivo inicial en la caja (fondo de cambio)" hint="Contá los billetes y monedas que hay en la caja ahora.">
          {(id) => <MoneyInput id={id} value={cash} onChange={setCash} autoFocus />}
        </Field>
        <div className="stack">
          <div>
            <h3>Stock con el que arrancás (opcional)</h3>
            <p className="muted small" style={{ margin: '2px 0 0' }}>Si contás distinto a lo que dice el sistema, escribí lo que contaste: ese número pasa a ser el stock inicial. Dejá en blanco lo que no cuentes.</p>
          </div>
          {!inv.data ? <Loading error={inv.error} /> : inv.data.stock.length === 0
            ? <div className="muted">No hay productos con control de stock.</div>
            : <StockCountTable stock={inv.data.stock} counts={counts} setCounts={setCounts} label="Contado" />}
        </div>
        <Field label="Observaciones (opcional)">{(id) => <textarea id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {error && <div className="notice red" role="alert">{error}</div>}
        <button className="btn big" disabled={busy}>Abrir turno</button>
      </form>
      <ShiftHistory data={hist} />
    </div>
  );
}

// ---------------------------------------------------------------- turno abierto

function LiveShift() {
  const { shift, user } = useApp();
  const live = useData(() => api.get('/api/shift/current'), []);
  const moves = useData(() => api.get(`/api/shifts/${shift.id}/report`), [shift.id]);
  const hist = useData(() => api.get('/api/shifts?limit=10'), []);
  const [movement, setMovement] = useState(false);
  const [closing, setClosing] = useState(false);

  if (!live.data) return <Loading error={live.error} />;
  const t = live.data.live?.totals;
  const cash = live.data.live?.cash;
  const isAdmin = user.role === 'admin';

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Turno #{shift.id} abierto</h1>
          <div className="muted">Encargado: <b>{shift.openedBy}</b> · desde {fmtDateTime(shift.openedAt)} · fondo inicial {money(shift.openingCashCents)}</div>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => { live.reload(); moves.reload(); }}>Actualizar</button>
          <button className="btn dark" onClick={() => setMovement(true)}>Retiro / ingreso de efectivo</button>
          <button className="btn danger" onClick={() => setClosing(true)}>Cerrar turno</button>
        </div>
      </div>

      {t && (
        <>
          <div className="grid cols-4">
            <div className="stat yellow"><div className="k">Total vendido</div><div className="v">{money(t.totalCents)}</div></div>
            <div className="stat"><div className="k">Ventas</div><div className="v">{int(t.salesCount)}</div></div>
            <div className="stat"><div className="k">Ticket promedio</div><div className="v">{money(t.avgTicketCents)}</div></div>
            {isAdmin
              ? <div className="stat dark"><div className="k">Efectivo esperado en caja</div><div className="v">{money(cash.expectedCents)}</div></div>
              : <div className="stat"><div className="k">Anuladas</div><div className="v">{int(t.voidedCount)}</div></div>}
          </div>
          <div className="card">
            <h2>Cobros por medio de pago</h2>
            <div className="grid cols-4" style={{ marginTop: 12 }}>
              {METHOD_ORDER.map((m) => (
                <div key={m} className="stat">
                  <div className="k"><MethodChip method={m} /> {plural(t.countByMethod[m], 'cobro', 'cobros')}</div>
                  <div className="v">{money(t.byMethod[m])}</div>
                </div>
              ))}
            </div>
            <div className="row wrap" style={{ marginTop: 14, gap: 24 }}>
              <span>Digital (transferencia + débito + crédito): <b>{money(t.digitalCents)}</b></span>
              <span>Efectivo: <b>{money(t.cashCents)}</b></span>
              <span>Total: <b>{money(t.totalCents)}</b></span>
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Retiros e ingresos de efectivo</h2>
        {!moves.data ? <Loading error={moves.error} /> : moves.data.cashMovements.length === 0
          ? <div className="empty">Todavía no hubo movimientos de efectivo en este turno.</div>
          : (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="t">
                <thead><tr><th>Hora</th><th>Tipo</th><th className="num">Monto</th><th>Motivo</th><th>Registró</th></tr></thead>
                <tbody>
                  {moves.data.cashMovements.map((m) => (
                    <tr key={m.id}>
                      <td>{fmtTime(m.createdAt)}</td>
                      <td>{m.type === 'in' ? <span className="chip ok">Ingreso</span> : <span className="chip bad">Retiro</span>}</td>
                      <td className="num">{money2(m.amountCents)}</td>
                      <td>{m.reason}</td><td>{m.userName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <ShiftHistory data={hist} />
      {movement && <MovementModal onClose={() => setMovement(false)} onDone={() => { setMovement(false); live.reload(); moves.reload(); }} />}
      {closing && <CloseModal onClose={() => setClosing(false)} />}
    </div>
  );
}

function MovementModal({ onClose, onDone }) {
  const { toast } = useApp();
  const [type, setType] = useState('out');
  const [amount, setAmount] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { await api.post('/api/cash-movements', { type, amountCents: amount, reason }); toast('Movimiento registrado', 'ok'); onDone(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Retiro / ingreso de efectivo" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || !amount || reason.trim().length < 2} onClick={submit}>Registrar</button></>}>
      <div className="stack">
        <div className="pay-methods">
          <button className={`pay-method ${type === 'out' ? 'sel' : ''}`} onClick={() => setType('out')}>Retiro<small>sale plata de la caja</small></button>
          <button className={`pay-method ${type === 'in' ? 'sel' : ''}`} onClick={() => setType('in')}>Ingreso<small>entra plata a la caja</small></button>
        </div>
        <Field label="Monto">{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus />}</Field>
        <Field label="Motivo" hint="Ej: pago a proveedor, compra de hielo, cambio.">{(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="notice">Todo lo que saques de la caja tiene que quedar registrado acá; si no, el cierre va a dar faltante.</div>
        {error && <div className="notice red">{error}</div>}
      </div>
    </Modal>
  );
}

function CloseModal({ onClose }) {
  const { refresh, toast, shift } = useApp();
  const inv = useData(() => api.get('/api/inventory'), []);
  const [cash, setCash] = useState(null);
  const [counts, setCounts] = useState({});
  const [notes, setNotes] = useState('');
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/api/shifts/close', { countedCashCents: cash, notes: notes || null, stockCounts: toCounts(counts) });
      await refresh();
      toast('Turno cerrado', 'ok');
      go(`/caja/turno/${shift.id}`);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title={`Cerrar turno #${shift.id} · paso ${step} de 3`} onClose={onClose} size="wide" dismissable={!busy}
      footer={(
        <>
          {step > 1 && <button className="btn ghost" onClick={() => setStep(step - 1)} disabled={busy}>Atrás</button>}
          {step < 3 && <button className="btn" disabled={step === 1 && cash == null} onClick={() => setStep(step + 1)}>Siguiente</button>}
          {step === 3 && <button className="btn danger" disabled={busy || cash == null} onClick={submit}>Cerrar turno definitivamente</button>}
        </>
      )}>
      {step === 1 && (
        <div className="stack">
          <div className="notice">Contá el efectivo que hay en la caja <b>ahora</b> (incluido el fondo inicial). El sistema compara con lo que debería haber.</div>
          <Field label="Efectivo contado en la caja">{(id) => <MoneyInput id={id} value={cash} onChange={setCash} autoFocus onEnter={() => cash != null && setStep(2)} />}</Field>
        </div>
      )}
      {step === 2 && (
        <div className="stack">
          <div className="notice">Contá el stock que queda (opcional pero recomendado). Lo que cargues se compara con el sistema y queda como diferencia en el cierre. Dejá en blanco lo que no cuentes.</div>
          {!inv.data ? <Loading error={inv.error} /> : <StockCountTable stock={inv.data.stock} counts={counts} setCounts={setCounts} label="Contado" />}
        </div>
      )}
      {step === 3 && (
        <div className="stack">
          <div className="kv">
            <div>Efectivo contado</div><div>{money2(cash)}</div>
            <div>Productos contados</div><div>{toCounts(counts).length}</div>
          </div>
          <Field label="Observaciones (opcional)" hint="Ej: faltaron $300 de cambio, se cayeron 2 pizzas.">{(id) => <textarea id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          <div className="notice red">Al cerrar el turno no se pueden cargar más ventas en él. Se genera el resumen para imprimir o descargar.</div>
          {error && <div className="notice red" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- historial

function ShiftHistory({ data }) {
  return (
    <div className="card">
      <h2>Turnos anteriores</h2>
      {!data.data ? <Loading error={data.error} /> : data.data.shifts.length === 0
        ? <div className="empty">Todavía no hay turnos.</div>
        : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="t">
              <thead><tr><th>N°</th><th>Apertura</th><th>Cierre</th><th>Encargado</th><th className="num">Ventas</th><th className="num">Total</th><th className="num">Dif. caja</th><th /></tr></thead>
              <tbody>
                {data.data.shifts.map((s) => (
                  <tr key={s.id}>
                    <td>#{s.id}</td>
                    <td>{fmtDateTime(s.openedAt)}</td>
                    <td>{s.closedAt ? fmtDateTime(s.closedAt) : <span className="chip ok">Abierto</span>}</td>
                    <td>{s.openedBy}</td>
                    <td className="num">{int(s.salesCount)}</td>
                    <td className="num">{money(s.totalCents)}</td>
                    <td className={`num ${s.cashDiffCents < 0 ? 'neg' : ''}`}>{s.cashDiffCents == null ? '—' : money(s.cashDiffCents)}</td>
                    <td><a className="btn small ghost" href={`#/caja/turno/${s.id}`}>Ver cierre</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

