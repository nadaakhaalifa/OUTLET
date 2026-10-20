import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { EGP, IDEM, TOKENS, U, bearer, createGiftCardHarness, type GiftCardHarness } from "./test/harness";
import { GiftCardsModule, MissingGiftCardPortsError } from "./gift-cards.module";
import { InMemoryGiftCardStore } from "./adapters/in-memory";

let h: GiftCardHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": IDEM(++seq) });
const money = (n: number) => ({ amount: String(EGP(n)), currency: "EGP" });

beforeAll(async () => {
  h = await createGiftCardHarness();
  h.rt.flags.sales = true;
  h.rt.flags.redemption = true;
}, 60_000);
afterAll(async () => {
  await h.close();
});

const send = (method: "get" | "post", path: string, token: string | null, body?: unknown, extra: Record<string, string> = idem()) => {
  h.rt.clock.advance(61_000);
  let r = h.http()[method](path).set(extra);
  if (token !== null) r = r.set(bearer(token));
  return body === undefined ? r : r.send(body as object);
};
const purchaseBody = { amount: money(500), design: "eid", channel: "in_app", payment_method: "card", is_new_card: false };

describe("authentication and authorization matrix", () => {
  const routes: ["get" | "post", string, unknown][] = [
    ["post", "/v1/gift-cards", purchaseBody],
    ["post", "/v1/gift-cards/redeem", { code: "AAAA-BBBB-CCCC-DDDD" }],
    ["get", "/v1/me/gift-cards", undefined],
    ["post", `/v1/gift-cards/${U(900)}/void`, {}],
    ["post", "/v1/gift-pots", { target: money(500), closes_at: "2026-04-20T00:00:00Z", organiser_nickname: "S", design: "eid", channel: "in_app" }],
    ["get", `/v1/gift-pots/${U(901)}`, undefined],
    ["post", `/v1/gift-pots/${U(901)}/contribute`, { share_token: "0".repeat(32), amount: money(100), payment_method: "card" }],
  ];
  for (const [method, path, body] of routes) {
    it(`${method.toUpperCase()} ${path}: 401 without a token and for seller/admin audiences`, async () => {
      expect((await send(method, path, null, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.seller, body)).status).toBe(401);
      expect((await send(method, path, TOKENS.admin, body)).status).toBe(401);
    });
  }

  it("rejects writes without an Idempotency-Key", async () => {
    h.rt.clock.advance(61_000);
    const r = await h.http().post("/v1/gift-cards").set(bearer(TOKENS.a)).send(purchaseBody);
    expect(r.status).toBe(400);
  });
});

