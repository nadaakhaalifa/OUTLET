import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HOUR,
  IDEM,
  SKU_1,
  SKU_2,
  STORE_A,
  STORE_B,
  TOKENS,
  USERS,
  bearer,
  createDropsHarness,
  type DropsHarness,
} from "./test/harness";

let h: DropsHarness;
let idem = 1;
const key = (): Record<string, string> => ({ "Idempotency-Key": IDEM(idem++) });
const dev = (n: number): Record<string, string> => ({ "x-device-id": `device-number-${n}`, "x-app-attest": `attest-${n}` });
const shopperToken = (i: number): string => TOKENS.shoppers[i] ?? "";

const iso = (ms: number): string => new Date(ms).toISOString();

async function createDrop(over: Record<string, unknown> = {}, token: string = TOKENS.ownerA) {
  const now = h.clock.nowMs();
  const body = {
    type: "public",
    title: "Summer clearance",
    starts_at: iso(now + HOUR),
    ends_at: iso(now + 3 * HOUR),
    items: [
      { sku_id: SKU_1, stock_cap: 3, price: "150000" },
      { sku_id: SKU_2, stock_cap: 2, price: 90000 },
    ],
    limits: { per_user: 2, per_device: 2 },
    admit_per_sec: 50,
    ...over,
  };
  return h.http().post("/v1/seller/drops").set(bearer(token)).set(key()).send(body);
}

async function liveDrop(over: Record<string, unknown> = {}): Promise<string> {
  const c = await createDrop(over);
  expect(c.status).toBe(201);
  const id = c.body.id as string;
  const s = await h.http().post(`/v1/seller/drops/${id}/schedule`).set(bearer(TOKENS.ownerA)).set(key()).send({});
  expect(s.status).toBe(200);
  h.clock.advance(HOUR + 1000);
  await h.advance.run();
  return id;
}

