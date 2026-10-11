import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAY, IDEM, TOKENS, U, USERS, bearer, createRewardsHarness, type RewardsHarness } from "./test/harness";

let h: RewardsHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });

beforeAll(async () => {
  h = await createRewardsHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Fresh rate-limit window for each call site. */
const tick = (): void => h.clock.advance(61_000);
const post = (path: string, token: string | null, body: unknown = {}, extra: Record<string, string> = idem()) => {
  tick();
  const r = h.http().post(path).set(extra);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const put = (path: string, token: string | null, body: unknown, extra: Record<string, string> = idem()) => {
  tick();
  const r = h.http().put(path).set(extra);
  return (token === null ? r : r.set(bearer(token))).send(body as object);
};
const get = (path: string, token: string | null = null) => {
  tick();
  const r = h.http().get(path);
  return token === null ? r : r.set(bearer(token));
};
const del = (path: string, token: string | null) => {
  tick();
  const r = h.http().delete(path);
  return token === null ? r : r.set(bearer(token));
};

const OUTCOMES = [
  { id: "nothing", kind: "nothing", probability_ppm: 500_000 },
  { id: "c25", kind: "coins", probability_ppm: 500_000, coins: "25" },
];
const CONFIG = {
  piastres_per_coin: "1",
  purchase_bps: "150",
  plus_bonus_bps: "500",
  review_base_coins: "2000",
  review_photo_coins: "3000",
  review_fit_coins: "2000",
  profile_completion_coins: "5000",
  fit_feedback_coins: "1000",
  max_coins_per_event: "1000000",
  expiry_months: 12,
  expiring_notice_days: 30,
  silver_from: "500000",
  gold_from: "2000000",
  black_from: "5000000",
  tier_downgrade_notice_days: 30,
  streak_milestones: [{ months: 3, coins: "5000" }],
  daily_plays_per_game: 1,
  odds_publish_lead_hours: 24,
  max_game_coins: "50000",
};

describe("GET /v1/me/rewards", () => {
  it("requires authentication", async () => {
    expect((await get("/v1/me/rewards")).status).toBe(401);
  });

  it("returns only the caller's own coins, tier and streak", async () => {
    await h.ingest.execute({ type: "order.closed", userId: USERS.s1, orderRef: "http-o1", netMerchandise: 150_000n, deliveredAtMs: h.clock.nowMs() });
    const mine = await get("/v1/me/rewards", TOKENS.s1);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ coins: "1500", piastres_per_coin: "1", debt_coins: "0", tier: { tier: "bronze" } });
    expect(mine.body.history).toHaveLength(1);
    expect(mine.body.streak.months).toBe(1);
    expect(mine.body.streak.resets_at).toEqual(expect.any(String));
    const other = await get("/v1/me/rewards", TOKENS.s2);
    expect(other.body.coins).toBe("0");
    expect(other.body.history).toEqual([]);
    expect(JSON.stringify(other.body)).not.toContain("http-o1");
    expect(mine.body.games.every((g: { enabled: boolean }) => g.enabled === false)).toBe(true);
  });
});

describe("POST /v1/me/coins/convert", () => {
  it("is authenticated and idempotency keyed", async () => {
    expect((await post("/v1/me/coins/convert", null)).status).toBe(401);
    tick();
    const noKey = await h.http().post("/v1/me/coins/convert").set(bearer(TOKENS.s1)).send({});
    expect(noKey.status).toBe(400);
    const ok = await post("/v1/me/coins/convert", TOKENS.s1);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ settled: 0, coins: "1500", credit_piastres: "1500" });
  });
});

describe("games", () => {
  it("odds are public, versioned and free to play", async () => {
    const r = await get("/v1/games/daily_spin/odds");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ game: "daily_spin", free_to_play: true, current: null, upcoming: [] });
    expect((await get("/v1/games/roulette/odds")).status).toBe(400);
  });

  it("play is 503 while the kill switch is off (default)", async () => {
    const r = await post("/v1/games/daily_spin/play", TOKENS.s2, {}, { ...idem(), "x-app-attest": `attest-${USERS.s2}` });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("games_disabled");
  });

  it("admin publishes odds with dual approval; play needs attestation, honours the daily cap and replays", async () => {
    h.approvals.approve("odds-http", "game_odds", ["x1", "x2"]);
    const pub = await post("/v1/admin/games/daily_spin/odds", TOKENS.marketing, { approval_id: "odds-http", outcomes: OUTCOMES });
    expect(pub.status).toBe(201);
    expect(new Date(pub.body.effective_from).getTime()).toBeGreaterThan(h.clock.nowMs());
    h.clock.advance(25 * 3_600_000);
    h.switches.setGames(true);

    const noAttest = await post("/v1/games/daily_spin/play", TOKENS.s2, {});
    expect(noAttest.status).toBe(403);
    expect(noAttest.body.code).toBe("attestation_required");

    const key = idem();
    const first = await post("/v1/games/daily_spin/play", TOKENS.s1, {}, { ...key, "x-app-attest": `attest-${USERS.s1}` });
    expect(first.status).toBe(200);
    expect(first.body.audit.server_seed_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(["nothing", "coins"]).toContain(first.body.outcome.kind);
    const odds = await get("/v1/games/daily_spin/odds");
    expect(odds.body.current.odds_version_id).toBe(first.body.odds_version_id);
    expect(odds.body.current.outcomes.map((o: { probability_percent: string }) => o.probability_percent)).toEqual(["50%", "50%"]);

    const replay = await post("/v1/games/daily_spin/play", TOKENS.s1, {}, { ...key, "x-app-attest": `attest-${USERS.s1}` });
    expect(replay.status).toBe(200);
    expect(replay.body.play_id).toBe(first.body.play_id);

    const second = await post("/v1/games/daily_spin/play", TOKENS.s1, {}, { ...idem(), "x-app-attest": `attest-${USERS.s1}` });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe("daily_limit_reached");

    // the spec limit is 3 plays a day per user, whatever the outcome
    const fourth = await post("/v1/games/daily_spin/play", TOKENS.s1, {}, { ...idem(), "x-app-attest": `attest-${USERS.s1}` });
    expect(fourth.status).toBe(429);
  });

  it("another user's attestation token does not work for me", async () => {
    const forged = await post("/v1/games/daily_spin/play", TOKENS.s2, {}, { ...idem(), "x-app-attest": `attest-${USERS.s1}` });
    expect(forged.status).toBe(403);
  });

  it("scratch cards without a delivered order are refused", async () => {
    const r = await post("/v1/games/scratch_card/play", TOKENS.s2, {}, { ...idem(), "x-app-attest": `attest-${USERS.s2}` });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("not_eligible");
  });
});

