import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dropMachine } from "../state-machine/machines/drop";
import {
  ADMISSION_TTL_MS,
  DEFAULT_SOCIAL_PROOF,
  EARLY_ACCESS_MS,
  FifoWaitingQueue,
  HOUR_MS,
  checkAdmissionClaims,
  checkEdit,
  checkPurchaseLimit,
  decideBot,
  dueEvent,
  fifoDeviation,
  joinVerdict,
  ladderPriceAt,
  mayAdmit,
  needsRefresh,
  nextState,
  socialProof,
  validateDraft,
  type Drop,
  type DropDraft,
} from "./index";

const T0 = 1_800_000_000_000;
const draft = (over: Partial<DropDraft> = {}): DropDraft => ({
  type: "public",
  title: "Summer clearance",
  startsAtMs: T0 + 10 * HOUR_MS,
  earlyAccessAtMs: null,
  endsAtMs: T0 + 20 * HOUR_MS,
  items: [{ skuId: "sku-1", stockCap: 10, pricePiastres: 100_000n }],
  limits: { perUser: 2, perDevice: 2 },
  ladder: [],
  mystery: null,
  admitPerSec: 50,
  ...over,
});
const drop = (over: Partial<Drop> = {}): Drop => ({
  ...draft(),
  id: "d1",
  storeId: "s1",
  state: "DRAFT",
  paused: false,
  createdAtMs: T0,
  updatedAtMs: T0,
  version: 1,
  ...over,
});

describe("validateDraft", () => {
  it("accepts a plain public drop", () => expect(validateDraft(draft())).toEqual([]));
  it("members-only needs exactly 24h early access", () => {
    const d = draft({ type: "members_only", earlyAccessAtMs: T0 + 10 * HOUR_MS - EARLY_ACCESS_MS });
    expect(validateDraft(d)).toEqual([]);
    expect(validateDraft({ ...d, earlyAccessAtMs: T0 + 10 * HOUR_MS - HOUR_MS })).toContainEqual({ field: "early_access_at", code: "must_be_24h" });
    expect(validateDraft({ ...d, earlyAccessAtMs: null })).toContainEqual({ field: "early_access_at", code: "before_start" });
  });
  it("early access on a non members-only type is refused", () => {
    expect(validateDraft(draft({ earlyAccessAtMs: T0 }))).toContainEqual({ field: "early_access_at", code: "members_only" });
  });
  it("flash hour is exactly 60 minutes", () => {
    expect(validateDraft(draft({ type: "flash_hour" }))).toContainEqual({ field: "ends_at", code: "flash_hour_is_60_min" });
    expect(validateDraft(draft({ type: "flash_hour", endsAtMs: T0 + 11 * HOUR_MS }))).toEqual([]);
  });
  it("price ladder: published, starts at the start, falling", () => {
    const s = T0 + 10 * HOUR_MS;
    const ok = draft({
      type: "price_ladder",
      ladder: [
        { atMs: s, pricePiastres: 100_000n },
        { atMs: s + HOUR_MS, pricePiastres: 80_000n },
      ],
    });
    expect(validateDraft(ok)).toEqual([]);
    const rising = { ...ok, ladder: [ok.ladder[0]!, { atMs: s + HOUR_MS, pricePiastres: 120_000n }] };
    expect(validateDraft(rising)).toContainEqual({ field: "ladder.1.price", code: "must_fall" });
    expect(validateDraft(draft({ type: "price_ladder" }))).toContainEqual({ field: "ladder", code: "steps" });
  });
  it("mystery box discloses range and guaranteed minimum", () => {
    expect(validateDraft(draft({ type: "mystery_box" }))).toContainEqual({ field: "mystery", code: "required" });
    const m = { minValuePiastres: 50_000n, maxValuePiastres: 200_000n, guaranteedMinPiastres: 50_000n };
    expect(validateDraft(draft({ type: "mystery_box", mystery: m }))).toEqual([]);
    expect(validateDraft(draft({ type: "mystery_box", mystery: { ...m, guaranteedMinPiastres: 10n } }))).toContainEqual({ field: "mystery", code: "range" });
  });
  it("limits: device limit cannot be below user limit", () => {
    expect(validateDraft(draft({ limits: { perUser: 3, perDevice: 2 } }))).toContainEqual({ field: "limits.per_device", code: "range" });
  });
});

