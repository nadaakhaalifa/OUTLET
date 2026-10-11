import { afterAll, describe, expect, it } from "vitest";
import { InMemoryAdsStore } from "../adapters/in-memory";
import { KyselyAdsStore, type AdsDb } from "../adapters/kysely-store";
import { createAdsDatabase } from "./pglite-db";
import { describeAdsStoreContract } from "./repository-contract";

const open: AdsDb[] = [];
let n = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };

describeAdsStoreContract("in-memory", async () => {
  const store = new InMemoryAdsStore();
  return { store, outboxCount: async () => store.outbox.length, topUpBalance: async () => 0n };
});

describeAdsStoreContract("kysely/pglite", async () => {
  const { pg, db } = await createAdsDatabase();
  open.push(db);
  return {
    store: new KyselyAdsStore(db, ids),
    outboxCount: async () => Number((await pg.query<{ n: string }>(`select count(*)::text as n from outbox_events`)).rows[0]?.n),
    topUpBalance: async () => 0n,
  };
});

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describe("kysely store specifics", () => {
  it("serializes concurrent billing so the budget is never overspent", async () => {
    const { db } = await createAdsDatabase();
    open.push(db);
    const store = new KyselyAdsStore(db, ids);
    const STORE = "00000000-0000-4000-8000-000000009001";
    const C = "00000000-0000-4000-8000-000000000100";
    const P = "00000000-0000-4000-8000-000000000700";
    await store.insertTopUp({ id: "00000000-0000-4000-8000-000000000300", storeId: STORE, net: 100_000n, vat: 0n, gross: 100_000n, status: "PENDING_PAYMENT", intentRef: null, idempotencyKey: "k", createdAtMs: 1, creditedAtMs: null });
    await store.creditTopUp("00000000-0000-4000-8000-000000000300", 2, []);
    await store.insertCampaign(
      { id: C, storeId: STORE, name: "Race", status: "ACTIVE", dailyBudget: 1_000n, maxCpc: 400n, keywords: [], categories: [], startsAtMs: 0, endsAtMs: null, createdAtMs: 1, updatedAtMs: 1 },
      [{ campaignId: C, productId: P, bid: 400n, createdAtMs: 1 }],
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.billClick(
          {
            id: `00000000-0000-4000-8000-00000000050${i}`,
            tokenJti: `jti-race-${i}-xxxx`,
            campaignId: C,
            storeId: STORE,
            productId: P,
            impressionId: "00000000-0000-4000-8000-000000000600",
            sessionHash: "s".repeat(64),
            valid: true,
            invalidReason: null,
            cost: 400n,
            dayKey: "2026-04-15",
            atMs: 10 + i,
            postedEntryId: null,
            creditedBack: 0n,
          },
          { dailyBudget: 1_000n },
          [],
        ),
      ),
    );
    expect(results.filter((r) => r.kind === "billed")).toHaveLength(2);
    expect(await store.getBalance(STORE)).toBe(100_000n - 800n);
  });
});
