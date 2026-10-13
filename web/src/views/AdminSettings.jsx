import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Loading, useApp, useData } from '../components/ui.jsx';

export function Settings({ query }) {
  const { refresh, toast } = useApp();
  const s = useData(() => api.get('/api/settings'), []);

  // vuelta desde Google (el servidor redirige a #/admin/config?drive=ok|error)
  useEffect(() => {
    const drive = query?.get('drive');
    if (!drive) return;
    if (drive === 'ok') toast('Google Drive conectado', 'ok'); else toast(query.get('msg') || 'No se pudo conectar Google Drive', 'error');
    window.history.replaceState(null, '', '#/admin/config');
    s.reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s.data) return <Loading error={s.error} />;
  const reloadAll = () => { s.reload(); refresh(); };

  return (
    <div className="stack">
      <General data={s.data} onSaved={reloadAll} />
      <MercadoPago data={s.data} onSaved={reloadAll} />
      <Backup data={s.data} onSaved={reloadAll} />
    </div>
  );
}

async function save(values, clearSecrets = []) {
  return api.put('/api/settings', { values, clearSecrets });
}

function General({ data, onSaved }) {
  const { toast } = useApp();
  const [name, setName] = useState(data.values['business.name']);
  const [block, setBlock] = useState(!!data.values['stock.blockOnNoStock']);
  return (
    <div className="card stack">
      <h2>General</h2>
      <Field label="Nombre del local">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <label className="switch"><input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} /> Bloquear la venta de productos sin stock</label>
      <div className="muted small">Si está apagado (recomendado al principio), se puede vender igual y el stock queda en negativo, marcado en rojo para revisarlo. Útil si el stock cargado no siempre coincide con la realidad.</div>
      <div><button className="btn" onClick={async () => { await save({ 'business.name': name.trim() || 'Mr.Cook', 'stock.blockOnNoStock': block }); toast('Guardado', 'ok'); onSaved(); }}>Guardar</button></div>
    </div>
  );
}

function MercadoPago({ data, onSaved }) {
  const { toast } = useApp();
  const [enabled, setEnabled] = useState(!!data.values['mp.enabled']);
  const [token, setToken] = useState('');
  const [lookback, setLookback] = useState(String(data.values['mp.lookbackSeconds']));
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const hasToken = data.secretsSet['mp.accessToken'];

  const doSave = async () => {
    await save({ 'mp.enabled': enabled, ...(token ? { 'mp.accessToken': token } : {}), 'mp.lookbackSeconds': Number(lookback) || 180 });
    setToken('');
    toast('Mercado Pago guardado', 'ok');
    onSaved();
  };
  const doTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await api.post('/api/settings/test-mp', token ? { accessToken: token } : {})); }
    catch (e) { setTest({ ok: false, message: e.message }); } finally { setBusy(false); }
  };

  return (
    <div className="card stack">
      <h2>Mercado Pago (cobros automáticos)</h2>
      <div className="notice">
        Con esto activado, al cobrar por <b>QR/transferencia</b> o <b>tarjeta</b> la venta espera el pago y <b>se confirma sola</b> cuando Mercado Pago lo acredita en tu cuenta (funciona con el QR del mostrador y con un posnet Mercado Pago Point).
        Necesita internet: si se corta, la persona de caja puede confirmar a mano y queda marcado en el cierre. Un posnet de otro banco no se integra.
      </div>
      <label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Confirmar cobros automáticamente con Mercado Pago</label>
      <Field label="Access Token (producción)" hint={hasToken ? 'Ya hay uno guardado. Pegá uno nuevo solo si querés reemplazarlo.' : 'Mercado Pago → Tus integraciones → tu aplicación → Credenciales de producción.'}>
        {(id) => <input id={id} className="input" type="password" autoComplete="off" placeholder={hasToken ? '•••••••••• (guardado)' : 'APP_USR-…'} value={token} onChange={(e) => setToken(e.target.value)} />}
      </Field>
      <Field label="Tolerancia hacia atrás (segundos)" hint="Si el cliente pagó unos segundos antes de que se inicie el cobro en la pantalla, se lo toma igual. Por defecto 180.">
        {(id) => <input id={id} className="input" inputMode="numeric" style={{ maxWidth: 160 }} value={lookback} onChange={(e) => setLookback(e.target.value.replace(/\D/g, ''))} />}
      </Field>
      {test && (test.ok
        ? <div className="notice green">Conexión correcta{test.account?.nickname ? ` · cuenta ${test.account.nickname}` : ''}{test.account?.email ? ` (${test.account.email})` : ''}.</div>
        : <div className="notice red">{test.message}</div>)}
      <div className="row wrap">
        <button className="btn" onClick={doSave}>Guardar</button>
        <button className="btn ghost" disabled={busy || (!hasToken && !token)} onClick={doTest}>{busy ? 'Probando…' : 'Probar conexión'}</button>
        {hasToken && <button className="btn ghost" onClick={async () => { await save({}, ['mp.accessToken']); await save({ 'mp.enabled': false }); toast('Token borrado', 'ok'); onSaved(); }}>Borrar token</button>}
      </div>
    </div>
  );
}

