// PlainVitamins D1 query library
// All functions accept D1Database as first param — NEVER at module scope

import type { D1Database } from './d1-adapter';

// --- Targeted query cache (permanent, for aggregate/listing queries) ---
const queryCache = new Map<string, any>();
export function getQueryCacheSize(): number { return queryCache.size; }
function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  if (queryCache.has(key)) return Promise.resolve(queryCache.get(key) as T);
  return compute().then(result => { queryCache.set(key, result); return result; });
}

// --- Interfaces ---

export interface Product {
  id: number;
  name: string;
  brand: string | null;
  product_type: string | null;
  product_type_code: string | null;
  physical_state: string | null;
  physical_state_code: string | null;
  serving_size: string | null;
  servings_per_container: string | null;
  entry_date: string | null;
  off_market: number;
  slug: string;
  ingredient_count: number;
}

export interface Ingredient {
  id: number;
  product_id: number;
  name: string;
  category: string | null;
  ingredient_group: string | null;
  quantity: number | null;
  unit: string | null;
  dv_pct: number | null;
  sort_order: number;
}

export interface Brand {
  name: string;
  slug: string;
  product_count: number;
  on_market_count: number;
}

export interface IngredientGroup {
  name: string;
  slug: string;
  category: string | null;
  product_count: number;
}

// --- Product Queries ---

export async function getProductBySlug(db: D1Database, slug: string): Promise<Product | null> {
  return db.prepare(`SELECT * FROM products WHERE slug = ?`).bind(slug).first<Product>();
}

export async function getProductsByType(db: D1Database, typeCode: string, limit = 50, offset = 0): Promise<Product[]> {
  const { results } = await db.prepare(
    `SELECT * FROM products WHERE product_type_code = ? ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).bind(typeCode, limit, offset).all<Product>();
  return results;
}

export async function getProductCountByType(db: D1Database, typeCode: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) as cnt FROM products WHERE product_type_code = ?`
  ).bind(typeCode).first<{ cnt: number }>();
  return row?.cnt || 0;
}

export async function getProductsByBrand(db: D1Database, brand: string, limit = 50, offset = 0): Promise<Product[]> {
  const { results } = await db.prepare(
    `SELECT * FROM products WHERE brand = ? ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).bind(brand, limit, offset).all<Product>();
  return results;
}

export async function getOnMarketProducts(db: D1Database, limit = 50, offset = 0): Promise<Product[]> {
  const { results } = await db.prepare(
    `SELECT * FROM products WHERE off_market = 0 ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<Product>();
  return results;
}

export async function searchProducts(db: D1Database, query: string, limit = 20): Promise<Product[]> {
  const term = `%${query}%`;
  const { results } = await db.prepare(
    `SELECT * FROM products WHERE name LIKE ? OR brand LIKE ? ORDER BY off_market ASC, name COLLATE NOCASE LIMIT ?`
  ).bind(term, term, limit).all<Product>();
  return results;
}

export async function getProductCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as cnt FROM products`).first<{ cnt: number }>();
  return row?.cnt || 0;
}

export async function getOnMarketCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as cnt FROM products WHERE off_market = 0`).first<{ cnt: number }>();
  return row?.cnt || 0;
}

// --- Ingredient Queries ---

export async function getIngredients(db: D1Database, productId: number): Promise<Ingredient[]> {
  const { results } = await db.prepare(
    `SELECT * FROM ingredients WHERE product_id = ? ORDER BY sort_order ASC`
  ).bind(productId).all<Ingredient>();
  return results;
}

export async function getProductsByIngredientGroup(db: D1Database, group: string, limit = 50, offset = 0): Promise<Product[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT p.* FROM products p
     INNER JOIN ingredients i ON p.id = i.product_id
     WHERE i.ingredient_group = ?
     ORDER BY p.off_market ASC, p.name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).bind(group, limit, offset).all<Product>();
  return results;
}

