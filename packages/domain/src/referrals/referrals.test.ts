import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFERRAL_CONFIG as C,
  InvalidReferralTransitionError,
  ReferralConfigError,
  UnionFind,
  clusterSizeOf,
  decideSettlement,
  detectSelfReferral,
  evaluateAttribution,
  linkUsersByIdentifiers,
  normalizeReferralCode,
  referralCodeFromBytes,
  referralDeepLink,
  refereeDiscountFor,
  suspiciousClusters,
  transitionReferral,
  validateReferralConfig,
  type IdentityEntry,
  type OrderClosure,
  type PartyProfile,
  type ReferrerContext,
} from "./index";

const party = (over: Partial<PartyProfile> = {}): PartyProfile => ({
  ageYears: 25,
  phoneIsNew: true,
  priorOrderCount: 0,
  deviceHashes: ["d-x"],
  active: true,
  ...over,
});

describe("codes", () => {
  it("maps bytes to the alphabet and normalises look-alikes", () => {
    const code = referralCodeFromBytes(Uint8Array.from([0, 1, 2, 3, 31, 30, 18, 19, 99]));
    expect(code).toHaveLength(8);
    expect(normalizeReferralCode(code.toLowerCase())).toBe(code);
    expect(normalizeReferralCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeReferralCode("oIlO1111")).toBe("01101111");
    expect(normalizeReferralCode("short")).toBeNull();
    expect(normalizeReferralCode("ABCDEFGU")).toBeNull();
  });
  it("rejects short entropy and builds links", () => {
    expect(() => referralCodeFromBytes(new Uint8Array(3))).toThrow(RangeError);
    expect(referralDeepLink("https://x.test/r/", "ABCDEFGH")).toBe("https://x.test/r/ABCDEFGH");
  });
  it("property: any bytes yield a normalisable code", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 8, maxLength: 16 }), (b) => {
        const c = referralCodeFromBytes(b);
        return normalizeReferralCode(c) === c;
      }),
    );
  });
});

describe("config and state machine", () => {
  it("accepts defaults (150 EGP off >= 600, 100 EGP reward)", () => {
    expect(validateReferralConfig(C)).toBe(C);
    expect(C.refereeDiscount).toBe(15_000n);
    expect(C.refereeMinOrder).toBe(60_000n);
  });
  it("rejects invalid values", () => {
    expect(() => validateReferralConfig({ ...C, refereeDiscount: 0n })).toThrow(ReferralConfigError);
    expect(() => validateReferralConfig({ ...C, refereeDiscount: 70_000n })).toThrow(ReferralConfigError);
    expect(() => validateReferralConfig({ ...C, milestoneEvery: 0 })).toThrow(ReferralConfigError);
  });
  it("only attributed can move", () => {
    expect(transitionReferral("attributed", "rewarded")).toBe("rewarded");
    expect(() => transitionReferral("rewarded", "rejected")).toThrow(InvalidReferralTransitionError);
    expect(() => transitionReferral("rejected", "rewarded")).toThrow(InvalidReferralTransitionError);
  });
});

describe("evaluateAttribution", () => {
  const base = { referrerId: "a", refereeId: "b" };
  it("accepts a clean friend", () => {
    expect(evaluateAttribution(C, { ...base, referrer: party({ deviceHashes: ["d-r"] }), referee: party() })).toEqual({ ok: true });
  });
  it.each([
    ["self_referral", { referrerId: "a", refereeId: "a" }, party(), party()],
    ["same_device", base, party({ deviceHashes: ["d-x"] }), party({ deviceHashes: ["d-x"] })],
    ["underage", base, party({ deviceHashes: ["d-r"] }), party({ ageYears: 17 })],
    ["underage", base, party({ deviceHashes: ["d-r"] }), party({ ageYears: null })],
    ["not_new_user", base, party({ deviceHashes: ["d-r"] }), party({ phoneIsNew: false })],
    ["not_new_user", base, party({ deviceHashes: ["d-r"] }), party({ priorOrderCount: 1 })],
    ["referrer_suspended", base, party({ deviceHashes: ["d-r"], active: false }), party()],
    ["referrer_unknown", base, null, party()],
    ["referee_unknown", base, party(), null],
  ] as const)("rejects %s", (reason, ids, referrer, referee) => {
    expect(evaluateAttribution(C, { ...ids, referrer, referee })).toEqual({ ok: false, reason });
  });
  it("boundary: exactly 18 is allowed", () => {
    expect(
      evaluateAttribution(C, { ...base, referrer: party({ deviceHashes: ["d-r"] }), referee: party({ ageYears: 18 }) }),
    ).toEqual({ ok: true });
  });
});

