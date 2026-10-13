import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// SQLite integrado en Node (node:sqlite): no hay módulos nativos que compilar,
// así que el paquete para Windows es solo "node.exe + código".

const MIGRATIONS = [
  /* 1 — esquema inicial */
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name       TEXT NOT NULL,
    login_alias     TEXT,
    role            TEXT NOT NULL CHECK (role IN ('admin','cajero')),
    pin_hash        TEXT NOT NULL,
    pin_salt        TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER,
    created_at      INTEGER NOT NULL,
    last_login_at   INTEGER
  );

  CREATE TABLE user_login_keys (
    login_key TEXT PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );

  CREATE TABLE categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE products (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id         INTEGER NOT NULL REFERENCES categories(id),
    name                TEXT NOT NULL,
    price_cents         INTEGER NOT NULL CHECK (price_cents >= 0),
    stock               INTEGER NOT NULL DEFAULT 0,
    track_stock         INTEGER NOT NULL DEFAULT 1,
    low_stock_threshold INTEGER NOT NULL DEFAULT 0,
    active              INTEGER NOT NULL DEFAULT 1,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE promos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    active      INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE promo_items (
    promo_id   INTEGER NOT NULL REFERENCES promos(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty        INTEGER NOT NULL CHECK (qty > 0),
    PRIMARY KEY (promo_id, product_id)
  );

  CREATE TABLE shifts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    status              TEXT NOT NULL CHECK (status IN ('open','closed')),
    opened_by           INTEGER NOT NULL REFERENCES users(id),
    opened_at           INTEGER NOT NULL,
    opening_cash_cents  INTEGER NOT NULL,
    opening_notes       TEXT,
    closed_by           INTEGER REFERENCES users(id),
    closed_at           INTEGER,
    counted_cash_cents  INTEGER,
    expected_cash_cents INTEGER,
    cash_diff_cents     INTEGER,
    closing_notes       TEXT
  );
  -- un solo turno abierto a la vez (una sola caja)
  CREATE UNIQUE INDEX idx_one_open_shift ON shifts(status) WHERE status = 'open';

  CREATE TABLE shift_stock (
    shift_id            INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    product_id          INTEGER NOT NULL REFERENCES products(id),
    opening_qty         INTEGER NOT NULL,
    closing_system_qty  INTEGER,
    closing_counted_qty INTEGER,
    PRIMARY KEY (shift_id, product_id)
  );

  CREATE TABLE cash_movements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id     INTEGER NOT NULL REFERENCES shifts(id),
    user_id      INTEGER NOT NULL REFERENCES users(id),
    type         TEXT NOT NULL CHECK (type IN ('in','out')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reason       TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE sales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    number      INTEGER NOT NULL UNIQUE,
    shift_id    INTEGER NOT NULL REFERENCES shifts(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    status      TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void')),
    voided_at   INTEGER,
    voided_by   INTEGER REFERENCES users(id),
    void_approved_by INTEGER REFERENCES users(id),
    void_reason TEXT,
    note        TEXT
  );
  CREATE INDEX idx_sales_shift ON sales(shift_id);
  CREATE INDEX idx_sales_created ON sales(created_at);

  CREATE TABLE sale_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('product','promo')),
    product_id       INTEGER REFERENCES products(id),
    promo_id         INTEGER REFERENCES promos(id),
    name             TEXT NOT NULL,
    category_name    TEXT,
    qty              INTEGER NOT NULL CHECK (qty > 0),
    unit_price_cents INTEGER NOT NULL,
    total_cents      INTEGER NOT NULL
  );
  CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

  -- unidades de cada producto que consume cada línea (una promo => varias filas)
  CREATE TABLE sale_components (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
    sale_id      INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id),
    qty          INTEGER NOT NULL
  );
  CREATE INDEX idx_sale_components_sale ON sale_components(sale_id);

  CREATE TABLE payment_charges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id        INTEGER NOT NULL REFERENCES shifts(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    kind            TEXT NOT NULL CHECK (kind IN ('qr','tarjeta')),
    amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
    status          TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled')),
    provider        TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    confirmed_at    INTEGER,
    mp_payment_id   TEXT,
    resolved_method TEXT,
    mp_info         TEXT,
    last_checked_at INTEGER,
    last_error      TEXT,
    sale_id         INTEGER REFERENCES sales(id)
  );
  CREATE UNIQUE INDEX idx_charge_mp_payment ON payment_charges(mp_payment_id)
    WHERE mp_payment_id IS NOT NULL AND status <> 'cancelled';

  CREATE TABLE sale_payments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method        TEXT NOT NULL CHECK (method IN ('efectivo','transferencia','debito','credito')),
    amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
    tendered_cents INTEGER,
    change_cents  INTEGER,
    confirmation  TEXT NOT NULL CHECK (confirmation IN ('cash','auto','manual')),
    charge_id     INTEGER REFERENCES payment_charges(id),
    mp_payment_id TEXT
  );
  CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);

  CREATE TABLE restocks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    shift_id   INTEGER REFERENCES shifts(id),
    supplier   TEXT,
    note       TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE stock_movements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    type       TEXT NOT NULL CHECK (type IN
                 ('restock','sale','void_return','adjustment','waste','count_open','count_close')),
    qty        INTEGER NOT NULL,
    reason     TEXT,
    user_id    INTEGER REFERENCES users(id),
    shift_id   INTEGER REFERENCES shifts(id),
    sale_id    INTEGER REFERENCES sales(id),
    restock_id INTEGER REFERENCES restocks(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_stock_mov_product ON stock_movements(product_id, created_at);
  CREATE INDEX idx_stock_mov_shift ON stock_movements(shift_id);
  CREATE INDEX idx_stock_mov_created ON stock_movements(created_at);

  CREATE TABLE time_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    clock_in   INTEGER NOT NULL,
    clock_out  INTEGER,
    note       TEXT,
    edited_by  INTEGER REFERENCES users(id)
  );
  CREATE INDEX idx_time_user ON time_entries(user_id, clock_in);

  CREATE TABLE backup_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL CHECK (kind IN ('weekly','manual')),
    period_start INTEGER NOT NULL,
    period_end   INTEGER NOT NULL,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    status       TEXT NOT NULL CHECK (status IN ('running','ok','partial','error')),
    local_dir    TEXT,
    drive_status TEXT,
    message      TEXT
  );

  CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    user_id   INTEGER REFERENCES users(id),
    action    TEXT NOT NULL,
    entity    TEXT,
    entity_id TEXT,
    detail    TEXT
  );
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // FULL: cada venta confirmada se graba en disco antes de responder (un corte de luz no se la lleva)
    db.exec('PRAGMA synchronous = FULL');
  }
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

const depth = new WeakMap();

/**
 * Ejecuta `fn` dentro de una transacción. Si lanza, se revierte todo.
 * Admite anidado (SAVEPOINT). node:sqlite es síncrono, así que mientras dura
 * la transacción no puede colarse ninguna otra operación de la app.
 */
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  const name = `sp_${d}`;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth.set(db, d + 1);
  try {
    const result = fn();
    depth.set(db, d);
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (e) {
    depth.set(db, d);
    db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  }
}

export const all = (db, sql, ...params) => db.prepare(sql).all(...params);
export const get = (db, sql, ...params) => db.prepare(sql).get(...params);
export const run = (db, sql, ...params) => db.prepare(sql).run(...params);