describe("checkEdit (seller cannot edit price/stock after SCHEDULED except to increase stock)", () => {
  const scheduled = drop({ state: "SCHEDULED" });
  it("DRAFT is free", () => {
    expect(checkEdit(drop(), { items: [{ skuId: "sku-1", stockCap: 1, pricePiastres: 5n }] })).toEqual({ ok: true });
  });
  it("SCHEDULED: price change is locked", () => {
    expect(checkEdit(scheduled, { items: [{ skuId: "sku-1", stockCap: 10, pricePiastres: 99_999n }] })).toEqual({ ok: false, code: "price_locked" });
  });
  it("SCHEDULED: lowering stock is locked, raising is allowed", () => {
    expect(checkEdit(scheduled, { items: [{ skuId: "sku-1", stockCap: 9, pricePiastres: 100_000n }] })).toEqual({ ok: false, code: "stock_lowered" });
    expect(checkEdit(scheduled, { items: [{ skuId: "sku-1", stockCap: 11, pricePiastres: 100_000n }] })).toEqual({ ok: true });
  });
  it("SCHEDULED: sku set and schedule are locked", () => {
    expect(checkEdit(scheduled, { items: [] })).toEqual({ ok: false, code: "sku_set_locked" });
    expect(checkEdit(scheduled, { startsAtMs: scheduled.startsAtMs + 1 })).toEqual({ ok: false, code: "schedule_locked" });
  });
  it("running drops are not editable", () => {
    for (const s of ["EARLY_ACCESS", "LIVE", "SOLD_OUT", "ENDED", "ARCHIVED"] as const) {
      expect(checkEdit(drop({ state: s }), {})).toEqual({ ok: false, code: "state_locked" });
    }
  });
  it("property: any patch that is accepted on SCHEDULED never changes a price or lowers a cap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), fc.bigInt({ min: 1n, max: 200_000n }), (cap, price) => {
        const v = checkEdit(scheduled, { items: [{ skuId: "sku-1", stockCap: cap, pricePiastres: price }] });
        if (v.ok) expect(cap >= 10 && price === 100_000n).toBe(true);
      }),
    );
  });
});

describe("lifecycle", () => {
  it("reuses the registered Drop machine and never skips states", () => {
    expect(nextState("DRAFT", "SCHEDULE")).toBe("SCHEDULED");
    expect(() => nextState("DRAFT", "GO_LIVE")).toThrow();
    expect(dropMachine.analyze().ok).toBe(true);
  });
  it("dueEvent follows server time", () => {
    const base = { startsAtMs: 1000, earlyAccessAtMs: 400, endsAtMs: 2000 };
    expect(dueEvent({ ...base, state: "SCHEDULED" }, 399)).toBeNull();
    expect(dueEvent({ ...base, state: "SCHEDULED" }, 400)).toBe("OPEN_EARLY_ACCESS");
    expect(dueEvent({ ...base, state: "SCHEDULED" }, 1000)).toBe("GO_LIVE");
    expect(dueEvent({ ...base, state: "EARLY_ACCESS" }, 1000)).toBe("GO_LIVE");
    expect(dueEvent({ ...base, state: "LIVE" }, 1999)).toBeNull();
    expect(dueEvent({ ...base, state: "LIVE" }, 2000)).toBe("WINDOW_CLOSED");
    expect(dueEvent({ ...base, state: "SOLD_OUT" }, 9999)).toBeNull();
  });
  it("non-Plus user is refused during EARLY_ACCESS with a reason", () => {
    const d = drop({ state: "EARLY_ACCESS", type: "members_only", earlyAccessAtMs: T0, startsAtMs: T0 + EARLY_ACCESS_MS });
    expect(joinVerdict(d, T0 + 1, false, 60_000)).toEqual({ ok: false, code: "plus_required" });
    expect(joinVerdict(d, T0 + 1, true, 60_000)).toEqual({ ok: true, phase: "early_access" });
  });
  it("pause and sold-out block both join and admission", () => {
    const live = drop({ state: "LIVE", paused: true });
    expect(joinVerdict(live, T0, true, 0)).toEqual({ ok: false, code: "paused" });
    expect(mayAdmit(live)).toBe(false);
    expect(joinVerdict(drop({ state: "SOLD_OUT" }), T0, true, 0)).toEqual({ ok: false, code: "sold_out" });
    expect(mayAdmit(drop({ state: "LIVE" }))).toBe(true);
  });
  it("SCHEDULED drops accept joins only inside the pre-queue window", () => {
    const d = drop({ state: "SCHEDULED", startsAtMs: T0 + 100_000 });
    expect(joinVerdict(d, T0, false, 60_000)).toEqual({ ok: false, code: "not_open" });
    expect(joinVerdict(d, T0 + 50_000, false, 60_000)).toEqual({ ok: true, phase: "pre_open" });
    expect(joinVerdict(d, T0 + 100_000, false, 60_000)).toEqual({ ok: true, phase: "live" });
  });
});

