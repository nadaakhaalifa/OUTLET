import { sellerSettings as ss } from "@outlet/domain";
import { describe, expect, it } from "vitest";
import type { InviteRecord, PayoutAccountRecord, ProfileRecord, SettingsRepository, ShippingRecord } from "../domain/ports";

export const STORE_A = "0192f3a4-5b6c-7d8e-9f01-00000000000a";
export const STORE_B = "0192f3a4-5b6c-7d8e-9f01-00000000000b";
export const USER_1 = "0192f3a4-5b6c-7d8e-9f01-000000000101";
const U = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export const profile = (storeId: string, version = 1): ProfileRecord => ({
  storeId,
  nameAr: "متجر",
  nameEn: "Shop",
  descriptionAr: null,
  descriptionEn: null,
  logoKey: null,
  coverKey: null,
  socialLinks: { website: "https://shop.example.com/" },
  returnPolicy: { changeOfMindDays: 14, defectDays: 30, textAr: "سياسة", textEn: "Policy" },
  freeDeliveryThreshold: 200_000n,
  vacation: { enabled: true, untilMs: 1_800_000_000_000, etaExtraDays: 4 },
  version,
  updatedBy: USER_1,
  updatedAtMs: 1_700_000_000_000,
});

const account = (n: number, storeId = STORE_A): PayoutAccountRecord => ({
  id: U(n),
  storeId,
  accountToken: `acct_${n.toString(16).padStart(32, "0")}`,
  ibanEnc: bytes(`cipher-${n}`),
  ibanLast4: "0001",
  holderNameEnc: bytes("holder"),
  legalNameScore: 100,
  status: "ACTIVE",
  createdBy: USER_1,
  createdAtMs: 1_700_000_000_000 + n,
  activatesAtMs: 1_700_000_000_000 + n + 1000,
});

const invite = (n: number, phone: string, hash: string, status: InviteRecord["status"] = "PENDING"): InviteRecord => ({
  id: U(n),
  storeId: STORE_A,
  role: "catalog",
  phoneBlind: bytes(phone),
  phoneEnc: bytes(`enc-${phone}`),
  phoneMasked: "+20*******78",
  tokenHash: hash,
  status,
  invitedBy: USER_1,
  respondedBy: null,
  createdAtMs: 1_700_000_000_000 + n,
  expiresAtMs: 1_700_000_000_000 + ss.INVITE_TTL_MS,
  respondedAtMs: null,
});