function Backup({ data, onSaved }) {
  const { toast } = useApp();
  const [dir, setDir] = useState(data.values['backup.localDir']);
  const [keep, setKeep] = useState(String(data.values['backup.keep']));
  const [cid, setCid] = useState(data.values['backup.drive.clientId']);
  const [secret, setSecret] = useState('');
  const connected = data.driveConnected;
  const hasSecret = data.secretsSet['backup.drive.clientSecret'];

  const saveAll = async () => {
    await save({ 'backup.localDir': dir.trim(), 'backup.keep': Number(keep) || 12, 'backup.drive.clientId': cid.trim(), ...(secret ? { 'backup.drive.clientSecret': secret } : {}) });
    setSecret('');
    toast('Guardado', 'ok');
    onSaved();
  };
  const connect = async () => {
    try {
      await saveAll();
      const r = await api.post('/api/drive/connect');
      window.location.href = r.url;
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="card stack">
      <h2>Respaldos y Google Drive</h2>
      <Field label="Carpeta de respaldos en esta PC" hint="Si instalás “Google Drive para ordenador” en esta PC, elegí una carpeta dentro de “Mi unidad”: el respaldo sube solo a tu Drive, sin configurar nada más.">
        {(id) => <input id={id} className="input" value={dir} onChange={(e) => setDir(e.target.value)} />}
      </Field>
      <Field label="Semanas de respaldo a conservar en la PC">{(id) => <input id={id} className="input" style={{ maxWidth: 140 }} inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value.replace(/\D/g, ''))} />}</Field>

      <h3 style={{ marginTop: 8 }}>Subida directa a Google Drive (opcional)</h3>
      <div className="notice">
        Sube el Excel semanal y la copia de la base a una carpeta <b>“Mr.Cook Backups”</b> que la app crea en tu Drive. Hay que crear una vez credenciales de Google (ver <b>docs/GOOGLE-DRIVE.md</b>). Si la subida falla, el respaldo local se guarda igual.
      </div>
      <div className="grid cols-2">
        <Field label="Client ID">{(id) => <input id={id} className="input" autoComplete="off" value={cid} onChange={(e) => setCid(e.target.value)} />}</Field>
        <Field label="Client Secret" hint={hasSecret ? 'Ya hay uno guardado.' : undefined}>{(id) => <input id={id} className="input" type="password" autoComplete="off" placeholder={hasSecret ? '•••••••• (guardado)' : ''} value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
      </div>
      {connected && <div className="notice green">Google Drive conectado.</div>}
      <div className="row wrap">
        <button className="btn" onClick={saveAll}>Guardar</button>
        <button className="btn dark" disabled={!cid.trim() || (!hasSecret && !secret)} onClick={connect}>{connected ? 'Volver a conectar Google Drive' : 'Conectar Google Drive'}</button>
        {connected && <button className="btn ghost" onClick={async () => { await api.post('/api/drive/disconnect'); toast('Google Drive desconectado', 'ok'); onSaved(); }}>Desconectar</button>}
      </div>
    </div>
  );
}
