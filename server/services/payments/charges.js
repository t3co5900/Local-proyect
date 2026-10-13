import { all, get, run } from '../../db.js';
import { badRequest, conflict, notFound } from '../../util/errors.js';
import { audit } from '../audit.js';
import { requireOpenShift } from '../common.js';
import { getSetting } from '../settings.js';
import { createMercadoPagoProvider, mapPaymentType } from './mercadopago.js';

const MIN_RECHECK_MS = 2500;
const STALE_MS = 30 * 60 * 1000;

/** Proveedor de cobros activo, o null si Mercado Pago no está configurado. */
export function getProvider(ctx) {
  if (ctx.paymentProvider) return ctx.paymentProvider; // inyectado en tests
  const token = getSetting(ctx, 'mp.accessToken');
  if (!getSetting(ctx, 'mp.enabled') || !token) return null;
  if (!ctx._mp || ctx._mp.token !== token) {
    ctx._mp = { token, provider: createMercadoPagoProvider({ accessToken: token, fetchImpl: ctx.fetch }) };
  }
  return ctx._mp.provider;
}

function view(c) {
  const info = c.mp_info ? JSON.parse(c.mp_info) : null;
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    amountCents: c.amount_cents,
    createdAt: c.created_at,
    confirmedAt: c.confirmed_at,
    resolvedMethod: c.resolved_method,
    mpPaymentId: c.mp_payment_id,
    matched: info?.matched ?? null,
    candidates: c.status === 'pending' ? info?.candidates ?? [] : [],
    lastError: c.last_error,
    lastCheckedAt: c.last_checked_at,
    used: c.sale_id != null,
  };
}

export function getCharge(ctx, id) {
  const c = get(ctx.db, 'SELECT * FROM payment_charges WHERE id = ?', id);
  if (!c) throw notFound('Cobro no encontrado.');
  return c;
}

export function createCharge(ctx, user, { kind, amountCents }) {
  if (!['qr', 'tarjeta'].includes(kind)) throw badRequest('Tipo de cobro inválido.');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw badRequest('Monto inválido.');
  const provider = getProvider(ctx);
  if (!provider) throw conflict('Mercado Pago no está configurado: confirmá el cobro manualmente.', 'mp_disabled');
  const shift = requireOpenShift(ctx);
  // limpia cobros que quedaron colgados
  run(ctx.db, `UPDATE payment_charges SET status='cancelled' WHERE status='pending' AND created_at < ?`, ctx.now() - STALE_MS);
  const info = run(
    ctx.db,
    `INSERT INTO payment_charges(shift_id, user_id, kind, amount_cents, status, provider, created_at)
     VALUES (?,?,?,?,'pending',?,?)`,
    shift.id,
    user.id,
    kind,
    amountCents,
    provider.name,
    ctx.now(),
  );
  return view(getCharge(ctx, Number(info.lastInsertRowid)));
}

function claimedPaymentIds(ctx) {
  const ids = new Set();
  for (const r of all(ctx.db, `SELECT mp_payment_id FROM payment_charges WHERE mp_payment_id IS NOT NULL AND status <> 'cancelled'`)) ids.add(r.mp_payment_id);
  for (const r of all(ctx.db, `SELECT mp_payment_id FROM sale_payments WHERE mp_payment_id IS NOT NULL`)) ids.add(r.mp_payment_id);
  return ids;
}

function confirm(ctx, c, payment, candidatesSeen = []) {
  const resolved = c.kind === 'qr' ? 'transferencia' : mapPaymentType(payment.typeId);
  const info = {
    matched: {
      paymentId: payment.id,
      typeId: payment.typeId,
      methodId: payment.methodId,
      payer: payment.payerLabel,
      approvedAt: payment.approvedMs,
    },
    candidates: candidatesSeen,
  };
  run(
    ctx.db,
    `UPDATE payment_charges SET status='confirmed', confirmed_at=?, mp_payment_id=?, resolved_method=?, mp_info=?, last_error=NULL
      WHERE id=? AND status='pending'`,
    ctx.now(),
    payment.id,
    resolved,
    JSON.stringify(info),
    c.id,
  );
}

/**
 * Consulta a Mercado Pago (como mucho cada ~2,5 s) y confirma el cobro si
 * aparece exactamente un pago aprobado por ese monto. Si hay varios
 * candidatos no adivina: los muestra para que la persona elija.
 */