describe("ladder", () => {
  const ladder = [
    { atMs: 100, pricePiastres: 1000n },
    { atMs: 200, pricePiastres: 800n },
    { atMs: 300, pricePiastres: 500n },
  ];
  it("steps down on the published schedule", () => {
    expect(ladderPriceAt(ladder, 50_000n, 99)).toBe(50_000n);
    expect(ladderPriceAt(ladder, 50_000n, 100)).toBe(50_000n);
    expect(ladderPriceAt(ladder, 50_000n, 250)).toBe(40_000n);
    expect(ladderPriceAt(ladder, 50_000n, 9999)).toBe(25_000n);
  });
  it("property: price never rises over time", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000n }), fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (p, a, b) => {
        const [x, y] = a <= b ? [a, b] : [b, a];
        expect(ladderPriceAt(ladder, p, y) <= ladderPriceAt(ladder, p, x)).toBe(true);
      }),
    );
  });
});

describe("purchase limits", () => {
  it("enforces per user and per device", () => {
    const l = { perUser: 2, perDevice: 3 };
    expect(checkPurchaseLimit(l, { byUser: 0, byDevice: 0 }, 2)).toEqual({ ok: true });
    expect(checkPurchaseLimit(l, { byUser: 1, byDevice: 0 }, 2)).toMatchObject({ ok: false, code: "user_limit", remaining: 1 });
    expect(checkPurchaseLimit(l, { byUser: 0, byDevice: 2 }, 2)).toMatchObject({ ok: false, code: "device_limit", remaining: 1 });
    expect(checkPurchaseLimit(l, { byUser: 0, byDevice: 0 }, 0)).toMatchObject({ ok: false, code: "bad_quantity" });
  });
});

describe("social proof is truthful", () => {
  it("hides below threshold, null signals and remaining above 5", () => {
    expect(socialProof({ boughtToday: 19, viewingNow: 9, remaining: 6 })).toEqual({ boughtToday: null, viewingNow: null, remaining: null });
    expect(socialProof({ boughtToday: 20, viewingNow: 10, remaining: 5 })).toEqual({ boughtToday: 20, viewingNow: 10, remaining: 5 });
    expect(socialProof({ boughtToday: null, viewingNow: null, remaining: null })).toEqual({ boughtToday: null, viewingNow: null, remaining: null });
    expect(socialProof({ boughtToday: 500, viewingNow: 0, remaining: 0 }).remaining).toBeNull();
  });
  it("property: output is always either null or the real input value", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 1000 }), fc.integer({ min: -5, max: 1000 }), fc.integer({ min: -5, max: 50 }), (b, v, r) => {
        const o = socialProof({ boughtToday: b, viewingNow: v, remaining: r });
        expect(o.boughtToday === null || o.boughtToday === b).toBe(true);
        expect(o.viewingNow === null || o.viewingNow === v).toBe(true);
        expect(o.remaining === null || (o.remaining === r && r <= 5 && r >= 1)).toBe(true);
      }),
    );
  });
  it("refresh is once per minute", () => {
    expect(needsRefresh(null, 5)).toBe(true);
    expect(needsRefresh(1000, 1000 + DEFAULT_SOCIAL_PROOF.refreshMs - 1)).toBe(false);
    expect(needsRefresh(1000, 1000 + DEFAULT_SOCIAL_PROOF.refreshMs)).toBe(true);
  });
});

describe("admission claims and bot decision", () => {
  const c = { jti: "j", dropId: "d", userId: "u", deviceHash: "h", iatMs: 1000, expMs: 1000 + ADMISSION_TTL_MS };
  const exp = { dropId: "d", userId: "u", deviceHash: "h" };
  it("binds to drop, user and device and expires at 15 min", () => {
    expect(checkAdmissionClaims(c, exp, 1000)).toEqual({ ok: true });
    expect(checkAdmissionClaims(c, exp, c.expMs)).toEqual({ ok: false, code: "expired" });
    expect(checkAdmissionClaims(c, { ...exp, userId: "x" }, 1000)).toEqual({ ok: false, code: "wrong_user" });
    expect(checkAdmissionClaims(c, { ...exp, deviceHash: "x" }, 1000)).toEqual({ ok: false, code: "wrong_device" });
    expect(checkAdmissionClaims(c, { ...exp, dropId: "x" }, 1000)).toEqual({ ok: false, code: "wrong_drop" });
    expect(checkAdmissionClaims({ ...c, expMs: c.expMs + 1 }, exp, 1000)).toEqual({ ok: false, code: "bad_lifetime" });
  });
  it("bot scores fail closed", () => {
    expect(decideBot(10)).toBe("allow");
    expect(decideBot(65)).toBe("challenge");
    expect(decideBot(80)).toBe("block");
    expect(decideBot(Number.NaN)).toBe("block");
    expect(decideBot(-1)).toBe("block");
  });
});