export async function getProductCountByIngredientGroup(db: D1Database, group: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT product_id) as cnt FROM ingredients WHERE ingredient_group = ?`
  ).bind(group).first<{ cnt: number }>();
  return row?.cnt || 0;
}

// --- Brand Queries ---

export async function getBrandBySlug(db: D1Database, slug: string): Promise<Brand | null> {
  return db.prepare(`SELECT * FROM brands WHERE slug = ?`).bind(slug).first<Brand>();
}

export async function getAllBrands(db: D1Database, limit = 100, offset = 0): Promise<Brand[]> {
  return cached(`brands:all:${limit}:${offset}`, async () => {
    const { results } = await db.prepare(
      `SELECT * FROM brands ORDER BY product_count DESC, name COLLATE NOCASE LIMIT ? OFFSET ?`
    ).bind(limit, offset).all<Brand>();
    return results;
  });
}

export async function getBrandCount(db: D1Database): Promise<number> {
  return cached('brands:count', async () => {
    const row = await db.prepare(`SELECT COUNT(*) as cnt FROM brands`).first<{ cnt: number }>();
    return row?.cnt || 0;
  });
}

export async function searchBrands(db: D1Database, query: string, limit = 20): Promise<Brand[]> {
  const term = `%${query}%`;
  const { results } = await db.prepare(
    `SELECT * FROM brands WHERE name LIKE ? ORDER BY product_count DESC LIMIT ?`
  ).bind(term, limit).all<Brand>();
  return results;
}

// --- Ingredient Group Queries ---

export async function getIngredientGroupBySlug(db: D1Database, slug: string): Promise<IngredientGroup | null> {
  return db.prepare(`SELECT * FROM ingredient_groups WHERE slug = ?`).bind(slug).first<IngredientGroup>();
}

export async function getAllIngredientGroups(db: D1Database, limit = 100, offset = 0): Promise<IngredientGroup[]> {
  return cached(`ingredient_groups:all:${limit}:${offset}`, async () => {
    const { results } = await db.prepare(
      `SELECT * FROM ingredient_groups ORDER BY product_count DESC, name COLLATE NOCASE LIMIT ? OFFSET ?`
    ).bind(limit, offset).all<IngredientGroup>();
    return results;
  });
}

export async function getIngredientGroupCount(db: D1Database): Promise<number> {
  return cached('ingredient_groups:count', async () => {
    const row = await db.prepare(`SELECT COUNT(*) as cnt FROM ingredient_groups`).first<{ cnt: number }>();
    return row?.cnt || 0;
  });
}

export async function getIngredientGroupsByCategory(db: D1Database, category: string): Promise<IngredientGroup[]> {
  return cached(`ingredient_groups:category:${category}`, async () => {
    const { results } = await db.prepare(
      `SELECT * FROM ingredient_groups WHERE category = ? ORDER BY product_count DESC, name COLLATE NOCASE`
    ).bind(category).all<IngredientGroup>();
    return results;
  });
}

// --- Rankings ---

export async function getMostCommonIngredients(db: D1Database, limit = 50): Promise<IngredientGroup[]> {
  return cached(`ingredient_groups:most_common:${limit}`, async () => {
    const { results } = await db.prepare(
      `SELECT * FROM ingredient_groups ORDER BY product_count DESC LIMIT ?`
    ).bind(limit).all<IngredientGroup>();
    return results;
  });
}

export async function getTopBrands(db: D1Database, limit = 50): Promise<Brand[]> {
  return cached(`brands:top:${limit}`, async () => {
    const { results } = await db.prepare(
      `SELECT * FROM brands ORDER BY product_count DESC LIMIT ?`
    ).bind(limit).all<Brand>();
    return results;
  });
}

export async function getNewestProducts(db: D1Database, limit = 50): Promise<Product[]> {
  const { results } = await db.prepare(
    `SELECT * FROM products WHERE off_market = 0 ORDER BY entry_date DESC, name COLLATE NOCASE LIMIT ?`
  ).bind(limit).all<Product>();
  return results;
}

// --- Product Types ---

export const PRODUCT_TYPES = [
  { code: 'A1299', name: 'Mineral', icon: '🪨' },
  { code: 'A1302', name: 'Vitamin', icon: '💊' },
  { code: 'A1305', name: 'Amino Acid & Protein', icon: '🧬' },
  { code: 'A1306', name: 'Botanical', icon: '🌿' },
  { code: 'A1309', name: 'Non-Nutrient', icon: '⚗️' },
  { code: 'A1310', name: 'Fat & Fatty Acid', icon: '🫒' },
  { code: 'A1315', name: 'Multi-Vitamin & Mineral', icon: '💎' },
  { code: 'A1317', name: 'Botanical with Nutrients', icon: '🌱' },
  { code: 'A1325', name: 'Other Combinations', icon: '🔬' },
] as const;

export function getProductTypeName(code: string): string {
  return PRODUCT_TYPES.find(t => t.code === code)?.name || code;
}

// --- Stats ---

export async function getStats(db: D1Database) {
  return cached('stats', async () => {
    const total = await db.prepare(`SELECT COUNT(*) as c FROM products`).first<{ c: number }>();
    const onMarket = await db.prepare(`SELECT COUNT(*) as c FROM products WHERE off_market = 0`).first<{ c: number }>();
    const brands = await db.prepare(`SELECT COUNT(*) as c FROM brands`).first<{ c: number }>();
    const ingredientGroups = await db.prepare(`SELECT COUNT(*) as c FROM ingredient_groups`).first<{ c: number }>();
    const types = await db.prepare(`SELECT COUNT(DISTINCT product_type) as c FROM products`).first<{ c: number }>();

    return {
      total_products: total?.c || 0,
      on_market: onMarket?.c || 0,
      brand_count: brands?.c || 0,
      ingredient_group_count: ingredientGroups?.c || 0,
      type_count: types?.c || 0,
    };
  });
}

// --- Slugs (for sitemaps) ---

export async function getAllProductSlugs(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`SELECT slug FROM products ORDER BY slug`).all<{ slug: string }>();
  return results.map(r => r.slug);
}

export async function getAllBrandSlugs(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`SELECT slug FROM brands ORDER BY slug`).all<{ slug: string }>();
  return results.map(r => r.slug);
}

export async function getAllIngredientGroupSlugs(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`SELECT slug FROM ingredient_groups ORDER BY slug`).all<{ slug: string }>();
  return results.map(r => r.slug);
}

// --- Helpers ---

export function categoryLabel(category: string | null): string {
  if (!category) return 'Other';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function formatDV(pct: number | null): string {
  if (pct === null || pct === undefined) return '—';
  return `${Math.round(pct)}%`;
}

export async function warmQueryCache(db: D1Database): Promise<number> {
  const start = Date.now();
  await Promise.all([
    getBrandCount(db),
    getIngredientGroupCount(db),
    getMostCommonIngredients(db),
    getTopBrands(db),
    getStats(db),
    getAllIngredientGroups(db),
    getAllBrands(db),
  ]);
  // Warm ingredient groups by category (shared across ~30 category groupings)
  const allGroups = await getAllIngredientGroups(db);
  const categories = new Set(allGroups.map(g => g.category).filter(Boolean) as string[]);
  await Promise.all(Array.from(categories).map(cat => getIngredientGroupsByCategory(db, cat)));
  console.log(`[cache] Warmed ${queryCache.size} queries in ${Date.now() - start}ms`);
  return queryCache.size;
}
