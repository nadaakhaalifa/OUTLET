import { describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, type OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { PortError } from "../worlds/model";
import { ApiDropsPort } from "./api";

type Call = (arg: unknown, opts?: unknown) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const problem = (status: number, type: string, code?: string) =>
  new ApiError("op", status, (code === undefined ? { type, title: "t", status } : { type, title: "t", status, code }) as ConstructorParameters<typeof ApiError>[2], true, null);

function port(client: Record<string, Call>, locale: "ar" | "en" = "ar") {
  const ctx: AdapterContext = { client: client as unknown as OutletClient, locale: () => locale, nowMs: () => 5_000, deviceId: () => "device-12345" };
  return new ApiDropsPort(ctx);
}

const drop = (over: Record<string, unknown> = {}) => ({
  id: "d1", store_id: "s1", title: "Summer", type: "members_only", state: "EARLY_ACCESS", paused: false,
  starts_at: "2026-10-01T10:00:00Z", early_access_at: "2026-10-01T09:00:00Z", ends_at: "2026-10-02T10:00:00Z",
  limits: { per_user: 2 }, social_proof: { remaining: 7 }, server_time: "2026-10-01T08:00:00Z", ...over,
});
const store = { name: { ar: "نيل", en: "Nile" } };

describe("ApiDropsPort.getDrop", () => {
  it("maps wire types, states and the store name by locale", async () => {
    const client = { getPublicDrop: () => ok(drop()), getStore: () => ok(store) };
    const ar = await port(client).getDrop("d1");
    expect(ar).toMatchObject({ id: "d1", storeName: "نيل", type: "members", state: "earlyAccess", perUserLimit: 2, remainingStock: 7 });
    expect(ar?.startsAtMs).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(ar?.earlyAccessAtMs).toBe(Date.parse("2026-10-01T09:00:00Z"));
    expect((await port(client, "en").getDrop("d1"))?.storeName).toBe("Nile");
  });

  it.each([
    ["LIVE", "live"], ["SOLD_OUT", "soldOut"], ["ENDED", "ended"], ["ARCHIVED", "ended"], ["SCHEDULED", "scheduled"], ["DRAFT", "scheduled"],
  ])("state %s becomes %s", async (wire, view) => {
    const client = { getPublicDrop: () => ok(drop({ state: wire })), getStore: () => ok(store) };
    expect((await port(client).getDrop("d1"))?.state).toBe(view);
  });

  it("a paused drop is paused whatever its state, and a null early access stays null", async () => {
    const client = { getPublicDrop: () => ok(drop({ paused: true, state: "LIVE", early_access_at: null, type: "mystery_box" })), getStore: () => ok(store) };
    const d = await port(client).getDrop("d1");
    expect(d).toMatchObject({ state: "paused", earlyAccessAtMs: null, type: "mystery" });
  });

  it("returns null for a 404 and a PortError for other failures", async () => {
    const missing = { getPublicDrop: () => Promise.reject(problem(404, "x")), getStore: () => ok(store) };
    expect(await port(missing).getDrop("d1")).toBeNull();
    const down = { getPublicDrop: () => Promise.reject(new NetworkError("op", new Error("x"))), getStore: () => ok(store) };
    await expect(port(down).getDrop("d1")).rejects.toMatchObject({ kind: "offline" });
    const boom = { getPublicDrop: () => Promise.reject(problem(500, "x")), getStore: () => ok(store) };
    await expect(port(boom).getDrop("d1")).rejects.toBeInstanceOf(PortError);
  });
});

describe("ApiDropsPort queue", () => {
  const status = (s: Record<string, unknown>) => ({ getDropQueueStatus: () => ok(s) });

  it("status maps admitted, waiting, expired and idle", async () => {
    expect(await port(status({ state: "admitted", admission_token: "tok", expires_at: "2026-10-01T10:00:00Z" })).status("d1"))
      .toEqual({ state: "admitted", token: { value: "tok", expiresAtMs: Date.parse("2026-10-01T10:00:00Z") }, serverNowMs: 5_000 });
    expect(await port(status({ state: "waiting", position: 4, eta_seconds: 30 })).status("d1")).toEqual({ state: "waiting", position: 4, etaSeconds: 30, pollAfterMs: 2_000 });
    expect(await port(status({ state: "waiting" })).status("d1")).toEqual({ state: "waiting", position: null, etaSeconds: null, pollAfterMs: 2_000 });
    expect(await port(status({ state: "idle", admission_expired: true })).status("d1")).toEqual({ state: "expired" });
    expect(await port(status({ state: "idle" })).status("d1")).toEqual({ state: "idle" });
    // an admitted state without a token must not be treated as admitted
    expect(await port(status({ state: "admitted" })).status("d1")).toEqual({ state: "idle" });
  });

  it("join sends the device id and idempotency key, and reports the waiting position", async () => {
    const joinDropQueue = vi.fn(() => ok({ state: "waiting", position: 9 }));
    const res = await port({ joinDropQueue }).join("d1", "key-1");
    expect(res).toEqual({ state: "waiting", position: 9, etaSeconds: null, pollAfterMs: 2_000 });
    expect(joinDropQueue).toHaveBeenCalledWith({ path: { dropId: "d1" }, headers: { "X-Device-Id": "device-12345" } }, { idempotencyKey: "key-1" });
  });

  it("join of an already admitted shopper reads the status", async () => {
    const client = {
      joinDropQueue: () => ok({ state: "admitted" }),
      getDropQueueStatus: () => ok({ state: "admitted", admission_token: "t", expires_at: "2026-10-01T10:00:00Z" }),
    };
    expect((await port(client).join("d1", "k")).state).toBe("admitted");
  });

  it.each([
    ["purchase-limit-reached", "perUserLimit"], ["members-only", "membersOnly"], ["sold-out", "soldOut"], ["drop-paused", "paused"],
    ["drop-not-live", "notLive"], ["drop_not_live", "notLive"], ["age-restricted", "underAge"],
  ])("join rejection %s maps to %s", async (type, reason) => {
    const client = { joinDropQueue: () => Promise.reject(problem(409, type)) };
    expect(await port(client).join("d1", "k")).toEqual({ state: "rejected", reason });
  });

  it("join rethrows an unclassified failure as a PortError", async () => {
    await expect(port({ joinDropQueue: () => Promise.reject(problem(500, "weird")) }).join("d1", "k")).rejects.toBeInstanceOf(PortError);
    await expect(port({ joinDropQueue: () => Promise.reject(new Error("x")) }).join("d1", "k")).rejects.toMatchObject({ kind: "failed" });
  });

  it("leave is local and waitlist posts with the idempotency key", async () => {
    const joinDropWaitlist = vi.fn(() => ok({}));
    const p = port({ joinDropWaitlist });
    await expect(p.leave("d1")).resolves.toBeUndefined();
    await p.waitlist("d1", "wk");
    expect(joinDropWaitlist).toHaveBeenCalledWith({ path: { id: "d1" } }, { idempotencyKey: "wk" });
  });
});