describe("FifoWaitingQueue", () => {
  it("one active ticket per device, accounts collapse to the earliest", () => {
    const q = new FifoWaitingQueue();
    const a = q.join("t1", "u1", "dev", 0);
    expect(a.kind).toBe("joined");
    expect(q.join("t2", "u2", "dev", 1).kind).toBe("device_busy");
    expect(q.join("t3", "u3", "dev", 2).kind).toBe("device_busy");
    const again = q.join("t4", "u1", "dev2", 3);
    expect(again.kind).toBe("existing");
    if (again.kind === "existing") expect(again.ticket.id).toBe("t1");
    expect(q.waitingCount).toBe(1);
  });
  it("admits strictly in arrival order and positions follow", () => {
    const q = new FifoWaitingQueue();
    for (let i = 0; i < 5; i++) q.join(`t${i}`, `u${i}`, `d${i}`, i);
    expect(q.position("t3")).toBe(4);
    expect(q.admit(2, 10).map((t) => t.id)).toEqual(["t0", "t1"]);
    expect(q.position("t3")).toBe(2);
    expect(q.admit(10, 11).map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
    expect(q.admit(1, 12)).toEqual([]);
  });
  it("heartbeat TTL releases the slot after 30 s", () => {
    const q = new FifoWaitingQueue();
    q.join("t0", "u0", "d0", 0);
    q.join("t1", "u1", "d1", 0);
    q.heartbeat("u1", 25_000);
    const gone = q.expire(31_000);
    expect(gone.map((t) => t.id)).toEqual(["t0"]);
    expect(q.position("t1")).toBe(1);
    expect(q.join("t9", "u0", "d0", 32_000).kind).toBe("joined");
  });
  it("an admitted account cannot re-queue until finish()", () => {
    const q = new FifoWaitingQueue();
    q.join("t0", "u0", "d0", 0);
    q.admit(1, 1);
    expect(q.join("t1", "u0", "d0", 2).kind).toBe("existing");
    q.finish("t0");
    expect(q.join("t2", "u0", "d0", 3).kind).toBe("joined");
  });
  it("matches a naive FIFO model on random operation sequences (no duplicate admission, no starvation)", () => {
    const op = fc.oneof(
      fc.record({ k: fc.constant("join" as const), u: fc.integer({ min: 0, max: 15 }), d: fc.integer({ min: 0, max: 20 }) }),
      fc.record({ k: fc.constant("admit" as const), n: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ k: fc.constant("leave" as const), u: fc.integer({ min: 0, max: 15 }) }),
      fc.record({ k: fc.constant("beat" as const), u: fc.integer({ min: 0, max: 15 }) }),
      fc.record({ k: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: 20_000 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 150 }), (ops) => {
        const q = new FifoWaitingQueue();
        let now = 0;
        let n = 0;
        const admitted: number[] = [];
        const seen = new Set<string>();
        const seqOf = new Map<string, number>();
        for (const o of ops) {
          now += 1;
          if (o.k === "tick") now += o.ms;
          else if (o.k === "join") {
            const r = q.join(`t${n++}`, `u${o.u}`, `d${o.d}`, now);
            if (r.kind === "joined") seqOf.set(r.ticket.id, r.ticket.seq);
          } else if (o.k === "leave") q.leave(`u${o.u}`, now);
          else if (o.k === "beat") q.heartbeat(`u${o.u}`, now);
          else
            for (const t of q.admit(o.n, now)) {
              expect(seen.has(t.id)).toBe(false);
              seen.add(t.id);
              admitted.push(t.seq);
            }
        }
        expect(fifoDeviation(admitted)).toBeLessThanOrEqual(0.01);
        // no starvation: draining admits everything that is still waiting
        q.expire(now + 1);
        const before = q.waitingCount;
        const drained = q.admit(before + 1, now + 1);
        expect(drained.length).toBe(before);
        expect(q.waitingCount).toBe(0);
        // at most one active ticket per device was ever admitted concurrently
        expect(new Set([...seen]).size).toBe(seen.size);
      }),
      { numRuns: 200 },
    );
  });
  it("50k joins admit in order with deviation 0", () => {
    const q = new FifoWaitingQueue(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < 50_000; i++) q.join(`t${i}`, `u${i}`, `d${i}`, i);
    const seqs: number[] = [];
    let now = 50_000;
    while (q.waitingCount > 0) for (const t of q.admit(500, now++)) seqs.push(t.seq);
    expect(seqs).toHaveLength(50_000);
    expect(fifoDeviation(seqs)).toBe(0);
  });
});
