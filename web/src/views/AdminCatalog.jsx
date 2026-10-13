import { useState } from 'react';
import { api } from '../api.js';
import { int, money } from '../format.js';
import { Field, Loading, Modal, MoneyInput, useApp, useData } from '../components/ui.jsx';

// ------------------------------------------------------------------ productos

export function Products() {
  const { settings, refresh, toast } = useApp();
  const cat = useData(() => api.get('/api/admin/catalog'), []);
  const [editing, setEditing] = useState(null);
  const [cats, setCats] = useState(false);

  if (!cat.data) return <Loading error={cat.error} />;
  const { categories, products } = cat.data;

  const confirmPrices = async () => {
    await api.post('/api/admin/confirm-prices');
    await refresh();
    toast('Precios confirmados', 'ok');
  };

  return (
    <div className="stack">
      {!settings.pricesConfirmed && (
        <div className="notice row between wrap">
          <span><b>Los precios cargados son de ejemplo.</b> Editá cada producto con el precio real y después confirmá.</span>
          <button className="btn small dark" onClick={confirmPrices}>Ya revisé los precios</button>
        </div>
      )}
      <div className="row between wrap">
        <p className="muted" style={{ margin: 0 }}>Un producto con &quot;controla stock&quot; descuenta del inventario en cada venta. Si deja de venderse, desactivalo (no se borra, para conservar el historial).</p>
        <div className="row">
          <button className="btn ghost" onClick={() => setCats(true)}>Categorías</button>
          <button className="btn" onClick={() => setEditing({})}>+ Nuevo producto</button>
        </div>
      </div>
      {categories.map((c) => {
        const items = products.filter((p) => p.categoryId === c.id);
        if (!items.length && !c.active) return null;
        return (
          <div className="card stack" key={c.id}>
            <h2>{c.name} {!c.active && <span className="chip neutral">categoría oculta</span>}</h2>
            {items.length === 0 ? <div className="muted">Sin productos.</div> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Producto</th><th className="num">Precio</th><th>Stock</th><th className="num">Avisar desde</th><th>Estado</th><th /></tr></thead>
                <tbody>{items.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'dim'}>
                    <td><b>{p.name}</b></td>
                    <td className="num">{money(p.priceCents)}</td>
                    <td>{p.trackStock ? <span className="chip neutral">controla ({int(p.stock)})</span> : <span className="muted">no controla</span>}</td>
                    <td className="num">{p.trackStock ? int(p.lowStockThreshold) : '—'}</td>
                    <td>{p.active ? <span className="chip ok">Activo</span> : <span className="chip neutral">Desactivado</span>}</td>
                    <td className="right"><button className="btn small ghost" onClick={() => setEditing(p)}>Editar</button></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        );
      })}
      {editing && <ProductForm product={editing} categories={categories.filter((c) => c.active || c.id === editing.categoryId)} onClose={() => setEditing(null)} onDone={() => { setEditing(null); cat.reload(); }} />}
      {cats && <CategoriesModal categories={categories} onClose={() => { setCats(false); cat.reload(); }} />}
    </div>
  );
}

function ProductForm({ product, categories, onClose, onDone }) {
  const { toast } = useApp();
  const isNew = !product.id;
  const [name, setName] = useState(product.name || '');
  const [categoryId, setCategoryId] = useState(product.categoryId || categories[0]?.id);
  const [price, setPrice] = useState(product.priceCents ?? null);
  const [track, setTrack] = useState(product.trackStock ?? true);
  const [low, setLow] = useState(String(product.lowStockThreshold ?? 0));
  const [active, setActive] = useState(product.active ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError('');
    const body = { name, categoryId: Number(categoryId), priceCents: price, trackStock: track, lowStockThreshold: Number(low) || 0 };
    try {
      if (isNew) await api.post('/api/admin/products', body); else await api.patch(`/api/admin/products/${product.id}`, { ...body, active });
      toast('Producto guardado', 'ok');
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'Nuevo producto' : `Editar ${product.name}`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || !name.trim() || price == null} onClick={save}>Guardar</button></>}>
      <div className="stack">
        <Field label="Nombre" hint="Si vendés distintos gustos, creá un producto por gusto (Ej: Empanada de carne).">{(id) => <input id={id} className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Categoría">{(id) => <select id={id} className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
        <Field label="Precio de venta">{(id) => <MoneyInput id={id} value={price} onChange={setPrice} />}</Field>
        <label className="switch"><input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} /> Controla stock (descuenta del inventario al vender)</label>
        {track && <Field label="Avisar cuando queden… unidades o menos">{(id) => <input id={id} className="input" inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value.replace(/\D/g, ''))} />}</Field>}
        {!isNew && <label className="switch"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo (aparece en la pantalla de venta)</label>}
        {error && <div className="notice red">{error}</div>}
      </div>
    </Modal>
  );
}

