import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/sql.js";
import { createTestClient } from "../src/testing.js";

// Migration 0042: keyset list indexes for the admin ops lists and the covering trial-balance index. Existence is asserted always; the planner
// assertions run on a seeded 2k-row table with the exact WHERE / ORDER BY shapes of apps/api ops-lists.ts.

let c: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ client: c, close } = await createTestClient());
}, 60_000);
afterAll(async () => {
  await close();
});

const INDEXES: readonly [table: string, name: string][] = [
  ["refunds", "refunds_market_created_idx"],
  ["refunds", "refunds_market_status_created_idx"],
  ["payouts", "payouts_market_created_idx"],
  ["payouts", "payouts_market_status_created_idx"],
  ["return_requests", "return_requests_pipeline_created_idx"],
  ["disputes", "disputes_open_created_idx"],
  ["disputes", "disputes_market_status_created_idx"],
  ["postings", "postings_market_currency_amount_idx"],
];

describe("0042 indexes", () => {
  it.each(INDEXES)("%s has %s", async (table, name) => {
    const r = await c.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2", [table, name]);
    expect(r.rows).toHaveLength(1);
  });

  it("the trial-balance index covers amount_minor", async () => {
    const r = await c.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'postings_market_currency_amount_idx'");
    expect(r.rows[0]?.indexdef).toMatch(/\(market_id, currency\) INCLUDE \(amount_minor\)/);
  });

  // Planner check: with seqscan disabled the keyset query must walk the new index with no Sort node.
  it("the refunds keyset query uses the new index and needs no Sort", async () => {
    await c.query("SET enable_seqscan = off");
    const plan = await c.query<{ "QUERY PLAN": string }>(
      "EXPLAIN SELECT id FROM refunds WHERE market_id = 'EG' AND (created_at, id) < ('2030-01-01'::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid) ORDER BY created_at DESC, id DESC LIMIT 51",
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/refunds_market_created_idx/);
    expect(text).not.toMatch(/Sort/);
    await c.query("RESET enable_seqscan");
  });
});
