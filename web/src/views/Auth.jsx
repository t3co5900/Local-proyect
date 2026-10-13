import { useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, fmtTime } from '../format.js';
import { Field, PinPad } from '../components/ui.jsx';

function AuthFrame({ title, children, footer }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <img className="auth-logo" src="/logo-white.png" alt="Mr.Cook" />
        <h1>{title}</h1>
        {children}
      </div>
      {footer && <div style={{ marginTop: 16 }}>{footer}</div>}
    </div>
  );
}

export function Login({ business, onLogin }) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim()) { setError('Escribí tu usuario (tu nombre y apellido).'); return; }
    setBusy(true);
    setError('');
    try {
      onLogin(await api.post('/api/auth/login', { username, pin }));
    } catch (e) {
      setError(e.message);
      setPin('');
    } finally { setBusy(false); }
  };

  return (
    <AuthFrame
      title={`Ingresá a ${business || 'Mr.Cook'}`}
      footer={<a href="#/fichar" className="btn ghost" style={{ color: '#fff', borderColor: '#4a4a45' }}>Fichar entrada / salida</a>}
    >
      <div className="stack">
        <Field label="Usuario" hint="Tu nombre y apellido, o la inicial y el apellido. Ej: Carlos Pérez o C Pérez">
          {(id) => (
            <input
              id={id}
              className="input"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          )}
        </Field>
        <div className="field"><span className="lbl">Código de 4 dígitos</span></div>
        <PinPad value={pin} onChange={setPin} onSubmit={submit} busy={busy} />
        {error && <div className="notice red" role="alert">{error}</div>}
      </div>
    </AuthFrame>
  );
}

export function PublicClock() {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const punch = async (action) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post('/api/timeclock/punch', { username, pin, action });
      setResult({ ok: true, r });
      setUsername('');
    } catch (e) {
      setResult({ ok: false, message: e.message });
    } finally { setBusy(false); setPin(''); }
  };

  return (
    <AuthFrame title="Fichaje" footer={<a href="#/" className="btn ghost" style={{ color: '#fff', borderColor: '#4a4a45' }}>← Volver al ingreso</a>}>
      <div className="stack">
        <Field label="Usuario">
          {(id) => (
            <input id={id} className="input" autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false}
              value={username} onChange={(e) => setUsername(e.target.value)} />
          )}
        </Field>
        <PinPad value={pin} onChange={setPin} onSubmit={() => {}} busy={busy} submitLabel="" />
        <div className="grid cols-2">
          <button className="btn big" disabled={busy || pin.length < 4 || !username.trim()} onClick={() => punch('in')}>Entrada</button>
          <button className="btn big dark" disabled={busy || pin.length < 4 || !username.trim()} onClick={() => punch('out')}>Salida</button>
        </div>
        {result?.ok && (
          <div className="notice green" role="status">
            {result.r.userName.split(' ')[0]}, {result.r.action === 'in' ? 'entrada' : 'salida'} registrada a las {fmtTime(result.r.at)}.
            {result.r.workedMs ? ` Trabajaste ${fmtDuration(result.r.workedMs)}.` : ''}
          </div>
        )}
        {result && !result.ok && <div className="notice red" role="alert">{result.message}</div>}
      </div>
    </AuthFrame>
  );
}

export function Setup({ onDone }) {
  const [fullName, setFullName] = useState('');
  const [withSample, setWithSample] = useState(true);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { setCreated(await api.post('/api/setup', { fullName, withSample })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (created) {
    return (
      <AuthFrame title="¡Listo! Anotá este código">
        <div className="stack">
          <p style={{ margin: 0 }}>
            Usuario: <b>{created.user.fullName}</b>. Este es tu código de 4 dígitos. <b>No se vuelve a mostrar</b>: anotalo en un lugar seguro.
          </p>
          <div className="big-pin">{created.pin}</div>
          {created.warnings?.map((w) => <div className="notice" key={w}>{w}</div>)}
          <button className="btn big" onClick={onDone}>Ir al ingreso</button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Bienvenido: primera configuración">
      <form className="stack" onSubmit={submit}>
        <p style={{ margin: 0 }} className="muted">
          Creá el usuario encargado (administrador). El sistema le asigna un código de 4 dígitos al azar.
        </p>
        <Field label="Nombre y apellido del encargado">
          {(id) => <input id={id} className="input" autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} />}
        </Field>
        <label className="switch">
          <input type="checkbox" checked={withSample} onChange={(e) => setWithSample(e.target.checked)} />
          Cargar productos y promos de ejemplo (después los editás)
        </label>
        {error && <div className="notice red">{error}</div>}
        <button className="btn big" disabled={busy || fullName.trim().length < 3}>Crear encargado</button>
      </form>
    </AuthFrame>
  );
}
