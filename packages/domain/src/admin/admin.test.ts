import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE_NAMES,
  APPROVAL_KINDS,
  APPROVER_ROLES,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_ELEVATION_CONFIG,
  REQUESTER_ROLES,
  activateElevation,
  addBusinessDays,
  approvalCovers,
  approvalMachine,
  cairoWeekday,
  decideApproval,
  decideReview,
  effectiveApprovalState,
  effectiveRoles,
  elevationMachine,
  expireIfStale,
  isElevationLive,
  isReviewOverdue,
  newBreakGlass,
  newElevation,
  openSuspensionReview,
  requestApproval,
  requiresDualApproval,
  revokeElevation,
  suspensionReviewMachine,
  validateApprovalConfig,
  type AdminRoleName,
  type ApprovalRecord,
} from "./index";

const T0 = 1_800_000_000_000;
const cfg = DEFAULT_APPROVAL_CONFIG;

const approvalFor = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "a1",
  kind: "plan_price_change",
  subjectType: "plan",
  subjectId: "p1",
  amountMinor: null,
  reasonCode: "finance_reconciliation",
  requesterId: "u-req",
  state: "REQUESTED",
  approverId: null,
  requestedAtMs: T0,
  expiresAtMs: T0 + 1000,
  decidedAtMs: null,
  decisionNote: null,
  ...over,
});

describe("machines", () => {
  it("are structurally sound", () => {
    for (const m of [approvalMachine, elevationMachine, suspensionReviewMachine]) {
      expect(m.analyze().ok).toBe(true);
    }
  });
});

describe("threshold", () => {
  it("refund and payout need dual approval at or above the threshold, and when amount is unknown", () => {
    expect(requiresDualApproval("refund", cfg.refundThresholdMinor - 1n, cfg)).toBe(false);
    expect(requiresDualApproval("refund", cfg.refundThresholdMinor, cfg)).toBe(true);
    expect(requiresDualApproval("refund", null, cfg)).toBe(true);
    expect(requiresDualApproval("payout", cfg.payoutThresholdMinor - 1n, cfg)).toBe(false);
    expect(requiresDualApproval("payout", cfg.payoutThresholdMinor, cfg)).toBe(true);
  });
  it("every non-money kind always needs it", () => {
    for (const k of APPROVAL_KINDS.filter((x) => x !== "refund" && x !== "payout")) {
      expect(requiresDualApproval(k, 0n, cfg)).toBe(true);
    }
  });
  it("validates config", () => {
    expect(() => validateApprovalConfig({ ...cfg, requestTtlMs: 0 })).toThrow();
    expect(() => validateApprovalConfig({ ...cfg, refundThresholdMinor: -1n })).toThrow();
    expect(validateApprovalConfig(cfg)).toBe(cfg);
  });
});

describe("requestApproval", () => {
  const base = {
    id: "a1",
    subjectType: "refund",
    subjectId: "r1",
    reasonCode: "customer_support_ticket",
    requesterId: "u1",
    nowMs: T0,
  } as const;
  it("refuses requester roles outside the kind's scope", () => {
    const r = requestApproval({ ...base, kind: "refund", amountMinor: 900_000n, requesterRoles: ["marketing"] }, cfg);
    expect(r).toEqual({ kind: "denied", reason: "requester_role_not_allowed" });
  });
  it("small refunds need no approval record", () => {
    expect(requestApproval({ ...base, kind: "refund", amountMinor: 100n, requesterRoles: ["support"] }, cfg).kind).toBe("not_required");
  });
  it("creates with expiry from config", () => {
    const r = requestApproval({ ...base, kind: "refund", amountMinor: 900_000n, requesterRoles: ["finance"] }, cfg);
    expect(r.kind).toBe("created");
    if (r.kind === "created") {
      expect(r.record.state).toBe("REQUESTED");
      expect(r.record.expiresAtMs).toBe(T0 + cfg.requestTtlMs);
    }
  });
  it("rejects negative amounts", () => {
    expect(() => requestApproval({ ...base, kind: "refund", amountMinor: -1n, requesterRoles: ["finance"] }, cfg)).toThrow();
  });
});

