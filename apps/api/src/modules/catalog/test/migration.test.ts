import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lintMigration, parseMigration, createTestDatabaseUpTo } from "@outlet/db";

// Migrations 1..12 only, so another module's in-flight migration cannot break this suite.
let db: Awaited<ReturnType<typeof createTestDatabaseUpTo>>;
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STORE_A = U(9001);
const STORE_B = U(9002);
const CAT = U(1);
const AR = 'فستان كتان';

beforeAll(async () => {
  db = await createTestDatabaseUpTo(12);
  await db.query(`INSERT INTO categories (id, slug, name_ar, product_type) VALUES ($1, 'dresses', 'فساتين', 'dress')`, [CAT]);
}, 60_000);
afterAll(async () => {
  await db.close();
});

const rejects = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toThrow(re);
};

let n = 100;
const newProduct = async (over: { store?: string; titleAr?: string; condition?: string } = {}): Promise<string> => {
  n += 1;
  const id = U(n);
  await db.query(
    `INSERT INTO products (id, store_id, category_id, title_ar, condition) VALUES ($1, $2, $3, $4, $5)`,
    [id, over.store ?? STORE_A, CAT, over.titleAr ?? AR, over.condition ?? 'new_with_tags'],
  );
  return id;
};
const addSku = async (productId: string, store = STORE_A, size = 'M', price = 129900): Promise<string> => {
  n += 1;
  const id = U(n);
  await db.query(
    `INSERT INTO skus (id, product_id, store_id, size_label, list_price_amount) VALUES ($1,$2,$3,$4,$5)`,
    [id, productId, store, size, price],
  );
  return id;
};
const addImage = async (productId: string, store = STORE_A): Promise<void> => {
  n += 1;
  await db.query(
    `INSERT INTO product_media (product_id, store_id, media_asset_id, position) VALUES ($1,$2,$3,0)`,
    [productId, store, U(n)],
  );
};

