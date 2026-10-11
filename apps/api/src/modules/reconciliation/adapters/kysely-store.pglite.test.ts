import { afterAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyReconStore, type ReconDb } from "./kysely-store";
import { describeReconScenarios } from "../test/scenarios";
import { createReconDatabase } from "../test/db";
import { TestClock, csv, kit, T0, DAY } from "../test/fixtures";

const open: Kysely<Record<string, never>>[] = [];

const fresh = async () => {
  const raw = await createReconDatabase();
  const db: ReconDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  return {
    raw,
    store: new KyselyReconStore(db),
    clock: new TestClock(),
    outboxTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, ctid`)).rows.map((r) => r.t),
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeReconScenarios("kysely/pglite", fresh);

describe("KyselyReconStore specifics", () => {
  it("keeps files, lines, run, tickets and outbox events from one run together, and files are immutable", async () => {
    const c = await fresh();
    const k = kit(c.store, c.clock);
    await k.ingest.execute({
      kind: "psp",
      provider: "fakepay",
      format: "fixture_csv_v1",
      content: csv("S1", [{ no: 1, ref: "r1", gross: 100n, at: T0 - 2 * DAY }]),
    });
    k.clearing.post("psp", "fakepay", "S1", 100n, 0n);
    await k.runner.execute("nightly");
    const files = await c.raw.query<{ n: string }>(`select count(*)::text as n from settlement_file_lines`);
    expect(files.rows[0]?.n).toBe("1");
    await expect(c.raw.query(`update settlement_file_lines set gross = 1`)).rejects.toThrow(/append-only/);
    await expect(c.raw.query(`delete from settlement_files`)).rejects.toThrow(/append-only/);
    const t = await c.raw.query<{ n: string }>(`select count(*)::text as n from recon_tickets`);
    expect(Number(t.rows[0]?.n)).toBe(1); // r1 has no ledger line: unmatched_external
  });
});
