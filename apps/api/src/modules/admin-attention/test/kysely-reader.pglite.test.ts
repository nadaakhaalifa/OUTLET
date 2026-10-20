import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KyselyAdminAudit } from "../../admin";
import { createAdminDatabase, type PgliteLike } from "./pglite-db";
import { KyselyAuditChainReader, type AuditReadDb } from "../adapters/kysely-reader";

let pg: PgliteLike;
let reader: KyselyAuditChainReader;
let audit: KyselyAdminAudit;
const T0 = Date.UTC(2026, 9, 1);

beforeAll(async () => {
  const d = await createAdminDatabase();
  pg = d.pg;
  reader = new KyselyAuditChainReader(d.db as unknown as AuditReadDb);
  audit = new KyselyAdminAudit(d.db as never);
  for (let i = 0; i < 5; i++) {
    await audit.append({ action: `a${i}`, actorId: null, targetType: null, targetId: null, reasonCode: null, diff: { i }, requestId: null, atMs: T0 + i });
  }
});
afterAll(async () => {
  await pg.close();
});

describe("KyselyAuditChainReader over the real audit_log", () => {
  it("verifies an intact chain, with checkpoint, read-only", async () => {
    await pg.exec("select audit_chain_checkpoint('admin:2026-10')");
    const v = await reader.verify("admin:2026-10", "dpo");
    expect(v).toMatchObject({ rowsChecked: 5, headSeq: "5", checkpointsChecked: 1, problems: [] });
    expect(v.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await reader.chainLength("admin:2026-10", "dpo")).toBe(5);
    expect(await reader.chainLength("nope", "dpo")).toBe(0);
  });
  it("detects a modified row, a removed middle row and a truncated tail (superuser tamper)", async () => {
    await pg.exec("alter table audit_log disable trigger audit_log_immutable_trg");
    await pg.exec("update audit_log set action = 'forged' where chain_id = 'admin:2026-10' and seq = 2");
    let v = await reader.verify("admin:2026-10", "security");
    expect(v.problems.some((p) => p.seq === 2 && p.problem.includes("modified"))).toBe(true);
    await pg.exec("delete from audit_log where chain_id = 'admin:2026-10' and seq = 3");
    v = await reader.verify("admin:2026-10", "security");
    expect(v.problems.some((p) => p.problem.includes("gap"))).toBe(true);
    await pg.exec("delete from audit_log where chain_id = 'admin:2026-10' and seq = 5");
    v = await reader.verify("admin:2026-10", "security");
    expect(v.problems.some((p) => p.problem.includes("tail truncated"))).toBe(true);
    await pg.exec("alter table audit_log enable trigger audit_log_immutable_trg");
  });
  it("its own transactions are read only", async () => {
    const db = (reader as unknown as { db: AuditReadDb }).db;
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`select set_config('app.role', 'system', true)`.execute(trx);
        await sql`set transaction read only`.execute(trx);
        await sql`insert into audit_log (chain_id, actor_type, action) values ('y','user','z')`.execute(trx);
      }),
    ).rejects.toThrow(/read-only transaction/i);
  });
});
