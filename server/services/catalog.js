import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import { audit } from './audit.js';
import { setSetting } from './settings.js';

const bool = (v) => !!v;

function mapProduct(r) {
  return {
    id: r.id,
    categoryId: r.category_id,
    category: r.category_name,
    name: r.name,
    priceCents: r.price_cents,
    stock: r.stock,
    trackStock: bool(r.track_stock),
    lowStockThreshold: r.low_stock_threshold,
    active: bool(r.active),
    sortOrder: r.sort_order,
  };
}

const PRODUCT_SQL = `
  SELECT p.*, c.name AS category_name
    FROM products p JOIN categories c ON c.id = p.category_id`;

export function listCategories(ctx) {
  return all(ctx.db, 'SELECT * FROM categories ORDER BY sort_order, name').map((c) => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sort_order,
    active: bool(c.active),
  }));
}

export function listProducts(ctx, { includeInactive = false } = {}) {
  return all(
    ctx.db,
    `${PRODUCT_SQL} ${includeInactive ? '' : 'WHERE p.active = 1 AND c.active = 1'}
      ORDER BY c.sort_order, c.name, p.sort_order, p.name`,
  ).map(mapProduct);
}

export function listPromos(ctx, { includeInactive = false } = {}) {
  const promos = all(
    ctx.db,
    `SELECT * FROM promos ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`,
  );
  const items = all(
    ctx.db,
    `SELECT pi.promo_id, pi.product_id, pi.qty, p.name, p.active
       FROM promo_items pi JOIN products p ON p.id = pi.product_id`,
  );
  return promos.map((pr) => {
    const its = items.filter((i) => i.promo_id === pr.id);
    return {
      id: pr.id,
      name: pr.name,
      priceCents: pr.price_cents,
      active: bool(pr.active),
      sortOrder: pr.sort_order,
      // una promo no se puede vender si alguno de sus productos está desactivado
      available: bool(pr.active) && its.length > 0 && its.every((i) => i.active),
      items: its.map((i) => ({ productId: i.product_id, name: i.name, qty: i.qty })),
    };
  });
}

/** Todo lo que necesita la pantalla de venta. */
export function posCatalog(ctx) {
  return {
    categories: listCategories(ctx).filter((c) => c.active),
    products: listProducts(ctx),
    promos: listPromos(ctx).filter((p) => p.available),
  };
}

export function adminCatalog(ctx) {
  return {
    categories: listCategories(ctx),
    products: listProducts(ctx, { includeInactive: true }),
    promos: listPromos(ctx, { includeInactive: true }),
  };
}

// ---------- categorías ----------

export function createCategory(ctx, actor, { name, sortOrder = 0 }) {
  name = String(name ?? '').trim();
  if (!name) throw badRequest('Escribí el nombre de la categoría.');
  if (get(ctx.db, 'SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE', name)) {
    throw conflict('Ya existe una categoría con ese nombre.');
  }
  const info = run(ctx.db, 'INSERT INTO categories(name, sort_order) VALUES (?,?)', name, sortOrder | 0);
  audit(ctx, actor.id, 'category.create', 'category', info.lastInsertRowid, { name });
  return { id: Number(info.lastInsertRowid) };
}

export function updateCategory(ctx, actor, id, patch) {
  const c = get(ctx.db, 'SELECT * FROM categories WHERE id = ?', id);
  if (!c) throw notFound('Categoría no encontrada.');
  const name = patch.name != null ? String(patch.name).trim() : c.name;
  if (!name) throw badRequest('Escribí el nombre de la categoría.');
  run(
    ctx.db,
    'UPDATE categories SET name=?, sort_order=?, active=? WHERE id=?',
    name,
    patch.sortOrder ?? c.sort_order,
    patch.active != null ? (patch.active ? 1 : 0) : c.active,
    id,
  );
  audit(ctx, actor.id, 'category.update', 'category', id, patch);
}

// ---------- productos ----------

function checkPrice(priceCents) {
  if (!Number.isInteger(priceCents) || priceCents < 0) throw badRequest('El precio es inválido.');
}

