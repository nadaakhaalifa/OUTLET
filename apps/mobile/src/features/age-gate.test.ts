import { describe, expect, it } from "vitest";
import { FakeAgeGate, parseAgeGateResponse, type AgeGatePort, type AgeGateResponse } from "../api/age-gate";
import { ageGateErrorKey, formatBlockedUntil, runAgeGate, type AgeGateRunDeps } from "./age-gate";
import { sha256Hex, type DeviceSoftBlock } from "../workspace";

const clock = { now: () => new Date("2026-10-10T12:00:00Z") };
const adult = { day: "10", month: "10", year: "2000" };
const minor = { day: "11", month: "10", year: "2012" };

function setup(port: AgeGatePort, initial: DeviceSoftBlock | null = null) {
  let stored = initial;
  const deps: AgeGateRunDeps = {
    port,
    hasher: sha256Hex,
    clock,
    loadBlock: async () => stored,
    saveBlock: async (b) => {
      stored = b;
    },
  };
  return { deps, stored: () => stored };
}
const fixed = (r: AgeGateResponse): AgeGatePort => ({ check: async () => r });

describe("age gate before phone", () => {
  it("allows an adult after the server allows, returning the DOB only for one-time submission", async () => {
    const gate = new FakeAgeGate({ clock });
    const { deps, stored } = setup(gate);
    const r = await runAgeGate(adult, true, "install-1", deps);
    expect(r).toMatchObject({ kind: "allowed", limitedCapacity: false });
    expect(stored()).toBeNull();
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0]?.deviceIdHash).toBe(sha256Hex("install-1"));
    expect(JSON.stringify(gate.requests)).not.toContain("install-1");
  });

  it("validates input and attestation locally without calling the server", async () => {
    const gate = new FakeAgeGate({ clock });
    const { deps } = setup(gate);
    expect(await runAgeGate({ day: "", month: "1", year: "2000" }, true, "i", deps)).toEqual({ kind: "invalid_date", incomplete: true });
    expect(await runAgeGate({ day: "31", month: "2", year: "2000" }, true, "i", deps)).toEqual({ kind: "invalid_date", incomplete: false });
    expect(await runAgeGate(adult, false, "i", deps)).toEqual({ kind: "needs_attestation" });
    expect(gate.requests).toHaveLength(0);
  });

  it("blocks a minor, persists only hash+expiry, and informs the server so reinstall cannot bypass", async () => {
    const gate = new FakeAgeGate({ clock });
    const { deps, stored } = setup(gate);
    const r = await runAgeGate(minor, true, "install-1", deps);
    expect(r.kind).toBe("blocked");
    expect(Object.keys(stored() ?? {}).sort()).toEqual(["blockedUntil", "deviceHash"]);
    expect(JSON.stringify(stored())).not.toContain("2012");
    // Reinstall: no local state, same hardware-derived id hash, adult-looking DOB.
    const fresh = setup(gate);
    const again = await runAgeGate(adult, true, "install-1", fresh.deps);
    expect(again).toMatchObject({ kind: "blocked", source: "server" });
    expect(fresh.stored()?.deviceHash).toBe(sha256Hex("install-1"));
  });

  it("server 403 blocks an adult-looking date and saves the server expiry", async () => {
    const until = "2026-11-09T12:00:00.000Z";
    const { deps, stored } = setup(fixed({ ok: true, allowed: false, blockedUntil: until }));
    expect(await runAgeGate(adult, true, "d", deps)).toEqual({ kind: "blocked", blockedUntil: until, source: "server" });
    expect(stored()).toEqual({ deviceHash: sha256Hex("d"), blockedUntil: until });
  });

  it("fails closed: a local minor stays blocked when the server is offline or says allowed", async () => {
    for (const resp of [{ ok: false, error: "network" }, { ok: true, allowed: true }] as const) {
      const { deps, stored } = setup(fixed(resp));
      const r = await runAgeGate(minor, true, "d", deps);
      expect(r).toMatchObject({ kind: "blocked", source: "local_rule" });
      expect(stored()).not.toBeNull();
    }
  });

  it("offline with an adult-looking date is a retryable error, never an acceptance", async () => {
    const { deps, stored } = setup(new FakeAgeGate({ clock, offline: true }));
    expect(await runAgeGate(adult, true, "d", deps)).toEqual({ kind: "error", reason: "network", retryable: true });
    expect(stored()).toBeNull();
    expect(ageGateErrorKey("network")).toBe("errors.offline");
    expect(ageGateErrorKey("rate_limited")).toBe("errors.rateLimited");
    expect(ageGateErrorKey("unavailable")).toBe("errors.generic");
  });

  it("an active local block short-circuits with its date and makes no network call", async () => {
    const gate = new FakeAgeGate({ clock });
    const block = { deviceHash: sha256Hex("d"), blockedUntil: "2026-10-20T00:00:00.000Z" };
    const { deps } = setup(gate, block);
    expect(await runAgeGate(adult, true, "d", deps)).toEqual({ kind: "blocked", blockedUntil: block.blockedUntil, source: "device" });
    expect(gate.requests).toHaveLength(0);
  });

  it("an expired local block no longer applies", async () => {
    const block = { deviceHash: sha256Hex("d"), blockedUntil: "2026-10-01T00:00:00.000Z" };
    const { deps } = setup(new FakeAgeGate({ clock }), block);
    expect((await runAgeGate(adult, true, "d", deps)).kind).toBe("allowed");
  });

  it("flags 18-20 as limited capacity", async () => {
    const { deps } = setup(new FakeAgeGate({ clock }));
    expect(await runAgeGate({ day: "1", month: "1", year: "2007" }, true, "d", deps)).toMatchObject({ kind: "allowed", limitedCapacity: true });
  });

  it("an invalid blocked_until from the server is an error, not a block of unknown length", async () => {
    const { deps } = setup(fixed({ ok: true, allowed: false, blockedUntil: "tomorrow" }));
    expect(await runAgeGate(adult, true, "d", deps)).toMatchObject({ kind: "error", reason: "unavailable" });
  });
});

describe("age gate wire contract", () => {
  it("parses 200 and 403 and fails closed on anything else", () => {
    expect(parseAgeGateResponse(200, { allowed: true })).toEqual({ ok: true, allowed: true });
    expect(parseAgeGateResponse(200, { allowed: false })).toMatchObject({ ok: false });
    expect(parseAgeGateResponse(403, { blocked_until: "2026-11-09T12:00:00.000Z" })).toEqual({
      ok: true,
      allowed: false,
      blockedUntil: "2026-11-09T12:00:00.000Z",
    });
    expect(parseAgeGateResponse(403, {})).toMatchObject({ ok: false, error: "unavailable" });
    expect(parseAgeGateResponse(429, null)).toEqual({ ok: false, error: "rate_limited" });
    expect(parseAgeGateResponse(500, { allowed: true })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("blocked date formatting", () => {
  it("formats in both languages and tolerates garbage", () => {
    expect(formatBlockedUntil("2026-11-09T12:00:00.000Z", "en")).toContain("2026");
    expect(formatBlockedUntil("2026-11-09T12:00:00.000Z", "ar")).not.toBe("");
    expect(formatBlockedUntil("nope", "en")).toBe("");
  });
});
