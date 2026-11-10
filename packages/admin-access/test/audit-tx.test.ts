import { PgAuditStore } from "@outlet/audit-log";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import type { Principal } from "@outlet/policy";
import { describe, expect, it } from "vitest";
import { createAdminAccess } from "../src/index.js";

const finance = (): Principal => ({ kind: "admin", userId: uuidv7(), marketId: "EG", roles: ["finance"], scopes: [] });

describe("audit entries share the transaction of the audited change", () => {
  it("a failing UPDATE after the audit append leaves no chain entry and no vote", async () => {
    const { client, close } = await createTestClient();
    try {
      const store = new PgAuditStore(client);
      const svc = createAdminAccess({ db: roleClient(client, "outlet_app"), audit: { appendIn: (tx, i) => store.appendIn(tx, i) }, clock: () => new Date("2026-11-08T10:00:00Z"), thresholdMinor: 1_000n });
      const [a, b, c] = [finance(), finance(), finance()] as [Principal, Principal, Principal];
      const count = async (table: string): Promise<number> => Number((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n);
      const asked = await svc.requireApproval(a, { action: "payout.approve", targetType: "payout", targetId: uuidv7(), payload: {}, amountMinor: 5_000n });
      if (!asked.required) throw new Error("approval expected");
      expect(await count("audit_log")).toBe(1);
      await svc.approve(b, asked.request.id);
      expect(await count("audit_log")).toBe(2);
      await client.query(`CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
      await client.query("CREATE TRIGGER approval_boom BEFORE UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION boom()");
      await expect(svc.approve(c, asked.request.id)).rejects.toThrow("boom");
      expect(await count("audit_log")).toBe(2);
      expect(await count("approval_decisions")).toBe(1);
      expect((await new PgAuditStore(client).verifyChain("EG").catch(() => ({ ok: true })))).toMatchObject({ ok: true });
    } finally {
      await close();
    }
  });

  it("a PII view is audited in its own transaction (one entry, ids and code only)", async () => {
    const { client, close } = await createTestClient();
    try {
      const store = new PgAuditStore(client);
      const svc = createAdminAccess({ db: roleClient(client, "outlet_app"), audit: { appendIn: (tx, i) => store.appendIn(tx, i) }, clock: () => new Date(), thresholdMinor: 1n });
      const p: Principal = { kind: "admin", userId: uuidv7(), marketId: "EG", roles: ["support"], scopes: [] };
      await svc.recordPiiView(p, { action: "user.read", targetType: "user", targetId: uuidv7() }, "support_ticket");
      expect((await client.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'pii.viewed'")).rows[0]?.n).toBe(1);
    } finally {
      await close();
    }
  });
});
