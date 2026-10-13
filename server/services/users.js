import crypto from 'node:crypto';
import { all, get, run, tx } from '../db.js';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../util/errors.js';
import { audit } from './audit.js';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
const SCRYPT = { N: 4096, r: 8, p: 1 };

// ---------- PIN ----------

/** PIN de 4 dígitos al azar, sin secuencias ni repeticiones triviales. */
export function generatePin() {
  for (;;) {
    const s = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (/^(\d)\1{3}$/.test(s)) continue; // 0000, 1111...
    if ('0123456789'.includes(s) || '9876543210'.includes(s)) continue; // 1234, 4321...
    return s;
  }
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32, SCRYPT).toString('hex');
}

function newPinRecord(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { pin_salt: salt, pin_hash: hashPin(pin, salt) };
}

function pinMatches(user, pin) {
  const a = Buffer.from(hashPin(String(pin), user.pin_salt), 'hex');
  const b = Buffer.from(user.pin_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- nombre de usuario ----------

/** "T. Corvalán" -> "tcorvalan": sin tildes, mayúsculas, espacios ni signos. */
export function normalizeKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Formas válidas de escribir el usuario: nombre completo, "inicial + apellido",
 * "nombre + apellido" (si tiene segundo nombre) y un alias opcional.
 */
export function loginKeysFor(fullName, alias) {
  const tokens = String(fullName).trim().split(/\s+/).filter(Boolean);
  const derived = new Set([normalizeKey(fullName)]);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    derived.add(normalizeKey(tokens[0][0] + last));
    derived.add(normalizeKey(tokens[0] + last));
  }
  derived.delete('');
  const aliasKey = alias ? normalizeKey(alias) : '';
  return { derived: [...derived], aliasKey: aliasKey || null };
}

function publicUser(u) {
  return {
    id: u.id,
    fullName: u.full_name,
    loginAlias: u.login_alias,
    role: u.role,
    active: !!u.active,
    lockedUntil: u.locked_until && u.locked_until > Date.now() ? u.locked_until : null,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}
export { publicUser };

function assignKeys(ctx, userId, fullName, alias) {
  const { derived, aliasKey } = loginKeysFor(fullName, alias);
  run(ctx.db, 'DELETE FROM user_login_keys WHERE user_id = ?', userId);
  const warnings = [];
  const taken = (key) => get(ctx.db, 'SELECT user_id FROM user_login_keys WHERE login_key = ?', key);
  const [primary, ...others] = derived;
  if (taken(primary)) throw conflict('Ya existe un usuario con ese nombre.', 'duplicate_user');
  run(ctx.db, 'INSERT INTO user_login_keys(login_key, user_id) VALUES (?,?)', primary, userId);
  for (const key of others) {
    if (taken(key)) {
      warnings.push(`"${key}" ya lo usa otra persona; esta persona debe ingresar con su nombre completo o con un alias.`);
      continue;
    }
    run(ctx.db, 'INSERT INTO user_login_keys(login_key, user_id) VALUES (?,?)', key, userId);
  }
  if (aliasKey) {
    if (taken(aliasKey) && !derived.includes(aliasKey)) {
      throw conflict('Ese alias ya lo usa otra persona.', 'duplicate_alias');
    }
    if (!derived.includes(aliasKey)) {
      run(ctx.db, 'INSERT INTO user_login_keys(login_key, user_id) VALUES (?,?)', aliasKey, userId);
    }
  }
  return warnings;
}

// ---------- CRUD ----------

export function countUsers(ctx) {
  return get(ctx.db, 'SELECT COUNT(*) AS n FROM users').n;
}

export function listUsers(ctx) {
  return all(ctx.db, 'SELECT * FROM users ORDER BY active DESC, full_name COLLATE NOCASE').map(publicUser);
}

export function getUser(ctx, id) {
  const u = get(ctx.db, 'SELECT * FROM users WHERE id = ?', id);
  return u || null;
}

export function createUser(ctx, actorId, { fullName, role = 'cajero', alias = null }) {
  fullName = String(fullName ?? '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 3) throw badRequest('Escribí el nombre completo (nombre y apellido).');
  if (!['admin', 'cajero'].includes(role)) throw badRequest('Rol inválido.');
  return tx(ctx.db, () => {
    const pin = generatePin();
    const rec = newPinRecord(pin);
    const info = run(
      ctx.db,
      `INSERT INTO users(full_name, login_alias, role, pin_hash, pin_salt, created_at)
       VALUES (?,?,?,?,?,?)`,
      fullName,
      alias?.trim() || null,
      role,
      rec.pin_hash,
      rec.pin_salt,
      ctx.now(),
    );
    const id = Number(info.lastInsertRowid);
    const warnings = assignKeys(ctx, id, fullName, alias);
    audit(ctx, actorId, 'user.create', 'user', id, { fullName, role });
    return { user: publicUser(getUser(ctx, id)), pin, warnings };
  });
}

function activeAdminCount(ctx, excludingId = null) {
  return get(
    ctx.db,
    `SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id <> ?`,
    excludingId ?? -1,
  ).n;
}

export function updateUser(ctx, actorId, id, patch) {
  const u = getUser(ctx, id);
  if (!u) throw notFound('Usuario no encontrado.');
  return tx(ctx.db, () => {
    const fullName = patch.fullName != null ? String(patch.fullName).trim().replace(/\s+/g, ' ') : u.full_name;
    if (fullName.length < 3) throw badRequest('Escribí el nombre completo (nombre y apellido).');
    const role = patch.role ?? u.role;
    const active = patch.active != null ? (patch.active ? 1 : 0) : u.active;
    const alias = patch.alias !== undefined ? patch.alias?.trim() || null : u.login_alias;
    if (!['admin', 'cajero'].includes(role)) throw badRequest('Rol inválido.');
    if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && activeAdminCount(ctx, id) === 0) {
      throw conflict('Tiene que quedar al menos un administrador activo.', 'last_admin');
    }
    if (actorId === id && !active) throw conflict('No podés desactivar tu propio usuario.', 'self_deactivate');
    run(ctx.db, 'UPDATE users SET full_name=?, role=?, active=?, login_alias=? WHERE id=?', fullName, role, active, alias, id);
    const warnings = assignKeys(ctx, id, fullName, alias);
    if (!active) run(ctx.db, 'DELETE FROM sessions WHERE user_id = ?', id);
    audit(ctx, actorId, 'user.update', 'user', id, { fullName, role, active: !!active });
    return { user: publicUser(getUser(ctx, id)), warnings };
  });
}

export function resetPin(ctx, actorId, id) {
  const u = getUser(ctx, id);
  if (!u) throw notFound('Usuario no encontrado.');
  const pin = generatePin();
  const rec = newPinRecord(pin);
  run(
    ctx.db,
    'UPDATE users SET pin_hash=?, pin_salt=?, failed_attempts=0, locked_until=NULL WHERE id=?',
    rec.pin_hash,
    rec.pin_salt,
    id,
  );
  run(ctx.db, 'DELETE FROM sessions WHERE user_id = ?', id);
  audit(ctx, actorId, 'user.reset_pin', 'user', id);
  return { pin };
}

// ---------- credenciales y bloqueo ----------

const GENERIC = 'Usuario o código incorrecto.';

/**
 * Valida usuario + PIN aplicando el bloqueo por intentos fallidos.
 * Lo usan el login, el fichaje y la autorización de un encargado.
 */
export function verifyCredentials(ctx, { username, pin }) {
  const key = normalizeKey(username);
  if (!key || !/^\d{4}$/.test(String(pin ?? ''))) throw unauthorized(GENERIC, 'bad_credentials');
  const user = get(
    ctx.db,
    `SELECT u.* FROM user_login_keys k JOIN users u ON u.id = k.user_id WHERE k.login_key = ?`,
    key,
  );
  if (!user || !user.active) {
    // gasta el mismo tiempo que un intento real para no revelar si el usuario existe
    hashPin(String(pin), 'x'.repeat(32));
    throw unauthorized(GENERIC, 'bad_credentials');
  }
  const now = ctx.now();
  if (user.locked_until && user.locked_until > now) {
    const mins = Math.ceil((user.locked_until - now) / 60000);
    throw new HttpError(429, `Usuario bloqueado por demasiados intentos. Probá de nuevo en ${mins} min o pedile un código nuevo al encargado.`, 'locked');
  }
  if (!pinMatches(user, pin)) {
    const attempts = user.failed_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      run(ctx.db, 'UPDATE users SET failed_attempts=0, locked_until=? WHERE id=?', now + LOCK_MS, user.id);
      audit(ctx, user.id, 'auth.locked', 'user', user.id);
    } else {
      run(ctx.db, 'UPDATE users SET failed_attempts=? WHERE id=?', attempts, user.id);
    }
    throw unauthorized(GENERIC, 'bad_credentials');
  }
  run(ctx.db, 'UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?', now, user.id);
  return user;
}

// ---------- sesiones ----------

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = ctx.now();
  const expires = now + ctx.config.sessionHours * 3600 * 1000;
  run(ctx.db, 'DELETE FROM sessions WHERE expires_at < ?', now);
  run(
    ctx.db,
    'INSERT INTO sessions(token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)',
    sha(token),
    userId,
    now,
    now,
    expires,
  );
  return { token, expiresAt: expires };
}

export function userForToken(ctx, token) {
  if (!token) return null;
  const row = get(
    ctx.db,
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1`,
    sha(token),
  );
  if (!row) return null;
  const now = ctx.now();
  if (row.expires_at < now) {
    run(ctx.db, 'DELETE FROM sessions WHERE token_hash = ?', sha(token));
    return null;
  }
  // vencimiento deslizante: la sesión caduca por inactividad, no a las N horas de haber entrado
  run(
    ctx.db,
    'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?',
    now,
    now + ctx.config.sessionHours * 3600 * 1000,
    sha(token),
  );
  return row;
}

export function destroySession(ctx, token) {
  if (token) run(ctx.db, 'DELETE FROM sessions WHERE token_hash = ?', sha(token));
}
