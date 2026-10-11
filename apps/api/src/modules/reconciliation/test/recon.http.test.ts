import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createReconHarness, adminActor, sellerActor, shopperActor, type ReconHarness } from "./harness";
import { DAY, FINANCE, OPS, T0, U, csv } from "./fixtures";

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const T = {
  finance: "token-admin-finance-00001",
  ops: "token-admin-ops-0000000001",
  support: "token-admin-support-000001",
  dpo: "token-admin-dpo-0000000001",
  noPasskey: "token-admin-finance-nopass",
  noScope: "token-admin-finance-noscope",
  suspended: "token-admin-finance-suspend",
  seller: "token-seller-on-admin-aud-1",
  sellerAud: "token-finance-on-seller-aud-1",
  shopper: "token-shopper-on-admin-aud-1",
};
const MISSING = U(0xdead);

let h: ReconHarness;
let ticketId = "";

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createReconHarness();
  const t = h.tokens;
  t.add(T.finance, { actor: adminActor(FINANCE, "finance"), aud: "admin_api" });
  t.add(T.ops, { actor: adminActor(OPS, "ops"), aud: "admin_api" });
  t.add(T.support, { actor: adminActor(U(42), "support"), aud: "admin_api" });
  t.add(T.dpo, { actor: adminActor(U(43), "dpo"), aud: "admin_api" });
  t.add(T.noPasskey, { actor: adminActor(U(44), "finance", { assurance: "basic" }), aud: "admin_api" });
  t.add(T.noScope, { actor: adminActor(U(45), "finance", { tokenScopes: [] }), aud: "admin_api" });
  t.add(T.suspended, { actor: adminActor(U(46), "finance", { status: "suspended" }), aud: "admin_api" });
  t.add(T.seller, { actor: sellerActor(U(47), "00000000-0000-4000-a000-00000000000a"), aud: "admin_api" });
  t.add(T.sellerAud, { actor: adminActor(FINANCE, "finance"), aud: "seller_api" });
  t.add(T.shopper, { actor: shopperActor(U(48)), aud: "admin_api" });

  const k = h.kit;
  await k.ingest.execute({
    kind: "psp",
    provider: "fakepay",
    format: "fixture_csv_v1",
    content: csv("S1", [{ no: 1, ref: "ref-1", gross: 10_000n, fee: 250n, at: T0 - 2 * DAY }]),
  });
  await k.ingest.execute({ kind: "cod", provider: "bosta", format: "fixture_csv_v1", content: "garbage" });
  k.clearing.addLine("psp", "fakepay", { id: "orphan", key: "ref-9", amount: 777n, atMs: T0 - 2 * DAY });
  k.clearing.post("psp", "fakepay", "S1", 10_000n, 250n);
  k.clearing.addLine("psp", "fakepay", { id: "l1", key: "ref-1", amount: 10_000n, atMs: T0 - 2 * DAY });
  await k.runner.execute("nightly");
  ticketId = (await h.store.listTickets({ after: null, limit: 10 })).items.find((x) => x.kind === "unmatched_internal")?.id ?? "";
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const get = (path: string, token: string | null) => {
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  return r;
};

const PATHS = [
  "/v1/admin/finance/reconciliation/summary",
  "/v1/admin/finance/reconciliation/tickets",
  "/v1/admin/finance/reconciliation/runs",
  "/v1/admin/finance/reconciliation/files",
];

describe("finance reconciliation read model", () => {
  it("shows the summary with severity, source and aging", async () => {
    const r = await get(PATHS[0] as string, T.finance);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      open: 2,
      escalated: 0,
      by_severity: { critical: 0, high: 1, medium: 1 },
      rejected_files: 1,
    });
    expect(r.body.last_run).toMatchObject({ mode: "nightly", finding_count: 2 });
    expect(r.body.oldest_item_at).toBe(new Date(T0 - 2 * DAY).toISOString());
  });

  it("lists, filters and paginates tickets and reads one", async () => {
    const all = await get(PATHS[1] as string, T.ops);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0]).toMatchObject({ amount_delta: { currency: "EGP" } });
    const high = await get(`${PATHS[1]}?severity=high`, T.finance);
    expect(high.body.items.map((x: { kind: string }) => x.kind)).toEqual(["file_rejected"]);
    const page = await get(`${PATHS[1]}?limit=1`, T.finance);
    expect(page.body.page.has_more).toBe(true);
    const next = await get(`${PATHS[1]}?limit=1&cursor=${page.body.page.next_cursor}`, T.finance);
    expect(next.body.items).toHaveLength(1);
    const one = await get(`${PATHS[1]}/${ticketId}`, T.finance);
    expect(one.status).toBe(200);
    expect(one.body.kind).toBe("unmatched_internal");
    expect((await get(`${PATHS[1]}/${MISSING}`, T.finance)).status).toBe(404);
    expect((await get(`${PATHS[1]}/not-a-uuid`, T.finance)).status).toBe(400);
  });

  it("lists runs and files without exposing file lines", async () => {
    const runs = await get(PATHS[2] as string, T.finance);
    expect(runs.body.items).toHaveLength(1);
    const files = await get(PATHS[3] as string, T.finance);
    expect(files.body.items.map((f: { status: string }) => f.status).sort()).toEqual(["parsed", "rejected"]);
    expect(JSON.stringify(files.body)).not.toContain("provider_ref");
  });

  it("validates query strings", async () => {
    expect((await get(`${PATHS[1]}?status=bogus`, T.finance)).status).toBe(400);
    expect((await get(`${PATHS[1]}?limit=0`, T.finance)).status).toBe(400);
    expect((await get(`${PATHS[1]}?cursor=%%%`, T.finance)).status).toBe(400);
    expect((await get(`${PATHS[1]}?x=1`, T.finance)).status).toBe(400);
  });

  it("negative authorization on every route", async () => {
    for (const p of [...PATHS, `${PATHS[1]}/${ticketId}`]) {
      expect((await get(p, null)).status).toBe(401);
      expect((await get(p, T.sellerAud)).status).toBe(401);
      for (const t of [T.support, T.dpo, T.noPasskey, T.noScope, T.suspended, T.seller, T.shopper]) {
        expect((await get(p, t)).status).toBe(403);
      }
    }
  });

  it("is read only: there is no write route", async () => {
    for (const p of PATHS) {
      const r = await h.http().post(p).set(bearer(T.finance)).set("Idempotency-Key", "0192f3a4-5b6c-7d8e-9f01-000000000001").send({});
      expect([404, 405]).toContain(r.status);
    }
  });
});
