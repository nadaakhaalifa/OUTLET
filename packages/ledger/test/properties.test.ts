import type { SqlClient } from "@outlet/db";
import { createTestClient } from "@outlet/db/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/index.js";
import { MARKET, acc, counts, draftOf } from "./fixtures.js";

let client: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ client, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});

const POOL = [
  acc("psp_clearing", "paymob"),
  acc("commission_revenue"),
  acc("platform_vat_output"),
  acc("seller_pending", "P1"),
  acc("seller_pending", "P2"),
  acc("seller_available", "P1"),
  acc("store_credit", "u1", "goodwill"),
  acc("bank_collections", "main"),
];

/** A valid draft: random signed amounts plus one balancing leg (always non-zero, so there are no zero postings). */
const validLines = fc
  .array(fc.tuple(fc.integer({ min: 0, max: POOL.length - 1 }), fc.bigInt({ min: -5_000_000_000n, max: 5_000_000_000n }).filter((n) => n !== 0n)), { minLength: 1, maxLength: 6 })
  .chain((rows) => {
    const sum = rows.reduce((a, [, n]) => a + n, 0n);
    return fc.integer({ min: 0, max: POOL.length - 1 }).map((i) => (sum === 0n ? rows : [...rows, [i, -sum] as const]));
  })
  .filter((rows) => rows.length >= 2)
  .map((rows) => rows.map(([i, n]) => [POOL[i] ?? "", n] as const));

let counter = 0;
const nextKey = (p: string): string => `${p}:${String(counter++)}`;
const snapshot = async () => Object.fromEntries(await Promise.all(POOL.map(async (c) => [c, (await Ledger.balance(client, c)).amountMinor] as const)));

describe("ledger properties (against the real schema)", () => {
  it("random valid drafts always post and the trial balance stays 0; the chain verifies", { timeout: 300_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(validLines, async (lines) => {
        const r = await client.transaction((tx) => Ledger.post(tx, draftOf({ kind: "line_closed", key: nextKey("prop-post"), lines })));
        expect(r.replayed).toBe(false);
        expect((await Ledger.trialBalance(client, MARKET, "EGP")).amountMinor).toBe(0n);
      }),
      { numRuns: 1000, verbose: fc.VerbosityLevel.Verbose },
    );
    expect(await Ledger.verifyChain(client, MARKET)).toMatchObject({ ok: true });
  });

  it("reversal(post(x)) leaves every balance unchanged and the trial balance at 0", { timeout: 300_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(validLines, async (lines) => {
        const before = await snapshot();
        const posted = await client.transaction((tx) => Ledger.post(tx, draftOf({ kind: "line_closed", key: nextKey("prop-rev"), lines })));
        await client.transaction((tx) => Ledger.reverse(tx, posted.entryId, { idempotencyKey: nextKey("prop-rev-undo"), reason: "property" }));
        expect(await snapshot()).toEqual(before);
        expect((await Ledger.trialBalance(client, MARKET, "EGP")).amountMinor).toBe(0n);
      }),
      { numRuns: 1000, verbose: fc.VerbosityLevel.Verbose },
    );
  });

  it("replaying a post inserts nothing new (rows, postings, outbox) and returns the same entry", { timeout: 300_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(validLines, fc.integer({ min: 1, max: 3 }), async (lines, replays) => {
        const step = { kind: "line_closed", key: nextKey("prop-idem"), lines };
        const first = await client.transaction((tx) => Ledger.post(tx, draftOf(step)));
        const before = await counts(client);
        const bal = await snapshot();
        for (let i = 0; i < replays; i += 1) {
          const again = await client.transaction((tx) => Ledger.post(tx, draftOf(step)));
          expect(again).toEqual({ entryId: first.entryId, replayed: true });
        }
        expect(await counts(client)).toEqual(before);
        expect(await snapshot()).toEqual(bal);
      }),
      { numRuns: 1000, verbose: fc.VerbosityLevel.Verbose },
    );
  });
});
