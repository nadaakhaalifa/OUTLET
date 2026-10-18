import { randomBytes, randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOtpChallenge, issueFamily, revokeFamily, revokeSession, rotateRefreshToken, hashRefreshToken, type Csprng } from "@outlet/auth-core";
import type {
  AgeGateStore,
  NonceStore,
  OtpChallengeRepository,
  OtpSendLog,
  PasskeyChallengeStore,
  PasskeyCredentialRepository,
  SessionRepository,
  StoredSession,
  UserDirectory,
} from "../domain/ports";

export interface StoresFixture {
  readonly users: UserDirectory;
  readonly sessions: SessionRepository;
  readonly challenges: OtpChallengeRepository;
  readonly sendLog: OtpSendLog;
  readonly ageGate: AgeGateStore;
  readonly nonces: NonceStore;
  readonly passkeyChallenges: PasskeyChallengeStore;
  readonly passkeyCredentials: PasskeyCredentialRepository;
}

export const rng: Csprng = { randomBytes: (n) => new Uint8Array(randomBytes(n)) };
export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const NOW = 1_800_000_000_000;
const phone = (): string => `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function newSession(f: StoresFixture): Promise<{ stored: StoredSession; token: string; userId: string }> {
  const user = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW });
  const { family, token } = issueFamily({ familyId: randomUUID(), userId: user.id, deviceId: randomUUID(), recordId: randomUUID(), rng, nowMs: NOW });
  const stored: StoredSession = {
    platform: "ios",
    family,
    session: {
      id: randomUUID(),
      userId: user.id,
      deviceId: family.deviceId,
      familyId: family.familyId,
      amr: ["otp_sms", "attestation"],
      createdAtMs: NOW,
      lastUsedAtMs: NOW,
      revokedAtMs: null,
    },
  };
  await f.sessions.insert(stored);
  return { stored, token, userId: user.id };
}

/** Behaviour every auth store implementation (in-memory and Kysely/PGlite) must share. */
export function describeAuthStoresContract(name: string, make: () => Promise<StoresFixture>): void {
  describe(`auth stores contract: ${name}`, () => {
    it("users: find-or-create by phone is idempotent and distinct per phone", async () => {
      const f = await make();
      const p = phone();
      const a = await f.users.findOrCreateByPhone({ phoneE164: p, language: "ar", newId: randomUUID(), nowMs: NOW });
      const b = await f.users.findOrCreateByPhone({ phoneE164: p, language: "en", newId: randomUUID(), nowMs: NOW + 1 });
      const c = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW });
      expect(b.id).toBe(a.id);
      expect(c.id).not.toBe(a.id);
      expect(a.phoneE164).toBe(p);
      expect(a.status).toBe("active");
      expect((await f.users.findById(a.id))?.phoneE164).toBe(p);
      expect(await f.users.findById(randomUUID())).toBeNull();
    });

    it("users: findByPhone is read only (null for an unknown number, creates nothing) and finds an existing account", async () => {
      const f = await make();
      const p = phone();
      expect(await f.users.findByPhone(p)).toBeNull();
      expect(await f.users.findByPhone(p)).toBeNull();
      const wanted = randomUUID();
      // If findByPhone had created a row, this would return that row's id instead of the one we asked for.
      const created = await f.users.findOrCreateByPhone({ phoneE164: p, language: "ar", newId: wanted, nowMs: NOW });
      expect(created.id).toBe(wanted);
      expect((await f.users.findByPhone(p))?.id).toBe(wanted);
    });

    it("users: age band and limited capacity come from the age pass, never from the client", async () => {
      const f = await make();
      const young = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW, age: { ageBand: "18_20", dobCiphertext: null } });
      const adult = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW, age: { ageBand: "21_plus", dobCiphertext: null } });
      const none = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW });
      expect([young.ageBand, young.limitedCapacity]).toEqual(["18_20", true]);
      expect([adult.ageBand, adult.limitedCapacity]).toEqual(["21_plus", false]);
      expect([none.ageBand, none.limitedCapacity]).toEqual([null, false]);
    });

    it("users: federated identities resolve by (provider, subject) and never link by e-mail", async () => {
      const f = await make();
      const subject = `sub-${randomUUID()}`;
      const a = await f.users.findOrCreateByIdentity({ provider: "apple", subject, email: "a@example.com", language: "ar", newId: randomUUID(), nowMs: NOW });
      const again = await f.users.findOrCreateByIdentity({ provider: "apple", subject, email: null, language: "ar", newId: randomUUID(), nowMs: NOW });
      const google = await f.users.findOrCreateByIdentity({ provider: "google", subject, email: "a@example.com", language: "ar", newId: randomUUID(), nowMs: NOW });
      expect(again.id).toBe(a.id);
      expect(google.id).not.toBe(a.id);
      expect(a.email).toBe("a@example.com");
    });

    it("users: concurrent first sign-ins for one phone converge on one account", async () => {
      const f = await make();
      const p = phone();
      const users = await Promise.all(
        [1, 2, 3, 4].map(() => f.users.findOrCreateByPhone({ phoneE164: p, language: "ar", newId: randomUUID(), nowMs: NOW })),
      );
      expect(new Set(users.map((u) => u.id)).size).toBe(1);
    });

    it("sessions: round trip, lookup by any refresh hash, list by user", async () => {
      const f = await make();
      const { stored, token, userId } = await newSession(f);
      const found = await f.sessions.find(stored.session.id);
      expect(found?.session.userId).toBe(userId);
      expect(found?.platform).toBe("ios");
      expect(found?.session.amr).toEqual(["otp_sms", "attestation"]);
      expect(found?.family.deviceId).toBe(stored.family.deviceId);
      expect(found?.family.records).toHaveLength(1);
      expect((await f.sessions.findByRefreshHash(hashRefreshToken(token)))?.session.id).toBe(stored.session.id);
      expect(await f.sessions.findByRefreshHash(hashRefreshToken("nope"))).toBeNull();
      expect((await f.sessions.listByUser(userId)).map((s) => s.session.id)).toEqual([stored.session.id]);
      expect(await f.sessions.find(randomUUID())).toBeNull();
    });

    it("sessions: a web session keeps uv and the install-token hash; clearing the hash persists; mobile rows have no uv", async () => {
      const f = await make();
      const mobile = await newSession(f);
      expect((await f.sessions.find(mobile.stored.session.id))?.uv === true).toBe(false);
      const user = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW });
      const { family } = issueFamily({ familyId: randomUUID(), userId: user.id, deviceId: randomUUID(), recordId: randomUUID(), rng, nowMs: NOW });
      const hash = sha(randomUUID());
      const web: StoredSession = {
        platform: "web",
        uv: true,
        installSecretHash: hash,
        family,
        session: { id: randomUUID(), userId: user.id, deviceId: family.deviceId, familyId: family.familyId, amr: ["passkey", "webauthn"], createdAtMs: NOW, lastUsedAtMs: NOW, revokedAtMs: null },
      };
      await f.sessions.insert(web);
      const found = await f.sessions.find(web.session.id);
      expect(found?.platform).toBe("web");
      expect(found?.uv).toBe(true);
      expect(found?.installSecretHash).toBe(hash);
      expect((await f.sessions.findByRefreshHash(family.records[0]?.tokenHash ?? ""))?.installSecretHash).toBe(hash);
      await f.sessions.save({ ...web, installSecretHash: null });
      expect((await f.sessions.find(web.session.id))?.installSecretHash).toBeNull();
    });

    it("sessions: a stale compareAndSave loses (two concurrent rotations cannot both win)", async () => {
      const f = await make();
      const { stored, token } = await newSession(f);
      const r1 = rotateRefreshToken({ family: stored.family, presentedToken: token, presentingDeviceId: stored.family.deviceId, newRecordId: randomUUID(), rng, nowMs: NOW + 1000 });
      const r2 = rotateRefreshToken({ family: stored.family, presentedToken: token, presentingDeviceId: stored.family.deviceId, newRecordId: randomUUID(), rng, nowMs: NOW + 1000 });
      if (r1.outcome !== "rotated" || r2.outcome !== "rotated") throw new Error("expected rotation");
      const [a, b] = await Promise.all([
        f.sessions.compareAndSave(stored, { ...stored, family: r1.family }),
        f.sessions.compareAndSave(stored, { ...stored, family: r2.family }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const after = await f.sessions.find(stored.session.id);
      expect(after?.family.records.map((r) => r.status)).toEqual(["rotated", "active"]);
    });

    it("sessions: rotated token stays findable (reuse detection) and revocation persists with its reason", async () => {
      const f = await make();
      const { stored, token } = await newSession(f);
      const r = rotateRefreshToken({ family: stored.family, presentedToken: token, presentingDeviceId: stored.family.deviceId, newRecordId: randomUUID(), rng, nowMs: NOW + 1 });
      if (r.outcome !== "rotated") throw new Error("expected rotation");
      expect(await f.sessions.compareAndSave(stored, { ...stored, family: r.family })).toBe(true);
      const old = await f.sessions.findByRefreshHash(hashRefreshToken(token));
      expect(old?.family.records.find((x) => x.tokenHash === hashRefreshToken(token))?.status).toBe("rotated");
      const cur = (await f.sessions.find(stored.session.id)) as StoredSession;
      const revoked: StoredSession = { ...cur, session: revokeSession(cur.session, NOW + 2), family: revokeFamily(cur.family, NOW + 2, "reuse_detected") };
      await f.sessions.save(revoked);
      const after = await f.sessions.find(stored.session.id);
      expect(after?.session.revokedAtMs).toBe(NOW + 2);
      expect(after?.family.revokeReason).toBe("reuse_detected");
      expect(after?.family.records.every((x) => x.status === "revoked")).toBe(true);
    });

    it("otp: challenge round trip keeps the phone, device binding comparable via deviceKeyOf", async () => {
      const f = await make();
      const p = phone();
      const { challenge } = createOtpChallenge({ id: randomUUID(), phoneE164: p, rng, pepper: new Uint8Array(32), nowMs: NOW });
      await f.challenges.insert({ challenge, channel: "whatsapp", deviceKey: "device-key-1" });
      const got = await f.challenges.find(challenge.id);
      expect(got?.challenge).toEqual(challenge);
      expect(got?.channel).toBe("whatsapp");
      expect(got?.deviceKey).toBe(await f.challenges.deviceKeyOf("device-key-1"));
      expect(got?.deviceKey).not.toBe(await f.challenges.deviceKeyOf("device-key-2"));
      expect(await f.challenges.find(randomUUID())).toBeNull();
    });

    it("otp: compareAndSet is optimistic on (attempts, status)", async () => {
      const f = await make();
      const { challenge } = createOtpChallenge({ id: randomUUID(), phoneE164: phone(), rng, pepper: new Uint8Array(32), nowMs: NOW });
      await f.challenges.insert({ challenge, channel: "sms", deviceKey: "d" });
      const next = { challenge: { ...challenge, attempts: 1 }, channel: "sms" as const, deviceKey: "d" };
      const results = await Promise.all([f.challenges.compareAndSet(challenge, next), f.challenges.compareAndSet(challenge, next)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await f.challenges.find(challenge.id))?.challenge.attempts).toBe(1);
    });

    it("otp send log: history returns the times recorded for that phone and that device only", async () => {
      const f = await make();
      const p = phone();
      const q = phone();
      await f.sendLog.record(p, "dev-a", NOW);
      await f.sendLog.record(p, "dev-b", NOW + 1000);
      await f.sendLog.record(q, "dev-a", NOW + 2000);
      const h = await f.sendLog.history(p, "dev-a", NOW + 3000);
      expect([...h.phoneSendTimes].sort()).toEqual([NOW, NOW + 1000]);
      expect(h.deviceSendTimes.length).toBeGreaterThanOrEqual(2);
      expect((await f.sendLog.history(phone(), "dev-never", NOW + 3000)).phoneSendTimes).toEqual([]);
    });

    it("age gate: blocks last until expiry, passes carry the band and expire", async () => {
      const f = await make();
      const k1 = sha(randomUUID());
      const k2 = sha(randomUUID());
      expect(await f.ageGate.activeBlock([k1, k2], NOW)).toBeNull();
      await f.ageGate.block([k1], NOW + 1000);
      await f.ageGate.block([k2], NOW + 5000);
      await f.ageGate.block([k1], NOW + 500);
      expect(await f.ageGate.activeBlock([k1, k2], NOW)).toBe(NOW + 5000);
      expect(await f.ageGate.activeBlock([k1], NOW)).toBe(NOW + 1000);
      expect(await f.ageGate.activeBlock([k1], NOW + 1000)).toBeNull();
      const pass = sha(randomUUID());
      expect(await f.ageGate.hasPassed(pass, NOW)).toBe(false);
      await f.ageGate.markPassed(pass, NOW + 1000, { ageBand: "18_20", dobCiphertext: null });
      expect(await f.ageGate.hasPassed(pass, NOW)).toBe(true);
      expect((await f.ageGate.passInfo(pass, NOW))?.ageBand).toBe("18_20");
      expect(await f.ageGate.hasPassed(pass, NOW + 1000)).toBe(false);
      expect(await f.ageGate.passInfo(pass, NOW + 1000)).toBeNull();
    });

    it("nonces: consumed exactly once, even concurrently", async () => {
      const f = await make();
      const key = `apple:${sha(randomUUID())}`;
      const r = await Promise.all([1, 2, 3].map(() => f.nonces.consume(key, NOW + 10_000, NOW)));
      expect(r.filter(Boolean)).toHaveLength(1);
      expect(await f.nonces.consume(key, NOW + 10_000, NOW + 1)).toBe(false);
      expect(await f.nonces.consume(key, NOW + 30_000, NOW + 20_000)).toBe(true);
    });

    it("passkey challenges: take is single use and expiry is honoured", async () => {
      const f = await make();
      const user = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW });
      const rec = { id: randomUUID(), challenge: randomBytes(32).toString("base64url"), purpose: "register" as const, userId: user.id, expiresAtMs: NOW + 1000 };
      await f.passkeyChallenges.put(rec);
      expect(await f.passkeyChallenges.peek(rec.id, NOW)).toEqual(rec);
      const taken = await Promise.all([f.passkeyChallenges.take(rec.id, NOW), f.passkeyChallenges.take(rec.id, NOW)]);
      expect(taken.filter((x) => x !== null)).toHaveLength(1);
      expect(await f.passkeyChallenges.take(rec.id, NOW)).toBeNull();
      const old = { ...rec, id: randomUUID(), purpose: "assert" as const, userId: null, expiresAtMs: NOW + 10 };
      await f.passkeyChallenges.put(old);
      expect(await f.passkeyChallenges.peek(old.id, NOW + 10)).toBeNull();
      expect(await f.passkeyChallenges.take(old.id, NOW + 10)).toBeNull();
    });

    it("passkey credentials: duplicate id is refused, update persists counter, status and backup state", async () => {
      const f = await make();
      const user = await f.users.findOrCreateByPhone({ phoneE164: phone(), language: "ar", newId: randomUUID(), nowMs: NOW });
      const p = { userId: user.id, credentialId: randomBytes(16).toString("base64url"), publicKey: "pk", signCount: 0, status: "active" as const, backupEligible: true, backedUp: false, createdAtMs: NOW };
      expect(await f.passkeyCredentials.insert(p)).toBe(true);
      expect(await f.passkeyCredentials.insert({ ...p, userId: randomUUID() })).toBe(false);
      await f.passkeyCredentials.update({ ...p, signCount: 7, status: "suspected_clone", backedUp: true });
      const got = await f.passkeyCredentials.find(p.credentialId);
      expect([got?.signCount, got?.status, got?.backedUp, got?.backupEligible, got?.userId]).toEqual([7, "suspected_clone", true, true, user.id]);
      expect(await f.passkeyCredentials.find("missing")).toBeNull();
    });
  });
}
