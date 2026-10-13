import { all, run } from '../db.js';

/** Registro de acciones sensibles (anulaciones, ajustes, cambios de usuarios...). */
export function audit(ctx, userId, action, entity = null, entityId = null, detail = null) {
  run(
    ctx.db,
    'INSERT INTO audit_log(at, user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)',
    ctx.now(),
    userId ?? null,
    action,
    entity,
    entityId == null ? null : String(entityId),
    detail == null ? null : JSON.stringify(detail),
  );
}

export function listAudit(ctx, { limit = 200 } = {}) {
  return all(
    ctx.db,
    `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.detail, u.full_name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`,
    limit,
  ).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
