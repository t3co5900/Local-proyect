// Fechas: en la base se guarda epoch en milisegundos (UTC). Los límites de
// "día" y "semana" se calculan en la zona horaria del negocio, no en la de
// la PC, para que los reportes no cambien si Windows tiene otra zona.

const partsCache = new Map();

function formatter(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** Componentes de fecha/hora locales de `ms` en la zona `tz`. */
export function localParts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday, // Mon..Sun
  };
}

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante `ms`. */
export function tzOffsetMs(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch UTC (ms) de la medianoche local del día que contiene `ms`. */
export function startOfDay(ms, tz) {
  const p = localParts(ms, tz);
  const wallMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  let guess = wallMidnightAsUtc - tzOffsetMs(ms, tz);
  // segunda pasada por si hay cambio de horario entre `ms` y la medianoche
  guess = wallMidnightAsUtc - tzOffsetMs(guess, tz);
  return guess;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Medianoche local del día siguiente (robusto ante DST). */
export function startOfNextDay(ms, tz) {
  return startOfDay(startOfDay(ms, tz) + DAY_MS + 3 * 60 * 60 * 1000, tz);
}

const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Lunes 00:00 local de la semana que contiene `ms`. */
export function startOfWeek(ms, tz) {
  const dayStart = startOfDay(ms, tz);
  const idx = WEEKDAY_INDEX[localParts(dayStart + 12 * 60 * 60 * 1000, tz).weekday];
  let t = dayStart;
  for (let i = 0; i < idx; i++) t = startOfDay(t - 12 * 60 * 60 * 1000, tz);
  return t;
}

/** Lunes 00:00 de la semana siguiente (fin exclusivo de la semana). */
export function endOfWeek(weekStartMs, tz) {
  let t = weekStartMs;
  for (let i = 0; i < 7; i++) t = startOfNextDay(t, tz);
  return t;
}

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD local. */
export function ymd(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** dd/MM/yyyy HH:mm local. */
export function formatDateTime(ms, tz) {
  if (ms == null) return '';
  const p = localParts(ms, tz);
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatDate(ms, tz) {
  if (ms == null) return '';
  const p = localParts(ms, tz);
  return `${pad(p.day)}/${pad(p.month)}/${p.year}`;
}

export function formatTime(ms, tz) {
  if (ms == null) return '';
  const p = localParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Interpreta 'YYYY-MM-DD' como medianoche local en `tz`. */
export function parseYmd(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

/** Semana ISO "2026-W41" del lunes dado (para nombrar archivos). */
export function isoWeekLabel(weekStartMs, tz) {
  const p = localParts(weekStartMs + 12 * 60 * 60 * 1000, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((d - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}
