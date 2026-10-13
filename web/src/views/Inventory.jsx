import { useMemo, useState } from 'react';
import { api, download } from '../api.js';
import { addDays, fmtDateTime, int, todayYmd } from '../format.js';
import { Field, Loading, Modal, useApp, useData } from '../components/ui.jsx';

const MOVEMENT = {
  restock: ['Ingreso de mercadería', 'ok'],
  sale: ['Venta', 'neutral'],
  void_return: ['Venta anulada', 'warn'],
  adjustment: ['Ajuste', 'warn'],
  waste: ['Merma', 'bad'],
  count_open: ['Conteo al abrir', 'neutral'],
  count_close: ['Conteo al cerrar', 'neutral'],
};

export default function Inventory() {
  const { toast } = useApp();
  const [tab, setTab] = useState('stock');
  const stock = useData(() => api.get('/api/inventory'), []);
  const [restocking, setRestocking] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [q, setQ] = useState('');

  const rows = useMemo(() => (stock.data?.stock || []).filter((s) => `${s.name} ${s.category}`.toLowerCase().includes(q.toLowerCase())), [stock.data, q]);

  const exportXlsx = async () => {
    try { await download('/api/inventory/export.xlsx', 'MrCook_Inventario.xlsx'); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Inventario</h1>
        <div className="row wrap">
          <button className="btn ghost" onClick={exportXlsx}>Descargar Excel</button>
          <button className="btn dark" onClick={() => setAdjusting(true)}>Ajuste / merma</button>
          <button className="btn" onClick={() => setRestocking(true)}>+ Ingreso de mercadería</button>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>Stock actual</button>
        <button className={tab === 'mov' ? 'active' : ''} onClick={() => setTab('mov')}>Movimientos</button>
      </div>

      {tab === 'stock' && (
        <div className="card stack">
          <input className="input" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar producto" />
          {!stock.data ? <Loading error={stock.error} /> : rows.length === 0 ? <div className="empty">No hay productos que coincidan.</div> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Producto</th><th>Categoría</th><th className="num">Stock</th><th className="num">Avisar desde</th><th>Estado</th></tr></thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.productId} className={s.active ? '' : 'dim'}>
                      <td><b>{s.name}</b>{!s.active && <span className="muted small"> (desactivado)</span>}</td>
                      <td>{s.category}</td>
                      <td className={`num ${s.stock < 0 ? 'neg' : ''}`}><b>{int(s.stock)}</b></td>
                      <td className="num">{int(s.lowStockThreshold)}</td>
                      <td>{s.stock < 0 ? <span className="chip bad">Negativo: revisar</span> : s.low ? <span className="chip warn">Stock bajo</span> : <span className="chip ok">OK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {tab === 'mov' && <Movements />}

      {restocking && stock.data && <RestockModal stock={stock.data.stock.filter((s) => s.active)} onClose={() => setRestocking(false)} onDone={() => { setRestocking(false); stock.reload(); }} />}
      {adjusting && stock.data && <AdjustModal stock={stock.data.stock} onClose={() => setAdjusting(false)} onDone={() => { setAdjusting(false); stock.reload(); }} />}
    </div>
  );
}

function Movements() {
  const [from, setFrom] = useState(addDays(todayYmd(), -6));
  const [to, setTo] = useState(todayYmd());
  const mv = useData(() => api.get(`/api/inventory/movements?from=${from}&to=${to}`), [from, to]);
  return (
    <div className="card stack">
      <div className="row wrap">
        <Field label="Desde">{(id) => <input id={id} type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="Hasta">{(id) => <input id={id} type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      {!mv.data ? <Loading error={mv.error} /> : mv.data.movements.length === 0 ? <div className="empty">No hay movimientos en ese período.</div> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th className="num">Cantidad</th><th>Registró</th><th>Motivo</th></tr></thead>
            <tbody>
              {mv.data.movements.map((m) => {
                const [label, kind] = MOVEMENT[m.type] || [m.type, 'neutral'];
                return (
                  <tr key={m.id}>
                    <td className="nowrap">{fmtDateTime(m.created_at)}</td><td>{m.product}</td>
                    <td><span className={`chip ${kind}`}>{label}</span></td>
                    <td className={`num ${m.qty < 0 ? 'neg' : ''}`}><b>{m.qty > 0 ? `+${m.qty}` : m.qty}</b></td>
                    <td>{m.user_name || '—'}</td><td>{m.reason || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RestockModal({ stock, onClose, onDone }) {
  const { toast } = useApp();
  const [qty, setQty] = useState({});
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([productId, v]) => ({ productId: Number(productId), qty: Number(v) }));
  const units = items.reduce((a, i) => a + i.qty, 0);

  const submit = async () => {
    setBusy(true); setError('');
    try { await api.post('/api/inventory/restock', { items, supplier: supplier || null, note: note || null }); toast(`Ingreso registrado: ${int(units)} unidades`, 'ok'); onDone(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Ingreso de mercadería" size="wide" onClose={onClose} footer={
      <>
        <span className="muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>{items.length} productos · {int(units)} unidades</span>
        <button className="btn ghost" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={busy || items.length === 0} onClick={submit}>Registrar ingreso</button>
      </>
    }>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Cargá cuánto entró de cada producto. Dejá en blanco lo que no llegó.</p>
        <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
          <table className="t">
            <thead><tr><th>Producto</th><th className="num">Stock actual</th><th className="num">Entra</th></tr></thead>
            <tbody>
              {stock.map((s) => (
                <tr key={s.productId}>
                  <td>{s.name}</td><td className="num">{int(s.stock)}</td>
                  <td className="num" style={{ width: 150 }}>
                    <input className="input" inputMode="numeric" style={{ textAlign: 'right' }} placeholder="0" value={qty[s.productId] ?? ''} aria-label={`Entra: ${s.name}`}
                      onChange={(e) => setQty({ ...qty, [s.productId]: e.target.value.replace(/\D/g, '') })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid cols-2">
          <Field label="Proveedor / origen (opcional)">{(id) => <input id={id} className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />}</Field>
          <Field label="Nota (opcional)">{(id) => <input id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej: remito 0001-4521" />}</Field>
        </div>
        {error && <div className="notice red" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

function AdjustModal({ stock, onClose, onDone }) {
  const { toast } = useApp();
  const [productId, setProductId] = useState(stock[0]?.productId ?? '');
  const [kind, setKind] = useState('waste');
  const [sign, setSign] = useState(-1);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const n = Number(qty);
      await api.post('/api/inventory/adjust', { productId: Number(productId), kind, qty: kind === 'waste' ? -n : sign * n, reason });
      toast(kind === 'waste' ? 'Merma registrada' : 'Ajuste registrado', 'ok');
      onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Ajuste de stock / merma" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || !Number(qty) || reason.trim().length < 2} onClick={submit}>Registrar</button></>}>
      <div className="stack">
        <div className="pay-methods">
          <button className={`pay-method ${kind === 'waste' ? 'sel' : ''}`} onClick={() => setKind('waste')}>Merma<small>se tiró, se cayó, venció</small></button>
          <button className={`pay-method ${kind === 'adjustment' ? 'sel' : ''}`} onClick={() => setKind('adjustment')}>Ajuste<small>corregir el conteo</small></button>
        </div>
        <Field label="Producto">
          {(id) => <select id={id} className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>{stock.map((s) => <option key={s.productId} value={s.productId}>{s.name} (stock {s.stock})</option>)}</select>}
        </Field>
        {kind === 'adjustment' && (
          <div className="pay-methods">
            <button className={`pay-method ${sign === 1 ? 'sel' : ''}`} onClick={() => setSign(1)}>Sumar</button>
            <button className={`pay-method ${sign === -1 ? 'sel' : ''}`} onClick={() => setSign(-1)}>Restar</button>
          </div>
        )}
        <Field label="Cantidad">{(id) => <input id={id} className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label="Motivo (obligatorio)">{(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: se cayeron al piso, conteo físico" />}</Field>
        {error && <div className="notice red">{error}</div>}
      </div>
    </Modal>
  );
}