describe("admin configuration", () => {
  it("authorization: anonymous 401, wrong audience 401/403, wrong role 403, buyer on admin route 403", async () => {
    expect((await get("/v1/admin/rewards/config")).status).toBe(401);
    expect([401, 403]).toContain((await get("/v1/admin/rewards/config", TOKENS.shopperOnAdmin)).status);
    expect([401, 403]).toContain((await get("/v1/admin/rewards/config", TOKENS.adminOnBuyer)).status);
    expect((await get("/v1/admin/rewards/config", TOKENS.support)).status).toBe(403);
    expect((await put("/v1/admin/rewards/config", TOKENS.support, { approval_id: "x", ...CONFIG })).status).toBe(403);
    expect((await post("/v1/admin/games/daily_spin/odds", TOKENS.support, { approval_id: "x", outcomes: OUTCOMES })).status).toBe(403);
    expect((await post("/v1/admin/rewards/challenges", TOKENS.support, { code: "x", orders_closed: 1, window_start: "2027-01-01T00:00:00Z", window_end: "2027-02-01T00:00:00Z", reward_coins: "5" })).status).toBe(403);
    expect((await del(`/v1/admin/rewards/challenges/${U(5)}`, TOKENS.support)).status).toBe(403);
    expect((await get("/v1/admin/rewards/challenges", TOKENS.support)).status).toBe(403);
  });

  it("reads the current configuration", async () => {
    const r = await get("/v1/admin/rewards/config", TOKENS.marketing);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, piastres_per_coin: "1", purchase_bps: "100", expiry_months: 12 });
  });

  it("a change needs dual approval, is validated, and is versioned", async () => {
    const noApproval = await put("/v1/admin/rewards/config", TOKENS.marketing, { approval_id: "nope", ...CONFIG });
    expect(noApproval.status).toBe(403);
    expect(noApproval.body.code).toBe("dual_approval_required");
    h.approvals.approve("cfg-http", "rewards_config", ["x1", "x2"]);
    const invalid = await put("/v1/admin/rewards/config", TOKENS.marketing, { approval_id: "cfg-http", ...CONFIG, gold_from: "10" });
    expect(invalid.status).toBe(422);
    const ok = await put("/v1/admin/rewards/config", TOKENS.marketing, { approval_id: "cfg-http", ...CONFIG });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ version: 2, purchase_bps: "150" });
    expect((await put("/v1/admin/rewards/config", TOKENS.marketing, { approval_id: "cfg-http", ...CONFIG, extra: 1 })).status).toBe(400);
  });

  it("challenges: create, list, deactivate", async () => {
    const start = new Date(h.clock.nowMs() - DAY).toISOString();
    const end = new Date(h.clock.nowMs() + 30 * DAY).toISOString();
    const created = await post("/v1/admin/rewards/challenges", TOKENS.marketing, { code: "http-three", orders_closed: 3, window_start: start, window_end: end, reward_coins: "4000" });
    expect(created.status).toBe(201);
    const dup = await post("/v1/admin/rewards/challenges", TOKENS.marketing, { code: "http-three", orders_closed: 3, window_start: start, window_end: end, reward_coins: "4000" });
    expect(dup.status).toBe(409);
    const bad = await post("/v1/admin/rewards/challenges", TOKENS.marketing, { code: "http-bad", orders_closed: 3, window_start: end, window_end: start, reward_coins: "4000" });
    expect(bad.status).toBe(422);
    const list = await get("/v1/admin/rewards/challenges", TOKENS.marketing);
    expect(list.body.items.map((c: { code: string }) => c.code)).toEqual(["http-three"]);
    const shopperView = await get("/v1/me/rewards", TOKENS.s2);
    expect(shopperView.body.challenges.map((c: { code: string }) => c.code)).toEqual(["http-three"]);
    expect((await del(`/v1/admin/rewards/challenges/${created.body.id}`, TOKENS.marketing)).status).toBe(204);
    expect((await del(`/v1/admin/rewards/challenges/${created.body.id}`, TOKENS.marketing)).status).toBe(404);
    expect((await del(`/v1/admin/rewards/challenges/not-a-uuid`, TOKENS.marketing)).status).toBe(400);
  });
});
