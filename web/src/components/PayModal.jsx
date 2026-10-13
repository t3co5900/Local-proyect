import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { METHODS, METHOD_ORDER, fmtTime, money } from '../format.js';
import { ConfirmModal, Field, MethodChip, Modal, MoneyInput, useApp } from './ui.jsx';

const BILLS = [1000, 2000, 5000, 10000, 20000];

/** Billetes sugeridos para pagar `amountCents` (el cliente entrega uno solo). */
function cashSuggestions(amountCents) {
  const a = amountCents / 100;
  const set = new Set([a]);
  for (const step of [500, 1000, 5000, 10000, 20000]) set.add(Math.ceil(a / step) * step);
  for (const b of BILLS) if (b >= a) set.add(b);
  return [...set].filter((v) => v >= a).sort((x, y) => x - y).slice(0, 5).map((v) => Math.round(v * 100));
}

export default function PayModal({ cart, totalCents, onClose, onSold }) {
  const { settings, toast } = useApp();
  const mpOn = settings.mercadoPagoEnabled;

  const [payments, setPayments] = useState([]); // pagos ya acreditados
  const [method, setMethod] = useState(null);
  const [amount, setAmount] = useState(null);
  const [tendered, setTendered] = useState(null);
  const [charge, setCharge] = useState(null); // cobro electrónico en espera
  const [manualAsk, setManualAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sale, setSale] = useState(null);

  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const remaining = totalCents - paid;
  const lockedByCharge = payments.some((p) => p.chargeId) || !!charge;

  const pickMethod = (m) => {
    setMethod(m);
    setAmount(remaining);
    setTendered(null);
    setError('');
  };

  // cuando no queda nada por cobrar, se registra la venta
  const submitting = useRef(false);
  useEffect(() => {
    if (remaining !== 0 || payments.length === 0 || submitting.current || sale) return;
    submitting.current = true;
    (async () => {
      setBusy(true);
      try {
        const body = {
          items: cart.map((l) => ({ kind: l.kind, id: l.id, qty: l.qty })),
          payments: payments.map((p) => ({
            method: p.method,
            amountCents: p.amountCents,
            ...(p.tenderedCents != null ? { tenderedCents: p.tenderedCents } : {}),
            ...(p.chargeId ? { chargeId: p.chargeId } : {}),
          })),
        };
        setSale(await api.post('/api/sales', body));
      } catch (e) {
        setError(e.message);
        submitting.current = false;
      } finally { setBusy(false); }
    })();
  }, [remaining, payments, sale, cart]);

  // un cobro electrónico quedó confirmado (solo o elegido entre candidatos): pasa a la lista de pagos
  const onConfirmed = (c) => {
    setPayments((p) => (p.some((x) => x.chargeId === c.id) ? p : [...p, { method: c.resolvedMethod, amountCents: c.amountCents, chargeId: c.id, auto: true, matched: c.matched }]));
    setCharge(null);
    setMethod(null);
    toast(`Cobro recibido: ${money(c.amountCents)}`, 'ok');
  };

  // consulta periódica del cobro electrónico
  useEffect(() => {
    if (!charge || charge.status !== 'pending') return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const c = await api.get(`/api/charges/${charge.id}`);
        if (!alive) return;
        if (c.status === 'confirmed') onConfirmed(c);
        else setCharge(c);
      } catch { /* se reintenta en el próximo ciclo */ }
    };
    const t = setInterval(tick, 2500);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [charge?.id, charge?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const addCash = () => {
    const a = amount;
    const t = tendered ?? a;
    if (!a || a <= 0 || a > remaining) { setError('Revisá el monto.'); return; }
    if (t < a) { setError('El efectivo recibido no alcanza.'); return; }
    setPayments((p) => [...p, { method: 'efectivo', amountCents: a, tenderedCents: t }]);
    setMethod(null);
    setError('');
  };

  const startElectronic = async () => {
    const a = amount;
    if (!a || a <= 0 || a > remaining) { setError('Revisá el monto.'); return; }
    setError('');
    if (!mpOn) { // sin Mercado Pago: la persona confirma que el cobro llegó
      setPayments((p) => [...p, { method, amountCents: a, manual: true }]);
      setMethod(null);
      return;
    }
    setBusy(true);
    try {
      setCharge(await api.post('/api/charges', { kind: method === 'transferencia' ? 'qr' : 'tarjeta', amountCents: a }));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const cancelCharge = async () => {
    if (charge) { try { await api.post(`/api/charges/${charge.id}/cancel`); } catch { /* ya no estaba */ } }
    setCharge(null);
    setMethod(null);
  };

  const confirmManually = async () => {
    const c = charge;
    await cancelCharge();
    setPayments((p) => [...p, { method, amountCents: c.amountCents, manual: true }]);
    setManualAsk(false);
  };

  const pick = async (paymentId) => {
    try {
      const c = await api.post(`/api/charges/${charge.id}/pick`, { paymentId });
      if (c.status === 'confirmed') onConfirmed(c);
      else setCharge(c);
    } catch (e) { setError(e.message); }
  };

  const change = useMemo(() => sale?.payments.reduce((a, p) => a + (p.changeCents || 0), 0) || 0, [sale]);

  // ---------- venta lista ----------
  if (sale) {
    return (
      <Modal title={`Venta #${sale.number} registrada`} onClose={() => onSold(sale)} dismissable={false}
        footer={<button className="btn big block" autoFocus onClick={() => onSold(sale)}>Listo — nueva venta</button>}>
        <div className="stack">
          <div className="stat dark"><div className="k">Total cobrado</div><div className="v">{money(sale.totalCents)}</div></div>
          <div className="row wrap">
            {sale.payments.map((p, i) => <span key={i} className="row" style={{ gap: 6 }}><MethodChip method={p.method} manual={p.confirmation === 'manual'} /><b>{money(p.amountCents)}</b></span>)}
          </div>
          {change > 0 && <div className="change-box"><div>Vuelto para el cliente</div><div className="v">{money(change)}</div></div>}
        </div>
      </Modal>
    );
  }

  const primary = method && !charge && remaining > 0 ? (
    method === 'efectivo' ? (
      <button className="btn big grow" onClick={addCash} disabled={!amount || (tendered != null && tendered < amount)}>
        Cobrar {amount ? money(amount) : ''} en efectivo
      </button>
    ) : (
      <button className="btn big grow" onClick={startElectronic} disabled={busy || !amount}>
        {mpOn ? `Cobrar ${amount ? money(amount) : ''} · ${METHODS[method].label}` : `Confirmo que cobré ${amount ? money(amount) : ''} (${METHODS[method].short})`}
      </button>
    )
  ) : null;
  const footer = charge ? null : (
    <>
      {!primary && <button className="btn ghost" onClick={onClose} disabled={lockedByCharge}>Volver al carrito</button>}
      {primary && <button className="btn ghost" onClick={() => setMethod(null)}>Atrás</button>}
      {primary}
    </>
  );

  return (
    <Modal title={`Cobrar ${money(totalCents)}`} onClose={onClose} dismissable={!lockedByCharge && !busy} footer={footer}>
      <div className="stack">
        <div className="row between">
          <span className="muted">Por cobrar</span>
          <b style={{ fontSize: '1.6rem' }}>{money(remaining)}</b>
        </div>

        {payments.length > 0 && (
          <div className="paid-list">
            {payments.map((p, i) => (
              <div key={i} className="paid-item">
                <span className="row"><MethodChip method={p.method} manual={p.manual} /> {p.auto && <span className="small muted">Mercado Pago{p.matched?.payer ? ` · ${p.matched.payer}` : ''}</span>}</span>
                <span className="row">
                  <b>{money(p.amountCents)}</b>
                  {!p.chargeId && <button className="linkbtn small" onClick={() => setPayments((x) => x.filter((_, j) => j !== i))} aria-label="Quitar pago">quitar</button>}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ---- espera de pago electrónico ---- */}
        {charge && (
          <div className="card flat waiting">
            <div className="pulse" aria-hidden="true">{charge.kind === 'qr' ? '▦' : '▭'}</div>
            <h3>Esperando el pago de {money(charge.amountCents)}…</h3>
            <p className="muted" style={{ margin: '4px 0 12px' }}>
              {charge.kind === 'qr' ? 'Que el cliente escanee el QR del mostrador y pague.' : 'Pasá la tarjeta por el posnet.'} Se confirma solo cuando Mercado Pago lo acredita.
            </p>
            {charge.lastError && <div className="notice red" style={{ marginBottom: 10 }}>{charge.lastError} Si ya viste el pago en tu celular, confirmalo a mano.</div>}
            {charge.candidates?.length > 1 && (
              <div className="stack" style={{ marginBottom: 10 }}>
                <div className="notice">Hay varios pagos por el mismo monto. ¿Cuál es el de este cliente?</div>
                {charge.candidates.map((c) => (
                  <button key={c.paymentId} className="btn ghost" onClick={() => pick(c.paymentId)}>
                    {c.payer || `Pago ${c.paymentId}`} · {fmtTime(c.approvedAt)}
                  </button>
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn ghost" onClick={cancelCharge}>Cancelar cobro</button>
              <button className="btn dark" onClick={() => setManualAsk(true)}>Confirmar a mano</button>
            </div>
          </div>
        )}

        {/* ---- elegir medio de pago ---- */}
        {!charge && remaining > 0 && (
          <>
            <div className="pay-methods">
              {METHOD_ORDER.map((m) => (
                <button key={m} className={`pay-method ${method === m ? 'sel' : ''}`} onClick={() => pickMethod(m)}>
                  {METHODS[m].label}
                  {m !== 'efectivo' && <small>{mpOn ? 'se confirma solo' : 'confirmás vos'}</small>}
                </button>
              ))}
            </div>

            {method && (
              <div className="card flat stack">
                <Field label={`${payments.length ? 'Monto de este pago' : 'Monto'} (si pagan en partes, bajalo)`}>
                  {(id) => <MoneyInput id={id} value={amount} onChange={setAmount} autoFocus={method !== 'efectivo'} />}
                </Field>

                {method === 'efectivo' ? (
                  <>
                    <Field label="¿Con cuánto paga el cliente?">
                      {(id) => <MoneyInput id={id} value={tendered} onChange={setTendered} autoFocus placeholder={amount ? String(amount / 100) : '0'} onEnter={addCash} />}
                    </Field>
                    <div className="quick-cash">
                      <button type="button" onClick={() => setTendered(amount)}>Justo</button>
                      {amount > 0 && cashSuggestions(amount).filter((c) => c !== amount).map((c) => (
                        <button type="button" key={c} onClick={() => setTendered(c)}>{money(c)}</button>
                      ))}
                    </div>
                    {tendered != null && amount != null && tendered >= amount && tendered > amount && (
                      <div className="change-box"><div>Vuelto</div><div className="v">{money(tendered - amount)}</div></div>
                    )}
                  </>
                ) : (
                  <p className="muted small" style={{ margin: 0 }}>
                    {mpOn ? 'Al tocar el botón de abajo, la venta queda esperando el pago y se confirma sola.' : 'Mercado Pago no está activado: confirmá vos que el cobro se acreditó.'}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {busy && remaining === 0 && <div className="notice">Registrando la venta…</div>}
        {error && <div className="notice red" role="alert">{error}</div>}
        {lockedByCharge && !charge && <div className="notice">Ya se cobró una parte por Mercado Pago: completá el resto para cerrar la venta.</div>}
      </div>

      {manualAsk && (
        <ConfirmModal
          title="Confirmar el cobro a mano"
          message={`¿Ya comprobaste que ${money(charge.amountCents)} llegaron a la cuenta? La venta queda marcada como "confirmada a mano" en el cierre para revisarla después.`}
          confirmLabel="Sí, ya llegó"
          onConfirm={confirmManually}
          onClose={() => setManualAsk(false)}
        />
      )}
    </Modal>
  );
}
