import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabaseUpTo, lintMigration } from "@outlet/db";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SQL = readFileSync(fileURLToPath(new URL("../../../../../../packages/db/migrations/0051_sellers_applications.sql", import.meta.url)), "utf8");
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

const as = async <T>(role: string, userId: string, fn: () => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("select set_config('app.role',$1,true), set_config('app.user_id',$2,true), set_config('app.store_ids','',true)", [role, userId]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};
const count = async (t: string): Promise<number> => Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t}`)).rows[0]?.n);
const insertApp = (id: number, applicant: number, name: string, status = "DRAFT") =>
  `insert into brand_applications (id, applicant_id, status, brand_kind, country, brand_name, brand_name_norm)
   values ('${U(id)}','${U(applicant)}','${status}','local','EG','${name}','${name.toLowerCase()}')`;

beforeAll(async () => {
  db = await createTestDatabaseUpTo(51);
  await db.exec(`${insertApp(100, 1, "Zara")}; ${insertApp(101, 2, "Mango")};
    insert into brand_application_documents (id, application_id, applicant_id, requirement_code, content_type, size_bytes, sha256, object_key)
    values ('${U(200)}','${U(100)}','${U(1)}','tax_card','application/pdf',10,'${"a".repeat(64)}','kyc/2026/10/${U(200)}');`);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0051_sellers_applications", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });
  it("RLS: an applicant sees only their rows, review roles see all, strangers nothing", async () => {
    expect(await as("seller", U(1), () => count("brand_applications"))).toBe(1);
    expect(await as("seller", U(1), () => count("brand_application_documents"))).toBe(1);
    expect(await as("seller", U(2), () => count("brand_application_documents"))).toBe(0);
    expect(await as("seller", U(99), () => count("brand_applications"))).toBe(0);
    expect(await as("customer", U(1), () => count("brand_applications"))).toBe(0);
    expect(await as("ops", "", () => count("brand_applications"))).toBe(2);
    expect(await as("system", "", () => count("brand_applications"))).toBe(2);
  });
  it("an applicant cannot insert for someone else or touch another applicant's row", async () => {
    await expect(as("seller", U(1), () => db.query(insertApp(102, 2, "Hijack")))).rejects.toThrow();
    const upd = await as("seller", U(1), () => db.query(`update brand_applications set brand_name = 'X1' where id = '${U(101)}' returning id`));
    expect(upd.rows).toHaveLength(0);
  });
  it("one active application per (applicant, normalised name); withdrawn frees the slot", async () => {
    await expect(db.query(insertApp(103, 1, "Zara"))).rejects.toThrow(/one_active/);
    await db.exec(`update brand_applications set status = 'WITHDRAWN' where id = '${U(100)}'`);
    await db.exec(insertApp(104, 1, "Zara"));
  });
  it("constraints and guards: statuses, withdrawn is terminal, ownership immutable, object keys random-shaped", async () => {
    await expect(db.query(insertApp(105, 1, "Bad", "BOGUS"))).rejects.toThrow();
    await expect(db.query(`update brand_applications set status = 'DRAFT' where id = '${U(100)}'`)).rejects.toThrow(/withdrawn/);
    await expect(db.query(`update brand_applications set applicant_id = '${U(2)}' where id = '${U(104)}'`)).rejects.toThrow(/immutable/);
    await expect(
      db.query(`insert into brand_application_documents (id, application_id, applicant_id, requirement_code, content_type, size_bytes, sha256, object_key)
                values ('${U(201)}','${U(104)}','${U(1)}','tax_card','application/pdf',10,'${"a".repeat(64)}','kyc/user-1/passport.pdf')`),
    ).rejects.toThrow();
    await expect(
      db.query(`insert into brand_application_documents (id, application_id, applicant_id, requirement_code, content_type, size_bytes, sha256, object_key)
                values ('${U(202)}','${U(104)}','${U(1)}','tax_card','text/html',10,'${"a".repeat(64)}','kyc/2026/10/${U(202)}')`),
    ).rejects.toThrow();
  });
});
