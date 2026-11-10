import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext } from "@outlet/db";
import { OnboardingExistsError } from "../src/index.js";
import { buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.close();
});

describe("one live onboarding case per applicant", () => {
  it("second createDraft is onboarding_exists with the first ids; a REJECTED case allows a new draft", async () => {
    const u = await w.user();
    const first = await w.onboarding.createDraft(u, { legal_type: "sole_trader" });
    const err: unknown = await w.onboarding.createDraft(u, { legal_type: "company" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnboardingExistsError);
    expect(err).toMatchObject({ code: "onboarding_exists", sellerId: first.sellerId, caseId: first.caseId, details: [first.sellerId, first.caseId] });
    // only the first seller exists
    expect((await w.raw.query("SELECT 1 FROM kyc_cases WHERE applicant_user_id = $1", [u])).rows).toHaveLength(1);
    await w.raw.query("UPDATE kyc_cases SET state = 'REJECTED', submitted_at = now(), decided_at = now(), decided_by = $2 WHERE id = $1", [first.caseId, u]);
    const second = await w.onboarding.createDraft(u, { legal_type: "sole_trader" });
    expect(second.caseId).not.toBe(first.caseId);
  });

  it("the partial unique index also stops a racing insert (constraint path)", async () => {
    const u = await w.user();
    const [a, b] = await Promise.allSettled([w.onboarding.createDraft(u, { legal_type: "sole_trader" }), w.onboarding.createDraft(u, { legal_type: "sole_trader" })]);
    const ok = [a, b].filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect((await w.raw.query("SELECT 1 FROM kyc_cases WHERE applicant_user_id = $1", [u])).rows).toHaveLength(1);
  });
});

describe("draft runs under the applicant's own app context", () => {
  it("a shopper cannot read another applicant's case or seller-bound rows; direct seller INSERT stays refused", async () => {
    const u1 = await w.user();
    const u2 = await w.user();
    const c1 = await w.onboarding.createDraft(u1, { legal_type: "sole_trader" });
    const seen = await withDbContext(w.app, { kind: "user", marketId: "EG", userId: u2 }, (tx) => tx.query("SELECT id FROM kyc_cases WHERE id = $1", [c1.caseId]));
    expect(seen.rows).toHaveLength(0);
    await expect(
      withDbContext(w.app, { kind: "user", marketId: "EG", userId: u2 }, (tx) =>
        tx.query("INSERT INTO kyc_cases (id, seller_id, market_id, applicant_user_id) VALUES (gen_random_uuid(), $1, 'EG', $2)", [c1.sellerId, u1]),
      ),
    ).rejects.toThrow();
    await expect(
      withDbContext(w.app, { kind: "user", marketId: "EG", userId: u2 }, (tx) => tx.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type) VALUES (gen_random_uuid(),'EG','EG','company')")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withDbContext(w.app, { kind: "user", marketId: "EG" }, (tx) => tx.query("SELECT create_seller_draft(gen_random_uuid(),gen_random_uuid(),'company',null,null,null,null,null,null,now())")),
    ).rejects.toThrow(/bound user/);
    // Chief-review fix 6/7: the case row is written only by the function (no direct INSERT), and the function refuses the store context.
    await expect(
      withDbContext(w.app, { kind: "user", marketId: "EG", userId: u2 }, (tx) =>
        tx.query("INSERT INTO kyc_cases (id, seller_id, market_id, applicant_user_id) VALUES (gen_random_uuid(), gen_random_uuid(), 'EG', $1)", [u2])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withDbContext(w.app, { kind: "store", marketId: "EG", userId: u2, storeId: "00000000-0000-4000-8000-000000000001" }, (tx) =>
        tx.query("SELECT create_seller_draft(gen_random_uuid(),gen_random_uuid(),'company',null,null,null,null,null,null,now())")),
    ).rejects.toThrow(/user context/);
  });

  it("clamps a post-dated clock to now() so a seller draft cannot be created in the future", async () => {
    const u3 = await w.user();
    const sellerId = randomUUID();
    await withDbContext(w.app, { kind: "user", marketId: "EG", userId: u3 }, (tx) =>
      tx.query("SELECT create_seller_draft($1,$2,'company',null,null,null,null,null,null, now() + interval '7 days')", [sellerId, randomUUID()]));
    const r = await w.raw.query<{ future: boolean }>("SELECT created_at > now() AS future FROM sellers WHERE id = $1", [sellerId]);
    expect(r.rows[0]?.future).toBe(false);
  });
});
