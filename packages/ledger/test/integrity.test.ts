import type { SqlClient } from "@outlet/db";
import { createTestClient } from "@outlet/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger, integrityScan, snapshotDigest } from "../src/index.js";
import { MARKET, acc, cr, dr, draftOf } from "./fixtures.js";

let client: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => { ({ client, close } = await createTestClient()); });
afterAll(async () => { await close(); });

describe("integrityScan", () => {
  it("an empty market is balanced with no totals; the digest is stable", async () => {
    const a = await integrityScan(client, MARKET, "2030-01-01");
    expect(a).toMatchObject({ totals: [], unbalanced: [], unbalancedTotal: 0, balanced: true, chain: { ok: true, entries: 0 } });
    expect((await integrityScan(client, MARKET, "2030-01-01")).snapshotSha256).toBe(a.snapshotSha256);
  });

  it("balanced postings: totals 0 per currency, chain head in the digest; the digest changes with the day and with the chain", async () => {
    const before = await integrityScan(client, MARKET, "2030-01-01");
    await client.transaction((tx) => Ledger.post(tx, draftOf({ kind: "order_recognised", key: "int-1", lines: [dr(acc("psp_clearing", "paymob"), 100n), cr(acc("seller_pending", "S1"), 100n)] })));
    const s = await integrityScan(client, MARKET, "2030-01-01");
    expect(s.balanced).toBe(true);
    expect(s.totals).toEqual([{ currency: "EGP", totalMinor: 0n }]);
    expect(s.chain.ok && s.chain.entries).toBe(1);
    expect(s.snapshotSha256).not.toBe(before.snapshotSha256);
    expect((await integrityScan(client, MARKET, "2030-01-02")).snapshotSha256).not.toBe(s.snapshotSha256);
  });
});

describe("snapshotDigest", () => {
  const ok = { ok: true, entries: 1, headHash: "a".repeat(64) } as const;
  it("is independent of currency order and distinguishes a broken chain from a healthy one", () => {
    const t = [{ currency: "EGP", totalMinor: 0n }, { currency: "USD", totalMinor: 0n }];
    expect(snapshotDigest("EG", "2030-01-01", t, ok)).toBe(snapshotDigest("EG", "2030-01-01", [...t].reverse(), ok));
    expect(snapshotDigest("EG", "2030-01-01", t, { ok: false, entryId: "x", chainSeq: 1n, reason: "r" })).not.toBe(snapshotDigest("EG", "2030-01-01", t, ok));
    expect(snapshotDigest("EG", "2030-01-01", [{ currency: "EGP", totalMinor: 1n }], ok)).not.toBe(snapshotDigest("EG", "2030-01-01", [{ currency: "EGP", totalMinor: 0n }], ok));
  });
});