describe('migration 0012 catalog', () => {
  it('passes the migration linter and fills the 0012 slot', async () => {
    const url = new URL('../../../../../../packages/db/migrations/0012_catalog.sql', import.meta.url);
    const f = parseMigration('0012_catalog.sql', await readFile(fileURLToPath(url), 'utf8'));
    expect(f.name).toBe('catalog');
    expect(lintMigration(f.sql)).toEqual([]);
  });

  it('requires an Arabic title: blank and Latin-only are refused by the database', async () => {
    await rejects(newProduct({ titleAr: 'Linen dress' }), /products_title_ar_check|check/i);
    await rejects(newProduct({ titleAr: '   ' }), /check/i);
    await rejects(newProduct({ titleAr: '12345' }), /check/i);
    expect(await newProduct({ titleAr: 'Nike فستان' })).toBeTruthy();
  });

  it('has no was-price, reference-price, discount or badge column anywhere in the catalog', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('products','skus','product_media','product_defects')
          AND column_name ~* '(was|reference|original|compare|discount|badge|percent|strike)'`,
    );
    expect(r.rows).toEqual([]);
  });

  it('keeps money as bigint piastres within range and EGP only', async () => {
    const p = await newProduct();
    await rejects(addSku(p, STORE_A, 'S', 0), /check/i);
    await rejects(addSku(p, STORE_A, 'S', 1_000_000_000), /check/i);
    await addSku(p, STORE_A, 'T');
    await rejects(db.query(`UPDATE skus SET currency = 'USD' WHERE product_id = $1`, [p]), /check/i);
    const col = await db.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_name='skus' AND column_name='list_price_amount'`,
    );
    expect(col.rows[0]?.data_type).toBe('bigint');
  });

  it('enforces one variant per colour and size, and tenant consistency of children', async () => {
    const p = await newProduct();
    await addSku(p, STORE_A, 'M');
    await rejects(addSku(p, STORE_A, ' m '), /duplicate|unique/i);
    await rejects(addSku(p, STORE_B, 'L'), /foreign key|violates/i);
  });

  it('scopes seller sku and gtin uniqueness to the store', async () => {
    const pa = await newProduct();
    const pb = await newProduct({ store: STORE_B });
    n += 1;
    await db.query(`INSERT INTO skus (product_id, store_id, size_label, list_price_amount, seller_sku, gtin, color_code) VALUES ($1,$2,'M',100,'SKU-1','4006381333931','red')`, [pa, STORE_A]);
    await db.query(`INSERT INTO skus (product_id, store_id, size_label, list_price_amount, seller_sku, gtin, color_code) VALUES ($1,$2,'M',100,'SKU-1','4006381333931','red')`, [pb, STORE_B]);
    const pa2 = await newProduct();
    await rejects(
      db.query(`INSERT INTO skus (product_id, store_id, size_label, list_price_amount, seller_sku) VALUES ($1,$2,'L',100,'SKU-1')`, [pa2, STORE_A]),
      /duplicate|unique/i,
    );
    await rejects(
      db.query(`INSERT INTO skus (product_id, store_id, size_label, list_price_amount, gtin, color_code) VALUES ($1,$2,'M',100,'4006381333931','RED')`, [pa2, STORE_A]),
      /duplicate|unique/i,
    );
    await rejects(
      db.query(`INSERT INTO skus (product_id, store_id, size_label, list_price_amount, gtin) VALUES ($1,$2,'M',100,'123')`, [pa2, STORE_A]),
      /check/i,
    );
  });

  it('gates publish: description, image, active sku, defect photo', async () => {
    const p = await newProduct({ condition: 'minor_defect' });
    await rejects(db.query(`UPDATE products SET status='active', version = version + 1 WHERE id=$1`, [p]), /description|check/i);
    await db.query(`UPDATE products SET description_ar = 'وصف', version = version + 1 WHERE id=$1`, [p]);
    await rejects(db.query(`UPDATE products SET status='active', version = version + 1 WHERE id=$1`, [p]), /image/);
    await addImage(p);
    await rejects(db.query(`UPDATE products SET status='active', version = version + 1 WHERE id=$1`, [p]), /SKU/);
    await addSku(p);
    await rejects(db.query(`UPDATE products SET status='active', version = version + 1 WHERE id=$1`, [p]), /defect photo/);
    n += 1;
    await db.query(`INSERT INTO product_defects (product_id, store_id, media_asset_id) VALUES ($1,$2,$3)`, [p, STORE_A, U(n)]);
    await db.query(`UPDATE products SET status='active', version = version + 1 WHERE id=$1`, [p]);
    const r = await db.query<{ status: string; published_at: string | null }>(`SELECT status, published_at FROM products WHERE id=$1`, [p]);
    expect(r.rows[0]?.status).toBe('active');
    expect(r.rows[0]?.published_at).not.toBeNull();
  });

  it('refuses insertion as anything but draft, status regression from delisted and version rewind', async () => {
    n += 1;
    await rejects(
      db.query(`INSERT INTO products (id, store_id, category_id, title_ar, condition, status, description_ar) VALUES ($1,$2,$3,$4,'sample','active','وصف')`, [U(n), STORE_A, CAT, AR]),
      /created as draft/,
    );
    const p = await newProduct();
    await db.query(`UPDATE products SET status='delisted', version = version + 1 WHERE id=$1`, [p]);
    await rejects(db.query(`UPDATE products SET status='draft', version = version + 1 WHERE id=$1`, [p]), /terminal/);
    const q = await newProduct();
    await rejects(db.query(`UPDATE products SET material='x' WHERE id=$1`, [q]), /version must increase/);
    await rejects(db.query(`UPDATE products SET store_id=$2, version = version + 1 WHERE id=$1`, [q, STORE_B]), /immutable|foreign key/);
  });

  it('only the system may enter or leave the price-parity pause', async () => {
    const p = await newProduct();
    await db.query(`UPDATE products SET description_ar='وصف', version=version+1 WHERE id=$1`, [p]);
    await addImage(p);
    await addSku(p);
    await db.query(`UPDATE products SET status='active', version=version+1 WHERE id=$1`, [p]);
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.role','seller',true)`);
      await expect(tx.query(`UPDATE products SET status='auto_paused_price_parity', version=version+1 WHERE id=$1`, [p])).rejects.toThrow(/system/);
    });
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.role','system',true)`);
      await tx.query(`UPDATE products SET status='auto_paused_price_parity', version=version+1 WHERE id=$1`, [p]);
    });
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.role','seller',true)`);
      await expect(tx.query(`UPDATE products SET status='active', version=version+1 WHERE id=$1`, [p])).rejects.toThrow(/system/);
    });
  });
});

