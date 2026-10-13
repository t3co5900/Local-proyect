// Todo el dinero se guarda y se calcula en CENTAVOS (enteros) para evitar
// errores de redondeo de punto flotante. Solo se formatea al mostrar.

export const toCents = (pesos) => Math.round(Number(pesos) * 100);

export const centsToPesos = (cents) => Math.round(cents) / 100;

const fmt = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatMoney = (cents) => fmt.format(centsToPesos(cents));
