import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgePlan } from "../src/index.js";
import { setupEnv, T0 } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await env.close();
});
const DAY = 86_400_000;

describe("purgePlan", () => {
  it("seeds the B1 policies and flags unconfirmed ones", async () => {
    const plan = await purgePlan(env.client, new Date(T0));
    const codes = plan.map((p) => p.policyCode);
    expect(codes).toEqual(
      expect.arrayContaining(["tax_records_orders", "tax_records_invoices", "analytics_25m", "support_chats_2y", "raw_webhooks_financial", "otp_24h", "rate_limit_48h"]),
    );
    expect(plan.find((p) => p.policyCode === "tax_records_orders")?.verifyRef).toBe("V71");
    expect(plan.find((p) => p.policyCode === "otp_24h")?.verifyRef).toBeNull();
    // Tables owned by later modules are reported as absent, never queried.
    const orders = plan.find((p) => p.policyCode === "tax_records_orders");
    expect(orders).toMatchObject({ tableExists: false, dueCount: 0 });
  });

  it("counts only rows past the cutoff in existing tables", async () => {
    const old = new Date(T0 - 3 * DAY);
    const fresh = new Date(T0 - 1 * 3_600_000);
    await env.client.query("INSERT INTO rate_limit_hits (key, hit_at) VALUES ('a',$1),('b',$1),('c',$2)", [old, fresh]);
    const item = (await purgePlan(env.client, new Date(T0))).find((p) => p.policyCode === "rate_limit_48h");
    expect(item).toMatchObject({ tableExists: true, dueCount: 2, action: "delete", table: "rate_limit_hits" });
    expect(item?.cutoff.getTime()).toBe(T0 - 2 * DAY);
    // moving "now" forward makes the fresh row due too
    const later = (await purgePlan(env.client, new Date(T0 + 3 * DAY))).find((p) => p.policyCode === "rate_limit_48h");
    expect(later?.dueCount).toBe(3);
  });

  it("treats a policy with an unsafe identifier as not applicable", async () => {
    await env.client.query("ALTER TABLE retention_policies DROP CONSTRAINT retention_policies_table_name_check");
    await env.client.query("INSERT INTO retention_policies VALUES ('evil','users; drop','created_at', interval '1 day','delete',NULL,'x')");
    const evil = (await purgePlan(env.client, new Date(T0))).find((p) => p.policyCode === "evil");
    expect(evil).toMatchObject({ tableExists: false, dueCount: 0 });
  });
});