function CategoriesModal({ categories, onClose }) {
  const { toast } = useApp();
  const [rows, setRows] = useState(categories.map((c) => ({ ...c })));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const saveRow = async (c) => {
    try { await api.patch(`/api/admin/categories/${c.id}`, { name: c.name, active: c.active }); toast('Categoría guardada', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  };
  const add = async () => {
    setBusy(true);
    try { const r = await api.post('/api/admin/categories', { name, sortOrder: rows.length }); setRows([...rows, { id: r.id, name, active: true }]); setName(''); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal title="Categorías" onClose={onClose} footer={<button className="btn" onClick={onClose}>Listo</button>}>
      <div className="stack">
        {rows.map((c, i) => (
          <div className="row" key={c.id}>
            <input className="input grow" value={c.name} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} aria-label="Nombre de la categoría" />
            <label className="switch"><input type="checkbox" checked={c.active} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, active: e.target.checked } : r)))} /> visible</label>
            <button className="btn small ghost" onClick={() => saveRow(c)}>Guardar</button>
          </div>
        ))}
        <div className="row"><input className="input grow" placeholder="Nueva categoría…" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn" disabled={busy || !name.trim()} onClick={add}>Agregar</button></div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ promos

export function Promos() {
  const cat = useData(() => api.get('/api/admin/catalog'), []);
  const [editing, setEditing] = useState(null);
  if (!cat.data) return <Loading error={cat.error} />;
  const { products, promos } = cat.data;
  const byId = new Map(products.map((p) => [p.id, p]));
  const loose = (pr) => pr.items.reduce((a, i) => a + (byId.get(i.productId)?.priceCents || 0) * i.qty, 0);

  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted" style={{ margin: 0 }}>Una promo es un combo a precio fijo (Ej: docena de empanadas, 3 medialunas, 3 empanadas + gaseosa). Al venderla se descuenta del stock cada producto que incluye.</p>
        <button className="btn" onClick={() => setEditing({})}>+ Nueva promo</button>
      </div>
      <div className="card stack">
        {promos.length === 0 ? <div className="empty">No hay promos todavía.</div> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Promo</th><th>Incluye</th><th className="num">Precio promo</th><th className="num">Suelto</th><th className="num">Ahorro</th><th>Estado</th><th /></tr></thead>
            <tbody>{promos.map((pr) => (
              <tr key={pr.id} className={pr.active ? '' : 'dim'}>
                <td><b>{pr.name}</b></td>
                <td>{pr.items.map((i) => `${i.qty}× ${i.name}`).join(' + ')}</td>
                <td className="num"><b>{money(pr.priceCents)}</b></td>
                <td className="num">{money(loose(pr))}</td>
                <td className={`num ${pr.priceCents > loose(pr) ? 'neg' : ''}`}>{money(loose(pr) - pr.priceCents)}</td>
                <td>{!pr.active ? <span className="chip neutral">Desactivada</span> : pr.available ? <span className="chip ok">Activa</span> : <span className="chip warn">No disponible (producto desactivado)</span>}</td>
                <td className="right"><button className="btn small ghost" onClick={() => setEditing(pr)}>Editar</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {editing && <PromoForm promo={editing} products={products.filter((p) => p.active)} onClose={() => setEditing(null)} onDone={() => { setEditing(null); cat.reload(); }} />}
    </div>
  );
}

function PromoForm({ promo, products, onClose, onDone }) {
  const { toast } = useApp();
  const isNew = !promo.id;
  const [name, setName] = useState(promo.name || '');
  const [price, setPrice] = useState(promo.priceCents ?? null);
  const [items, setItems] = useState(promo.items?.length ? promo.items.map((i) => ({ productId: i.productId, qty: i.qty })) : [{ productId: products[0]?.id, qty: 1 }]);
  const [active, setActive] = useState(promo.active ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const byId = new Map(products.map((p) => [p.id, p]));
  const loose = items.reduce((a, i) => a + (byId.get(Number(i.productId))?.priceCents || 0) * (Number(i.qty) || 0), 0);

  const save = async () => {
    setBusy(true); setError('');
    const body = { name, priceCents: price, items: items.map((i) => ({ productId: Number(i.productId), qty: Number(i.qty) })) };
    try {
      if (isNew) await api.post('/api/admin/promos', body); else await api.patch(`/api/admin/promos/${promo.id}`, { ...body, active });
      toast('Promo guardada', 'ok');
      onDone();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'Nueva promo' : `Editar ${promo.name}`} size="wide" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || !name.trim() || price == null || items.some((i) => !Number(i.qty))} onClick={save}>Guardar</button></>}>
      <div className="stack">
        <div className="grid cols-2">
          <Field label="Nombre de la promo">{(id) => <input id={id} className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Precio de la promo">{(id) => <MoneyInput id={id} value={price} onChange={setPrice} />}</Field>
        </div>
        <div className="stack">
          <span className="lbl" style={{ fontWeight: 800, fontSize: '0.88rem' }}>Qué incluye</span>
          {items.map((it, i) => (
            <div className="row" key={i}>
              <input className="input" style={{ width: 90, textAlign: 'center' }} inputMode="numeric" value={it.qty} aria-label="Cantidad"
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} />
              <span>×</span>
              <select className="input grow" value={it.productId} aria-label="Producto" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({money(p.priceCents)})</option>)}
              </select>
              {items.length > 1 && <button className="btn small ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>Quitar</button>}
            </div>
          ))}
          <div><button className="btn small ghost" onClick={() => setItems([...items, { productId: products[0]?.id, qty: 1 }])}>+ Agregar otro producto</button></div>
        </div>
        <div className="notice">Comprado suelto saldría <b>{money(loose)}</b>{price != null && <> · el cliente ahorra <b>{money(loose - price)}</b>{price > loose && ' (la promo sale más cara que suelto: revisá el precio)'}</>}.</div>
        {!isNew && <label className="switch"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activa (aparece en la pantalla de venta)</label>}
        {error && <div className="notice red">{error}</div>}
      </div>
    </Modal>
  );
}
