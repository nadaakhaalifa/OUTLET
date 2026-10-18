import { describe, expect, it } from "vitest";
import { createClient, dataOf, operations } from "./index";

describe("planned operations are notImplemented stubs (ADR-0050)", () => {
  it("never sends a request and returns { ok: false, error: 'not_implemented' }", async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: "https://api.test",
      fetch: () => {
        calls++;
        return Promise.reject(new Error("no network expected"));
      },
    });
    const res = await client.getAdminOrderGroup({ path: { orderGroupId: "00000000-0000-7000-8000-000000000001" } });
    expect(res).toEqual({ ok: false, error: "not_implemented" });
    expect(calls).toBe(0);
    expect(() => dataOf(res)).toThrow(/not_implemented/);
  });

  it("marks exactly the planned operations and keeps their input and output types", () => {
    expect(operations.getAdminOrderGroup.planned).toBe(true);
    expect(operations.getAdminAttention.planned).toBe(false);
    expect(operations.approveAdminRefund.planned).toBe(true);
    expect(operations.getSellerAnalyticsSummary.planned).toBe(true);
    expect(operations.getSellerStoreMe.planned).toBe(false);
    expect(operations.createCheckout.planned).toBe(false);
  });
});
