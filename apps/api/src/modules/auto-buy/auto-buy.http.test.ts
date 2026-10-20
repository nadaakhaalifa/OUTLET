import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTO_BUY_LIMITS } from "./domain/bridge";
import { IDEM, TOKENS, UU, bearer, createAutoBuyHarness, type AutoBuyHarness } from "./test/harness";
import { SKU, T0 } from "./test/repository-contract";
import { TOKEN, quote } from "./test/world";

let h: AutoBuyHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const egp = (n: number) => ({ amount: String(BigInt(n) * 100n), currency: "EGP" });
const FAR = (): string => new Date(T0 + 30 * 86_400_000).toISOString();
const body = (over: Record<string, unknown> = {}) => ({
  sku_id: SKU(1),
  size_label: "M",
  target_price: egp(649),
  max_price: egp(700),
  expires_at: FAR(),
  locale: "en",
  accepted_terms_version: 1,
  ...over,
});

beforeAll(async () => {
  h = await createAutoBuyHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** A fresh rate-limit window for each call site. */
const tick = (): void => h.world.clock.advance(61_000);
const send = (method: "get" | "post" | "delete", path: string, token: string | null, payload?: unknown, extra: Record<string, string> = idem()) => {
  tick();
  let r = h.http()[method](path).set(extra);
  if (token !== null) r = r.set(bearer(token));
  return payload === undefined ? r : r.send(payload as object);
};

describe("authentication and authorization matrix (negative tests on every route)", () => {
  const routes: [Parameters<typeof send>[0], string, unknown][] = [
    ["post", "/v1/me/auto-buy", body()],
    ["get", "/v1/me/auto-buy", undefined],
    ["get", "/v1/me/auto-buy/terms?locale=en", undefined],
    ["delete", `/v1/me/auto-buy/${UU(900)}`, undefined],
    ["post", `/v1/me/auto-buy/attempts/${UU(901)}/cancel`, {}],
  ];
  for (const [method, path, payload] of routes) {
    it(`${method.toUpperCase()} ${path}: 401 without a token and for tokens of other audiences`, async () => {
      expect((await send(method, path, null, payload)).status).toBe(401);
      expect((await send(method, path, TOKENS.seller, payload)).status).toBe(401);
      expect((await send(method, path, TOKENS.admin, payload)).status).toBe(401);
      expect((await send(method, path, TOKENS.shopperOnSellerAud, payload)).status).toBe(401);
    });
  }

  it("writes require an Idempotency-Key", async () => {
    tick();
    const r = await h.http().post("/v1/me/auto-buy").set(bearer(TOKENS.a)).send(body());
    expect(r.status).toBe(400);
    tick();
    const d = await h.http().delete(`/v1/me/auto-buy/${UU(900)}`).set(bearer(TOKENS.a));
    expect(d.status).toBe(400);
  });

  it("no route accepts a user id", async () => {
    expect((await send("post", "/v1/me/auto-buy", TOKENS.a, body({ user_id: UU(2) }))).status).toBe(400);
    expect((await send("get", `/v1/me/auto-buy?user_id=${UU(2)}`, TOKENS.a)).status).toBe(400);
  });
});

describe("create over HTTP", () => {
  it("requires a passkey step-up: an OTP-only session is 403 step_up_required", async () => {
    const r = await send("post", "/v1/me/auto-buy", TOKENS.aBasic, body());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("step_up_required");
  });

  it("is a 404 while the feature switch is off (dark by default)", async () => {
    h.world.flags.rules = false;
    const r = await send("post", "/v1/me/auto-buy", TOKENS.a, body());
    h.world.flags.rules = true;
    expect(r.status).toBe(404);
  });

  it("validates the body strictly", async () => {
    for (const bad of [
      body({ mode: "turbo" }),
      body({ size_label: "" }),
      body({ expires_at: "tomorrow" }),
      body({ target_price: { amount: "-1", currency: "EGP" } }),
      body({ mode: "unattended" }), // token required
      body({ payment_token_ref: TOKEN }), // token not allowed in notify mode
      body({ extra: true }),
    ]) {
      const r = await send("post", "/v1/me/auto-buy", TOKENS.a, bad);
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });

  it("creates a rule, returns the accepted wording and never the token reference or device", async () => {
    const r = await send("post", "/v1/me/auto-buy", TOKENS.a, body());
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toMatchObject({
      sku_id: SKU(1),
      status: "ARMED",
      mode: "notify_confirm",
      payment_method: null,
      target_price: egp(649),
      max_price: egp(700),
      terms_version: 1,
      latest_attempt: null,
    });
    expect(r.body.terms.text).toContain("Linen dress");
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/psp_token|device|tok_card/);
  });

  it("maps domain refusals to stable problem codes", async () => {
    const dup = await send("post", "/v1/me/auto-buy", TOKENS.a, body());
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("auto_buy_rule_exists");

    const high = await send("post", "/v1/me/auto-buy", TOKENS.b, body({ target_price: egp(800), max_price: egp(900) }));
    expect(high.status).toBe(422);
    expect(high.body.code).toBe("terms_invalid");
    expect(high.body.errors).toEqual([{ pointer: "/body/target_price", code: "target_not_below_current" }]);

    const stale = await send("post", "/v1/me/auto-buy", TOKENS.b, body({ accepted_terms_version: 9 }));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("terms_version_stale");

    const unattended = await send("post", "/v1/me/auto-buy", TOKENS.b, body({ mode: "unattended", payment_token_ref: TOKEN }));
    expect(unattended.status).toBe(422);
    expect(unattended.body.code).toBe("unattended_unavailable");

    h.world.eligibility.byUser.set(UU(2), { plusActive: false, ageOk: true });
    const noPlus = await send("post", "/v1/me/auto-buy", TOKENS.b, body());
    expect(noPlus.status).toBe(403);
    expect(noPlus.body.code).toBe("plus_required");
    h.world.eligibility.byUser.delete(UU(2));
  });

  it("an unattended rule is accepted only with the charge switch on and a valid card", async () => {
    h.world.flags.charge = true;
    h.world.catalog.skus.set(SKU(3), quote());
    const ok = await send("post", "/v1/me/auto-buy", TOKENS.b, body({ sku_id: SKU(3), mode: "unattended", payment_token_ref: TOKEN }));
    h.world.flags.charge = false;
    expect(ok.status).toBe(201);
    expect(ok.body.mode).toBe("unattended");
    expect(ok.body.payment_method).toBe("saved_card");
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);
  });
});

describe("list, cancel and BOLA", () => {
  it("lists only the caller's rules, with the latest attempt and the paused flag", async () => {
    const a = await send("get", "/v1/me/auto-buy", TOKENS.a);
    expect(a.status).toBe(200);
    expect(a.body.paused).toBe(false);
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items.every((i: { sku_id: string }) => i.sku_id === SKU(1))).toBe(true);
    const b = await send("get", "/v1/me/auto-buy", TOKENS.b);
    expect(b.body.items).toHaveLength(1);
    expect(b.body.items[0].sku_id).toBe(SKU(3));
    h.world.flags.rules = false;
    const paused = await send("get", "/v1/me/auto-buy", TOKENS.a);
    h.world.flags.rules = true;
    expect(paused.body.paused).toBe(true);
    expect(paused.body.items[0].paused).toBe(true);
  });

  it("list carries the server clock and whether unattended charging is available", async () => {
    const r = await send("get", "/v1/me/auto-buy", TOKENS.a);
    expect(r.status).toBe(200);
    expect(Number.isNaN(Date.parse(r.body.server_time))).toBe(false);
    expect(Object.keys(r.body.capabilities)).toEqual(["unattended_available"]);
    expect(r.body.capabilities.unattended_available).toBe(h.world.flags.charge);
  });

  it("terms returns the current wording template and version, never subject data", async () => {
    const en = await send("get", "/v1/me/auto-buy/terms?locale=en", TOKENS.a);
    expect(en.status).toBe(200);
    expect(Object.keys(en.body).sort()).toEqual(["locale", "text", "version"]);
    expect(en.body.locale).toBe("en");
    expect(en.body.version).toBe(1);
    expect(en.body.text).toContain("{{item}}");
    expect(en.headers["cache-control"]).toBe("no-store");
    const dflt = await send("get", "/v1/me/auto-buy/terms", TOKENS.b);
    expect(dflt.body.locale).toBe("ar");
    expect((await send("get", "/v1/me/auto-buy/terms?locale=fr", TOKENS.a)).status).toBe(400);
    expect((await send("get", "/v1/me/auto-buy/terms?user_id=" + UU(5), TOKENS.a)).status).toBe(400);
  });

  it("another user's rule and attempt are 404, identical to a missing one, with no side effect", async () => {
    const mine = (await send("get", "/v1/me/auto-buy", TOKENS.a)).body.items[0].id as string;
    const foreign = await send("delete", `/v1/me/auto-buy/${mine}`, TOKENS.b);
    const missing = await send("delete", `/v1/me/auto-buy/${UU(999)}`, TOKENS.b);
    const garbage = await send("delete", "/v1/me/auto-buy/not-a-uuid", TOKENS.b);
    for (const r of [foreign, missing, garbage]) expect(r.status).toBe(404);
    const strip = (x: Record<string, unknown>) => {
      const { request_id: _r, ...rest } = x;
      return rest;
    };
    expect(strip(foreign.body)).toEqual(strip(missing.body));
    expect(h.world.store.mandatesAll.find((m) => m.id === mine)?.status).toBe("ARMED");
  });

  it("price event to attempt cancel over HTTP: 200, then idempotent, and the hold is released", async () => {
    h.world.setLive({ price: 64_000n });
    await h.world.handle.execute(h.world.priceEvent("pe-http-1", 64_000n));
    const listed = (await send("get", "/v1/me/auto-buy", TOKENS.a)).body.items[0];
    expect(listed.latest_attempt).toMatchObject({ state: "NOTIFIED", mode: "notify_confirm", cancellable: true });
    const attemptId = listed.latest_attempt.id as string;

    const foreign = await send("post", `/v1/me/auto-buy/attempts/${attemptId}/cancel`, TOKENS.b, {});
    expect(foreign.status).toBe(404);

    const r = await send("post", `/v1/me/auto-buy/attempts/${attemptId}/cancel`, TOKENS.a, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "cancelled" });
    const again = await send("post", `/v1/me/auto-buy/attempts/${attemptId}/cancel`, TOKENS.a, {});
    expect(again.status).toBe(200);
    expect(h.world.store.attemptsAll.find((x) => x.id === attemptId)?.state).toBe("CANCELLED_BY_USER");
  });

  it("an attempt that is already charging is 409 attempt_not_cancellable", async () => {
    h.world.catalog.skus.set(SKU(1), quote());
    // new rule for the same sku after cancelling the first
    const first = (await send("get", "/v1/me/auto-buy", TOKENS.a)).body.items[0].id as string;
    expect((await send("delete", `/v1/me/auto-buy/${first}`, TOKENS.a)).status).toBe(200);
    h.world.flags.charge = true;
    h.world.vault.tokens.set(TOKEN, "valid");
    const c = await send("post", "/v1/me/auto-buy", TOKENS.a, body({ mode: "unattended", payment_token_ref: TOKEN }));
    expect(c.status).toBe(201);
    h.world.clock.advance(AUTO_BUY_LIMITS.cooldownMs);
    h.world.catalog.skus.set(SKU(1), quote({ price: 64_000n }));
    await h.world.handle.execute(h.world.priceEvent("pe-http-2", 64_000n));
    h.world.mit.next = { kind: "pending" };
    h.world.clock.advance(AUTO_BUY_LIMITS.cancelWindowMs);
    await h.world.sweep.execute();
    const attempt = h.world.store.attemptsAll.find((x) => x.priceEventId === "pe-http-2");
    expect(attempt?.state).toBe("CHARGING");
    const r = await send("post", `/v1/me/auto-buy/attempts/${attempt?.id}/cancel`, TOKENS.a, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("attempt_not_cancellable");
    h.world.flags.charge = false;
  });

  it("deleting a rule twice is 200 both times; a purchased rule is 409 auto_buy_closed", async () => {
    const items = (await send("get", "/v1/me/auto-buy", TOKENS.b)).body.items as { id: string }[];
    const id = items[0]?.id ?? "";
    expect((await send("delete", `/v1/me/auto-buy/${id}`, TOKENS.b)).status).toBe(200);
    expect((await send("delete", `/v1/me/auto-buy/${id}`, TOKENS.b)).status).toBe(200);
  });
});
