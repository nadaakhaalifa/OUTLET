import { describe, expect, it } from "vitest";
import { subBalanceStates } from "./credit-balances";

describe("F-11 subBalanceStates plans only from lots spendable at now", () => {
  const lot = (id: string, remaining: bigint, held: bigint, expiresAtMs: number | null) => ({
    id,
    userId: "u",
    sub: { kind: "goodwill" as const },
    granted: remaining,
    remaining,
    held,
    expiresAtMs,
    createdAtMs: 0,
  });
  it("excludes expired lots and held amounts", () => {
    const out = subBalanceStates([lot("a", 1_000n, 200n, null), lot("b", 5_000n, 0n, 500)], 1_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.balance.amount).toBe(800n);
  });
});
