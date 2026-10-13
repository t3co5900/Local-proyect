import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { setTimezone } from './format.js';
import { AppCtx, Loading, Toasts, useApp } from './components/ui.jsx';
import { go } from './nav.js';
import { Login, PublicClock, Setup } from './views/Auth.jsx';
import Admin from './views/Admin.jsx';
import Inventory from './views/Inventory.jsx';
import Pos from './views/Pos.jsx';
import Reports from './views/Reports.jsx';
import ShiftPage from './views/Shift.jsx';
import ShiftReport from './views/ShiftReport.jsx';
import TimeClock from './views/TimeClock.jsx';

function useHash() {
  const read = () => (window.location.hash.replace(/^#/, '') || '/');
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const on = () => setHash(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function NavLink({ to, current, children }) {
  const active = current === to || current.startsWith(`${to}/`);
  return <a href={`#${to}`} className={active ? 'active' : ''}>{children}</a>;
}

export default function App() {
  const [boot, setBoot] = useState(null); // { needsSetup, business }
  const [session, setSession] = useState(undefined); // undefined = cargando, null = sin sesión
  const [toasts, setToasts] = useState([]);
  const hash = useHash();

  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text, kind = '') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6500 : 3500);
  }, []);

  const applySession = useCallback((s) => {
    if (s?.settings?.timezone) setTimezone(s.settings.timezone);
    setSession(s);
  }, []);

  const refresh = useCallback(async () => {
    try { applySession(await api.get('/api/auth/me')); } catch { applySession(null); }
  }, [applySession]);

  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    (async () => {
      try { setBoot(await api.get('/api/bootstrap')); } catch (e) { setBoot({ error: e }); return; }
      await refresh();
    })();
  }, [refresh]);

  // mantiene al día el estado del turno (otro puesto pudo abrirlo/cerrarlo)
  useEffect(() => {
    if (!session) return undefined;
    const t = setInterval(refresh, 60000);
    return () => clearInterval(t);
  }, [session, refresh]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* da igual */ }
    try { sessionStorage.removeItem('mrcook.cart.v1'); } catch { /* sin storage */ }
    setSession(null);
    go('/');
  }, []);

  const value = useMemo(() => ({ session, refresh, toast, logout, user: session?.user, shift: session?.shift, settings: session?.settings }), [session, refresh, toast, logout]);

  let body;
  if (!boot || session === undefined) body = <div className="auth-wrap"><Loading error={boot?.error} /></div>;
  else if (boot.needsSetup) body = <Setup onDone={async () => setBoot(await api.get('/api/bootstrap'))} />;
  else if (!session) body = hash === '/fichar' ? <PublicClock /> : <Login business={boot.business} onLogin={(s) => { applySession(s); go(s.shift ? '/vender' : '/caja'); }} />;
  else body = <Shell hash={hash} />;

  return (
    <AppCtx.Provider value={value}>
      {body}
      <Toasts items={toasts} onDismiss={dismissToast} />
    </AppCtx.Provider>
  );
}

function Shell({ hash }) {
  const { user, shift, settings, logout } = useApp();
  const isAdmin = user.role === 'admin';
  const [rawPath, rawQuery] = hash.split('?');
  const path = rawPath === '/' ? '/vender' : rawPath;
  const query = new URLSearchParams(rawQuery || '');

  let view;
  if (path.startsWith('/vender')) view = <Pos />;
  else if (path.startsWith('/caja/turno/')) view = <ShiftReport id={Number(path.split('/')[3])} />;
  else if (path.startsWith('/caja')) view = <ShiftPage />;
  else if (path.startsWith('/inventario')) view = <Inventory />;
  else if (path.startsWith('/fichaje')) view = <TimeClock />;
  else if (path.startsWith('/reportes') && isAdmin) view = <Reports />;
  else if (path.startsWith('/admin') && isAdmin) view = <Admin tab={path.split('/')[2] || 'usuarios'} query={query} />;
  else view = <Pos />;

  return (
    <>
      <header className="topbar">
        <img className="logo" src="/logo-white.png" alt={settings.businessName} />
        <nav className="nav" aria-label="Secciones">
          <NavLink to="/vender" current={path}>Vender</NavLink>
          <NavLink to="/caja" current={path}>Caja</NavLink>
          <NavLink to="/inventario" current={path}>Inventario</NavLink>
          <NavLink to="/fichaje" current={path}>Fichaje</NavLink>
          {isAdmin && <NavLink to="/reportes" current={path}>Reportes</NavLink>}
          {isAdmin && <NavLink to="/admin" current={path}>Administración</NavLink>}
        </nav>
        <a className={`shift-pill ${shift ? 'open' : ''}`} href="#/caja">
          <span className="dot" />
          {shift ? `Turno abierto · ${shift.openedBy.split(' ')[0]}` : 'Sin turno abierto'}
        </a>
        <div className="userbox">
          <div className="who"><b>{user.fullName}</b><span>{isAdmin ? 'Encargado' : 'Cajero'}</span></div>
          <button className="btn small ghost" style={{ color: '#fff', borderColor: '#4a4a45' }} onClick={logout}>Salir</button>
        </div>
      </header>
      <main className="page">{view}</main>
    </>
  );
}