describe('catalog imports', () => {
  it('keeps counts consistent and a dry run from ever completing or creating products', async () => {
    n += 1;
    const imp = U(n);
    await db.query(`INSERT INTO catalog_imports (id, store_id, actor_id, upload_id, status, dry_run, rows_total, rows_ok, rows_failed) VALUES ($1,$2,$3,$4,'dry_run_complete',true,3,2,1)`, [imp, STORE_A, U(7), U(8)]);
    await rejects(
      db.query(`INSERT INTO catalog_imports (store_id, actor_id, upload_id, status, dry_run, rows_total, rows_ok, rows_failed) VALUES ($1,$2,$3,'dry_run_complete',true,3,1,1)`, [STORE_A, U(7), U(8)]),
      /counts/,
    );
    await rejects(
      db.query(`INSERT INTO catalog_imports (store_id, actor_id, upload_id, status, dry_run) VALUES ($1,$2,$3,'completed',true)`, [STORE_A, U(7), U(8)]),
      /dry_run_status/,
    );
    const p = await newProduct();
    await rejects(
      db.query(`INSERT INTO catalog_import_products (import_id, store_id, product_ref, product_id) VALUES ($1,$2,'p1',$3)`, [imp, STORE_A, p]),
      /dry-run import cannot create products/,
    );
  });

  it('claims a product once per real import and rejects a foreign tenant product', async () => {
    n += 1;
    const imp = U(n);
    await db.query(`INSERT INTO catalog_imports (id, store_id, actor_id, upload_id, status, dry_run, rows_total, rows_ok, rows_failed) VALUES ($1,$2,$3,$4,'completed',false,1,1,0)`, [imp, STORE_A, U(7), U(8)]);
    const p = await newProduct();
    await db.query(`INSERT INTO catalog_import_products (import_id, store_id, product_ref, product_id) VALUES ($1,$2,'p1',$3)`, [imp, STORE_A, p]);
    await rejects(
      db.query(`INSERT INTO catalog_import_products (import_id, store_id, product_ref, product_id) VALUES ($1,$2,'p1',$3)`, [imp, STORE_A, p]),
      /duplicate|unique/i,
    );
    const other = await newProduct({ store: STORE_B });
    await rejects(
      db.query(`INSERT INTO catalog_import_products (import_id, store_id, product_ref, product_id) VALUES ($1,$2,'p2',$3)`, [imp, STORE_A, other]),
      /foreign key|violates/i,
    );
  });

  it('stores error codes only, not cell contents', async () => {
    n += 1;
    const imp = U(n);
    await db.query(`INSERT INTO catalog_imports (id, store_id, actor_id, upload_id, status, dry_run, rows_total, rows_ok, rows_failed) VALUES ($1,$2,$3,$4,'dry_run_complete',true,1,0,1)`, [imp, STORE_A, U(7), U(8)]);
    await db.query(`INSERT INTO catalog_import_errors (import_id, store_id, row_number, column_name, code) VALUES ($1,$2,2,'price_egp','invalid_value')`, [imp, STORE_A]);
    await rejects(
      db.query(`INSERT INTO catalog_import_errors (import_id, store_id, row_number, column_name, code) VALUES ($1,$2,2,'=HYPERLINK("x")','invalid_value')`, [imp, STORE_A]),
      /check/i,
    );
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='catalog_import_errors'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['code', 'column_name', 'id', 'import_id', 'row_number', 'store_id']);
  });
});

describe('catalog row level security', () => {
  const as = async <T>(role: string | null, stores: string[], fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE app_user');
      await tx.query(`SELECT set_config('app.role', $1, true)`, [role ?? '']);
      await tx.query(`SELECT set_config('app.store_ids', $1, true)`, [stores.join(',')]);
      return fn((sql, p) => tx.query(sql, p) as Promise<{ rows: Record<string, unknown>[] }>);
    });

  it('shows a seller only their own drafts and everyone only active rows', async () => {
    const draftB = await newProduct({ store: STORE_B });
    const live = await newProduct({ store: STORE_B });
    await db.query(`UPDATE products SET description_ar='وصف', version=version+1 WHERE id=$1`, [live]);
    await addImage(live, STORE_B);
    await addSku(live, STORE_B);
    await db.query(`UPDATE products SET status='active', version=version+1 WHERE id=$1`, [live]);

    const asA = await as('seller', [STORE_A], (q) => q(`SELECT id, status FROM products WHERE store_id = $1`, [STORE_B]));
    expect(asA.rows.map((r) => r.id)).toEqual([live]);
    expect(asA.rows.map((r) => r.id)).not.toContain(draftB);
    const anon = await as(null, [], (q) => q(`SELECT id FROM products`));
    expect(anon.rows).toEqual([]);
    const buyer = await as('customer', [], (q) => q(`SELECT id FROM products WHERE store_id = $1`, [STORE_B]));
    expect(buyer.rows.map((r) => r.id)).toEqual([live]);
    const skus = await as('customer', [], (q) => q(`SELECT product_id FROM skus WHERE store_id = $1`, [STORE_B]));
    expect(skus.rows.map((r) => r.product_id)).toEqual([live]);
  });

  it('blocks cross-tenant writes and tenant reassignment', async () => {
    const pb = await newProduct({ store: STORE_B });
    const upd = await as('seller', [STORE_A], (q) => q(`UPDATE products SET material = 'x', version = version + 1 WHERE id = $1 RETURNING id`, [pb]));
    expect(upd.rows).toEqual([]);
    await rejects(
      as('seller', [STORE_A], (q) => q(`INSERT INTO products (store_id, category_id, title_ar, condition) VALUES ($1,$2,$3,'sample')`, [STORE_B, CAT, AR])),
      /row-level security/i,
    );
    const imp = await as('seller', [STORE_A], (q) => q(`SELECT id FROM catalog_imports`));
    expect(imp.rows.every((r) => typeof r.id === 'string')).toBe(true);
  });

  it('only ops may write taxonomy', async () => {
    await rejects(
      as('seller', [STORE_A], (q) => q(`INSERT INTO brands (slug, name_ar) VALUES ('x', 'ب')`)),
      /row-level security/i,
    );
    const ok = await as('ops', [], (q) => q(`INSERT INTO brands (slug, name_ar) VALUES ('acme', 'أكمي') RETURNING id`));
    expect(ok.rows).toHaveLength(1);
  });
});