export function describeSettingsRepository(name: string, fresh: () => Promise<SettingsRepository>): void {
  describe(`SettingsRepository contract: ${name}`, () => {
    it("profile: insert once, version-checked update, tenant isolation", async () => {
      const r = await fresh();
      expect(await r.getProfile(STORE_A)).toBeNull();
      expect(await r.saveProfile(profile(STORE_A), null)).toBe(true);
      expect(await r.saveProfile(profile(STORE_A), null)).toBe(false);
      const got = await r.getProfile(STORE_A);
      expect(got).toMatchObject({ nameAr: "متجر", freeDeliveryThreshold: 200_000n, version: 1 });
      expect(got?.vacation).toEqual({ enabled: true, untilMs: 1_800_000_000_000, etaExtraDays: 4 });
      expect(got?.socialLinks).toEqual({ website: "https://shop.example.com/" });
      expect(await r.saveProfile({ ...profile(STORE_A, 2), nameAr: "جديد" }, 5)).toBe(false);
      expect(await r.saveProfile({ ...profile(STORE_A, 2), nameAr: "جديد" }, 1)).toBe(true);
      expect((await r.getProfile(STORE_A))?.nameAr).toBe("جديد");
      expect(await r.getProfile(STORE_B)).toBeNull();
    });

    it("uploads: create, read per store, mark confirmed", async () => {
      const r = await fresh();
      await r.createUpload({
        id: U(1),
        storeId: STORE_A,
        slot: "logo",
        objectKey: `stores/${STORE_A}/logo/${U(1)}.png`,
        contentType: "image/png",
        declaredBytes: 1000,
        status: "issued",
        rejectCode: null,
        width: null,
        height: null,
        createdBy: USER_1,
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_600_000,
      });
      expect(await r.getUpload(STORE_B, U(1))).toBeNull();
      await r.markUpload(STORE_A, U(1), { status: "confirmed", width: 512, height: 512, atMs: 1_700_000_001_000 });
      expect(await r.getUpload(STORE_A, U(1))).toMatchObject({ status: "confirmed", width: 512, height: 512 });
    });

    it("payout account: one ACTIVE per store, replacement supersedes", async () => {
      const r = await fresh();
      expect(await r.activeAccount(STORE_A)).toBeNull();
      await r.replaceAccount(account(1));
      await r.replaceAccount(account(2));
      await r.replaceAccount(account(3, STORE_B));
      const a = await r.activeAccount(STORE_A);
      expect(a?.id).toBe(U(2));
      expect(Buffer.from(a?.ibanEnc ?? new Uint8Array()).toString()).toBe("cipher-2");
      expect((await r.activeAccount(STORE_B))?.id).toBe(U(3));
    });

    it("shipping: insert, version-checked update", async () => {
      const r = await fresh();
      const rec: ShippingRecord = {
        storeId: STORE_A,
        governorateCode: "EG-C",
        cityCode: "nasr-city",
        street: "10 Street",
        building: null,
        landmark: "Mall",
        contactName: "WH",
        contactPhoneEnc: bytes("phone"),
        pin: { lat: 30.1, lng: 31.2 },
        handlingHours: 48,
        courierPreferences: { default: ["bosta", "aramex"] },
        packaging: ["standard_box"],
        version: 1,
        updatedBy: USER_1,
      };
      expect(await r.saveShipping(rec, null)).toBe(true);
      expect(await r.saveShipping(rec, null)).toBe(false);
      expect(await r.getShipping(STORE_A)).toMatchObject({ handlingHours: 48, pin: { lat: 30.1, lng: 31.2 }, courierPreferences: { default: ["bosta", "aramex"] } });
      expect(await r.saveShipping({ ...rec, handlingHours: 24, version: 2 }, 9)).toBe(false);
      expect(await r.saveShipping({ ...rec, handlingHours: 24, version: 2 }, 1)).toBe(true);
      expect((await r.getShipping(STORE_A))?.handlingHours).toBe(24);
      expect(await r.getShipping(STORE_B)).toBeNull();
    });

    it("notification prefs: defaults then persisted overrides", async () => {
      const r = await fresh();
      expect((await r.getPrefs(STORE_A)).new_order.in_app).toBe(true);
      const next = ss.applyPrefUpdate(await r.getPrefs(STORE_A), { new_order: { sms: true }, marketing_tips: { in_app: false } });
      await r.savePrefs(STORE_A, next, USER_1, 1_700_000_000_000);
      const got = await r.getPrefs(STORE_A);
      expect(got.new_order.sms).toBe(true);
      expect(got.marketing_tips.in_app).toBe(false);
      expect((await r.getPrefs(STORE_B)).new_order.sms).toBe(false);
    });

    it("invites: single pending per phone, single-use close, token lookup", async () => {
      const r = await fresh();
      const h1 = "a".repeat(64);
      const h2 = "b".repeat(64);
      expect(await r.insertInvite(invite(1, "p1", h1))).toBe("ok");
      expect(await r.insertInvite(invite(2, "p1", h2))).toBe("duplicate_pending");
      expect(await r.countPendingInvites(STORE_A, 1_700_000_000_000)).toBe(1);
      expect((await r.getInviteByTokenHash(h1))?.id).toBe(U(1));
      expect(await r.getInviteByTokenHash(h2)).toBeNull();
      expect(await r.getInvite(STORE_B, U(1))).toBeNull();
      expect(await r.closeInvite(U(1), "ACCEPTED", USER_1, 1_700_000_001_000)).toBe(true);
      expect(await r.closeInvite(U(1), "DECLINED", USER_1, 1_700_000_002_000)).toBe(false);
      expect((await r.getInvite(STORE_A, U(1)))?.status).toBe("ACCEPTED");
      expect(await r.insertInvite(invite(3, "p1", "c".repeat(64)))).toBe("ok");
      expect((await r.listInvites(STORE_A)).map((i) => i.id)).toEqual([U(3), U(1)]);
    });

    it("eta: absent then saved, status only", async () => {
      const r = await fresh();
      expect(await r.getEta(STORE_A)).toBeNull();
      await r.saveEta({ storeId: STORE_A, status: "pending_verification", failureCode: null, requestedAtMs: 1_700_000_000_000, lastCheckedAtMs: null, lastVerifiedAtMs: null }, USER_1, 1_700_000_000_000);
      await r.saveEta({ storeId: STORE_A, status: "verified", failureCode: null, requestedAtMs: 1_700_000_000_000, lastCheckedAtMs: 1_700_000_001_000, lastVerifiedAtMs: 1_700_000_001_000 }, USER_1, 1_700_000_001_000);
      expect(await r.getEta(STORE_A)).toMatchObject({ status: "verified", lastVerifiedAtMs: 1_700_000_001_000 });
    });

    it("events: append and list newest first per area and store", async () => {
      const r = await fresh();
      for (const [n, area, at] of [[1, "team", 1], [2, "team", 2], [3, "eta", 3]] as const) {
        await r.addEvent({ id: U(n), storeId: STORE_A, area, kind: "x.y", actorId: USER_1, occurredAtMs: 1_700_000_000_000 + at * 1000, detail: { n } });
      }
      expect((await r.listEvents(STORE_A, "team", 10)).map((e) => e.id)).toEqual([U(2), U(1)]);
      expect(await r.listEvents(STORE_B, "team", 10)).toEqual([]);
    });
  });
}
