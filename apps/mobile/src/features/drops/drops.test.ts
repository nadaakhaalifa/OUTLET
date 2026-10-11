import { describe, expect, it } from "vitest";
import {
  FIXTURE_DROP as D, InMemoryDropsPort, MIN_POLL_MS, PortError, canJoin, clockFromServer, countdownParts, dropFailureState, dropPhase,
  nextPollDelay, serverNow, stockLabelCount, tokenState, waitingView, type DropSnapshot,
} from "./model";

const drop = (o: Partial<DropSnapshot>): DropSnapshot => ({ ...D, ...o });

describe("server clock", () => {
  it("ignores a wrong device clock", () => {
    const c = clockFromServer(1_000_000, 10); // device far behind
    expect(serverNow(c, 5_010)).toBe(1_005_000);
    const ahead = clockFromServer(1_000_000, 9_000_000);
    expect(serverNow(ahead, 9_002_000)).toBe(1_002_000);
  });
  it("splits a countdown without going negative", () => {
    expect(countdownParts(93_784_000)).toEqual({ days: 1, hours: 2, minutes: 3, seconds: 4, done: false });
    expect(countdownParts(-500).done).toBe(true);
    expect(countdownParts(999).done).toBe(true);
  });
});

describe("phase", () => {
  it("counts to the early access time when scheduled, public start during early access", () => {
    const sched = drop({ state: "scheduled", earlyAccessAtMs: 1_000, startsAtMs: 5_000 });
    expect(dropPhase(sched, 400)).toEqual({ kind: "upcoming", untilMs: 600 });
    expect(dropPhase(drop({ state: "earlyAccess", startsAtMs: 5_000 }), 4_000)).toEqual({ kind: "earlyAccess", untilMs: 1_000 });
  });
  it("does not flip to live when the countdown hits zero on its own", () => {
    expect(dropPhase(drop({ state: "scheduled", earlyAccessAtMs: null, startsAtMs: 100 }), 500)).toEqual({ kind: "upcoming", untilMs: 0 });
  });
  it("maps terminal states", () => {
    expect(dropPhase(drop({ state: "soldOut" }), 0).kind).toBe("soldOut");
    expect(dropPhase(drop({ state: "ended" }), 0).kind).toBe("ended");
    expect(dropPhase(drop({ state: "paused" }), 0).kind).toBe("paused");
  });
});

describe("stock and joining", () => {
  it("shows real stock only when 5 or fewer", () => {
    expect(stockLabelCount({ remainingStock: 4 })).toBe(4);
    expect(stockLabelCount({ remainingStock: 6 })).toBeNull();
    expect(stockLabelCount({ remainingStock: 0 })).toBeNull();
    expect(stockLabelCount({ remainingStock: null })).toBeNull();
  });
  it("allows joining only while live or early access and not already queued", () => {
    const live = { kind: "live", untilMs: 1 } as const;
    expect(canJoin(live, { state: "idle" })).toBe(true);
    expect(canJoin(live, { state: "expired" })).toBe(true);
    expect(canJoin(live, { state: "waiting", position: 1, etaSeconds: null, pollAfterMs: 1000 })).toBe(false);
    expect(canJoin({ kind: "soldOut" }, { state: "idle" })).toBe(false);
    expect(canJoin({ kind: "upcoming", untilMs: 5 }, { state: "idle" })).toBe(false);
  });
});

describe("waiting room", () => {
  it("never invents position or ETA", () => {
    expect(waitingView({ state: "waiting", position: null, etaSeconds: null, pollAfterMs: 2000 })).toEqual({ position: null, etaMinutes: null });
    expect(waitingView({ state: "waiting", position: 12, etaSeconds: 61, pollAfterMs: 2000 })).toEqual({ position: 12, etaMinutes: 2 });
    expect(waitingView({ state: "waiting", position: 0, etaSeconds: 0, pollAfterMs: 2000 })).toEqual({ position: null, etaMinutes: null });
  });
  it("respects the 1 per second status limit", () => {
    expect(nextPollDelay({ state: "waiting", position: 1, etaSeconds: 1, pollAfterMs: 100 })).toBe(MIN_POLL_MS);
    expect(nextPollDelay({ state: "waiting", position: 1, etaSeconds: 1, pollAfterMs: 5000 })).toBe(5000);
  });
  it("judges the admission token on server time", () => {
    const t = { value: "x", expiresAtMs: 10_000 };
    expect(tokenState(t, 4_000)).toEqual({ kind: "valid", remainingMs: 6_000 });
    expect(tokenState(t, 10_000)).toEqual({ kind: "expired" });
  });
  it("walks a scripted queue through admission", async () => {
    const tok = { value: "t", expiresAtMs: 9 };
    const p = new InMemoryDropsPort(D, [
      { state: "waiting", position: 3, etaSeconds: 30, pollAfterMs: 1000 },
      { state: "admitted", token: tok, serverNowMs: 1 },
    ]);
    expect((await p.join("d1")).state).toBe("waiting");
    expect((await p.status()).state).toBe("admitted");
    await p.leave();
    expect(p.joined).toEqual(["d1"]);
  });
  it("surfaces rejection reasons and failures", async () => {
    const p = new InMemoryDropsPort(D, [{ state: "rejected", reason: "perUserLimit" }]);
    expect(await p.join("d1")).toEqual({ state: "rejected", reason: "perUserLimit" });
    p.setFailure("offline");
    await expect(p.status()).rejects.toBeInstanceOf(PortError);
    expect(dropFailureState(new PortError("offline"))).toEqual({ status: "error", offline: true });
    p.setFailure(null);
    p.setDrop(null);
    expect(await p.getDrop()).toBeNull();
  });
});
