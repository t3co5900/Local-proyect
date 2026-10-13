import { useState } from 'react';
import { api } from '../api.js';
import { fmtDateTime, money } from '../format.js';
import { ConfirmModal, Field, Loading, Modal, useApp, useData } from '../components/ui.jsx';
import { Products, Promos } from './AdminCatalog.jsx';
import { Settings } from './AdminSettings.jsx';

const TABS = [
  ['usuarios', 'Usuarios'],
  ['productos', 'Productos'],
  ['promos', 'Promos'],
  ['config', 'Configuración'],
  ['respaldos', 'Respaldos'],
  ['auditoria', 'Auditoría'],
];

export default function Admin({ tab, query }) {
  const current = TABS.some(([id]) => id === tab) ? tab : 'usuarios';
  return (
    <div className="stack">
      <div className="page-head"><h1>Administración</h1></div>
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => <a key={id} href={`#/admin/${id}`} role="tab" className={current === id ? 'active' : ''}>{label}</a>)}
      </div>
      {current === 'usuarios' && <Users />}
      {current === 'productos' && <Products />}
      {current === 'promos' && <Promos />}
      {current === 'config' && <Settings query={query} />}
      {current === 'respaldos' && <Backups />}
      {current === 'auditoria' && <Audit />}
    </div>
  );
}

// ------------------------------------------------------------------ usuarios

function PinReveal({ title, name, pin, warnings, onClose }) {
  return (
    <Modal title={title} onClose={onClose} size="narrow" dismissable={false} footer={<button className="btn big block" onClick={onClose}>Ya lo anoté</button>}>
      <div className="stack">
        <p style={{ margin: 0 }}>Código de <b>{name}</b>. <b>No se vuelve a mostrar</b>: entregáselo en persona o anotalo.</p>
        <div className="big-pin">{pin}</div>
        {warnings?.map((w) => <div className="notice" key={w}>{w}</div>)}
      </div>
    </Modal>
  );
}

function Users() {
  const { user: me, toast } = useApp();
  const list = useData(() => api.get('/api/users'), []);
  const [editing, setEditing] = useState(null); // {} = nuevo
  const [reveal, setReveal] = useState(null);
  const [resetting, setResetting] = useState(null);

  return (
    <div className="card stack">
      <div className="row between"><h2>Personal</h2><button className="btn" onClick={() => setEditing({})}>+ Nuevo usuario</button></div>
      <p className="muted small" style={{ margin: 0 }}>Cada persona ingresa con su nombre y apellido (o inicial + apellido) y un código de 4 dígitos que asigna el sistema al azar.</p>
      {!list.data ? <Loading error={list.error} /> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Nombre</th><th>Rol</th><th>Alias de ingreso</th><th>Último ingreso</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {list.data.users.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'dim'}>
                  <td><b>{u.fullName}</b>{u.id === me.id && <span className="muted small"> (vos)</span>}</td>
                  <td>{u.role === 'admin' ? 'Encargado' : 'Cajero'}</td>
                  <td>{u.loginAlias || <span className="muted">—</span>}</td>
                  <td>{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="muted">nunca</span>}</td>
                  <td>{!u.active ? <span className="chip neutral">Inactivo</span> : u.lockedUntil ? <span className="chip bad">Bloqueado</span> : <span className="chip ok">Activo</span>}</td>
                  <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn small ghost" onClick={() => setEditing(u)}>Editar</button>
                    <button className="btn small ghost" onClick={() => setResetting(u)}>Nuevo código</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <UserForm
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(res) => {
            setEditing(null); list.reload();
            if (res.pin) setReveal({ title: 'Usuario creado', name: res.user.fullName, pin: res.pin, warnings: res.warnings });
            else if (res.warnings?.length) toast(res.warnings[0], 'error');
            else toast('Cambios guardados', 'ok');
          }}
        />
      )}
      {resetting && (
        <ConfirmModal
          title="Generar un código nuevo"
          message={`Se genera un código nuevo para ${resetting.fullName} y el anterior deja de funcionar. También se desbloquea su usuario.`}
          confirmLabel="Generar código nuevo"
          onClose={() => setResetting(null)}
          onConfirm={async () => {
            const r = await api.post(`/api/users/${resetting.id}/reset-pin`);
            setReveal({ title: 'Código nuevo', name: resetting.fullName, pin: r.pin });
            setResetting(null); list.reload();
          }}
        />
      )}
      {reveal && <PinReveal {...reveal} onClose={() => setReveal(null)} />}
    </div>
  );
}