beforeAll(async () => {
  h = await createDropsHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe("seller CRUD and authorization", () => {
  it("creates a DRAFT, returns money as strings", async () => {
    const r = await createDrop();
    expect(r.status).toBe(201);
    expect(r.body.state).toBe("DRAFT");
    expect(r.body.items[0].price).toBe("150000");
    expect(r.body.store_id).toBe(STORE_A);
  });
  it("rejects invalid drafts with field errors", async () => {
    const r = await createDrop({ type: "flash_hour" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("flash_hour_is_60_min");
  });
  it("401 without a token, 403 for a shopper on the seller audience, 403 for support role", async () => {
    expect((await h.http().post("/v1/seller/drops").set(key()).send({})).status).toBe(401);
    expect((await createDrop({}, TOKENS.shopperOnSellerAud)).status).toBe(403);
    expect((await createDrop({}, TOKENS.supportA)).status).toBe(403);
  });
  it("another store's drop is a 404 for read, edit, schedule and delete (BOLA)", async () => {
    const c = await createDrop();
    const id = c.body.id as string;
    const o = bearer(TOKENS.ownerB);
    expect((await h.http().get(`/v1/seller/drops/${id}`).set(o)).status).toBe(404);
    expect((await h.http().patch(`/v1/seller/drops/${id}`).set(o).set(key()).send({ title: "Hijack" })).status).toBe(404);
    expect((await h.http().post(`/v1/seller/drops/${id}/schedule`).set(o).set(key()).send({})).status).toBe(404);
    expect((await h.http().delete(`/v1/seller/drops/${id}`).set(o)).status).toBe(404);
  });
  it("cannot create a drop for a store it does not belong to", async () => {
    const r = await createDrop({ store_id: STORE_B });
    expect(r.status).toBe(404);
  });
  it("list is tenant scoped", async () => {
    await createDrop({}, TOKENS.ownerB);
    const a = await h.http().get("/v1/seller/drops").set(bearer(TOKENS.ownerA));
    expect(a.status).toBe(200);
    for (const d of a.body.items as { store_id: string }[]) expect(d.store_id).toBe(STORE_A);
  });
  it("DRAFT is deletable and invisible to the public", async () => {
    const c = await createDrop();
    const id = c.body.id as string;
    expect((await h.http().get(`/v1/drops/${id}`)).status).toBe(404);
    expect((await h.http().delete(`/v1/seller/drops/${id}`).set(bearer(TOKENS.ownerA))).status).toBe(204);
    expect((await h.http().get(`/v1/seller/drops/${id}`).set(bearer(TOKENS.ownerA))).status).toBe(404);
  });
});

describe("SCHEDULED drops: price and stock are locked, stock may only increase", () => {
  it("returns 409 for a price change or a stock decrease and 200 for an increase", async () => {
    const c = await createDrop();
    const id = c.body.id as string;
    await h.http().post(`/v1/seller/drops/${id}/schedule`).set(bearer(TOKENS.ownerA)).set(key()).send({}).expect(200);
    const patch = (items: unknown) =>
      h.http().patch(`/v1/seller/drops/${id}`).set(bearer(TOKENS.ownerA)).set(key()).send({ items });
    const price = await patch([
      { sku_id: SKU_1, stock_cap: 3, price: "140000" },
      { sku_id: SKU_2, stock_cap: 2, price: "90000" },
    ]);
    expect(price.status).toBe(409);
    expect(price.body.code).toBe("drop_locked_price_locked");
    const lower = await patch([
      { sku_id: SKU_1, stock_cap: 2, price: "150000" },
      { sku_id: SKU_2, stock_cap: 2, price: "90000" },
    ]);
    expect(lower.status).toBe(409);
    expect(lower.body.code).toBe("drop_locked_stock_lowered");
    const up = await patch([
      { sku_id: SKU_1, stock_cap: 5, price: "150000" },
      { sku_id: SKU_2, stock_cap: 2, price: "90000" },
    ]);
    expect(up.status).toBe(200);
    expect(up.body.items[0].stock_cap).toBe(5);
    expect((await h.inventory.snapshot(id, SKU_1)).cap).toBe(5);
  });
  it("cannot schedule a drop whose start is in the past", async () => {
    const c = await createDrop({ starts_at: iso(h.clock.nowMs() - 1000), ends_at: iso(h.clock.nowMs() + HOUR) });
    const r = await h.http().post(`/v1/seller/drops/${c.body.id}/schedule`).set(bearer(TOKENS.ownerA)).set(key()).send({});
    expect(r.status).toBe(409);
  });
});

describe("lifecycle sweeper and public views", () => {
  it("moves SCHEDULED -> LIVE -> ENDED on server time, idempotently", async () => {
    const id = await liveDrop();
    expect((await h.store.get(id))?.state).toBe("LIVE");
    expect((await h.advance.run()).advanced.filter((a) => a.dropId === id)).toEqual([]);
    h.clock.advance(3 * HOUR);
    const rep = await h.advance.run();
    expect(rep.advanced.filter((a) => a.dropId === id)).toEqual([{ dropId: id, to: "ENDED" }]);
    expect(h.store.events.filter((e) => e.type === "drop.live" && e.dropId === id)).toHaveLength(1);
    expect(h.store.events.filter((e) => e.type === "drop.ended" && e.dropId === id)).toHaveLength(1);
  });
  it("public view never carries a discount claim and hides social proof below threshold", async () => {
    const id = await liveDrop();
    const r = await h.http().get(`/v1/drops/${id}`);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/was_price|strike|discount|percent_off|save/i);
    // 5 units genuinely remain (3 + 2): that is real and at the "<= 5" display bound.
    expect(r.body.social_proof).toEqual({ bought_24h: null, viewing_now: null, remaining: 5 });
  });
  it("shows real counts only above the threshold, refreshed once a minute", async () => {
    const id = await liveDrop({ items: [{ sku_id: SKU_1, stock_cap: 100, price: "50000" }], limits: { per_user: 10, per_device: 10 } });
    h.signals.set(id, 9);
    const first = await h.http().get(`/v1/drops/${id}`);
    expect(first.body.social_proof.viewing_now).toBeNull();
    h.signals.set(id, 40);
    // Within the 1-minute cache the number does not move.
    const cached = await h.http().get(`/v1/drops/${id}`);
    expect(cached.body.social_proof.viewing_now).toBeNull();
    h.clock.advance(61_000);
    const fresh = await h.http().get(`/v1/drops/${id}`);
    expect(fresh.body.social_proof.viewing_now).toBe(40);
    expect(fresh.body.social_proof.remaining).toBeNull(); // 100 units left: not shown
  });
  it("lists with a keyset cursor and rejects a forged cursor", async () => {
    const r = await h.http().get("/v1/drops?limit=1");
    expect(r.status).toBe(200);
    if (r.body.page.next_cursor !== null) {
      expect((await h.http().get(`/v1/drops?limit=1&cursor=${r.body.page.next_cursor}`)).status).toBe(200);
    }
    expect((await h.http().get("/v1/drops?cursor=@@@")).status).toBe(400);
  });
});

describe("queue: admission, fairness and gates", () => {
  it("requires authentication, a device id and attestation", async () => {
    const id = await liveDrop();
    expect((await h.http().post(`/v1/drops/${id}/queue`).set(key()).set(dev(1))).status).toBe(401);
    const noDev = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key());
    expect(noDev.status).toBe(400);
    const noAttest = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set("x-device-id", "device-number-1");
    expect(noAttest.status).toBe(403);
    expect(noAttest.body.code).toBe("attestation_failed");
  });

  it("queues, admits FIFO and the token buys exactly once", async () => {
    const id = await liveDrop();
    const j1 = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(11));
    expect(j1.status).toBe(200);
    expect(j1.body.state).toBe("waiting");
    const j2 = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(1))).set(key()).set(dev(12));
    expect(j2.body.position).toBe(2);
    h.clock.advance(1000);
    const w = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(1)));
    expect(w.body.state).toBe("waiting");
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(0)));
    expect(s.body.state).toBe("admitted");
    const token = s.body.admission_token as string;

    const lines = [{ skuId: SKU_1, qty: 1 }];
    const base = { dropId: id, userId: USERS[0], deviceId: "device-number-11", lines };
    // Another account, another device, or another drop cannot use the token.
    expect((await h.reserve.execute({ ...base, userId: USERS[1], admissionToken: token })).kind).toBe("admission_invalid");
    expect((await h.reserve.execute({ ...base, deviceId: "device-number-99", admissionToken: token })).kind).toBe("admission_invalid");
    const ok = await h.reserve.execute({ ...base, admissionToken: token });
    expect(ok.kind).toBe("reserved");
    // Replay is refused: single use per drop.
    expect((await h.reserve.execute({ ...base, admissionToken: token })).kind).toBe("admission_used");
    // The status no longer hands the token out once it is used.
    h.clock.advance(1000);
    const after = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(0)));
    expect(after.body.state).not.toBe("admitted");
  });

  it("replays an idempotent join with the same response", async () => {
    const id = await liveDrop();
    const k = key();
    const a = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(2))).set(k).set(dev(21));
    const b = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(2))).set(k).set(dev(21));
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  it("the same device with three accounts holds one active ticket", async () => {
    const id = await liveDrop();
    const r1 = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(3))).set(key()).set(dev(31));
    const r2 = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(4))).set(key()).set(dev(31));
    const r3 = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(5))).set(key()).set(dev(31));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe("device_has_active_ticket");
    expect(r3.status).toBe(409);
    expect(await h.queue.size(id)).toBe(1);
  });

  it("an expired admission token is refused and the user rejoins at the back", async () => {
    const id = await liveDrop();
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(6))).set(key()).set(dev(41)).expect(200);
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(7))).set(key()).set(dev(42)).expect(200);
    h.clock.advance(1000);
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(6)));
    expect(s.body.state).toBe("admitted");
    h.clock.advance(16 * 60_000);
    const expired = await h.reserve.execute({
      dropId: id,
      userId: USERS[6],
      deviceId: "device-number-41",
      admissionToken: s.body.admission_token as string,
      lines: [{ skuId: SKU_1, qty: 1 }],
    });
    expect(expired.kind).toBe("admission_expired");
    const st = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(6)));
    expect(st.body).toEqual({ state: "not_queued", admission_expired: true });
    await h.admit.run(id); // frees the device and account after the token window
    const again = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(6))).set(key()).set(dev(41));
    expect(again.status).toBe(200);
    expect(again.body.resumed).toBe(false);
  });

  it("refuses a bot, challenges a grey score, and fails closed if scoring is down", async () => {
    const id = await liveDrop();
    h.bot.set(USERS[0], 95);
    const blocked = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(51));
    expect(blocked.body.code).toBe("bot_blocked");
    h.bot.set(USERS[0], 65);
    const challenged = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(51));
    expect(challenged.body.code).toBe("challenge_required");
    h.bot.set(USERS[0], 0);
    h.bot.fail = true;
    const down = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(51));
    expect(down.status).toBe(403);
    h.bot.fail = false;
  });
});