export async function refreshCharge(ctx, id) {
  let c = getCharge(ctx, id);
  if (c.status !== 'pending') return view(c);
  const provider = getProvider(ctx);
  if (!provider) return view(c);
  const now = ctx.now();
  if (c.last_checked_at && now - c.last_checked_at < MIN_RECHECK_MS) return view(c);
  run(ctx.db, 'UPDATE payment_charges SET last_checked_at = ? WHERE id = ?', now, id);
  try {
    const payments = await provider.listRecentPayments();
    // otro request pudo confirmarlo/cancelarlo mientras esperábamos a Mercado Pago
    c = getCharge(ctx, id);
    if (c.status !== 'pending') return view(c);
    const lookbackMs = Number(getSetting(ctx, 'mp.lookbackSeconds')) * 1000;
    const cutoff = c.created_at - lookbackMs;
    const claimed = claimedPaymentIds(ctx);
    const candidates = payments.filter(
      (p) =>
        p.status === 'approved' &&
        p.amountCents === c.amount_cents &&
        (p.approvedMs ?? p.createdMs ?? 0) >= cutoff &&
        !claimed.has(p.id),
    );
    if (candidates.length === 1) {
      confirm(ctx, c, candidates[0]);
    } else {
      run(
        ctx.db,
        'UPDATE payment_charges SET mp_info = ?, last_error = NULL WHERE id = ?',
        JSON.stringify({
          candidates: candidates.map((p) => ({ paymentId: p.id, payer: p.payerLabel, approvedAt: p.approvedMs, typeId: p.typeId })),
        }),
        id,
      );
    }
  } catch (e) {
    run(ctx.db, 'UPDATE payment_charges SET last_error = ? WHERE id = ?', e.message, id);
  }
  return view(getCharge(ctx, id));
}

/** La persona de caja elige entre varios pagos candidatos. */
export function pickCandidate(ctx, user, id, paymentId) {
  const c = getCharge(ctx, id);
  if (c.status !== 'pending') throw conflict('Ese cobro ya no está pendiente.');
  const info = c.mp_info ? JSON.parse(c.mp_info) : null;
  const cand = info?.candidates?.find((x) => x.paymentId === String(paymentId));
  if (!cand) throw badRequest('Ese pago no está entre los candidatos.');
  confirm(
    ctx,
    c,
    { id: cand.paymentId, typeId: cand.typeId, methodId: null, payerLabel: cand.payer, approvedMs: cand.approvedAt },
    info.candidates,
  );
  audit(ctx, user.id, 'charge.pick', 'charge', id, { paymentId });
  return view(getCharge(ctx, id));
}

export function cancelCharge(ctx, id) {
  const c = getCharge(ctx, id);
  if (c.status === 'pending') run(ctx.db, `UPDATE payment_charges SET status='cancelled' WHERE id = ?`, id);
  return view(getCharge(ctx, id));
}

export const chargeView = (ctx, id) => view(getCharge(ctx, id));

/** Valida que un cobro confirmado pueda usarse como pago de una venta. */
export function verifyChargeForSale(ctx, chargeId, { shiftId, amountCents, method }) {
  const c = get(ctx.db, 'SELECT * FROM payment_charges WHERE id = ?', chargeId);
  if (!c) throw badRequest('El cobro de Mercado Pago no existe.');
  if (c.status !== 'confirmed') throw conflict('El cobro todavía no fue confirmado.', 'charge_not_confirmed');
  if (c.sale_id != null) throw conflict('Ese cobro ya se usó en otra venta.', 'charge_used');
  if (c.shift_id !== shiftId) throw conflict('Ese cobro es de otro turno.', 'charge_other_shift');
  if (c.amount_cents !== amountCents) throw conflict('El monto del cobro no coincide con el de la venta.', 'charge_amount');
  const okMethod = c.kind === 'qr' ? method === 'transferencia' : ['debito', 'credito'].includes(method);
  if (!okMethod) throw conflict('El medio de pago no coincide con el cobro.', 'charge_method');
  return c;
}

export function markChargeUsed(ctx, chargeId, saleId) {
  run(ctx.db, 'UPDATE payment_charges SET sale_id = ? WHERE id = ?', saleId, chargeId);
}