describe("decideApproval", () => {
  const decide = (r: ApprovalRecord, o: Partial<Parameters<typeof decideApproval>[1]> = {}) =>
    decideApproval(r, { approverId: "u-app", approverRoles: ["finance"], decision: "APPROVE", note: null, nowMs: T0 + 1, ...o });

  it("approves with a distinct, scoped approver", () => {
    const r = decide(approvalFor());
    expect(r.kind).toBe("decided");
    if (r.kind === "decided") {
      expect(r.record.state).toBe("APPROVED");
      expect(r.record.approverId).toBe("u-app");
    }
  });
  it("the requester can never approve, even holding the scope", () => {
    expect(decide(approvalFor(), { approverId: "u-req" })).toEqual({ kind: "denied", reason: "self_approval" });
  });
  it("approver without the scope is refused", () => {
    expect(decide(approvalFor(), { approverRoles: ["marketing", "ops"] })).toEqual({
      kind: "denied",
      reason: "approver_scope_missing",
    });
  });
  it("expiry beats approval at the exact boundary", () => {
    const r = decide(approvalFor(), { nowMs: T0 + 1000 });
    expect(r.kind).toBe("expired");
    if (r.kind === "expired") expect(r.record.state).toBe("EXPIRED");
    expect(decide(approvalFor(), { nowMs: T0 + 999 }).kind).toBe("decided");
  });
  it("final records cannot be decided again", () => {
    for (const state of ["APPROVED", "REJECTED", "EXPIRED"] as const) {
      expect(decide(approvalFor({ state }))).toEqual({ kind: "denied", reason: "not_pending" });
    }
  });
  it("requester may withdraw (reject) but a stranger may not reject", () => {
    expect(decide(approvalFor(), { approverId: "u-req", approverRoles: ["support"], decision: "REJECT" }).kind).toBe("decided");
    expect(decide(approvalFor(), { approverRoles: ["marketing"], decision: "REJECT" })).toEqual({
      kind: "denied",
      reason: "approver_scope_missing",
    });
  });
  it("effective state and sweeper", () => {
    expect(effectiveApprovalState(approvalFor(), T0 + 1000)).toBe("EXPIRED");
    expect(effectiveApprovalState(approvalFor(), T0)).toBe("REQUESTED");
    expect(expireIfStale(approvalFor(), T0)).toBeNull();
    expect(expireIfStale(approvalFor(), T0 + 1000)?.state).toBe("EXPIRED");
    expect(expireIfStale(approvalFor({ state: "APPROVED" }), T0 + 9999)).toBeNull();
  });
  it("property: approval never succeeds for requester or unscoped approver", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...APPROVAL_KINDS),
        fc.subarray([...ADMIN_ROLE_NAMES]),
        fc.boolean(),
        (kind, roles, sameUser) => {
          const rec = approvalFor({ kind });
          const r = decideApproval(rec, {
            approverId: sameUser ? rec.requesterId : "someone",
            approverRoles: roles as AdminRoleName[],
            decision: "APPROVE",
            note: null,
            nowMs: T0,
          });
          const scoped = roles.some((x) => APPROVER_ROLES[kind].includes(x));
          expect(r.kind === "decided").toBe(!sameUser && scoped);
        },
      ),
    );
  });
  it("no kind lets a requester role also be absent from the registry", () => {
    for (const k of APPROVAL_KINDS) {
      expect(REQUESTER_ROLES[k].length).toBeGreaterThan(0);
      expect(APPROVER_ROLES[k].length).toBeGreaterThan(0);
    }
  });
});

describe("approvalCovers", () => {
  const ok = approvalFor({ kind: "refund", subjectType: "refund", subjectId: "r1", amountMinor: 700_000n, state: "APPROVED", approverId: "u-app" });
  const want = { kind: "refund", subjectType: "refund", subjectId: "r1", amountMinor: 700_000n } as const;
  it("covers the same subject up to the approved amount", () => {
    expect(approvalCovers(ok, want, T0)).toBe(true);
    expect(approvalCovers(ok, { ...want, amountMinor: 700_001n }, T0)).toBe(false);
    expect(approvalCovers(ok, { ...want, subjectId: "r2" }, T0)).toBe(false);
    expect(approvalCovers(ok, { ...want, kind: "payout" }, T0)).toBe(false);
    expect(approvalCovers(ok, want, T0 + 1000)).toBe(false);
    expect(approvalCovers({ ...ok, state: "REQUESTED" }, want, T0)).toBe(false);
    expect(approvalCovers({ ...ok, approverId: "u-req" }, want, T0)).toBe(false);
    expect(approvalCovers(ok, { ...want, amountMinor: null }, T0)).toBe(false);
  });
});

