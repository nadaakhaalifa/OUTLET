import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createReconHarness, adminActor, sellerActor, shopperActor, type ReconHarness } from "./harness";
import { DAY, FINANCE, OPS, T0, U, csv } from "./fixtures";

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const PATH = "/v1/admin/finance/reconciliation/summary";
const T = {
  finance: "token-admin-finance-00001",
  ops: "token-admin-ops-0000000001",
  support: "token-admin-support-000001",
  marketing: "token-admin-marketing-0001",
  seller: "token-seller-on-admin-aud-1",
  shopper: "token-shopper-on-admin-aud-1",
};
const SOURCES = ["psp_settlement", "cod_remittance", "bnpl_settlement", "eta_submission", "store_credit", "trial_balance", "run"];

let h: ReconHarness;

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createReconHarness();
  h.financeViewsFlag.on = true;
  const t = h.tokens;
  t.add(T.finance, { actor: adminActor(FINANCE, "finance"), aud: "admin_api" });
  t.add(T.ops, { actor: adminActor(OPS, "ops"), aud: "admin_api" });
  t.add(T.support, { actor: adminActor(U(42), "support"), aud: "admin_api" });
  t.add(T.marketing, { actor: adminActor(U(49), "marketing"), aud: "admin_api" });
  t.add(T.seller, { actor: sellerActor(U(47), "00000000-0000-4000-a000-00000000000a"), aud: "admin_api" });
  t.add(T.shopper, { actor: shopperActor(U(48)), aud: "admin_api" });
  const k = h.kit;
  await k.ingest.execute({
    kind: "psp",
    provider: "fakepay",
    format: "fixture_csv_v1",
    content: csv("S1", [{ no: 1, ref: "ref-1", gross: 10_000n, fee: 250n, at: T0 - 2 * DAY }]),
  });
  k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: T0 - 2 * DAY });
  k.clearing.post("psp", "fakepay", "S1", 10_000n, 250n);
  k.clearing.addLine("psp", "fakepay", { id: "l1", key: "ref-1", amount: 10_000n, atMs: T0 - 2 * DAY });
  await k.runner.execute("nightly");
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const get = (token: string | null, headers: Record<string, string> = {}) => {
  let r = h.http().get(PATH).set(headers);
  if (token !== null) r = r.set(bearer(token));
  return r;
};

describe("reconciliation summary additions (B-2)", () => {
  it("is never cached", async () => {
    expect((await get(T.finance)).headers["cache-control"]).toBe("private, no-store");
  });

  it("keeps the previous shape while release.admin.finance_views is blocked", async () => {
    h.financeViewsFlag.on = false;
    const r = await get(T.finance);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("by_source");
    expect(r.body).not.toHaveProperty("aging");
    expect(r.body).not.toHaveProperty("rails");
    expect(r.body).not.toHaveProperty("unmatched_over_3d");
  });

  it("reports every source, and bucket sums equal open + escalated per source", async () => {
    const r = await get(T.finance);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.aging)).toEqual(SOURCES);
    let total = 0;
    for (const src of SOURCES) {
      const a = r.body.aging[src] as { lt_1d: number; d1_3: number; gt_3d: number };
      const n = a.lt_1d + a.d1_3 + a.gt_3d;
      expect(n).toBe((r.body.by_source[src] ?? 0) as number);
      total += n;
    }
    expect(total).toBe(r.body.open + r.body.escalated);
  });

  it("puts exactly 72 h in d1_3 and one millisecond more in gt_3d (and unmatched_over_3d follows)", async () => {
    const list = await h.http().get("/v1/admin/finance/reconciliation/tickets").set(bearer(T.finance));
    const orphan = list.body.items.find((x: { kind: string }) => x.kind === "unmatched_internal");
    const itemAt = Date.parse(orphan.item_at as string);
    h.clock.set(itemAt + 24 * 3_600_000 - 1);
    expect((await get(T.finance)).body.aging.psp_settlement.lt_1d).toBeGreaterThanOrEqual(1);
    h.clock.set(itemAt + 24 * 3_600_000);
    const day1 = (await get(T.finance)).body;
    expect(day1.aging.psp_settlement.d1_3).toBeGreaterThanOrEqual(1);
    h.clock.set(itemAt + 3 * DAY);
    const edge = (await get(T.finance)).body;
    expect(edge.aging.psp_settlement.d1_3).toBeGreaterThanOrEqual(1);
    h.clock.set(itemAt + 3 * DAY + 1);
    const over = (await get(T.finance)).body;
    expect(over.aging.psp_settlement.gt_3d).toBeGreaterThanOrEqual(1);
    expect(over.unmatched_over_3d).toBe(
      over.aging.psp_settlement.gt_3d + over.aging.cod_remittance.gt_3d + over.aging.bnpl_settlement.gt_3d + over.aging.eta_submission.gt_3d,
    );
    expect(over.unmatched_over_3d).toBeGreaterThan(edge.unmatched_over_3d);
  });

  it("reports rails honestly: files received, and unconfigured unless the registry says otherwise", async () => {
    const r = await get(T.finance);
    const rails = Object.fromEntries((r.body.rails as { source: string; last_file_at: string | null }[]).map((x) => [x.source, x]));
    expect(Object.keys(rails)).toEqual(["psp_settlement", "cod_remittance", "bnpl_settlement", "eta_submission"]);
    expect(rails["psp_settlement"]).toMatchObject({ files_received: 1, input: "unconfigured" });
    expect(rails["psp_settlement"]?.last_file_at).not.toBeNull();
    expect(rails["cod_remittance"]).toMatchObject({ files_received: 0, last_file_at: null, input: "unconfigured" });
    // ETA submissions are API based: no file count is claimed.
    expect(rails["eta_submission"]).toMatchObject({ files_received: null, last_file_at: null });
    h.railInputs.value = { psp_settlement: "configured" };
    const again = await get(T.finance);
    expect((again.body.rails as { source: string; input: string }[]).find((x) => x.source === "psp_settlement")?.input).toBe("configured");
    expect((again.body.rails as { source: string; input: string }[]).find((x) => x.source === "cod_remittance")?.input).toBe("unconfigured");
  });

  it("keeps the same authorization: finance and ops read; others get 401/403 and the audit trail records it", async () => {
    expect((await get(T.ops)).status).toBe(200);
    for (const t of [T.support, T.marketing, T.seller, T.shopper]) expect((await get(t)).status).toBe(403);
    expect((await get(null)).status).toBe(401);
    const before = h.audit.entries.length;
    await get(T.finance);
    expect(h.audit.entries.length).toBeGreaterThan(before);
  });
});