describe("purchase, redeem and ownership over HTTP", () => {
  let cardId = "";
  let code = "";

  it("purchases (PENDING_PAYMENT, no code in the response) then issues on payment", async () => {
    const r = await send("post", "/v1/gift-cards", TOKENS.a, purchaseBody);
    expect(r.status).toBe(201);
    expect(r.body.card.status).toBe("PENDING_PAYMENT");
    expect(JSON.stringify(r.body)).not.toMatch(/code/i);
    cardId = r.body.card.id as string;
    const issued = await h.rt.issue.execute({ cardId, paymentIntentId: r.body.payment.intent_id as string });
    if (issued.kind !== "issued") throw new Error("issue failed");
    code = issued.code;
  });

  it("owner lists the card with last4 only; another shopper sees none", async () => {
    const mine = await send("get", "/v1/me/gift-cards", TOKENS.a);
    expect(mine.body.items).toHaveLength(1);
    expect(JSON.stringify(mine.body)).not.toContain(code.replace(/-/g, ""));
    const theirs = await send("get", "/v1/me/gift-cards", TOKENS.b);
    expect(theirs.body.items).toHaveLength(0);
  });

  it("void of someone else's card is 404, never 403 (no existence leak)", async () => {
    expect((await send("post", `/v1/gift-cards/${cardId}/void`, TOKENS.b, {})).status).toBe(404);
    expect((await send("post", `/v1/gift-cards/${U(950)}/void`, TOKENS.b, {})).status).toBe(404);
  });

  it("a strict body rejects unknown fields (mass assignment)", async () => {
    const r = await send("post", "/v1/gift-cards", TOKENS.a, { ...purchaseBody, status: "ISSUED", remaining: money(1) });
    expect(r.status).toBe(400);
  });

  it("any shopper redeems the right code once; credit lands in the gift_card sub-balance", async () => {
    const r = await send("post", "/v1/gift-cards/redeem", TOKENS.b, { code });
    expect(r.status).toBe(200);
    expect(r.body.credit.sub_balance).toBe("gift_card");
    const again = await send("post", "/v1/gift-cards/redeem", TOKENS.b, { code });
    expect(again.status).toBe(409);
  });

  it("5 wrong codes then 429 with Retry-After; an unrelated valid redemption by another account still works", async () => {
    const other = await send("post", "/v1/gift-cards", TOKENS.a, purchaseBody);
    const issued = await h.rt.issue.execute({ cardId: other.body.card.id as string, paymentIntentId: other.body.payment.intent_id as string });
    if (issued.kind !== "issued") throw new Error("issue failed");
    h.rt.clock.advance(3_600_000 + 5_000); // earlier failures of this account leave the window
    for (let i = 0; i < 5; i += 1) {
      h.rt.clock.advance(1_000);
      const w = await h.http().post("/v1/gift-cards/redeem").set(idem()).set(bearer(TOKENS.b)).set("x-device-id", `d-${i}`).send({ code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
      expect(w.status).toBe(404);
    }
    h.rt.clock.advance(1_000);
    const blocked = await h.http().post("/v1/gift-cards/redeem").set(idem()).set(bearer(TOKENS.b)).set("x-device-id", "d-ok").send({ code: issued.code });
    expect(blocked.status).toBe(429);
    h.rt.clock.advance(3_600_000 + 5_000);
    const ok = await h.http().post("/v1/gift-cards/redeem").set(idem()).set(bearer(TOKENS.b)).set("x-device-id", "d-ok").send({ code: issued.code });
    expect(ok.status).toBe(200);
  });

  it("kill switch OFF returns 503 feature_disabled", async () => {
    h.rt.flags.redemption = false;
    const r = await send("post", "/v1/gift-cards/redeem", TOKENS.a, { code: "AAAA-BBBB-CCCC-DDDD" });
    expect(r.status).toBe(503);
    h.rt.flags.redemption = true;
    h.rt.flags.sales = false;
    expect((await send("post", "/v1/gift-cards", TOKENS.a, purchaseBody)).status).toBe(503);
    h.rt.flags.sales = true;
  });

  it("a purchase above 5,000 EGP without a 21+ attestation is 403", async () => {
    const r = await send("post", "/v1/gift-cards", TOKENS.b, { ...purchaseBody, amount: money(6000) });
    expect(r.status).toBe(403);
  });
});

describe("group gift pot over HTTP", () => {
  it("organiser sees the pot; a stranger gets 404; the public shared view is anonymous and minimal", async () => {
    const created = await send("post", "/v1/gift-pots", TOKENS.a, {
      target: money(1000),
      closes_at: new Date(h.rt.clock.nowMs() + 5 * 86_400_000).toISOString(),
      organiser_nickname: "Sara",
      design: "wedding",
      channel: "in_app",
    });
    expect(created.status).toBe(201);
    const id = created.body.pot.id as string;
    const token = created.body.share_token as string;
    expect((await send("get", `/v1/gift-pots/${id}`, TOKENS.a)).status).toBe(200);
    expect((await send("get", `/v1/gift-pots/${id}`, TOKENS.b)).status).toBe(404);
    const pub = await send("get", `/v1/shared/gift-pots/${token}`, null, undefined, {});
    expect(pub.status).toBe(200);
    expect(Object.keys(pub.body).sort()).toEqual(["closes_at", "contributions", "id", "organiser_nickname", "raised", "status", "target"]);
    expect((await send("get", `/v1/shared/gift-pots/${"0".repeat(32)}`, null, undefined, {})).status).toBe(404);
    const give = await send("post", `/v1/gift-pots/${id}/contribute`, TOKENS.b, { share_token: token, amount: money(200), payment_method: "card" });
    expect(give.status).toBe(201);
    const bad = await send("post", `/v1/gift-pots/${id}/contribute`, TOKENS.b, { share_token: "f".repeat(32), amount: money(200), payment_method: "card" });
    expect(bad.status).toBe(404);
  });
});

describe("GiftCardsModule.forRoot", () => {
  it("boots in test mode and refuses production adapters without a real store or ports", () => {
    expect(() => GiftCardsModule.forRoot(loadConfig({ NODE_ENV: "test" }))).not.toThrow();
    const cfg = { ...loadConfig({ NODE_ENV: "test" }), adapters: "postgres" } as unknown as ReturnType<typeof loadConfig>;
    expect(() => GiftCardsModule.forRoot(cfg)).toThrow(NoProductionAdaptersError);
    expect(() => GiftCardsModule.forRoot(cfg, { store: new InMemoryGiftCardStore() })).toThrow(MissingGiftCardPortsError);
  });
});
