/**
 * Contexto que se pasa a todos los servicios. Reúne lo que cambia entre
 * producción y tests: base de datos, reloj y `fetch` (para Mercado Pago/Drive).
 */
export function createContext({ config, db, now = () => Date.now(), fetch = globalThis.fetch }) {
  return { config, db, now, fetch, timezone: config.timezone };
}
