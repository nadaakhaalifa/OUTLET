import { describe, expect, it, vi } from "vitest";
import { ApiError, type OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiGiftCardsPort } from "./api";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const apiError = (status: number, retry: number | null = null) =>
  new ApiError("op", status, { type: "t", title: "t", status } as ConstructorParameters<typeof ApiError>[2], true, retry);
const port = (client: Record<string, Call>) =>
  new ApiGiftCardsPort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 0, deviceId: () => "device-12345" } as AdapterContext);
const m = (amount: string) => ({ amount, currency: "EGP" });
const card = (over: Record<string, unknown>) => ({ id: "c", last4: "1234", amount: m("10000"), remaining: m("10000"), design: "new_baby", status: "issued", expires_at: null, ...over });

describe("ApiGiftCardsPort.load", () => {
  it("maps designs, statuses and the adult flag", async () => {
    const snap = await port({
      listMyGiftCards: () => ok({ items: [
        card({ id: "a", design: "new_baby", status: "delivered", expires_at: "2027-01-01T00:00:00Z" }),
        card({ id: "b", status: "redeemed", remaining: m("500") }),
        card({ id: "c", status: "redeemed", remaining: m("0"), design: "thank_you" }),
        card({ id: "d", status: "mystery_status", design: "eid" }),
      ] }),
      getMe: () => ok({ age_band: "21_plus" }),
    }).load();
    expect(snap.purchaserAdult).toBe(true);
    expect(snap.pots).toEqual([]);
    expect(snap.expiryMonths).toBe(36);
    expect(snap.cards.map((c) => [c.id, c.design, c.status])).toEqual([
      ["a", "newBaby", "DELIVERED"], ["b", "newBaby", "REDEEMED_PARTIAL"], ["c", "thankYou", "REDEEMED_FULL"], ["d", "eid", "ISSUED"],
    ]);
    expect(snap.cards[0]?.expiresAt).toBe(Date.parse("2027-01-01T00:00:00Z"));
    expect(snap.cards[0]?.amount).toBe(10000n);
  });

  it("an 18 to 20 shopper is not an adult purchaser", async () => {
    const snap = await port({ listMyGiftCards: () => ok({ items: [] }), getMe: () => ok({ age_band: "18_20" }) }).load();
    expect(snap.purchaserAdult).toBe(false);
  });
});

describe("ApiGiftCardsPort.redeem", () => {
  it("returns the redeemed amount and sends the code with the key", async () => {
    const redeemGiftCard = vi.fn(() => ok({ redeemed: m("2500") }));
    expect(await port({ redeemGiftCard }).redeem("CODE", "k")).toEqual({ kind: "redeemed", amount: 2500n });
    expect(redeemGiftCard).toHaveBeenCalledWith({ body: { code: "CODE" } }, { idempotencyKey: "k" });
  });

  it("maps 429 to rate limited with the retry hint, 503 to disabled and other 4xx to invalid", async () => {
    const fail = (e: unknown) => port({ redeemGiftCard: () => Promise.reject(e) }).redeem("X", "k");
    expect(await fail(apiError(429, 60))).toEqual({ kind: "rateLimited", retryAfterSeconds: 60 });
    expect(await fail(apiError(503))).toEqual({ kind: "disabled" });
    expect(await fail(apiError(404))).toEqual({ kind: "invalid", remainingAttempts: null });
    expect(await fail(apiError(422))).toEqual({ kind: "invalid", remainingAttempts: null });
  });

  it("a server error is a PortError rather than an invalid code", async () => {
    await expect(port({ redeemGiftCard: () => Promise.reject(apiError(500)) }).redeem("X", "k")).rejects.toMatchObject({ kind: "failed" });
    await expect(port({ redeemGiftCard: () => Promise.reject(new Error("x")) }).redeem("X", "k")).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("ApiGiftCardsPort other operations", () => {
  it("voids a card by id", async () => {
    const voidGiftCard = vi.fn(() => ok({}));
    await port({ voidGiftCard }).voidCard("c9", "k");
    expect(voidGiftCard).toHaveBeenCalledWith({ path: { id: "c9" } }, { idempotencyKey: "k" });
  });

  it("purchase and pots are declared unsupported instead of silently succeeding", async () => {
    const p = port({});
    await expect(p.purchase({ design: "eid" } as never, "k")).rejects.toMatchObject({ kind: "failed" });
    await expect(p.createPot(1n, "2026-01-01", "t", "k")).rejects.toMatchObject({ kind: "failed" });
    await expect(p.contribute("p", 1n, "k")).rejects.toMatchObject({ kind: "failed" });
  });
});