describe("members-only early access", () => {
  async function earlyDrop(): Promise<string> {
    const now = h.clock.nowMs();
    const start = now + 25 * HOUR;
    const c = await createDrop({
      type: "members_only",
      starts_at: iso(start),
      early_access_at: iso(start - 24 * HOUR),
      ends_at: iso(start + 2 * HOUR),
    });
    expect(c.status).toBe(201);
    const id = c.body.id as string;
    await h.http().post(`/v1/seller/drops/${id}/schedule`).set(bearer(TOKENS.ownerA)).set(key()).send({}).expect(200);
    h.clock.advance(HOUR + 1000);
    await h.advance.run();
    expect((await h.store.get(id))?.state).toBe("EARLY_ACCESS");
    return id;
  }

  it("refuses a non-Plus user with an explanation and admits a Plus member", async () => {
    const id = await earlyDrop();
    const no = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(61));
    expect(no.status).toBe(403);
    expect(no.body.code).toBe("plus_required");
    h.entitlements.grant(USERS[1]);
    const yes = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(1))).set(key()).set(dev(62));
    expect(yes.status).toBe(200);
    h.entitlements.revoke(USERS[1]);
  });

  it("re-checks the Plus entitlement at admission", async () => {
    const id = await earlyDrop();
    h.entitlements.grant(USERS[2]);
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(2))).set(key()).set(dev(63)).expect(200);
    h.entitlements.revoke(USERS[2]);
    h.clock.advance(1000);
    const rep = await h.admit.run(id);
    expect(rep.admitted).toBe(0);
    expect(rep.rejected).toBeGreaterThanOrEqual(1);
    h.clock.advance(1000);
    const st = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(2)));
    expect(st.body.state).toBe("not_queued");
  });
});

