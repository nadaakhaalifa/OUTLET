import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAffordability } from "../../recommendations";
import { DAY, IDEM, START_MS, TOKENS, U, bearer, cand, createRankingHarness, type RankingHarness } from "./harness";

const FEATURES = { categoryAffinity: { dress: 900 }, storeAffinity: { [`00000000-0000-4000-8000-${String(9001).padStart(12, "0")}`]: 500 }, builtAtMs: START_MS };
const seed = (h: RankingHarness): void => {
  for (let i = 1; i <= 12; i++) h.catalog.add(cand(i, 1 + (i % 4)));
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("shadow deployment through the real feed", () => {
  let h: RankingHarness;
  beforeAll(async () => {
    h = await createRankingHarness();
    seed(h);
  });
  afterAll(async () => h.close());

  it("serves v1 and logs v2 scores with personalized features", async () => {
    h.personalization.grantConsent(U(1));
    h.personalization.setFeatures(U(1), FEATURES);
    const r = await h.http().get("/v1/feed").set(bearer(TOKENS.shopper));
    expect(r.status).toBe(200);
    expect(r.body.personalized).toBe(true);
    expect(r.body.model_version).not.toBe("linear-baseline-v2");
    await settle();
    expect(h.shadow.runs).toHaveLength(1);
    const run = h.shadow.runs[0];
    expect(run?.personalized).toBe(true);
    expect(run?.servedModelVersion).toBe(r.body.model_version);
    expect(run?.shadowModelVersion).toBe("linear-baseline-v2");
    const logged = await h.shadow.itemsOf(run?.id ?? "");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((i) => i.features.category_affinity > 0)).toBe(true);
  });

  it("personalization off: no user feature is scored or stored", async () => {
    h.shadow.runs.length = 0;
    h.ranker.seen.length = 0;
    const r = await h.http().get("/v1/feed?personalized=false").set(bearer(TOKENS.shopper));
    expect(r.status).toBe(200);
    expect(r.body.personalized).toBe(false);
    await settle();
    expect(h.ranker.seen.length).toBe(1);
    for (const v of h.ranker.seen[0] ?? []) {
      expect(v.personalized).toBe(false);
      expect(v.values.category_affinity).toBe(0);
      expect(v.values.store_affinity).toBe(0);
    }
    const run = h.shadow.runs[0];
    expect(run?.personalized).toBe(false);
    const logged = await h.shadow.itemsOf(run?.id ?? "");
    expect(logged.every((i) => i.features.category_affinity === 0 && i.features.store_affinity === 0)).toBe(true);
  });

  it("kill switch blocks shadow scoring and the shopper still gets the feed", async () => {
    h.shadow.runs.length = 0;
    h.flags.allowed = false;
    const r = await h.http().get("/v1/feed?personalized=false").set(bearer(TOKENS.shopper));
    h.flags.allowed = true;
    expect(r.status).toBe(200);
    await settle();
    expect(h.shadow.runs).toHaveLength(0);
  });

  it("the logged payload never carries a budget or measurement key", async () => {
    h.shadow.runs.length = 0;
    await h.http().get("/v1/feed?personalized=false").set(bearer(TOKENS.shopper));
    await settle();
    const json = JSON.stringify([...h.shadow.items.values()], (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toMatch(/budget|afford|installment|payday|measure|size_profile|income/i);
  });
});

describe("budget-conditioned requests are never shadow logged", () => {
  it("affordable=true feed produces no shadow run", async () => {
    const aff = new FakeAffordability(100_000n);
    const h = await createRankingHarness({ affordability: aff });
    seed(h);
    const r = await h.http().get("/v1/feed?affordable=true&personalized=false").set(bearer(TOKENS.shopper));
    expect(r.status).toBe(200);
    expect(r.body.affordability_applied).toBe(true);
    await settle();
    expect(h.shadow.runs).toHaveLength(0);
    await h.close();
  });
});

describe("ranker down", () => {
  it("a throwing shadow ranker never breaks serving", async () => {
    const h = await createRankingHarness();
    seed(h);
    (h.ranker as { score: unknown }).score = async () => {
      throw new Error("boom");
    };
    const r = await h.http().get("/v1/feed?personalized=false").set(bearer(TOKENS.shopper));
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    await settle();
    expect(h.shadow.runs).toHaveLength(0);
    await h.close();
  });
});

describe("internal admin routes", () => {
  let h: RankingHarness;
  beforeAll(async () => {
    h = await createRankingHarness();
  });
  afterAll(async () => h.close());

  const EVAL = { request_key: "eval-0000-0001", candidate: "linear-baseline-v2", baseline: "popularity-baseline", seed: 7, requests: 120, k: 10 };
  const routes: readonly { name: string; send: (token: string | null) => Promise<{ status: number }> }[] = [
    { name: "GET shadow summary", send: (t) => h.http().get("/v1/admin/ranking/shadow/summary").set(t === null ? {} : bearer(t)) },
    { name: "GET evaluations", send: (t) => h.http().get("/v1/admin/ranking/evaluations").set(t === null ? {} : bearer(t)) },
    {
      name: "POST evaluations",
      send: (t) => h.http().post("/v1/admin/ranking/evaluations").set({ ...(t === null ? {} : bearer(t)), "Idempotency-Key": IDEM(900) }).send(EVAL),
    },
    {
      name: "POST guardrails",
      send: (t) =>
        h
          .http()
          .post("/v1/admin/ranking/guardrails/evaluate")
          .set({ ...(t === null ? {} : bearer(t)), "Idempotency-Key": IDEM(901) })
          .send({ control: { orders: 1000, returned: 100, complaints: 5 }, treatment: { orders: 1000, returned: 100, complaints: 5 } }),
    },
  ];

  for (const r of routes) {
    describe(r.name, () => {
      it("401 without a token", async () => expect((await r.send(null)).status).toBe(401));
      it("shopper token on the buyer audience is refused", async () => expect([401, 403, 404]).toContain((await r.send(TOKENS.shopper)).status));
      it("shopper token with the admin audience is 403", async () => expect((await r.send(TOKENS.shopperOnAdminAud)).status).toBe(403));
      it("seller token is refused", async () => expect([401, 403, 404]).toContain((await r.send(TOKENS.seller)).status));
      it("marketing and support admins are 403", async () => {
        expect((await r.send(TOKENS.marketing)).status).toBe(403);
        expect((await r.send(TOKENS.support)).status).toBe(403);
      });
      it("ops and super admin are allowed", async () => {
        expect((await r.send(TOKENS.ops)).status).toBe(200);
        expect((await r.send(TOKENS.superAdmin)).status).toBe(200);
      });
    });
  }

  it("evaluation passes the regression gate, is idempotent by request_key and listed", async () => {
    const a = await h.http().post("/v1/admin/ranking/evaluations").set({ ...bearer(TOKENS.ops), "Idempotency-Key": IDEM(910) }).send({ ...EVAL, request_key: "eval-stable-01" });
    expect(a.status).toBe(200);
    expect(a.body.passed).toBe(true);
    expect(a.body.candidate.ndcg_bps).toBeGreaterThan(a.body.baseline.ndcg_bps);
    expect(a.body.replayed).toBe(false);
    const b = await h.http().post("/v1/admin/ranking/evaluations").set({ ...bearer(TOKENS.ops), "Idempotency-Key": IDEM(911) }).send({ ...EVAL, request_key: "eval-stable-01" });
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.replayed).toBe(true);
    const l = await h.http().get("/v1/admin/ranking/evaluations?limit=5").set(bearer(TOKENS.ops));
    expect(l.body.items.some((x: { id: string }) => x.id === a.body.id)).toBe(true);
  });

  it("a worse candidate fails the gate with a reason", async () => {
    const r = await h.http().post("/v1/admin/ranking/evaluations").set({ ...bearer(TOKENS.ops), "Idempotency-Key": IDEM(912) }).send({ ...EVAL, request_key: "eval-regress-1", candidate: "fake-ranker-v2", baseline: "linear-baseline-v2" });
    expect(r.status).toBe(200);
    expect(r.body.passed).toBe(false);
    expect(r.body.reasons).toContain("ndcg_regression_vs_baseline");
  });

  it("unknown model and strict body validation answer 400", async () => {
    const u = await h.http().post("/v1/admin/ranking/evaluations").set({ ...bearer(TOKENS.ops), "Idempotency-Key": IDEM(913) }).send({ ...EVAL, request_key: "eval-unknown-1", candidate: "nope" });
    expect(u.status).toBe(400);
    const e = await h.http().post("/v1/admin/ranking/evaluations").set({ ...bearer(TOKENS.ops), "Idempotency-Key": IDEM(914) }).send({ ...EVAL, request_key: "eval-extra-001", budget: 5 });
    expect(e.status).toBe(400);
  });

  it("guardrails halt on a return-rate regression", async () => {
    const r = await h
      .http()
      .post("/v1/admin/ranking/guardrails/evaluate")
      .set({ ...bearer(TOKENS.ops), "Idempotency-Key": IDEM(915) })
      .send({ control: { orders: 2000, returned: 200, complaints: 10 }, treatment: { orders: 2000, returned: 300, complaints: 10 } });
    expect(r.status).toBe(200);
    expect(r.body.decision).toBe("halt");
    expect(r.body.breaches).toEqual(["return_rate"]);
  });

  it("shadow summary reports zero runs on a fresh store and never exposes ids", async () => {
    const r = await h.http().get("/v1/admin/ranking/shadow/summary").set(bearer(TOKENS.ops));
    expect(r.body.runs).toBe(0);
    expect(r.body.served).toBe("v1");
    expect(JSON.stringify(r.body)).not.toMatch(/user/i);
    void DAY;
  });
});
