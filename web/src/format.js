// Dinero en centavos (enteros), igual que en el servidor.

const moneyFmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const moneyFmt2 = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('es-AR');

export const money = (cents) => moneyFmt.format((cents ?? 0) / 100);
export const money2 = (cents) => moneyFmt2.format((cents ?? 0) / 100);
export const int = (n) => intFmt.format(n ?? 0);

/**
 * Interpreta lo que escribe una persona: "1.500", "1500,50", "$ 2.200".
 * En Argentina el punto separa miles y la coma los decimales.
 * Devuelve centavos o null si no es un número válido.
 */
export function parseMoney(text) {
  if (text == null) return null;
  let s = String(text).replace(/[$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // 1.500 / 12.000.000
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Centavos -> texto editable ("1500" o "1500,5"). */
export const moneyToInput = (cents) => {
  if (cents == null) return '';
  const v = cents / 100;
  return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
};

export const METHODS = {
  efectivo: { label: 'Efectivo', short: 'Efectivo', cls: 'm-efectivo' },
  transferencia: { label: 'Transferencia / QR', short: 'Transferencia', cls: 'm-transferencia' },
  debito: { label: 'Débito', short: 'Débito', cls: 'm-debito' },
  credito: { label: 'Crédito', short: 'Crédito', cls: 'm-credito' },
};
export const METHOD_ORDER = ['efectivo', 'transferencia', 'debito', 'credito'];

let TZ = 'America/Argentina/Buenos_Aires';
export const setTimezone = (tz) => { if (tz) TZ = tz; };

const dtf = (opts) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, ...opts });
export const fmtTime = (ms) => (ms == null ? '' : dtf({ hour: '2-digit', minute: '2-digit', hour12: false }).format(ms));
export const fmtDate = (ms) => (ms == null ? '' : dtf({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms));
export const fmtDateTime = (ms) => (ms == null ? '' : `${fmtDate(ms)} ${fmtTime(ms)}`);
export const fmtDay = (ms) => (ms == null ? '' : dtf({ weekday: 'long', day: 'numeric', month: 'long' }).format(ms));

/** YYYY-MM-DD de "hoy" en la zona del negocio. */
export const todayYmd = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Lunes de la semana que contiene `ymd`. */
export function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(ymd, -dow);
}

export const fmtDuration = (ms) => {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h} h ${String(m).padStart(2, '0')} min`;
};

/** "1 cobro" / "2 cobros". */
export const plural = (n, one, many) => `${intFmt.format(n ?? 0)} ${n === 1 ? one : many}`;