describe("kill switches, pause and Redis down", () => {
  it("drops_all kill switch pauses the queue with 503", async () => {
    const id = await liveDrop();
    h.roomSwitches.kill("drops_all");
    const r = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(71));
    expect(r.status).toBe(503);
    h.roomSwitches.restore("drops_all");
  });

  it("admin pause is role gated and pauses the queue; resume restores it", async () => {
    const id = await liveDrop();
    const body = { action: "pause" };
    expect((await h.http().post(`/v1/admin/drops/${id}/pause`).set(key()).send(body)).status).toBe(401);
    expect((await h.http().post(`/v1/admin/drops/${id}/pause`).set(bearer(TOKENS.shopperOnAdminAud)).set(key()).send(body)).status).toBe(403);
    expect((await h.http().post(`/v1/admin/drops/${id}/pause`).set(bearer(TOKENS.adminSupport)).set(key()).send(body)).status).toBe(403);
    const ok = await h.http().post(`/v1/admin/drops/${id}/pause`).set(bearer(TOKENS.moderator)).set(key()).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.paused).toBe(true);
    const j = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(72));
    expect(j.status).toBe(503);
    expect(j.body.code).toBe("drop_paused");
    await h.http().post(`/v1/admin/drops/${id}/pause`).set(bearer(TOKENS.moderator)).set(key()).send({ action: "resume" }).expect(200);
    const j2 = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(72));
    expect(j2.status).toBe(200);
  });

  it("admin end honours reserved units and closes the unsold pool", async () => {
    const id = await liveDrop();
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(73)).expect(200);
    h.clock.advance(1000);
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(0)));
    const r = await h.reserve.execute({
      dropId: id,
      userId: USERS[0],
      deviceId: "device-number-73",
      admissionToken: s.body.admission_token as string,
      lines: [{ skuId: SKU_1, qty: 1 }],
    });
    expect(r.kind).toBe("reserved");
    await h.http().post(`/v1/admin/drops/${id}/pause`).set(bearer(TOKENS.moderator)).set(key()).send({ action: "end" }).expect(200);
    expect((await h.store.get(id))?.state).toBe("ENDED");
    const snap = await h.inventory.snapshot(id, SKU_1);
    expect(snap.reserved).toBe(1);
    expect(snap.available).toBe(0);
  });

  it("Redis down: the queue fails closed (503) but an admitted shopper still buys and normal status serves", async () => {
    const id = await liveDrop();
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(81)).expect(200);
    h.clock.advance(1000);
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(0)));
    expect(s.body.state).toBe("admitted");

    h.queue.down = true;
    try {
      const join = await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(1))).set(key()).set(dev(82));
      expect(join.status).toBe(503);
      expect(join.body.code).toBe("drops_paused");
      expect((await h.admit.run(id)).paused).toBe(true);
      // Token verification is stateless and the reservation never touches the queue.
      const buy = await h.reserve.execute({
        dropId: id,
        userId: USERS[0],
        deviceId: "device-number-81",
        admissionToken: s.body.admission_token as string,
        lines: [{ skuId: SKU_2, qty: 1 }],
      });
      expect(buy.kind).toBe("reserved");
      // Public reads and the lifecycle sweeper keep working.
      expect((await h.http().get(`/v1/drops/${id}`)).status).toBe(200);
      await h.advance.run();
    } finally {
      h.queue.down = false;
    }
  });

  it("a rotated signing key keeps tokens valid until the old key is retired", async () => {
    const id = await liveDrop();
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(91)).expect(200);
    h.clock.advance(1000);
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(0)));
    h.secrets.rotate("k2", "second-signing-key-0123456789abcdef!!");
    const v = await h.verifier.verify({ token: s.body.admission_token as string, dropId: id, userId: USERS[0], deviceId: "device-number-91" });
    expect(v.ok).toBe(true);
    h.secrets.retire("k1");
    const v2 = await h.verifier.verify({ token: s.body.admission_token as string, dropId: id, userId: USERS[0], deviceId: "device-number-91" });
    expect(v2).toEqual({ ok: false, code: "bad_signature" });
    const forged = (s.body.admission_token as string).replace(/\.[^.]+$/, ".AAAA");
    expect((await h.verifier.verify({ token: forged, dropId: id, userId: USERS[0], deviceId: "device-number-91" })).ok).toBe(false);
  });
});

