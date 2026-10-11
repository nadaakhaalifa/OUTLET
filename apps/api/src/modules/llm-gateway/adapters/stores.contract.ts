import { describe, expect, it } from "vitest";
import type { AuditRecord, AuditStore, TokenUsageStore } from "../domain/types";

export interface StoresFixture {
  readonly audit: AuditStore;
  readonly usage: TokenUsageStore;
  readonly ensureUser: (id: string) => Promise<void>;
}

const rec = (n: number, over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  feature: "stylist",
  promptId: "stylist_rerank@1",
  promptHash: "a".repeat(64),
  model: "m1",
  tokensIn: 10,
  tokensOut: 5,
  latencyMs: 42,
  outcome: "ok",
  atMs: 1_800_000_000_000 + n * 1000,
  ...over,
});

export function describeGatewayStoresContract(name: string, make: () => Promise<StoresFixture>): void {
  describe(`gateway stores contract: ${name}`, () => {
    it("audit lists newest first per feature and round-trips", async () => {
      const f = await make();
      await f.audit.record(rec(1));
      await f.audit.record(rec(2, { outcome: "invalid_output" }));
      await f.audit.record(rec(3, { feature: "search_parse" }));
      const rows = await f.audit.list("stylist", 10);
      expect(rows.map((r) => r.id)).toEqual([rec(2).id, rec(1).id]);
      expect(rows[0]).toEqual(rec(2, { outcome: "invalid_output" }));
      expect(await f.audit.list("stylist", 1)).toHaveLength(1);
    });
    it("token usage accumulates per user, day and feature", async () => {
      const f = await make();
      const u = "00000000-0000-4000-8000-000000000011";
      await f.ensureUser(u);
      expect(await f.usage.used(u, "2026-10-11", "stylist")).toBe(0);
      await f.usage.add(u, "2026-10-11", "stylist", 100);
      await f.usage.add(u, "2026-10-11", "stylist", 50);
      await f.usage.add(u, "2026-10-12", "stylist", 7);
      await f.usage.add(u, "2026-10-11", "search_parse", 3);
      expect(await f.usage.used(u, "2026-10-11", "stylist")).toBe(150);
      expect(await f.usage.used(u, "2026-10-12", "stylist")).toBe(7);
      expect(await f.usage.used(u, "2026-10-11", "search_parse")).toBe(3);
    });
  });
}