function UserForm({ user, onClose, onSaved }) {
  const isNew = !user.id;
  const [fullName, setFullName] = useState(user.fullName || '');
  const [role, setRole] = useState(user.role || 'cajero');
  const [alias, setAlias] = useState(user.loginAlias || '');
  const [active, setActive] = useState(user.active ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { fullName, role, alias: alias.trim() || null };
      onSaved(isNew ? await api.post('/api/users', body) : await api.patch(`/api/users/${user.id}`, { ...body, active }));
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'Nuevo usuario' : `Editar a ${user.fullName}`} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" disabled={busy || fullName.trim().length < 3} onClick={save}>{isNew ? 'Crear y generar código' : 'Guardar'}</button></>}>
      <div className="stack">
        <Field label="Nombre y apellido" hint="Con esto ingresa: el nombre completo o inicial + apellido (C Pérez).">{(id) => <input id={id} className="input" autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
        <Field label="Rol" hint="El encargado puede anular ventas, ver reportes y administrar.">
          {(id) => <select id={id} className="input" value={role} onChange={(e) => setRole(e.target.value)}><option value="cajero">Cajero</option><option value="admin">Encargado (administrador)</option></select>}
        </Field>
        <Field label="Alias de ingreso (opcional)" hint="Una forma extra de escribir su usuario, si hay dos personas con la misma inicial y apellido.">{(id) => <input id={id} className="input" value={alias} onChange={(e) => setAlias(e.target.value)} />}</Field>
        {!isNew && <label className="switch"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Usuario activo</label>}
        {error && <div className="notice red">{error}</div>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ respaldos

function Backups() {
  const { toast } = useApp();
  const list = useData(() => api.get('/api/backups'), []);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/backups/run', {});
      toast(r.status === 'ok' ? 'Respaldo generado' : r.message, r.status === 'ok' ? 'ok' : 'error');
      list.reload();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const chip = (s) => ({ ok: ['ok', 'Correcto'], partial: ['warn', 'Local OK, Drive falló'], error: ['bad', 'Error'], running: ['neutral', 'En curso'] }[s] || ['neutral', s]);

  return (
    <div className="card stack">
      <div className="row between wrap">
        <h2>Respaldos semanales</h2>
        <button className="btn" onClick={run} disabled={busy}>{busy ? 'Generando…' : 'Hacer respaldo de esta semana ahora'}</button>
      </div>
      {!list.data ? <Loading error={list.error} /> : (
        <>
          <div className="notice">
            Cada semana (lunes a domingo) se genera un <b>Excel con el resumen de ventas, cobros por medio de pago y stock</b> más una <b>copia de la base de datos</b>.
            Se guarda en <b>{list.data.localDir}</b>{list.data.driveConfigured ? ' y se sube a Google Drive.' : '. Google Drive no está configurado (Configuración → Google Drive).'} Si la PC está apagada el lunes, se genera apenas se prenda.
          </div>
          {list.data.runs.length === 0 ? <div className="empty">Todavía no se hizo ningún respaldo.</div> : (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Semana</th><th>Cuándo</th><th>Tipo</th><th>Estado</th><th>Detalle</th></tr></thead>
              <tbody>{list.data.runs.map((r) => { const [k, l] = chip(r.status); return (
                <tr key={r.id}><td><b>{r.label}</b></td><td>{fmtDateTime(r.startedAt)}</td><td>{r.kind === 'weekly' ? 'Automático' : 'Manual'}</td><td><span className={`chip ${k}`}>{l}</span></td><td className="small">{r.message}</td></tr>
              ); })}</tbody>
            </table></div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ auditoría

const ACTIONS = {
  'sale.void': 'Anulación de venta', 'shift.open': 'Apertura de turno', 'shift.close': 'Cierre de turno', 'cash.movement': 'Movimiento de efectivo',
  'stock.restock': 'Ingreso de mercadería', 'stock.adjustment': 'Ajuste de stock', 'stock.waste': 'Merma', 'product.price': 'Cambio de precio',
  'product.create': 'Producto nuevo', 'product.update': 'Producto editado', 'promo.create': 'Promo nueva', 'promo.update': 'Promo editada',
  'user.create': 'Usuario creado', 'user.update': 'Usuario editado', 'user.reset_pin': 'Código regenerado', 'auth.locked': 'Usuario bloqueado por intentos',
  'timeclock.edit': 'Fichaje corregido', 'catalog.prices_confirmed': 'Precios confirmados', 'charge.pick': 'Pago elegido entre candidatos',
};

const DETAIL_LABELS = {
  amountCents: 'Monto', openingCashCents: 'Efectivo inicial', expectedCents: 'Esperado', countedCashCents: 'Contado', diffCents: 'Diferencia',
  totalCents: 'Total', priceCents: 'Precio', reason: 'Motivo', type: 'Tipo', qty: 'Cantidad', product: 'Producto', name: 'Nombre', number: 'Venta N°',
  fullName: 'Nombre', role: 'Rol', lines: 'Productos cargados', from: 'Antes', to: 'Ahora', active: 'Activo', paymentId: 'Pago',
};

/** Muestra el detalle de un evento de auditoría en castellano y con la plata formateada. */
function formatDetail(action, detail) {
  if (!detail) return '';
  const fmt = (k, v) => {
    if (k.endsWith('Cents') && typeof v === 'number') return money(v);
    if (action === 'product.price' && (k === 'from' || k === 'to')) return money(v);
    if (k === 'type') return v === 'in' ? 'ingreso' : v === 'out' ? 'retiro' : v;
    if (k === 'role') return v === 'admin' ? 'encargado' : 'cajero';
    if (typeof v === 'boolean') return v ? 'sí' : 'no';
    if (typeof v === 'number' && v > 1e12) return fmtDateTime(v);
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' && x > 1e12 ? fmtDateTime(x) : x ?? '—')).join(' → ');
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  };
  return Object.entries(detail)
    .filter(([k]) => k !== 'approvedBy')
    .map(([k, v]) => `${DETAIL_LABELS[k] || k}: ${fmt(k, v)}`)
    .join(' · ');
}

function Audit() {
  const ev = useData(() => api.get('/api/audit'), []);
  return (
    <div className="card stack">
      <h2>Registro de acciones</h2>
      <p className="muted small" style={{ margin: 0 }}>Quién hizo qué en las operaciones sensibles (últimas 200).</p>
      {!ev.data ? <Loading error={ev.error} /> : ev.data.events.length === 0 ? <div className="empty">Sin eventos.</div> : (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Fecha</th><th>Persona</th><th>Acción</th><th>Detalle</th></tr></thead>
          <tbody>{ev.data.events.map((e) => (
            <tr key={e.id}><td className="nowrap">{fmtDateTime(e.at)}</td><td>{e.user_name || 'Sistema'}</td><td>{ACTIONS[e.action] || e.action}</td><td className="small muted">{formatDetail(e.action, e.detail)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
