import { describe, expect, it } from "vitest";
import { sha256Hex } from "@outlet/idempotency";
import { IntegrityJob } from "../application/integrity-job";
import { InMemoryLedger } from "../adapters/in-memory";
import type { ProjectionSource } from "../domain/ports";

type Row = { userId: string; sub: string; balance: bigint };

/** Serves a different projection on each read, to model a grant landing around the snapshot. */
const sequence = (...reads: Row[][]): ProjectionSource => {
  let n = 0;
  return {
    rows: async () => reads[Math.min(n++, reads.length - 1)] ?? [],
  };
};

describe("F-12: integrity job tolerates a projection change in flight", () => {
  const user = "00000000-0000-4000-8000-0000000000c1";
  const store = new InMemoryLedger();
  // an empty ledger: any projected balance is a difference unless the second read agrees
  it("does not report drift when only one of the two projection reads differs from the ledger", async () => {
    const job = new IntegrityJob({
      snapshots: store,
      projection: sequence([{ userId: user, sub: "goodwill", balance: 0n }], [{ userId: user, sub: "goodwill", balance: 0n }]),
      sha256: sha256Hex,
    });
    expect((await job.run()).ok).toBe(true);
    const inflight = new IntegrityJob({
      snapshots: store,
      projection: sequence([], [{ userId: user, sub: "goodwill", balance: 5_000n }]),
      sha256: sha256Hex,
    });
    expect((await inflight.run()).storeCredit.drift).toEqual([]);
  });

  it("still reports drift that persists across both reads", async () => {
    const same = [{ userId: user, sub: "goodwill", balance: 5_000n }];
    const job = new IntegrityJob({ snapshots: store, projection: sequence(same, same), sha256: sha256Hex });
    const r = await job.run();
    expect(r.ok).toBe(false);
    expect(r.storeCredit.drift).toHaveLength(1);
  });
});
