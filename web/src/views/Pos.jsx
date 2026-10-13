import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime, money } from '../format.js';
import PayModal from '../components/PayModal.jsx';
import { Field, Loading, MethodChip, Modal, PinPad, useApp, useData } from '../components/ui.jsx';

const CART_KEY = 'mrcook.cart.v1';
const loadCart = () => { try { return JSON.parse(sessionStorage.getItem(CART_KEY)) || []; } catch { return []; } };

export default function Pos() {
  const { shift, user, settings } = useApp();
  const catalog = useData(() => api.get('/api/catalog'), []);
  const recent = useData(() => api.get('/api/sales?shiftId=current&limit=25'), [shift?.id]);
  const [tab, setTab] = useState('all');
  const [cart, setCart] = useState(loadCart);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(null);
  const [fresh, setFresh] = useState(null);

  useEffect(() => { try { sessionStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* sin storage */ } }, [cart]);
  useEffect(() => { const t = setInterval(recent.reload, 15000); return () => clearInterval(t); }, [recent.reload]);

  const total = useMemo(() => cart.reduce((a, l) => a + l.unitPriceCents * l.qty, 0), [cart]);
  const units = cart.reduce((a, l) => a + l.qty, 0);

  if (!shift) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center' }}>
        <h2>No hay un turno abierto</h2>
        <p className="muted">Para empezar a vender hay que abrir el turno (con el efectivo inicial de la caja).</p>
        <a className="btn big" href="#/caja">Abrir turno</a>
      </div>
    );
  }
  if (!catalog.data) return <Loading error={catalog.error} />;

  const { categories, products, promos } = catalog.data;
  const productsByCat = (id) => products.filter((p) => p.categoryId === id);

  const add = (kind, item, priceCents) => {
    setCart((c) => {
      const key = `${kind}:${item.id}`;
      const i = c.findIndex((l) => l.key === key);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { key, kind, id: item.id, name: item.name, unitPriceCents: priceCents, qty: 1 }];
    });
  };
  const setQty = (key, qty) => setCart((c) => (qty <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, qty: Math.min(qty, 999) } : l))));

  const tile = (p, withCat = false) => {
    const out = p.trackStock && p.stock <= 0;
    const low = p.trackStock && !out && p.stock <= p.lowStockThreshold;
    return (
      <button key={`p${p.id}`} className="tile" onClick={() => add('product', p, p.priceCents)}>
        {p.trackStock && <span className={`stk ${out ? 'out' : low ? 'low' : ''}`}>{out ? 'Sin stock' : `${p.stock} u.`}</span>}
        {withCat && <span className="cat">{p.category}</span>}
        <span className="nm">{p.name}</span>
        <span className="pr">{money(p.priceCents)}</span>
      </button>
    );
  };
  const promoTile = (pr) => (
    <button key={`pr${pr.id}`} className="tile promo" onClick={() => add('promo', pr, pr.priceCents)}>
      <span className="nm">{pr.name}</span>
      <span className="sub">{pr.items.map((i) => `${i.qty}× ${i.name}`).join(' + ')}</span>
      <span className="pr">{money(pr.priceCents)}</span>
    </button>
  );

  const tabs = [{ id: 'all', label: 'Todo' }, ...(promos.length ? [{ id: 'promos', label: '★ Promos' }] : []), ...categories.filter((c) => productsByCat(c.id).length).map((c) => ({ id: `c${c.id}`, label: c.name }))];

  let grid;
  if (tab === 'promos') grid = <div className="tiles">{promos.map(promoTile)}</div>;
  else if (tab.startsWith('c')) grid = <div className="tiles">{productsByCat(Number(tab.slice(1))).map((p) => tile(p))}</div>;
  else {
    grid = (
      <>
        {promos.length > 0 && (<><div className="section-title" style={{ marginTop: 0 }}>Promos</div><div className="tiles">{promos.map(promoTile)}</div></>)}
        <div className="section-title">Productos</div>
        <div className="tiles">{categories.flatMap((c) => productsByCat(c.id)).map((p) => tile(p, true))}</div>
      </>
    );
  }

  return (
    <div className="pos">
      <section>
        {user.role === 'admin' && !settings.pricesConfirmed && (
          <div className="notice" style={{ marginBottom: 14 }}>
            Los precios cargados son <b>de ejemplo</b>. Revisalos en <a href="#/admin/productos"><b>Administración → Productos</b></a> antes de cobrar de verdad.
          </div>
        )}
        <div className="cat-tabs" role="tablist">
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        {products.length === 0 ? <div className="empty">No hay productos cargados. Un encargado puede crearlos en Administración.</div> : grid}
      </section>

      <aside className="cart">
        <div className="card stack">
          <div className="row between">
            <h2>Venta actual</h2>
            {cart.length > 0 && <button className="linkbtn small" onClick={() => setCart([])}>Vaciar</button>}
          </div>
          {cart.length === 0 ? (
            <div className="empty" style={{ padding: '18px 0' }}>Tocá un producto para agregarlo.</div>
          ) : (
            <div className="cart-lines">
              {cart.map((l) => (
                <div key={l.key} className="cart-line">
                  <div><div className="nm">{l.name}</div><div className="muted small">{money(l.unitPriceCents)} c/u{l.kind === 'promo' ? ' · promo' : ''}</div></div>
                  <div className="tot">{money(l.unitPriceCents * l.qty)}</div>
                  <div className="stepper">
                    <button onClick={() => setQty(l.key, l.qty - 1)} aria-label={`Menos ${l.name}`}>−</button>
                    <input value={l.qty} inputMode="numeric" aria-label={`Cantidad de ${l.name}`} onChange={(e) => setQty(l.key, Number(e.target.value.replace(/\D/g, '')) || 0)} />
                    <button onClick={() => setQty(l.key, l.qty + 1)} aria-label={`Más ${l.name}`}>+</button>
                  </div>
                  <button className="linkbtn small" style={{ justifySelf: 'end' }} onClick={() => setQty(l.key, 0)}>quitar</button>
                </div>
              ))}
            </div>
          )}
          <div className="cart-total"><span>{units} {units === 1 ? 'ítem' : 'ítems'} · Total</span><span className="v">{money(total)}</span></div>
          <button className="btn big block" disabled={cart.length === 0} onClick={() => setPaying(true)}>Cobrar</button>
        </div>

        <div className="card stack">
          <h3>Últimos cobros</h3>
          {!recent.data ? <Loading error={recent.error} /> : recent.data.sales.length === 0 ? (
            <div className="empty" style={{ padding: 10 }}>Todavía no hubo ventas en este turno.</div>
          ) : (
            <div className="recent">
              {recent.data.sales.map((s) => (
                <div key={s.id} className={`recent-item ${s.status === 'void' ? 'void' : ''} ${fresh === s.id ? 'fresh' : ''}`}>
                  <div><b>#{s.number}</b> <span className="muted">{fmtTime(s.createdAt)}</span></div>
                  <b className="mono">{money(s.totalCents)}</b>
                  <div className="muted small" style={{ gridColumn: '1 / -1' }}>{s.summary}</div>
                  <div className="chips">
                    {s.status === 'void'
                      ? <span className="chip bad">Anulada</span>
                      : s.payments.map((p, i) => <MethodChip key={i} method={p.method} manual={p.confirmation === 'manual' && settings.mercadoPagoEnabled} />)}
                    {s.status !== 'void' && <button className="linkbtn small" style={{ marginLeft: 'auto' }} onClick={() => setVoiding(s)}>anular</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {paying && (
        <PayModal
          cart={cart}
          totalCents={total}
          onClose={() => setPaying(false)}
          onSold={(sale) => { setPaying(false); setCart([]); setFresh(sale.id); recent.reload(); catalog.reload(); }}
        />
      )}
      {voiding && <VoidModal sale={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); recent.reload(); catalog.reload(); }} />}
    </div>
  );
}

function VoidModal({ sale, onClose, onDone }) {
  const { user, toast } = useApp();
  const isAdmin = user.role === 'admin';
  const [reason, setReason] = useState('');
  const [sup, setSup] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post(`/api/sales/${sale.id}/void`, { reason, ...(isAdmin ? {} : { supervisor: { username: sup, pin } }) });
      toast(`Venta #${sale.number} anulada`, 'ok');
      if (r.refundNote) toast(r.refundNote, 'error');
      onDone();
    } catch (e) { setError(e.message); setPin(''); }
    finally { setBusy(false); }
  };

  const ready = reason.trim().length >= 3 && (isAdmin || (sup.trim() && pin.length === 4));
  return (
    <Modal title={`Anular venta #${sale.number}`} onClose={onClose} footer={
      <>
        <button className="btn ghost" onClick={onClose}>No anular</button>
        <button className="btn danger" disabled={!ready || busy} onClick={submit}>Anular venta</button>
      </>
    }>
      <div className="stack">
        <div className="notice">{sale.summary} — <b>{money(sale.totalCents)}</b>. Se devuelve el stock y deja de contar en el cierre.</div>
        <Field label="Motivo">{(id) => <input id={id} className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: error de carga, el cliente se arrepintió" />}</Field>
        {!isAdmin && (
          <>
            <div className="notice dark">Una anulación la autoriza un encargado: que ingrese su usuario y código.</div>
            <Field label="Usuario del encargado">{(id) => <input id={id} className="input" autoComplete="off" value={sup} onChange={(e) => setSup(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />}</Field>
            <PinPad value={pin} onChange={setPin} onSubmit={() => ready && submit()} busy={busy} />
          </>
        )}
        {error && <div className="notice red" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}
