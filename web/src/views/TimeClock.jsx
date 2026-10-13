import { useState } from 'react';
import { api } from '../api.js';
import { addDays, fmtDateTime, fmtDuration, fmtTime, todayYmd, weekStart } from '../format.js';
import { Field, Loading, Modal, PinPad, useApp, useData } from '../components/ui.jsx';

export default function TimeClock() {
  const { user } = useApp();
  const isAdmin = user.role === 'admin';
  const who = useData(() => api.get('/api/timeclock/who-is-in'), []);
  const [username, setUsername] = useState(user.fullName);
  const [pin, setPin] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const punch = async (action) => {
    setBusy(true); setResult(null);
    try { setResult({ ok: true, r: await api.post('/api/timeclock/punch', { username, pin, action }) }); who.reload(); }
    catch (e) { setResult({ ok: false, message: e.message }); }
    finally { setBusy(false); setPin(''); }
  };

  return (
    <div className="stack">
      <div className="page-head"><h1>Fichaje</h1></div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <h2>Fichar entrada o salida</h2>
          <Field label="Usuario">{(id) => <input id={id} className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />}</Field>
          <PinPad value={pin} onChange={setPin} onSubmit={() => {}} busy={busy} submitLabel="" />
          <div className="grid cols-2">
            <button className="btn big" disabled={busy || pin.length < 4} onClick={() => punch('in')}>Entrada</button>
            <button className="btn big dark" disabled={busy || pin.length < 4} onClick={() => punch('out')}>Salida</button>
          </div>
          {result?.ok && (
            <div className="notice green" role="status">
              {result.r.userName.split(' ')[0]}, {result.r.action === 'in' ? 'entrada' : 'salida'} registrada a las {fmtTime(result.r.at)}.
              {result.r.workedMs ? ` Trabajaste ${fmtDuration(result.r.workedMs)}.` : ''}
            </div>
          )}
          {result && !result.ok && <div className="notice red" role="alert">{result.message}</div>}
        </div>

        <div className="card stack">
          <h2>Ahora en el local</h2>
          {!who.data ? <Loading error={who.error} /> : who.data.entries.length === 0 ? <div className="empty">Nadie fichó entrada todavía.</div> : (
            <div className="paid-list">
              {who.data.entries.map((e) => (
                <div className="paid-item" key={e.id}>
                  <b>{e.userName}</b>
                  <span>{e.forgotten ? <span className="chip bad">Entrada vieja sin salida</span> : <span className="muted">desde las {fmtTime(e.since)}</span>}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {isAdmin && <AdminHours onChanged={who.reload} />}
    </div>
  );
}

const toLocalInput = (ms) => {
  if (ms == null) return '';
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);

function AdminHours({ onChanged }) {
  const { toast } = useApp();
  const [from, setFrom] = useState(weekStart(todayYmd()));
  const [to, setTo] = useState(addDays(weekStart(todayYmd()), 6));
  const data = useData(() => api.get(`/api/timeclock?from=${from}&to=${to}`), [from, to]);
  const [editing, setEditing] = useState(null);

  return (
    <div className="card stack">
      <div className="row between wrap">
        <h2>Horas trabajadas</h2>
        <div className="row wrap">
          <Field label="Desde">{(id) => <input id={id} type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Hasta">{(id) => <input id={id} type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
      </div>
      {!data.data ? <Loading error={data.error} /> : (
        <>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Persona</th><th className="num">Fichajes</th><th className="num">Horas</th><th className="num">Sin salida</th></tr></thead>
              <tbody>
                {data.data.hours.length === 0 && <tr><td colSpan={4} className="empty">Sin fichajes en el período.</td></tr>}
                {data.data.hours.map((h) => <tr key={h.userId}><td><b>{h.userName}</b></td><td className="num">{h.entries}</td><td className="num"><b>{h.hours.toFixed(2)}</b></td><td className={`num ${h.incomplete ? 'neg' : ''}`}>{h.incomplete}</td></tr>)}
              </tbody>
            </table>
          </div>
          <h3>Fichajes del período</h3>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Persona</th><th>Entrada</th><th>Salida</th><th /></tr></thead>
              <tbody>
                {data.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.userName}</td><td>{fmtDateTime(e.clockIn)}</td>
                    <td>{e.clockOut ? fmtDateTime(e.clockOut) : e.forgotten ? <span className="chip bad">Falta la salida</span> : <span className="chip ok">Adentro</span>}</td>
                    <td><button className="btn small ghost" onClick={() => setEditing(e)}>Corregir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && <EditEntry entry={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); data.reload(); onChanged?.(); toast('Fichaje corregido', 'ok'); }} />}
    </div>
  );
}

function EditEntry({ entry, onClose, onDone }) {
  const [cin, setCin] = useState(toLocalInput(entry.clockIn));
  const [cout, setCout] = useState(toLocalInput(entry.clockOut));
  const [error, setError] = useState('');
  const save = async () => {
    try { await api.patch(`/api/timeclock/${entry.id}`, { clockIn: fromLocalInput(cin), clockOut: fromLocalInput(cout) }); onDone(); }
    catch (e) { setError(e.message); }
  };
  return (
    <Modal title={`Corregir fichaje de ${entry.userName}`} onClose={onClose} size="narrow" footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn" onClick={save}>Guardar</button></>}>
      <div className="stack">
        <Field label="Entrada">{(id) => <input id={id} type="datetime-local" className="input" value={cin} onChange={(e) => setCin(e.target.value)} />}</Field>
        <Field label="Salida" hint="Dejala vacía si la persona todavía está trabajando.">{(id) => <input id={id} type="datetime-local" className="input" value={cout} onChange={(e) => setCout(e.target.value)} />}</Field>
        {error && <div className="notice red">{error}</div>}
      </div>
    </Modal>
  );
}