describe("elevation", () => {
  const ecfg = DEFAULT_ELEVATION_CONFIG;
  const mk = (role: AdminRoleName = "finance") => {
    const r = newElevation(
      { id: "e1", userId: "u-req", role, reasonCode: "incident_response", approvalId: "a1", ttlMs: null, heldRoles: ["support"], nowMs: T0 },
      ecfg,
    );
    if (r.kind !== "ok") throw new Error("setup");
    return r.record;
  };
  const approved = approvalFor({
    kind: "role_elevation",
    subjectType: "elevation",
    subjectId: "e1",
    state: "APPROVED",
    approverId: "u-sec",
    expiresAtMs: T0 + 10_000,
  });

  it("needs a reason code, a bounded ttl and a role not already held", () => {
    const base = { id: "e", userId: "u", role: "finance" as const, approvalId: "a", heldRoles: [] as AdminRoleName[], nowMs: T0 };
    expect(newElevation({ ...base, reasonCode: "because", ttlMs: null }, ecfg)).toEqual({ kind: "invalid", reason: "reason_code_required" });
    expect(newElevation({ ...base, reasonCode: "kyc_review", ttlMs: 5 * 3_600_000 }, ecfg)).toEqual({ kind: "invalid", reason: "ttl_out_of_range" });
    expect(newElevation({ ...base, reasonCode: "kyc_review", ttlMs: 10 }, ecfg)).toEqual({ kind: "invalid", reason: "ttl_out_of_range" });
    expect(newElevation({ ...base, reasonCode: "kyc_review", ttlMs: null, heldRoles: ["finance"] }, ecfg)).toEqual({ kind: "invalid", reason: "already_holds_role" });
    expect(newElevation({ ...base, role: "super_admin", reasonCode: "kyc_review", ttlMs: null }, ecfg)).toEqual({
      kind: "invalid",
      reason: "break_glass_requires_super_admin",
    });
  });
  it("break-glass needs a standing super_admin grant and has a shorter cap", () => {
    const base = { id: "e", userId: "u", approvalId: "a", reasonCode: "break_glass_emergency", ttlMs: null, nowMs: T0 };
    expect(newBreakGlass({ ...base, heldRoles: ["ops"] }, ecfg)).toEqual({ kind: "invalid", reason: "break_glass_requires_super_admin" });
    expect(newBreakGlass({ ...base, heldRoles: ["super_admin"], ttlMs: 31 * 60_000 }, ecfg)).toEqual({ kind: "invalid", reason: "ttl_out_of_range" });
    const ok = newBreakGlass({ ...base, heldRoles: ["super_admin"] }, ecfg);
    expect(ok.kind).toBe("ok");
  });
  it("activates only for the requester against a covering approval, and expires exactly at the end", () => {
    const e = mk();
    expect(activateElevation(e, approved, "other", T0 + 1)).toEqual({ kind: "denied", reason: "not_requester" });
    expect(activateElevation(e, null, "u-req", T0 + 1)).toEqual({ kind: "denied", reason: "approval_missing" });
    expect(activateElevation(e, { ...approved, state: "REQUESTED" }, "u-req", T0 + 1)).toEqual({ kind: "denied", reason: "approval_not_approved" });
    expect(activateElevation(e, { ...approved, subjectId: "e2" }, "u-req", T0 + 1)).toEqual({ kind: "denied", reason: "approval_not_approved" });
    expect(activateElevation(e, approved, "u-req", T0 + 10_000)).toEqual({ kind: "denied", reason: "approval_expired" });
    const r = activateElevation(e, approved, "u-req", T0 + 5);
    expect(r.kind).toBe("activated");
    if (r.kind !== "activated") return;
    const live = r.record;
    expect(live.expiresAtMs).toBe(T0 + 5 + ecfg.defaultTtlMs);
    expect(isElevationLive(live, live.expiresAtMs! - 1)).toBe(true);
    expect(isElevationLive(live, live.expiresAtMs!)).toBe(false);
    expect(effectiveRoles(["support"], [live], T0 + 6)).toEqual(["support", "finance"]);
    expect(effectiveRoles(["support"], [live], live.expiresAtMs!)).toEqual(["support"]);
    expect(activateElevation(live, approved, "u-req", T0 + 6)).toEqual({ kind: "denied", reason: "not_pending" });
    const revoked = revokeElevation(live, "u-sec", T0 + 7);
    expect(isElevationLive(revoked, T0 + 8)).toBe(false);
    expect(() => revokeElevation(revoked, "u-sec", T0 + 9)).toThrow();
  });
});

