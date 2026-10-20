import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import { issueFamily, nodeFriendlyRng } from "./support";
import { createPgliteDatabase, type PgliteInstance } from "../../../../platform/db";
import { LocalKeyFieldCipher } from "../../adapters/field-cipher";
import { createInMemorySellerStores } from "../adapters/in-memory";
import { createKyselySellerStores } from "../adapters/kysely-stores";
import { SELLER_OTP_POLICY, SellerOtp } from "../application/otp";
import type { SellerStores } from "../domain/ports";

let run = 0;
function contract(name: string, make: () => Promise<SellerStores>): void {
  const tag = String(++run);
  const ph = (n: string): string => `+4479${tag}0000${n}`;
  describe(`seller stores contract: ${name}`, () => {
    it("users: find-or-create is idempotent per phone and never overwrites the e-mail", async () => {
      const s = await make();
      const id = randomUUID();
      const a = await s.users.findOrCreateByPhone({ phoneE164: ph("01"), email: "a@example.com", language: "en", newId: id, nowMs: 1000 });
      const b = await s.users.findOrCreateByPhone({ phoneE164: ph("01"), email: "other@example.com", language: "ar", newId: randomUUID(), nowMs: 2000 });
      expect(b.id).toBe(a.id);
      expect(b.email).toBe("a@example.com");
      expect(a.strongFactor).toBe(false);
      await s.users.markStrongFactor(a.id);
      expect((await s.users.findById(a.id))?.strongFactor).toBe(true);
      expect((await s.users.findByPhone(ph("01")))?.id).toBe(a.id);
      expect(await s.users.findByPhone(ph("02"))).toBeNull();
      expect(await s.users.findById(randomUUID())).toBeNull();
    });

    it("proofs are single use and expire", async () => {
      const s = await make();
      const u = await s.users.findOrCreateByPhone({ phoneE164: ph("10"), email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      const h = randomBytes(32).toString("hex");
      await s.proofs.put(h, { sellerUserId: u.id, channel: "sms" }, 10_000);
      expect(await s.proofs.peek(h, 5000)).toEqual({ sellerUserId: u.id, channel: "sms" });
      expect(await s.proofs.consume(h, 5000)).not.toBeNull();
      expect(await s.proofs.consume(h, 5000)).toBeNull();
      const h2 = randomBytes(32).toString("hex");
      await s.proofs.put(h2, { sellerUserId: u.id, channel: "whatsapp" }, 10_000);
      expect(await s.proofs.consume(h2, 10_000)).toBeNull();
    });

    it("passkey challenges are single use; credentials are unique", async () => {
      const s = await make();
      const u = await s.users.findOrCreateByPhone({ phoneE164: ph("20"), email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      const id = randomUUID();
      await s.passkeyChallenges.put({ id, challenge: "c".repeat(43), purpose: "assert", sellerUserId: u.id, otpChannel: "sms", expiresAtMs: 10_000 });
      expect((await s.passkeyChallenges.peek(id, 1))?.otpChannel).toBe("sms");
      expect(await s.passkeyChallenges.take(id, 1)).not.toBeNull();
      expect(await s.passkeyChallenges.take(id, 1)).toBeNull();
      const pk = { sellerUserId: u.id, credentialId: `cred-${tag}-1`, publicKey: "pk", signCount: 0, backupEligible: false, backedUp: false, status: "active" as const, label: null, createdAtMs: 1 };
      expect(await s.passkeys.insert(pk)).toBe(true);
      expect(await s.passkeys.insert(pk)).toBe(false);
      await s.passkeys.update({ ...pk, signCount: 7, status: "suspected_clone" });
      expect((await s.passkeys.find(`cred-${tag}-1`))?.signCount).toBe(7);
      expect(await s.passkeys.listActive(u.id)).toHaveLength(0);
    });

    it("totp: pending enrolment can be replaced, active cannot; steps are compare-and-set; recovery codes are single use", async () => {
      const s = await make();
      const u = await s.users.findOrCreateByPhone({ phoneE164: ph("30"), email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      const rec = { sellerUserId: u.id, secretBase32: "JBSWY3DPEHPK3PXP", status: "pending" as const, lastUsedStep: null, failedCount: 0, lockCount: 0, lockedUntilMs: null, createdAtMs: 1 };
      const h1 = "a".repeat(64);
      const h2 = "b".repeat(64);
      expect(await s.totp.startEnrolment(rec, [h1])).toBe(true);
      expect(await s.totp.startEnrolment({ ...rec, secretBase32: "KRSXG5CTMVRXEZLU" }, [h2])).toBe(true);
      expect((await s.totp.find(u.id))?.secretBase32).toBe("KRSXG5CTMVRXEZLU");
      expect(await s.totp.consumeRecoveryCode(u.id, h1, 5)).toBe(false);
      expect(await s.totp.acceptStep(u.id, 100, null, true, 5)).toBe(true);
      expect(await s.totp.acceptStep(u.id, 101, null, false, 5)).toBe(false); // stale previous step
      expect(await s.totp.acceptStep(u.id, 101, 100, false, 5)).toBe(true);
      expect((await s.totp.find(u.id))?.status).toBe("active");
      expect(await s.totp.startEnrolment(rec, [])).toBe(false);
      expect(await s.totp.remainingRecoveryCodes(u.id)).toBe(1);
      expect(await s.totp.consumeRecoveryCode(u.id, h2, 5)).toBe(true);
      expect(await s.totp.consumeRecoveryCode(u.id, h2, 6)).toBe(false);
      await s.totp.recordFailure(u.id, 0, 1, 99_999);
      expect((await s.totp.find(u.id))).toMatchObject({ lockCount: 1, lockedUntilMs: 99_999 });
      await s.totp.resetFailures(u.id);
      expect((await s.totp.find(u.id))).toMatchObject({ lockCount: 0, lockedUntilMs: null });
    });

    it("sessions: refresh lookup by hash, compare-and-save is optimistic", async () => {
      const s = await make();
      const u = await s.users.findOrCreateByPhone({ phoneE164: ph("40"), email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      const { family, token } = issueFamily(u.id, "`install-${tag}`");
      const sid = family.familyId;
      const session = { id: sid, sellerUserId: u.id, kind: "full" as const, restricted: false, installId: "`install-${tag}`", amr: ["otp_sms" as const, "totp" as const], strongAtMs: 1000, createdAtMs: 1000, lastUsedAtMs: 1000, expiresAtMs: null, revokedAtMs: null };
      await s.sessions.insert({ session, family });
      const hash = family.records[0]?.tokenHash ?? "";
      expect((await s.sessions.findByRefreshHash(hash))?.session.id).toBe(sid);
      expect(await s.sessions.findByRefreshHash("0".repeat(64))).toBeNull();
      const stored = await s.sessions.find(sid);
      expect(stored?.session.amr).toEqual(["otp_sms", "totp"]);
      expect(token.length).toBeGreaterThan(10);
      if (stored === null) throw new Error("missing");
      const next = { session: { ...stored.session, revokedAtMs: 5000 }, family: stored.family };
      expect(await s.sessions.compareAndSave(stored, next)).toBe(true);
      expect(await s.sessions.compareAndSave(stored, next)).toBe(false);
      expect((await s.sessions.find(sid))?.session.revokedAtMs).toBe(5000);
      expect(await s.sessions.listBySeller(u.id)).toHaveLength(1);
    });

    it("memberships: one active row per (seller, store), last owner protected; invites are one open per (store, phone)", async () => {
      const s = await make();
      const a = await s.users.findOrCreateByPhone({ phoneE164: ph("50"), email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      const store = randomUUID();
      const m1 = await s.memberships.upsert({ id: randomUUID(), sellerUserId: a.id, storeId: store, role: "owner", grantedBy: null, nowMs: 1 });
      const m2 = await s.memberships.upsert({ id: randomUUID(), sellerUserId: a.id, storeId: store, role: "owner", grantedBy: null, nowMs: 2 });
      expect(m2.id).toBe(m1.id);
      expect(await s.memberships.revoke({ sellerUserId: a.id, storeId: store, nowMs: 3 })).toBe("last_owner");
      const b = await s.users.findOrCreateByPhone({ phoneE164: ph("51"), email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      await s.memberships.upsert({ id: randomUUID(), sellerUserId: b.id, storeId: store, role: "finance", grantedBy: a.id, nowMs: 4 });
      expect((await s.memberships.listByStore(store)).map((m) => m.role).sort()).toEqual(["finance", "owner"]);
      expect(await s.memberships.revoke({ sellerUserId: b.id, storeId: store, nowMs: 5 })).toBe("revoked");
      expect(await s.memberships.revoke({ sellerUserId: b.id, storeId: store, nowMs: 6 })).toBe("not_found");
      expect(await s.memberships.listBySeller(b.id)).toHaveLength(0);

      const inv = { id: randomUUID(), storeId: store, role: "support" as const, phoneE164: ph("52"), invitedBy: a.id, createdAtMs: 1, expiresAtMs: 10_000 };
      const first = await s.invites.upsertOpen(inv);
      const again = await s.invites.upsertOpen({ ...inv, id: randomUUID(), role: "catalog" });
      expect(again.id).toBe(first.id);
      expect((await s.invites.listOpenByPhone(ph("52"), 5))[0]?.role).toBe("catalog");
      expect(await s.invites.listOpenByPhone(ph("52"), 20_000)).toHaveLength(0);
      await s.invites.markAccepted(first.id, 6);
      expect(await s.invites.listOpenByPhone(ph("52"), 7)).toHaveLength(0);
    });

    it("otp: send log counts per phone, client and prefix; attempts are compare-and-set", async () => {
      const s = await make();
      await s.sendLog.record(ph("60"), `ip:${tag}.1.1.1`, `4479${tag}`, 1000);
      await s.sendLog.record(ph("61"), `ip:${tag}.1.1.1`, `4479${tag}`, 2000);
      await s.sendLog.markVerified(ph("61"), 2500);
      const h = await s.sendLog.history(ph("60"), `ip:${tag}.1.1.1`, `4479${tag}`, 3000, 10_000);
      expect(h.phoneSendTimes).toEqual([1000]);
      expect(h.clientSendTimes).toHaveLength(2);
      expect(h).toMatchObject({ prefixSends: 2, prefixVerified: 1 });
      const old = await s.sendLog.history(ph("60"), `ip:${tag}.1.1.1`, `4479${tag}`, 30_000, 10_000);
      expect(old.prefixSends).toBe(0);

      const id = randomUUID();
      const challenge = { id, phoneE164: ph("62"), salt: "s", codeHash: "c".repeat(64), issuedAtMs: 1, expiresAtMs: 99_999, attempts: 0, status: "pending" as const };
      await s.challenges.insert({ challenge, channel: "sms", clientKey: `ip:${tag}.9.9.9`, email: "e@example.com", language: "ar" });
      const found = await s.challenges.find(id);
      expect(found).toMatchObject({ email: "e@example.com", language: "ar", channel: "sms" });
      expect(found?.clientKey).toBe(await s.challenges.clientKeyOf(`ip:${tag}.2.3.4`)); // web clients share a bucket
      expect(await s.challenges.compareAndSet(challenge, { ...found!, challenge: { ...challenge, attempts: 1 } })).toBe(true);
      expect(await s.challenges.compareAndSet(challenge, { ...found!, challenge: { ...challenge, attempts: 1 } })).toBe(false);
    });
  });
}

contract("in-memory", async () => createInMemorySellerStores());

const cipher = new LocalKeyFieldCipher(new Uint8Array(randomBytes(32)));
const dbPromise = createTestDatabaseUpTo(53).then((raw) => ({ raw, db: createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance) }));
afterAll(async () => (await dbPromise).db.destroy());

contract("kysely/pglite (owner)", async () => createKyselySellerStores((await dbPromise).db, cipher));

describe("seller stores under the app_user role (RLS applies)", () => {
  it("grants allow the system-elevated adapter and deny everything else", async () => {
    const { raw, db } = await dbPromise;
    await raw.exec("SET ROLE app_user");
    try {
      const s = createKyselySellerStores(db, cipher);
      const u = await s.users.findOrCreateByPhone({ phoneE164: "+447900000099", email: null, language: "en", newId: randomUUID(), nowMs: 1 });
      expect((await s.users.findById(u.id))?.id).toBe(u.id);
      // Without the `system` elevation the role sees no seller rows: deny by default.
      for (const t of ["seller_users", "seller_sessions", "seller_totp", "seller_memberships", "seller_otp_proofs"]) {
        const r = await sql`select count(*)::int as n from ${sql.table(t)}`.execute(db);
        expect((r.rows[0] as { n: number }).n, t).toBe(0);
      }
    } finally {
      await raw.exec("RESET ROLE");
    }
  });
});

contract("kysely/pglite (app_user, RLS)", async () => {
  const { raw, db } = await dbPromise;
  await raw.exec("SET ROLE app_user");
  return createKyselySellerStores(db, cipher);
});

describe("SellerOtp abuse controls (in-memory)", () => {
  it("allows every calling code, caps sends per prefix and alerts", async () => {
    expect(SELLER_OTP_POLICY.allowedCallingCodes).toEqual([""]);
    const s = createInMemorySellerStores();
    const sent: string[] = [];
    const events: string[] = [];
    const otp = new SellerOtp({
      senders: [{ id: "x", channel: "sms", send: async (r) => (sent.push(r.phoneE164), { ok: true, providerMessageId: "1" }) }],
      challenges: s.challenges,
      sendLog: s.sendLog,
      proofs: s.proofs,
      users: s.users,
      issuer: undefined as never,
      events: { publish: async (e) => void events.push(e.type) },
      clock: { nowMs: () => 1_000_000 },
      rng: nodeFriendlyRng(),
      newId: () => randomUUID(),
      pepper: new Uint8Array(32),
      prefixCapPerHour: 2,
    });
    const req = (n: number) => otp.request({ phoneE164: `+8613800000${String(n).padStart(2, "0")}`, email: "a@b.co", language: "en", channel: undefined, clientKey: `ip:${n}`, sendKey: "k" });
    expect((await req(1)).kind).toBe("sent");
    expect((await req(2)).kind).toBe("sent");
    expect((await req(3)).kind).toBe("rate_limited");
    expect(events).toContain("seller.otp_prefix_anomaly");
    expect(sent).toHaveLength(2);
  });
});