export function createProduct(ctx, actor, p) {
  const name = String(p.name ?? '').trim();
  if (!name) throw badRequest('Escribí el nombre del producto.');
  checkPrice(p.priceCents);
  if (!get(ctx.db, 'SELECT 1 FROM categories WHERE id = ?', p.categoryId)) throw badRequest('Elegí una categoría.');
  const now = ctx.now();
  const info = run(
    ctx.db,
    `INSERT INTO products(category_id, name, price_cents, track_stock, low_stock_threshold, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    p.categoryId,
    name,
    p.priceCents,
    p.trackStock === false ? 0 : 1,
    p.lowStockThreshold | 0,
    p.sortOrder | 0,
    now,
    now,
  );
  audit(ctx, actor.id, 'product.create', 'product', info.lastInsertRowid, { name, priceCents: p.priceCents });
  return { id: Number(info.lastInsertRowid) };
}

export function updateProduct(ctx, actor, id, patch) {
  const p = get(ctx.db, 'SELECT * FROM products WHERE id = ?', id);
  if (!p) throw notFound('Producto no encontrado.');
  const name = patch.name != null ? String(patch.name).trim() : p.name;
  if (!name) throw badRequest('Escribí el nombre del producto.');
  const price = patch.priceCents ?? p.price_cents;
  checkPrice(price);
  run(
    ctx.db,
    `UPDATE products SET category_id=?, name=?, price_cents=?, track_stock=?, low_stock_threshold=?,
            active=?, sort_order=?, updated_at=? WHERE id=?`,
    patch.categoryId ?? p.category_id,
    name,
    price,
    patch.trackStock != null ? (patch.trackStock ? 1 : 0) : p.track_stock,
    patch.lowStockThreshold ?? p.low_stock_threshold,
    patch.active != null ? (patch.active ? 1 : 0) : p.active,
    patch.sortOrder ?? p.sort_order,
    ctx.now(),
    id,
  );
  if (price !== p.price_cents) {
    audit(ctx, actor.id, 'product.price', 'product', id, { from: p.price_cents, to: price, name });
  } else {
    audit(ctx, actor.id, 'product.update', 'product', id, patch);
  }
}

// ---------- promos ----------

function validatePromoItems(ctx, items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('La promo necesita al menos un producto.');
  const merged = new Map();
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Las cantidades de la promo deben ser enteros mayores a 0.');
    if (!get(ctx.db, 'SELECT 1 FROM products WHERE id = ?', it.productId)) throw badRequest('Producto inexistente en la promo.');
    merged.set(it.productId, (merged.get(it.productId) || 0) + qty);
  }
  return merged;
}

export function createPromo(ctx, actor, { name, priceCents, items, sortOrder = 0 }) {
  name = String(name ?? '').trim();
  if (!name) throw badRequest('Escribí el nombre de la promo.');
  checkPrice(priceCents);
  return tx(ctx.db, () => {
    const merged = validatePromoItems(ctx, items);
    const now = ctx.now();
    const info = run(
      ctx.db,
      'INSERT INTO promos(name, price_cents, sort_order, created_at, updated_at) VALUES (?,?,?,?,?)',
      name,
      priceCents,
      sortOrder | 0,
      now,
      now,
    );
    const id = Number(info.lastInsertRowid);
    for (const [productId, qty] of merged) {
      run(ctx.db, 'INSERT INTO promo_items(promo_id, product_id, qty) VALUES (?,?,?)', id, productId, qty);
    }
    audit(ctx, actor.id, 'promo.create', 'promo', id, { name, priceCents });
    return { id };
  });
}

export function updatePromo(ctx, actor, id, patch) {
  const pr = get(ctx.db, 'SELECT * FROM promos WHERE id = ?', id);
  if (!pr) throw notFound('Promo no encontrada.');
  return tx(ctx.db, () => {
    const name = patch.name != null ? String(patch.name).trim() : pr.name;
    if (!name) throw badRequest('Escribí el nombre de la promo.');
    const price = patch.priceCents ?? pr.price_cents;
    checkPrice(price);
    run(
      ctx.db,
      'UPDATE promos SET name=?, price_cents=?, active=?, sort_order=?, updated_at=? WHERE id=?',
      name,
      price,
      patch.active != null ? (patch.active ? 1 : 0) : pr.active,
      patch.sortOrder ?? pr.sort_order,
      ctx.now(),
      id,
    );
    if (patch.items) {
      const merged = validatePromoItems(ctx, patch.items);
      run(ctx.db, 'DELETE FROM promo_items WHERE promo_id = ?', id);
      for (const [productId, qty] of merged) {
        run(ctx.db, 'INSERT INTO promo_items(promo_id, product_id, qty) VALUES (?,?,?)', id, productId, qty);
      }
    }
    audit(ctx, actor.id, 'promo.update', 'promo', id, { name, priceCents: price });
  });
}

export function confirmPrices(ctx, actor) {
  setSetting(ctx, 'catalog.pricesConfirmed', true);
  audit(ctx, actor.id, 'catalog.prices_confirmed');
}

// ---------- datos de ejemplo (primer arranque) ----------

/**
 * Carga categorías y productos de ejemplo con los rubros del local.
 * Los precios son INVENTADOS: la app avisa hasta que un admin los confirme.
 */
export function seedCatalog(ctx) {
  if (get(ctx.db, 'SELECT COUNT(*) AS n FROM categories').n > 0) return false;
  tx(ctx.db, () => {
    const cats = ['Empanadas', 'Pizzas', 'Medialunas', 'Chipás', 'Criollitos', 'Alfajores', 'Bebidas'];
    const catId = {};
    cats.forEach((name, i) => {
      catId[name] = Number(run(ctx.db, 'INSERT INTO categories(name, sort_order) VALUES (?,?)', name, i).lastInsertRowid);
    });
    const now = ctx.now();
    const add = (cat, name, pesos, threshold = 0) =>
      Number(
        run(
          ctx.db,
          `INSERT INTO products(category_id, name, price_cents, low_stock_threshold, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,0,?,?)`,
          catId[cat],
          name,
          pesos * 100,
          threshold,
          now,
          now,
        ).lastInsertRowid,
      );
    const emp = add('Empanadas', 'Empanada', 2200, 24);
    add('Pizzas', 'Pizza', 13500, 3);
    const med = add('Medialunas', 'Medialuna', 900, 20);
    add('Chipás', 'Chipá', 700, 20);
    add('Criollitos', 'Criollito', 800, 20);
    add('Alfajores', 'Alfajor', 1500, 10);
    const gas = add('Bebidas', 'Gaseosa', 2500, 6);
    add('Bebidas', 'Agua', 1800, 6);

    const promo = (name, pesos, items) => {
      const id = Number(
        run(ctx.db, 'INSERT INTO promos(name, price_cents, created_at, updated_at) VALUES (?,?,?,?)', name, pesos * 100, now, now)
          .lastInsertRowid,
      );
      for (const [productId, qty] of items) {
        run(ctx.db, 'INSERT INTO promo_items(promo_id, product_id, qty) VALUES (?,?,?)', id, productId, qty);
      }
    };
    promo('Docena de empanadas', 24000, [[emp, 12]]);
    promo('Media docena de empanadas', 12500, [[emp, 6]]);
    promo('Combo 3 medialunas', 2400, [[med, 3]]);
    promo('Combo 3 empanadas + gaseosa', 8600, [[emp, 3], [gas, 1]]);
  });
  return true;
}
