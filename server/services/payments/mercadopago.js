// Integración con Mercado Pago por "conciliación": la app consulta los pagos
// recientes de tu cuenta y, cuando aparece uno aprobado por el monto del cobro
// en curso, lo marca como cobrado. No necesita webhooks ni una URL pública
// (la PC del local no la tiene) y sirve tanto para el QR fijo del mostrador
// como para un posnet Mercado Pago Point, porque en ambos casos el pago cae
// en tu cuenta de Mercado Pago.
//
// IMPORTANTE: requiere internet. Sin conexión, el cobro queda pendiente y la
// persona de caja puede confirmarlo a mano (queda marcado como "manual").

const API = 'https://api.mercadopago.com';

/** Tipo de medio de pago de Mercado Pago -> método interno. */
export function mapPaymentType(typeId) {
  switch (typeId) {
    case 'debit_card':
    case 'prepaid_card':
      return 'debito';
    case 'credit_card':
      return 'credito';
    default:
      // account_money, bank_transfer, digital_currency, consumer_credits...
      return 'transferencia';
  }
}

export function normalizePayment(r) {
  const createdMs = Date.parse(r.date_created);
  const approvedMs = Date.parse(r.date_approved || r.date_created);
  const payer = r.payer || {};
  const payerLabel =
    [payer.first_name, payer.last_name].filter(Boolean).join(' ') || payer.email || null;
  return {
    id: String(r.id),
    status: r.status,
    amountCents: Math.round(Number(r.transaction_amount) * 100),
    typeId: r.payment_type_id || null,
    methodId: r.payment_method_id || null,
    createdMs: Number.isNaN(createdMs) ? null : createdMs,
    approvedMs: Number.isNaN(approvedMs) ? null : approvedMs,
    payerLabel,
    description: r.description || null,
  };
}

export function createMercadoPagoProvider({ accessToken, fetchImpl = fetch, timeoutMs = 8000 }) {
  async function call(path, params = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = new Error('Sin conexión con Mercado Pago.');
      err.code = 'offline';
      err.cause = e;
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error('Mercado Pago rechazó las credenciales (Access Token inválido o sin permisos).');
      err.code = 'auth';
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Mercado Pago respondió con error ${res.status}.`);
      err.code = 'http';
      throw err;
    }
    return res.json();
  }

  return {
    name: 'mercadopago',

    /** Pagos aprobados más recientes de la cuenta (el filtro fino se hace en la app). */
    async listRecentPayments({ limit = 50 } = {}) {
      const body = await call('/v1/payments/search', {
        sort: 'date_created',
        criteria: 'desc',
        status: 'approved',
        limit,
      });
      return (body.results || []).map(normalizePayment);
    },

    /** Para el botón "Probar conexión" de la pantalla de configuración. */
    async testConnection() {
      const me = await call('/users/me');
      await call('/v1/payments/search', { sort: 'date_created', criteria: 'desc', limit: 1 });
      return { id: me.id, nickname: me.nickname || null, email: me.email || null };
    },
  };
}