describe("refereeDiscountFor", () => {
  it("is zero below 600 EGP and 150 EGP at or above", () => {
    expect(refereeDiscountFor(C, 59_999n)).toBe(0n);
    expect(refereeDiscountFor(C, 60_000n)).toBe(15_000n);
    expect(refereeDiscountFor(C, 1_000_000n)).toBe(15_000n);
  });
  it("never exceeds the subtotal", () => {
    const c = { ...C, refereeMinOrder: 100n, refereeDiscount: 100n };
    expect(refereeDiscountFor(c, 100n)).toBe(100n);
  });
});

describe("decideSettlement", () => {
  const closure = (o: Partial<OrderClosure> = {}): OrderClosure => ({
    isFirstOrder: true,
    merchandiseSubtotal: 80_000n,
    refunded: false,
    paymentMethod: "prepaid",
    deliveredAtMs: 1_000,
    closedAtMs: 2_000,
    paymentFingerprintHash: "fp-friend",
    ...o,
  });
  const referrer = (o: Partial<ReferrerContext> = {}): ReferrerContext => ({
    hasDeliveredOrder: true,
    active: true,
    deviceHashes: ["d-r"],
    paymentFingerprintHashes: ["fp-r"],
    rewardedInWindow: 0,
    rewardedTotal: 0,
    ...o,
  });
  const run = (o: { closure?: OrderClosure; referrer?: ReferrerContext; clusterSize?: number; status?: "attributed" | "rewarded" | "rejected" }) =>
    decideSettlement({
      config: C,
      referralStatus: o.status ?? "attributed",
      closure: o.closure ?? closure(),
      referrer: o.referrer ?? referrer(),
      clusterSize: o.clusterSize ?? 1,
    });

  it("rewards 100 EGP", () => {
    expect(run({})).toEqual({ kind: "reward", amount: 10_000n, plusMonths: 0 });
  });
  it("10th reward carries a Plus month, 9th and 11th do not", () => {
    expect(run({ referrer: referrer({ rewardedTotal: 9 }) })).toMatchObject({ plusMonths: 1 });
    expect(run({ referrer: referrer({ rewardedTotal: 8 }) })).toMatchObject({ plusMonths: 0 });
    expect(run({ referrer: referrer({ rewardedTotal: 10 }) })).toMatchObject({ plusMonths: 0 });
    expect(run({ referrer: referrer({ rewardedTotal: 19 }) })).toMatchObject({ plusMonths: 1 });
  });
  it("ignores non-attributed and non-first orders", () => {
    expect(run({ status: "rewarded" })).toEqual({ kind: "ignore" });
    expect(run({ status: "rejected" })).toEqual({ kind: "ignore" });
    expect(run({ closure: closure({ isFirstOrder: false }) })).toEqual({ kind: "ignore" });
  });
  it("rejects refunded, below minimum, undelivered, COD undelivered", () => {
    expect(run({ closure: closure({ refunded: true }) })).toEqual({ kind: "reject", reason: "order_refunded" });
    expect(run({ closure: closure({ merchandiseSubtotal: 59_999n }) })).toEqual({ kind: "reject", reason: "order_below_minimum" });
    expect(run({ closure: closure({ deliveredAtMs: null }) })).toEqual({ kind: "reject", reason: "not_delivered" });
    expect(run({ closure: closure({ deliveredAtMs: null, paymentMethod: "cod" }) })).toEqual({ kind: "reject", reason: "cod_not_delivered" });
    expect(run({ closure: closure({ closedAtMs: 500 }) })).toEqual({ kind: "reject", reason: "not_delivered" });
  });
  it("COD delivered and closed is rewarded", () => {
    expect(run({ closure: closure({ paymentMethod: "cod" }) })).toMatchObject({ kind: "reward" });
  });
  it("rejects fingerprint reuse, referrer without delivered order, suspended referrer", () => {
    expect(run({ closure: closure({ paymentFingerprintHash: "fp-r" }) })).toEqual({ kind: "reject", reason: "payment_fingerprint_reuse" });
    expect(run({ referrer: referrer({ hasDeliveredOrder: false }) })).toEqual({ kind: "reject", reason: "referrer_no_delivered_order" });
    expect(run({ referrer: referrer({ active: false }) })).toEqual({ kind: "reject", reason: "referrer_suspended" });
  });
  it("cluster threshold is strict (size 3 ok, 4 rejected)", () => {
    expect(run({ clusterSize: 3 })).toMatchObject({ kind: "reward" });
    expect(run({ clusterSize: 4 })).toEqual({ kind: "reject", reason: "cluster_suspected" });
  });
  it("cap: 49 rewarded still rewards, 50 rejects", () => {
    expect(run({ referrer: referrer({ rewardedInWindow: 49 }) })).toMatchObject({ kind: "reward" });
    expect(run({ referrer: referrer({ rewardedInWindow: 50 }) })).toEqual({ kind: "reject", reason: "cap_reached" });
  });
});