describe("suspension review SLA", () => {
  // 2027-01-15 is a Friday in Cairo; the 1,800,000,000,000 ms epoch is 2027-01-15T08:00Z.
  it("uses the Cairo calendar", () => {
    expect(cairoWeekday(T0)).toBe(5);
  });
  it("skips Friday and Saturday", () => {
    const due = addBusinessDays(T0, 5);
    // Fri start: Sat skipped, then Sun..Thu are days 1..5, six calendar days.
    expect(cairoWeekday(due)).toBe(4);
    expect(due - T0).toBe(6 * 86_400_000);
  });
  it("weekday start", () => {
    const sun = T0 + 2 * 86_400_000; // Sunday
    expect(cairoWeekday(sun)).toBe(0);
    const due = addBusinessDays(sun, 5);
    expect(due - sun).toBe(7 * 86_400_000); // Mon..Thu = 4, skip Fri Sat, Sun = 5th
    expect(addBusinessDays(sun, 0)).toBe(sun);
  });
  it("rejects bad input", () => {
    expect(() => addBusinessDays(T0, -1)).toThrow();
    expect(() => addBusinessDays(T0, 1, [0, 1, 2, 3, 4, 5, 6])).toThrow();
  });
  it("review lifecycle: overdue, suspender cannot review, one decision", () => {
    const r = openSuspensionReview({ id: "r", sellerId: "s", suspendedBy: "u-ts", reasonCode: "fraud_investigation", nowMs: T0 });
    expect(isReviewOverdue(r, r.dueAtMs)).toBe(false);
    expect(isReviewOverdue(r, r.dueAtMs + 1)).toBe(true);
    expect(decideReview(r, "u-ts", "REINSTATE", T0)).toEqual({ kind: "denied", reason: "reviewer_is_suspender" });
    const d = decideReview(r, "u-ops", "UPHOLD", T0 + 5);
    expect(d.kind).toBe("decided");
    if (d.kind === "decided") {
      expect(d.review.state).toBe("UPHELD");
      expect(isReviewOverdue(d.review, T0 + 99 * 86_400_000)).toBe(false);
      expect(decideReview(d.review, "u-x", "REINSTATE", T0)).toEqual({ kind: "denied", reason: "not_open" });
    }
    const auto = openSuspensionReview({ id: "r2", sellerId: "s", suspendedBy: null, reasonCode: "fraud_investigation", nowMs: T0 });
    expect(decideReview(auto, "anyone", "REINSTATE", T0).kind).toBe("decided");
  });
});

describe("addBusinessDays across Cairo DST transitions", () => {
  const civil = (ms: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(ms));
  const wall = (ms: number): string =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

  it("fall-back: Thu 2026-10-29 00:30 + 5 business days is Thu 2026-11-05, same wall time", () => {
    const start = Date.parse("2026-10-28T21:30:00Z");
    const due = addBusinessDays(start, 5);
    expect(civil(due)).toBe("2026-11-05");
    expect(wall(due)).toBe("00:30");
  });

  it("fall-back: Wed 10:00 + 2 business days is Sun 2026-11-01 10:00 local", () => {
    const due = addBusinessDays(Date.parse("2026-10-28T07:00:00Z"), 2);
    expect(civil(due)).toBe("2026-11-01");
    expect(wall(due)).toBe("10:00");
  });

  it("spring-forward: Thu 2026-04-23 10:00 + 1 business day is Sun 2026-04-26 10:00 local", () => {
    const due = addBusinessDays(Date.parse("2026-04-23T08:00:00Z"), 1);
    expect(civil(due)).toBe("2026-04-26");
    expect(wall(due)).toBe("10:00");
  });

  it("keeps wall time and lands on a working day for every start hour across both transitions", () => {
    for (let day = 0; day < 20; day += 1) {
      for (const hour of [0, 1, 6, 12, 21, 23]) {
        for (const base of ["2026-10-20", "2026-04-15"]) {
          const start = Date.parse(`${base}T00:00:00Z`) + day * 86_400_000 + hour * 3_600_000;
          for (const n of [1, 5, 8]) {
            const due = addBusinessDays(start, n);
            const dow = new Date(`${civil(due)}T00:00:00Z`).getUTCDay();
            expect([5, 6]).not.toContain(dow);
            expect(due).toBeGreaterThan(start);
          }
        }
      }
    }
  });
});
