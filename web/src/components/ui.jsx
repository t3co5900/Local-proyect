import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { METHODS, moneyToInput, parseMoney } from '../format.js';

// ---------- contexto de la app (sesión, avisos) ----------

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// ---------- hook de datos ----------

/** Carga datos de la API; `reload()` los vuelve a pedir. */
export function useData(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const data = await loader();
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

// ---------- piezas básicas ----------

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Cargando" />;
}

export function Loading({ error }) {
  if (error) return <div className="notice red">{error.message}</div>;
  return <div className="empty"><Spinner /></div>;
}

export function MethodChip({ method, manual = false }) {
  const m = METHODS[method];
  return (
    <span className={`chip ${m?.cls || 'neutral'}`} title={manual ? 'Confirmado a mano' : undefined}>
      {m?.short || method}
      {manual && <span aria-label="a mano">✋</span>}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, size = '', dismissable = true }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dismissable]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissable) onClose?.(); }}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {dismissable && <button type="button" onClick={onClose} aria-label="Cerrar">×</button>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, error }) {
  const id = useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      {typeof children === 'function' ? children(id) : children}
      {error ? <span className="hint" style={{ color: 'var(--red)' }}>{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Campo de plata: la persona escribe pesos; el valor sale en centavos. */
export function MoneyInput({ value, onChange, autoFocus, placeholder = '0', id, onEnter, disabled }) {
  const [text, setText] = useState(value == null ? '' : moneyToInput(value));
  const last = useRef(value);
  useEffect(() => {
    // si el padre cambia el valor desde afuera (ej: botón "Justo"), se refleja
    if (value !== last.current && value !== parseMoney(text)) setText(value == null ? '' : moneyToInput(value));
    last.current = value;
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      id={id}
      className="input money"
      inputMode="decimal"
      autoFocus={autoFocus}
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.,$\s]/g, '');
        setText(t);
        const c = parseMoney(t);
        last.current = c;
        onChange(t.trim() === '' ? null : c);
      }}
    />
  );
}

/** Teclado numérico para el código de 4 dígitos (también acepta el teclado físico). */
const isTyping = (el) => el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !['button', 'checkbox'].includes(el.type));

export function PinPad({ value, onChange, onSubmit, busy, submitLabel = '✓' }) {
  const press = (d) => { if (value.length < 4) onChange(value + d); };
  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e.target)) return; // si está escribiendo en un campo, los dígitos no van al PIN
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter' && value.length === 4 && !busy) onSubmit?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div>
      <div className="pin-dots" aria-label={`${value.length} de 4 dígitos`}>
        {[0, 1, 2, 3].map((i) => <i key={i} className={i < value.length ? 'on' : ''} />)}
      </div>
      <div className="pinpad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => <button type="button" key={d} onClick={() => press(String(d))}>{d}</button>)}
        <button type="button" onClick={() => onChange(value.slice(0, -1))} aria-label="Borrar">⌫</button>
        <button type="button" onClick={() => press('0')}>0</button>
        {submitLabel
          ? <button type="button" className="go" disabled={value.length < 4 || busy} onClick={onSubmit}>{busy ? '…' : submitLabel}</button>
          : <span aria-hidden="true" />}
      </div>
    </div>
  );
}

/** Pide confirmación antes de una acción delicada. */
export function ConfirmModal({ title, message, confirmLabel = 'Confirmar', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="narrow"
      footer={(
        <>
          <button className="btn ghost" onClick={onClose}>Cancelar</button>
          <button
            className={`btn ${danger ? 'danger' : ''}`}
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
          >{confirmLabel}</button>
        </>
      )}
    >
      <p style={{ margin: 0 }}>{message}</p>
    </Modal>
  );
}

export function Toasts({ items, onDismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ''}`} onClick={() => onDismiss?.(t.id)} title="Tocá para cerrar" style={{ cursor: 'pointer' }}>{t.text}</div>
      ))}
    </div>
  );
}
