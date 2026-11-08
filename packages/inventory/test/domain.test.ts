import { describe, expect, it } from "vitest";
import { InventoryError, RESERVATION_STATES, UNIT_STATES, canReservationTransition, canUnitTransition, poolTarget, reservationTransition, unitTransition } from "../src/index.js";

describe("unit machine", () => {
  it("allows only available -> reserved -> (claimed | available)", () => {
    expect(unitTransition("available", "reserve")).toBe("reserved");
    expect(unitTransition("reserved", "claim")).toBe("claimed");
    expect(unitTransition("reserved", "release")).toBe("available");
    for (const [s, e] of [["available", "claim"], ["available", "release"], ["claimed", "release"], ["claimed", "reserve"], ["reserved", "reserve"]] as const) {
      expect(() => unitTransition(s, e)).toThrow(InventoryError);
      expect(canUnitTransition(s, e)).toBe(false);
    }
    expect(UNIT_STATES).toHaveLength(3);
  });
  it("reservation: terminal states have no exits; EXPIRED only late-claims", () => {
    expect(reservationTransition("ACTIVE", "claim")).toBe("CLAIMED");
    expect(reservationTransition("ACTIVE", "release")).toBe("RELEASED");
    expect(reservationTransition("ACTIVE", "expire")).toBe("EXPIRED");
    expect(reservationTransition("EXPIRED", "late_claim")).toBe("CLAIMED");
    expect(canReservationTransition("EXPIRED", "claim")).toBe(false);
    for (const s of ["CLAIMED", "RELEASED"] as const) for (const e of ["claim", "release", "expire", "late_claim"] as const) expect(() => reservationTransition(s, e)).toThrow(/invalid|cannot/);
    expect(() => reservationTransition("ACTIVE", "late_claim")).toThrow(InventoryError);
    expect(RESERVATION_STATES).toHaveLength(4);
  });
});

describe("poolTarget", () => {
  it("is min(on_hand - committed, cap), never negative", () => {
    expect(poolTarget(5000, 0)).toBe(1000);
    expect(poolTarget(50, 10)).toBe(40);
    expect(poolTarget(5, 9)).toBe(0);
    expect(poolTarget(100, 0, 10)).toBe(10);
  });
  it("rejects non-integers and negatives", () => {
    expect(() => poolTarget(1.5, 0)).toThrow(RangeError);
    expect(() => poolTarget(-1, 0)).toThrow(RangeError);
  });
});