describe("limits, sold out and waitlist", () => {
  it("enforces per-user limits and goes SOLD_OUT only when units are claimed", async () => {
    const id = await liveDrop({ items: [{ sku_id: SKU_1, stock_cap: 1, price: "10000" }], limits: { per_user: 1, per_device: 1 } });
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(0))).set(key()).set(dev(101)).expect(200);
    h.clock.advance(1000);
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(0)));
    const over = await h.reserve.execute({
      dropId: id,
      userId: USERS[0],
      deviceId: "device-number-101",
      admissionToken: s.body.admission_token as string,
      lines: [{ skuId: SKU_1, qty: 2 }],
    });
    expect(over).toMatchObject({ kind: "limit_exceeded", code: "user_limit" });
    const ok = await h.reserve.execute({
      dropId: id,
      userId: USERS[0],
      deviceId: "device-number-101",
      admissionToken: s.body.admission_token as string,
      lines: [{ skuId: SKU_1, qty: 1 }],
    });
    expect(ok.kind).toBe("reserved");
    expect((await h.store.get(id))?.state).toBe("LIVE"); // reserved is not sold
    if (ok.kind !== "reserved") return;
    const waitEarly = await h.http().post(`/v1/drops/${id}/waitlist`).set(bearer(shopperToken(1))).set(key());
    expect(waitEarly.status).toBe(409); // the pre-filter has no sold-out hint yet
    expect(await h.claim.execute(ok.lines[0]?.reservationId ?? "", id)).toBe("claimed");
    expect((await h.store.get(id))?.state).toBe("SOLD_OUT");
    expect(h.store.events.some((e) => e.type === "drop.sold_out" && e.dropId === id)).toBe(true);
    const wl = await h.http().post(`/v1/drops/${id}/waitlist`).set(bearer(shopperToken(1))).set(key());
    expect(wl.status).toBe(200);
    expect((await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(2))).set(key()).set(dev(102))).status).toBe(409);
  });

  it("an abandoned reservation returns its units and frees the allowance", async () => {
    const id = await liveDrop({ items: [{ sku_id: SKU_1, stock_cap: 1, price: "10000" }], limits: { per_user: 1, per_device: 1 } });
    await h.http().post(`/v1/drops/${id}/queue`).set(bearer(shopperToken(3))).set(key()).set(dev(111)).expect(200);
    h.clock.advance(1000);
    await h.admit.run(id);
    h.clock.advance(1000);
    const s = await h.http().get(`/v1/drops/${id}/queue/status`).set(bearer(shopperToken(3)));
    const r = await h.reserve.execute({
      dropId: id,
      userId: USERS[3],
      deviceId: "device-number-111",
      admissionToken: s.body.admission_token as string,
      lines: [{ skuId: SKU_1, qty: 1 }],
    });
    if (r.kind !== "reserved") throw new Error("expected reserved");
    expect((await h.inventory.snapshot(id, SKU_1)).available).toBe(0);
    h.clock.advance(11 * 60_000);
    const rep = await h.advance.run();
    expect(rep.releasedReservations).toBeGreaterThanOrEqual(1);
    expect((await h.inventory.snapshot(id, SKU_1)).available).toBe(1);
    expect((await h.store.purchased(id, SKU_1, USERS[3], "x")).byUser).toBe(0);
  });

  it("waitlist requires auth and a known drop", async () => {
    expect((await h.http().post(`/v1/drops/${USERS[0]}/waitlist`).set(key())).status).toBe(401);
    expect((await h.http().post(`/v1/drops/${USERS[0]}/waitlist`).set(bearer(shopperToken(0))).set(key())).status).toBe(404);
  });
});
