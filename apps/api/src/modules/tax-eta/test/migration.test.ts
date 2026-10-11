import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);
const SQL = readFileSync(fileURLToPath(new URL("0027_tax_eta.sql", DIR)), "utf8");
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";
const DOC = `{"kind":"seller_einvoice"}`;

let db: PGlite;

const as = async <X>(userId: string, fn: () => Promise<X>, opts: { role?: string; stores?: string } = {}): Promise<X> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true), set_config('app.store_ids', $3, true)", [
      userId,
      opts.role ?? "customer",
      opts.stores ?? "",
    ]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const insertDoc = (n: number, kind: string, store: string | null, user: string | null, over: Record<string, string> = {}) =>
  db.query(
    `INSERT INTO tax_documents (id, internal_id, kind, source_ref, store_id, user_id, issuer_name_ar, recipient_name_ar,
                                net_amount, vat_amount, gross_amount, document, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'متجر', 100, 14, $8, $9::jsonb, now())`,
    [U(n), `INV-${n}`, kind, `src-${n}`, store, user, over.issuer ?? "زد أوتلت", over.gross ?? "114", DOC],
  );

const count = async (table: string): Promise<string | undefined> =>
  (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]?.n;

beforeAll(async () => {
  db = new PGlite();
  const names = readdirSync(fileURLToPath(DIR)).filter((f) => /^00(0[1-9]|1[01])_/.test(f)).sort();
  const base = names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8")));
  await migrate(withoutConcurrently(db), base);
  await db.exec(SQL);
  await db.exec(`INSERT INTO users (id, status) VALUES ('${U(1)}', 'active'), ('${U(2)}', 'active')`);
  await insertDoc(101, "seller_einvoice", STORE_A, null);
  await insertDoc(102, "seller_einvoice", STORE_B, null);
  await insertDoc(103, "shopper_ereceipt", null, U(1));
  await db.query(
    `INSERT INTO eta_submissions (document_id, internal_id) SELECT id, internal_id FROM tax_documents`,
  );
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0027_tax_eta", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("enforces Arabic names, balance, party shape and uniqueness", async () => {
    await expect(insertDoc(110, "seller_einvoice", STORE_A, null, { issuer: "Z-OUTLET" })).rejects.toThrow(/check/i);
    await expect(insertDoc(111, "seller_einvoice", STORE_A, null, { gross: "115" })).rejects.toThrow(/balance|check/i);
    await expect(insertDoc(112, "shopper_ereceipt", STORE_A, null)).rejects.toThrow(/party|check/i);
    await expect(insertDoc(101, "seller_einvoice", STORE_A, null)).rejects.toThrow(/unique|duplicate/i);
    await expect(db.query(`UPDATE tax_categories SET name_ar = 'English' WHERE code = 'standard'`)).rejects.toThrow(/check/i);
  });

  it("documents and signed documents are append-only", async () => {
    await expect(db.query(`UPDATE tax_documents SET gross_amount = 1 WHERE id = $1`, [U(101)])).rejects.toThrow(/append-only/i);
    await expect(db.query(`DELETE FROM tax_documents WHERE id = $1`, [U(101)])).rejects.toThrow(/append-only/i);
  });

  it("an accepted submission needs an ETA uuid", async () => {
    await expect(db.query(`UPDATE eta_submissions SET state = 'ACCEPTED' WHERE document_id = $1`, [U(101)])).rejects.toThrow(/check/i);
    await expect(db.query(`UPDATE eta_submissions SET state = 'BOGUS' WHERE document_id = $1`, [U(101)])).rejects.toThrow(/check/i);
  });

  it("RLS: a store sees only its own documents, a shopper only own receipts, finance everything, strangers nothing", async () => {
    const own = async (stores: string, role: string, user = U(50)) =>
      as(user, async () => (await db.query<{ id: string }>("SELECT id FROM tax_documents ORDER BY id")).rows.map((r) => r.id), { role, stores });
    expect(await own(STORE_A, "seller")).toEqual([U(101)]);
    expect(await own(STORE_B, "seller")).toEqual([U(102)]);
    expect(await own("", "customer", U(1))).toEqual([U(103)]);
    expect(await own("", "customer", U(2))).toEqual([]);
    expect((await own("", "finance")).length).toBe(3);
    expect((await own("", "support")).length).toBe(0);
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app_user");
    expect(await count("tax_documents")).toBe("0");
    await db.exec("ROLLBACK");
  });

  it("RLS: submissions follow the document, writes are system/finance only", async () => {
    const seen = (stores: string, role: string) => as(U(50), () => count("eta_submissions"), { role, stores });
    expect(await seen(STORE_A, "seller")).toBe("1");
    expect(await seen("", "customer")).toBe("0");
    expect(await seen("", "finance")).toBe("3");
    const upd = await as(U(50), () => db.query(`UPDATE eta_submissions SET attempts = 1 WHERE document_id = $1`, [U(101)]), { role: "seller", stores: STORE_A });
    expect(upd.affectedRows).toBe(0);
    await expect(as(U(50), () => insertDoc(120, "seller_einvoice", STORE_A, null), { role: "seller", stores: STORE_A })).rejects.toThrow(/row-level security/i);
    const sys = await as(U(50), () => db.query(`UPDATE eta_submissions SET attempts = 1 WHERE document_id = $1`, [U(101)]), { role: "system" });
    expect(sys.affectedRows).toBe(1);
  });

  it("RLS: tax categories are readable by any authenticated role but writable only by finance/system; audit is append-only", async () => {
    expect(await as(U(50), () => count("tax_categories"), { role: "customer" })).toBe("5");
    const nope = await as(U(50), () => db.query(`UPDATE tax_categories SET version = 9 WHERE code = 'standard'`), { role: "seller", stores: STORE_A });
    expect(nope.affectedRows).toBe(0);
    await db.query(
      `INSERT INTO tax_exemption_audit (category_code, actor_id, action, reason, version_before, version_after)
       VALUES ('standard', $1, 'exemption_set', 'because', 0, 1)`,
      [U(9)],
    );
    await expect(db.query(`DELETE FROM tax_exemption_audit`)).rejects.toThrow(/append-only/i);
    expect(await as(U(50), () => count("tax_exemption_audit"), { role: "customer" })).toBe("0");
    expect(await as(U(50), () => count("tax_exemption_audit"), { role: "finance" })).toBe("1");
  });
});
