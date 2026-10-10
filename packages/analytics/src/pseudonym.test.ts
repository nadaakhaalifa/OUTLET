import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidPseudonymousIdError } from "./errors";
import type { Clock, IdGenerator } from "./ports";
import {
  derivePseudonymousId,
  needsRotation,
  nextPseudonymState,
  pseudonymousIdSchema,
  RotatingPseudonymousId,
  rotationEpoch,
  type PseudonymState,
  type PseudonymStore,
} from "./pseudonym";

function seqIds(): IdGenerator & { count: number } {
  const g = {
    count: 0,
    next() {
      g.count += 1;
      return `id${String(g.count).padStart(20, "0")}`;
    },
  };
  return g;
}

function memoryStore(initial?: unknown): PseudonymStore & { value: unknown } {
  const s = {
    value: initial,
    read: () => s.value,
    write: (st: PseudonymState) => {
      s.value = st;
    },
    clear: () => {
      s.value = undefined;
    },
  };
  return s;
}

function mutableClock(iso: string): Clock & { set(iso: string): void } {
  let t = new Date(iso);
  return { now: () => t, set: (v) => void (t = new Date(v)) };
}

describe("rotation epoch", () => {
  it("is the UTC calendar year", () => {
    expect(rotationEpoch(new Date("2026-12-31T23:59:59Z"))).toBe(2026);
    expect(rotationEpoch(new Date("2027-01-01T00:00:00Z"))).toBe(2027);
  });
});

describe("nextPseudonymState", () => {
  it("mints when there is no state", () => {
    const s = nextPseudonymState(undefined, new Date("2026-05-01T00:00:00Z"), () => "a".repeat(24));
    expect(s).toEqual({ id: `px_${"a".repeat(24)}`, epoch: 2026 });
  });

  it("keeps the id inside the same year", () => {
    const state: PseudonymState = { id: `px_${"a".repeat(24)}`, epoch: 2026 };
    let minted = 0;
    const out = nextPseudonymState(state, new Date("2026-12-31T00:00:00Z"), () => {
      minted += 1;
      return "b".repeat(24);
    });
    expect(out).toBe(state);
    expect(minted).toBe(0);
  });

  it("rotates on a new year, and on a clock that moved backwards", () => {
    const state: PseudonymState = { id: `px_${"a".repeat(24)}`, epoch: 2026 };
    expect(nextPseudonymState(state, new Date("2027-01-01T00:00:00Z"), () => "b".repeat(24)).id).toBe(`px_${"b".repeat(24)}`);
    expect(needsRotation({ ...state, epoch: 2030 }, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("throws a typed error when the generator output is unusable", () => {
    expect(() => nextPseudonymState(undefined, new Date(), () => "short")).toThrow(InvalidPseudonymousIdError);
    expect(() => nextPseudonymState(undefined, new Date(), () => "has space has space")).toThrow(InvalidPseudonymousIdError);
  });

  it("property: the new id never contains the old id", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2020, max: 2090 }), fc.integer({ min: 1, max: 50 }), (year, delta) => {
        const old: PseudonymState = { id: `px_${"o".repeat(24)}`, epoch: year };
        const out = nextPseudonymState(old, new Date(Date.UTC(year + delta, 5, 1)), () => "n".repeat(24));
        expect(out.id).not.toContain(old.id.slice(3));
        expect(out.epoch).toBe(year + delta);
      }),
    );
  });
});

describe("RotatingPseudonymousId", () => {
  it("is stable within a year, rotates at the year boundary, and persists", () => {
    const clock = mutableClock("2026-03-01T10:00:00Z");
    const ids = seqIds();
    const store = memoryStore();
    const p = new RotatingPseudonymousId({ clock, ids, store });
    const first = p.current();
    expect(p.current()).toBe(first);
    expect(ids.count).toBe(1);
    clock.set("2026-12-31T23:59:59Z");
    expect(p.current()).toBe(first);
    clock.set("2027-01-01T00:00:00Z");
    const second = p.current();
    expect(second).not.toBe(first);
    expect(pseudonymousIdSchema.safeParse(second).success).toBe(true);
    expect(ids.count).toBe(2);
  });

  it("discards corrupted persisted state instead of repairing it", () => {
    const store = memoryStore({ id: "user@example.com", epoch: 2026 });
    const p = new RotatingPseudonymousId({ clock: mutableClock("2026-03-01T00:00:00Z"), ids: seqIds(), store });
    const id = p.current();
    expect(id.startsWith("px_")).toBe(true);
    expect(JSON.stringify(store.value)).not.toContain("user@example.com");
  });

  it("reset clears storage so a re-grant starts a new id", () => {
    const ids = seqIds();
    const store = memoryStore();
    const p = new RotatingPseudonymousId({ clock: mutableClock("2026-03-01T00:00:00Z"), ids, store });
    const a = p.current();
    p.reset();
    expect(store.value).toBeUndefined();
    expect(p.current()).not.toBe(a);
  });
});

describe("derivePseudonymousId", () => {
  const hmac = (m: string): string => {
    // Deterministic test double, not a real MAC.
    let h = 0;
    for (const ch of m) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(8, "0").repeat(4);
  };

  it("is deterministic within a year, differs across years and users, and omits the user key", () => {
    const a = derivePseudonymousId("user_fixture_001", new Date("2026-02-01T00:00:00Z"), hmac);
    expect(derivePseudonymousId("user_fixture_001", new Date("2026-11-01T00:00:00Z"), hmac)).toBe(a);
    expect(derivePseudonymousId("user_fixture_001", new Date("2027-02-01T00:00:00Z"), hmac)).not.toBe(a);
    expect(derivePseudonymousId("user_fixture_002", new Date("2026-02-01T00:00:00Z"), hmac)).not.toBe(a);
    expect(a).not.toContain("user_fixture");
    expect(pseudonymousIdSchema.safeParse(a).success).toBe(true);
  });

  it("rejects an empty key and unusable mac output", () => {
    expect(() => derivePseudonymousId("", new Date(), hmac)).toThrow(InvalidPseudonymousIdError);
    expect(() => derivePseudonymousId("u", new Date(), () => "abc")).toThrow(InvalidPseudonymousIdError);
  });
});
