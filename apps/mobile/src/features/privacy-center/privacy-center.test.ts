import { describe, expect, it } from "vitest";
import {
  FIXTURE_PRIVACY, InMemoryPrivacyPort, applyConsent, canRequestDeletion, cancellable, orderedBlockers, sortSessions, type DeletionState,
} from "./model";

describe("consents", () => {
  it("start with nothing pre-ticked", () => {
    expect(FIXTURE_PRIVACY.consents.every((c) => !c.granted)).toBe(true);
  });
  it("toggle exactly one purpose, in one step", () => {
    const on = applyConsent(FIXTURE_PRIVACY.consents, "analytics", true);
    expect(on.filter((c) => c.granted).map((c) => c.purpose)).toEqual(["analytics"]);
    expect(applyConsent(on, "analytics", false).some((c) => c.granted)).toBe(false);
  });
});

describe("deletion", () => {
  it("lists blockers exactly, in a fixed order, skipping zero counts", () => {
    const d: DeletionState = { state: "blocked", blockers: [{ kind: "open_disputes", count: 1 }, { kind: "open_returns", count: 0 }, { kind: "open_orders", count: 2 }] };
    expect(orderedBlockers(d)).toEqual([{ kind: "open_orders", count: 2 }, { kind: "open_disputes", count: 1 }]);
    expect(orderedBlockers({ state: "eligible", coolingDays: 14, forfeiture: null })).toEqual([]);
  });
  it("cannot be requested when blocked, cooling, or credit is unacknowledged", () => {
    expect(canRequestDeletion({ state: "blocked", blockers: [] }, true)).toBe(false);
    expect(canRequestDeletion({ state: "cooling", endsAt: "x" }, true)).toBe(false);
    const credit: DeletionState = { state: "eligible", coolingDays: 14, forfeiture: 100n };
    expect(canRequestDeletion(credit, false)).toBe(false);
    expect(canRequestDeletion(credit, true)).toBe(true);
    expect(canRequestDeletion({ state: "eligible", coolingDays: 14, forfeiture: null }, false)).toBe(true);
  });
  it("can be cancelled during cooling and returns to eligible", async () => {
    const port = new InMemoryPrivacyPort();
    const cooling = await port.requestDeletion({ acknowledgedForfeiture: true, idempotencyKey: "k" });
    expect(cancellable(cooling)).toBe(true);
    expect((await port.cancelDeletion()).state).toBe("eligible");
    expect(cancellable({ state: "eligible", coolingDays: 14, forfeiture: null })).toBe(false);
  });
});

describe("export and sessions", () => {
  it("moves export from none to requested", async () => {
    const port = new InMemoryPrivacyPort();
    expect((await port.load()).export.state).toBe("none");
    expect((await port.requestExport("key")).state).toBe("requested");
  });
  it("lists the current session first, then newest", () => {
    const s = sortSessions([
      { id: "a", deviceLabel: "A", lastUsedAt: "2026-10-01T00:00:00Z", current: false },
      { id: "b", deviceLabel: "B", lastUsedAt: "2026-10-05T00:00:00Z", current: false },
      { id: "c", deviceLabel: "C", lastUsedAt: "2026-09-01T00:00:00Z", current: true },
    ]);
    expect(s.map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
});
