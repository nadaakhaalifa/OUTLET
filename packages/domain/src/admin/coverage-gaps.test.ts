import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVATION_CONFIG,
  addBusinessDays,
  isAdminReasonCode,
  isAdminRoleName,
  isElevationLive,
  newElevation,
  withdrawElevation,
} from "./index";
import { InvalidTransitionError } from "../state-machine/errors";

const T0 = 1_800_000_000_000;

describe("role and reason guards", () => {
  it("recognise known names and reject unknown ones", () => {
    expect(isAdminRoleName("finance")).toBe(true);
    expect(isAdminRoleName("root")).toBe(false);
    expect(isAdminReasonCode("kyc_review")).toBe(true);
    expect(isAdminReasonCode("because")).toBe(false);
  });
});

describe("withdrawElevation", () => {
  const pending = () => {
    const r = newElevation(
      { id: "e1", userId: "u1", role: "finance", reasonCode: "kyc_review", approvalId: "a1", ttlMs: null, heldRoles: ["support"], nowMs: T0 },
      DEFAULT_ELEVATION_CONFIG,
    );
    if (r.kind !== "ok") throw new Error("setup");
    return r.record;
  };

  it("denies a pending elevation, records who withdrew it and never grants the role", () => {
    const w = withdrawElevation(pending(), "u1", T0 + 5);
    expect(w.state).toBe("DENIED");
    expect(w.revokedBy).toBe("u1");
    expect(w.revokedAtMs).toBe(T0 + 5);
    expect(isElevationLive(w, T0 + 6)).toBe(false);
  });

  it("cannot withdraw twice", () => {
    expect(() => withdrawElevation(withdrawElevation(pending(), "u1", T0), "u1", T0)).toThrow(InvalidTransitionError);
  });
});

describe("addBusinessDays across the Cairo spring-forward gap", () => {
  it("lands on the standard-time instant when the wall time does not exist", () => {
    // Egypt DST starts Friday 2026-04-24 at 00:00 local (clocks jump to 01:00), so 00:30 does not exist that day.
    const start = Date.UTC(2026, 3, 22, 22, 30); // Thu 2026-04-23 00:30 Cairo (UTC+2)
    expect(addBusinessDays(start, 1, [])).toBe(Date.UTC(2026, 3, 23, 22, 30));
  });
});
