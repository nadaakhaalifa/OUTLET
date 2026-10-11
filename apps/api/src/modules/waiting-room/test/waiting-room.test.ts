import { describe, expect, it } from "vitest";
import {
  FakeAttestation,
  FakeBotScore,
  FakeDropGate,
  FakeEntitlements,
  FakeSecrets,
  FakeSwitches,
  InMemoryAdmissionStore,
  InMemoryQueue,
} from "../adapters/in-memory";
import { jwtAdmissionCodec, parseAdmission, signAdmission, signatureValid } from "../adapters/jwt";
import { AdmissionVerifier } from "../application/admission";
import { AdmitFromQueue } from "../application/admit";
import { JoinQueue } from "../application/join";
import { DEFAULT_WAITING_ROOM_CONFIG, deviceHash, type WaitingRoomDeps } from "../application/shared";
import { QueueStatus } from "../application/status";
import type { GateDrop } from "../domain/ports";

const T0 = 1_800_000_000_000;
const clock = { ms: T0, nowMs() { return this.ms; } };
let n = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`, hex: (): string => "00" };
const D = "00000000-0000-4000-8000-000000000100";
const U = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const drop = (over: Partial<GateDrop> = {}): GateDrop => ({
  id: D,
  storeId: U(9001),
  type: "public",
  state: "LIVE",
  paused: false,
  startsAtMs: T0 - 1000,
  earlyAccessAtMs: null,
  admitPerSec: 10,
  soldOutHint: false,
  ...over,
});

function make(d: GateDrop = drop()) {
  clock.ms = T0;
  const gate = new FakeDropGate();
  gate.set(d);
  const deps: WaitingRoomDeps = {
    queue: new InMemoryQueue(),
    gate,
    store: new InMemoryAdmissionStore(),
    secrets: new FakeSecrets(),
    codec: jwtAdmissionCodec,
    bot: new FakeBotScore(),
    attest: new FakeAttestation(),
    entitlements: new FakeEntitlements(),
    switches: new FakeSwitches(),
    clock,
    ids,
    cfg: DEFAULT_WAITING_ROOM_CONFIG,
  };
  return { deps, gate, join: new JoinQueue(deps), admit: new AdmitFromQueue(deps), status: new QueueStatus(deps) };
}

const joinAs = (j: JoinQueue, i: number, attest: string | null = "tok") =>
  j.execute({ userId: U(i), dropId: D, deviceId: `device-${i}-xxxxxxxx`, attestToken: attest });

describe("admission pacing", () => {
  it("admits at admit_per_sec with a fractional carry and never above the burst cap", async () => {
    const { deps, join, admit } = make(drop({ admitPerSec: 10 }));
    for (let i = 1; i <= 100; i++) await joinAs(join, i);
    const first = await admit.run(D); // first tick gets one second of budget
    expect(first.admitted).toBe(10);
    clock.ms += 500;
    expect((await admit.run(D)).admitted).toBe(5);
    clock.ms += 250;
    expect((await admit.run(D)).admitted).toBe(2); // 2.5 -> 2, carry .5
    clock.ms += 250;
    expect((await admit.run(D)).admitted).toBe(3); // 0.5 + 2.5
    clock.ms += 60_000;
    // heartbeats lapsed after 30 s: tickets expire, nobody is admitted from a dead room
    const late = await admit.run(D);
    expect(late.admitted).toBe(0);
    expect(late.abandoned).toBeGreaterThan(0);
    expect(await deps.queue.size(D)).toBe(0);
  });

  it("a repeated tick with no elapsed time admits nobody", async () => {
    const { join, admit } = make();
    for (let i = 1; i <= 30; i++) await joinAs(join, i);
    await admit.run(D);
    expect((await admit.run(D)).admitted).toBe(0);
  });

  it("does not admit before the drop is open, or while paused or killed", async () => {
    const m = make(drop({ state: "SCHEDULED", startsAtMs: T0 + 60_000 }));
    expect((await joinAs(m.join, 1)).kind).toBe("queued"); // inside the pre-queue window
    expect((await m.admit.run(D)).admitted).toBe(0);
    m.gate.patch(D, { state: "LIVE" });
    m.gate.patch(D, { paused: true });
    clock.ms += 1000;
    expect((await m.admit.run(D)).paused).toBe(true);
    m.gate.patch(D, { paused: false });
    (m.deps.switches as FakeSwitches).kill("waiting_room");
    expect((await m.admit.run(D)).paused).toBe(true);
  });
});

describe("join decisions", () => {
  it("sold-out hint refuses, a missing drop is not_found, mystery switch applies", async () => {
    const m = make(drop({ soldOutHint: true }));
    expect(await joinAs(m.join, 1)).toEqual({ kind: "refused", code: "sold_out" });
    expect(await m.join.execute({ userId: U(1), dropId: U(555), deviceId: "device-1-xxxxxxxx", attestToken: "t" })).toEqual({ kind: "not_found" });
    const mb = make(drop({ type: "mystery_box" }));
    (mb.deps.switches as FakeSwitches).kill("mystery_box");
    expect(await joinAs(mb.join, 1)).toEqual({ kind: "paused", reason: "kill_switch" });
  });

  it("per-type kill switch applies only to that type", async () => {
    const m = make(drop({ type: "flash_hour" }));
    (m.deps.switches as FakeSwitches).kill("drop_type_flash_hour");
    expect((await joinAs(m.join, 1)).kind).toBe("paused");
    const p = make(drop({ type: "public" }));
    (p.deps.switches as FakeSwitches).kill("drop_type_flash_hour");
    expect((await joinAs(p.join, 1)).kind).toBe("queued");
  });

  it("attestation can be switched off by config but never skipped silently", async () => {
    const m = make();
    expect((await joinAs(m.join, 1, null)).kind).toBe("attestation_failed");
  });

  it("device ids are stored only as SHA-256", async () => {
    const m = make();
    await joinAs(m.join, 1);
    const q = m.deps.queue as InMemoryQueue;
    const [t] = await q.peek(D, 1);
    expect(t?.deviceHash).toBe(deviceHash("device-1-xxxxxxxx"));
    expect(t?.deviceHash).toHaveLength(64);
  });
});

describe("status", () => {
  it("shows position and an ETA from the admission rate", async () => {
    const m = make(drop({ admitPerSec: 10 }));
    for (let i = 1; i <= 25; i++) await joinAs(m.join, i);
    const s = await m.status.execute({ userId: U(25), dropId: D });
    expect(s).toEqual({ kind: "waiting", position: 25, etaSeconds: 3 });
    expect(await m.status.execute({ userId: U(77), dropId: D })).toEqual({ kind: "not_queued", admissionExpired: false });
  });
});

describe("admission token", () => {
  const claims = { jti: U(1), dropId: D, userId: U(2), deviceHash: deviceHash("d"), iatMs: 1_000_000, expMs: 1_000_000 + 900_000 };
  it("round-trips and rejects tampering with payload, header or signature", () => {
    const key = new TextEncoder().encode("k".repeat(32));
    const tok = signAdmission(claims, "k1", key);
    const p = parseAdmission(tok);
    expect(p.ok && p.claims).toEqual(claims);
    if (!p.ok) throw new Error("parse");
    expect(signatureValid(p, key)).toBe(true);
    expect(signatureValid(p, new TextEncoder().encode("x".repeat(32)))).toBe(false);
    const [h, pay, s] = tok.split(".") as [string, string, string];
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pay, "base64url").toString()), sub: U(9) })).toString("base64url");
    const tampered = parseAdmission(`${h}.${evil}.${s}`);
    expect(tampered.ok && signatureValid(tampered, key)).toBe(false);
    expect(parseAdmission("a.b").ok).toBe(false);
    expect(parseAdmission("x".repeat(3000)).ok).toBe(false);
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "k1" })).toString("base64url");
    expect(parseAdmission(`${none}.${pay}.`).ok).toBe(false);
  });

  it("verifier is stateless: it needs no queue and enforces binding", async () => {
    const secrets = new FakeSecrets();
    const store = new InMemoryAdmissionStore();
    clock.ms = T0;
    const v = new AdmissionVerifier(secrets, store, clock, jwtAdmissionCodec);
    const k = await secrets.current();
    const iatMs = Math.floor(T0 / 1000) * 1000;
    const tok = signAdmission({ ...claims, userId: U(2), iatMs, expMs: iatMs + 900_000 }, k.kid, k.key);
    expect((await v.verify({ token: tok, dropId: D, userId: U(2), deviceId: "d" })).ok).toBe(true);
    expect(await v.verify({ token: tok, dropId: D, userId: U(3), deviceId: "d" })).toEqual({ ok: false, code: "wrong_user" });
    clock.ms = T0 + 900_000;
    expect(await v.verify({ token: tok, dropId: D, userId: U(2), deviceId: "d" })).toEqual({ ok: false, code: "expired" });
  });
});
