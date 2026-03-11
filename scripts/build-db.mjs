#!/usr/bin/env node
/**
 * Build PlainVitamins SQLite database from DSLD NDJSON data
 *
 * Input: dsld-products.ndjson (from Phase 1)
 *        dsld-labels.ndjson (from Phase 2, optional enrichment)
 *
 * Output: plainvitamins.db
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const INPUT_DIR = process.argv[2] || '/storage/plainvitamins';
const PRODUCTS_FILE = `${INPUT_DIR}/dsld-products.ndjson`;
const LABELS_FILE = `${INPUT_DIR}/dsld-labels.ndjson`;
const DB_PATH = `${INPUT_DIR}/plainvitamins.db`;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 200);
}

async function main() {
  if (!existsSync(PRODUCTS_FILE)) {
    console.error(`Products file not found: ${PRODUCTS_FILE}`);
    process.exit(1);
  }

  console.log(`Building database: ${DB_PATH}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('foreign_keys = OFF');

  db.exec(`
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS ingredients;
    DROP TABLE IF EXISTS brands;
    DROP TABLE IF EXISTS ingredient_groups;

    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      product_type TEXT,
      product_type_code TEXT,
      physical_state TEXT,
      physical_state_code TEXT,
      serving_size TEXT,
      servings_per_container TEXT,
      entry_date TEXT,
      off_market INTEGER DEFAULT 0,
      slug TEXT UNIQUE NOT NULL,
      ingredient_count INTEGER DEFAULT 0
    );

    CREATE TABLE ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      ingredient_group TEXT,
      quantity REAL,
      unit TEXT,
      dv_pct REAL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE brands (
      name TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT '',
      product_count INTEGER DEFAULT 0,
      on_market_count INTEGER DEFAULT 0
    );

    CREATE TABLE ingredient_groups (
      name TEXT PRIMARY KEY,
      slug TEXT NOT NULL DEFAULT '',
      category TEXT,
      product_count INTEGER DEFAULT 0
    );
  `);

  // Import products
  console.log('Importing products...');
  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products (id, name, brand, product_type, product_type_code,
      physical_state, physical_state_code, entry_date, off_market, slug, ingredient_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIngredient = db.prepare(`
    INSERT INTO ingredients (product_id, name, category, ingredient_group, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  const rl = createInterface({ input: createReadStream(PRODUCTS_FILE), crlfDelay: Infinity });

  let productCount = 0;
  let ingredientCount = 0;
  const slugCounts = new Map();

  const insertBatch = db.transaction((lines) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      let p;
      try { p = JSON.parse(line); } catch { continue; }

      const id = typeof p.id === 'string' ? parseInt(p.id) : p.id;
      if (!id || !p.fullName) continue;

      const name = p.fullName.trim();
      const brand = (p.brandName || '').trim() || null;

      let baseSlug = slugify(name);
      if (!baseSlug) baseSlug = `product-${id}`;
      const count = slugCounts.get(baseSlug) || 0;
      const slug = count > 0 ? `${baseSlug}-${count}` : baseSlug;
      slugCounts.set(baseSlug, count + 1);

      const ingredients = p.allIngredients || [];

      insertProduct.run(
        id, name, brand,
        p.productType?.langualCodeDescription || null,
        p.productType?.langualCode || null,
        p.physicalState?.langualCodeDescription || null,
        p.physicalState?.langualCode || null,
        p.entryDate || null,
        p.offMarket ? 1 : 0,
        slug, ingredients.length
      );
      productCount++;

      for (let j = 0; j < ingredients.length; j++) {
        const ing = ingredients[j];
        insertIngredient.run(id, ing.name || ing.ingredientGroup || 'Unknown', ing.category || null, ing.ingredientGroup || null, j + 1);
        ingredientCount++;
      }
    }
  });

  let batch = [];
  for await (const line of rl) {
    batch.push(line);
    if (batch.length >= 1000) {
      insertBatch(batch);
      batch = [];
      if (productCount % 10000 === 0) process.stdout.write(`\r  Products: ${productCount.toLocaleString()}`);
    }
  }
  if (batch.length) insertBatch(batch);
  console.log(`\r  Products: ${productCount.toLocaleString()} | Ingredients: ${ingredientCount.toLocaleString()}`);

  // Enrich with label data if available
  if (existsSync(LABELS_FILE)) {
    console.log('Enriching with label data...');
    const updateProduct = db.prepare(`UPDATE products SET serving_size = ?, servings_per_container = ? WHERE id = ?`);
    const clearIngredients = db.prepare(`DELETE FROM ingredients WHERE product_id = ?`);
    const insertDetail = db.prepare(`
      INSERT INTO ingredients (product_id, name, category, ingredient_group, quantity, unit, dv_pct, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rl2 = createInterface({ input: createReadStream(LABELS_FILE), crlfDelay: Infinity });
    let enriched = 0;
    const enrichBatch = db.transaction((lines) => {
      for (const line of lines) {
        if (!line.trim()) continue;
        let label;
        try { label = JSON.parse(line); } catch { continue; }
        if (!label.id) continue;
        const ss = label.servingSizes?.[0];
        updateProduct.run(ss ? `${ss.minQuantity} ${ss.unit}` : null, label.servingsPerContainer || null, label.id);
        if (label.ingredientRows?.length) {
          clearIngredients.run(label.id);
          for (const row of label.ingredientRows) {
            const qty = row.quantity?.[0];
            insertDetail.run(label.id, row.name || 'Unknown', row.category || null, row.ingredientGroup || null, qty?.quantity || null, qty?.unit || null, qty?.dailyValueTargetGroup?.[0]?.percent || null, row.order || 0);
          }
        }
        enriched++;
      }
    });
    let batch2 = [];
    for await (const line of rl2) {
      batch2.push(line);
      if (batch2.length >= 500) { enrichBatch(batch2); batch2 = []; }
    }
    if (batch2.length) enrichBatch(batch2);
    console.log(`  Enriched: ${enriched.toLocaleString()}`);
  }

  // Aggregate brands
  console.log('Aggregating brands...');
  db.exec(`
    INSERT OR REPLACE INTO brands (name, slug, product_count, on_market_count)
    SELECT brand, '', COUNT(*), SUM(CASE WHEN off_market = 0 THEN 1 ELSE 0 END)
    FROM products WHERE brand IS NOT NULL AND brand != '' GROUP BY brand
  `);
  const allBrands = db.prepare('SELECT rowid, name FROM brands').all();
  const updateBrandSlug = db.prepare('UPDATE brands SET slug = ? WHERE name = ?');
  const bsc = new Map();
  db.transaction(() => {
    for (const b of allBrands) {
      let base = slugify(b.name); if (!base) base = `brand-${b.rowid}`;
      const c = bsc.get(base) || 0;
      updateBrandSlug.run(c > 0 ? `${base}-${c}` : base, b.name);
      bsc.set(base, c + 1);
    }
  })();
  console.log(`  ${allBrands.length.toLocaleString()} brands`);

  // Aggregate ingredient groups
  console.log('Aggregating ingredient groups...');
  db.exec(`
    INSERT OR REPLACE INTO ingredient_groups (name, slug, category, product_count)
    SELECT ingredient_group, '', category, COUNT(DISTINCT product_id)
    FROM ingredients WHERE ingredient_group IS NOT NULL AND ingredient_group != ''
    GROUP BY ingredient_group ORDER BY COUNT(DISTINCT product_id) DESC
  `);
  const allGroups = db.prepare('SELECT rowid, name FROM ingredient_groups').all();
  const updateGroupSlug = db.prepare('UPDATE ingredient_groups SET slug = ? WHERE name = ?');
  const gsc = new Map();
  db.transaction(() => {
    for (const g of allGroups) {
      let base = slugify(g.name); if (!base) base = `ingredient-${g.rowid}`;
      const c = gsc.get(base) || 0;
      updateGroupSlug.run(c > 0 ? `${base}-${c}` : base, g.name);
      gsc.set(base, c + 1);
    }
  })();
  console.log(`  ${allGroups.length.toLocaleString()} ingredient groups`);

  // Create indexes
  console.log('Creating indexes...');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
    CREATE INDEX IF NOT EXISTS idx_products_type ON products(product_type_code);
    CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
    CREATE INDEX IF NOT EXISTS idx_products_off_market ON products(off_market);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_ingredients_product ON ingredients(product_id);
    CREATE INDEX IF NOT EXISTS idx_ingredients_group ON ingredients(ingredient_group);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_slug ON brands(slug);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredient_groups_slug ON ingredient_groups(slug);
    CREATE INDEX IF NOT EXISTS idx_products_brand_name ON products(brand, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_products_type_brand ON products(product_type_code, brand);
    CREATE INDEX IF NOT EXISTS idx_ingredients_name ON ingredients(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_ingredients_group_product ON ingredients(ingredient_group, product_id);
  `);

  // Final stats
  const s = db.prepare;
  const stats = {
    products: db.prepare('SELECT COUNT(*) as c FROM products').get().c,
    on_market: db.prepare('SELECT COUNT(*) as c FROM products WHERE off_market = 0').get().c,
    brands: db.prepare('SELECT COUNT(*) as c FROM brands').get().c,
    ingredient_rows: db.prepare('SELECT COUNT(*) as c FROM ingredients').get().c,
    ingredient_groups: db.prepare('SELECT COUNT(*) as c FROM ingredient_groups').get().c,
  };
  console.log('\n── Database Stats ──');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v.toLocaleString()}`);

  console.log('\nFinalizing database...');
  db.exec('ANALYZE');
  db.pragma('journal_mode = DELETE');
  db.exec('VACUUM');
  console.log('Finalized (ANALYZE + journal_mode=DELETE + VACUUM)');

  db.close();
  console.log(`\nDatabase: ${DB_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