describe("fraud graph", () => {
  it("self referral and shared device are detected", () => {
    const base = { referrerId: "a", refereeId: "b", referrerDeviceHashes: ["d1"], refereeDeviceHashes: ["d2"] };
    expect(detectSelfReferral(base)).toBeNull();
    expect(detectSelfReferral({ ...base, refereeId: "a" })).toBe("self_referral");
    expect(detectSelfReferral({ ...base, refereeDeviceHashes: ["d2", "d1"] })).toBe("same_device");
  });

  it("union-find basics", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    uf.union("c", "d");
    expect(uf.componentSize("a")).toBe(2);
    uf.union("b", "c");
    expect(uf.componentSize("d")).toBe(4);
    expect(uf.components()).toEqual([["a", "b", "c", "d"]]);
  });

  it("clusters by shared identifiers and flags only large ones", () => {
    const entries: IdentityEntry[] = [
      { userId: "u1", identifiers: ["dev:1"] },
      { userId: "u2", identifiers: ["dev:1", "fp:9"] },
      { userId: "u3", identifiers: ["fp:9"] },
      { userId: "u4", identifiers: ["dev:4"] },
    ];
    expect(clusterSizeOf("u3", entries)).toBe(3);
    expect(clusterSizeOf("u4", entries)).toBe(1);
    expect(suspiciousClusters(entries, 2)).toEqual([["u1", "u2", "u3"]]);
    expect(suspiciousClusters(entries, 3)).toEqual([]);
  });

  const entriesArb = fc.array(
    fc.record({
      userId: fc.integer({ min: 0, max: 11 }).map((n) => `u${n}`),
      identifiers: fc.array(fc.integer({ min: 0, max: 7 }).map((n) => `id${n}`), { maxLength: 3 }),
    }),
    { maxLength: 20 },
  );

  /** Brute-force reachability to cross-check union-find. */
  const bruteComponents = (entries: readonly IdentityEntry[]): string[][] => {
    const users = [...new Set(entries.map((e) => e.userId))];
    const adj = new Map<string, Set<string>>(users.map((u) => [u, new Set<string>()]));
    for (const a of entries)
      for (const b of entries)
        if (a.identifiers.some((i) => b.identifiers.includes(i))) {
          adj.get(a.userId)?.add(b.userId);
          adj.get(b.userId)?.add(a.userId);
        }
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const u of users) {
      if (seen.has(u)) continue;
      const comp: string[] = [];
      const stack = [u];
      while (stack.length > 0) {
        const x = stack.pop();
        if (x === undefined || seen.has(x)) continue;
        seen.add(x);
        comp.push(x);
        for (const n of adj.get(x) ?? []) stack.push(n);
      }
      out.push(comp.sort());
    }
    return out.sort((p, q) => (p[0] ?? "").localeCompare(q[0] ?? ""));
  };

  it("property: components equal brute-force connectivity", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        expect(linkUsersByIdentifiers(entries).components()).toEqual(bruteComponents(entries));
      }),
    );
  });

  it("property: result is independent of entry order and sizes sum to user count", () => {
    fc.assert(
      fc.property(entriesArb, fc.nat(), (entries, k) => {
        const rotated = entries.length === 0 ? entries : [...entries.slice(k % entries.length), ...entries.slice(0, k % entries.length)];
        const a = linkUsersByIdentifiers(entries).components();
        const b = linkUsersByIdentifiers(rotated).components();
        expect(a).toEqual(b);
        const users = new Set(entries.map((e) => e.userId));
        expect(a.reduce((s, c) => s + c.length, 0)).toBe(users.size);
      }),
    );
  });

  it("property: clusterSizeOf matches the component containing the user", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const comps = bruteComponents(entries);
        for (const c of comps) for (const u of c) expect(clusterSizeOf(u, entries)).toBe(c.length);
      }),
    );
  });
});
