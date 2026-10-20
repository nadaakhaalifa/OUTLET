import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { TOKENS, bearer, createAnalyticsHarness, type AnalyticsHarness } from "./harness";
import { P1, STORE_A, ev } from "./repository-contract";

// Spec dashboard-foundations section 4, M5: unique_visitors below 50 distinct shoppers is
// suppressed (null + unique_visitors_suppressed: true) on the legacy traffic route; 50 releases.
let h: AnalyticsHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function traffic(visitors: number) {
  h = await createAnalyticsHarness();
  for (let i = 1; i <= visitors; i += 1) {
    const e = ev({ kind: "view", productId: P1, source: "feed" }, { shopper: i });
    h.source.push({ messageId: e.messageId, body: e });
  }
  await h.consumer.run(1000);
  const r = await h.http().get(`/v1/seller/stores/${STORE_A}/analytics/traffic`).set(bearer(TOKENS.ownerA));
  expect(r.status).toBe(200);
  return r.body as { unique_visitors: number | null; unique_visitors_suppressed?: boolean; product_views: number };
}

describe("M5: legacy traffic unique_visitors k >= 50", () => {
  it("49 distinct visitors: null and suppressed", async () => {
    const b = await traffic(49);
    expect(b.unique_visitors).toBeNull();
    expect(b.unique_visitors_suppressed).toBe(true);
  });
  it("50 distinct visitors: released as 50", async () => {
    const b = await traffic(50);
    expect(b.unique_visitors).toBe(50);
    expect(b.unique_visitors_suppressed).toBe(false);
  });
  it("1 visitor: never released", async () => {
    const b = await traffic(1);
    expect(b.unique_visitors).toBeNull();
  });
  it("property: a released value is always >= 50", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 70 }), async (n) => {
        const b = await traffic(n);
        await h?.close();
        h = undefined;
        if (b.unique_visitors !== null) expect(b.unique_visitors).toBeGreaterThanOrEqual(50);
        expect(b.unique_visitors === null).toBe(n < 50);
      }),
      { numRuns: 8 },
    );
  }, 60_000);
});
