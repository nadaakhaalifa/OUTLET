import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalKeyFieldCipher } from "../../auth";
import type { AddressStore } from "../ports";
import { AddressService, type AddressInput } from "../service";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const PIN = { lat: 30.0444, lng: 31.2357 };

export const input = (over: Partial<AddressInput> = {}): AddressInput => ({
  recipientName: "Nada Khalifa",
  phone: "01001234567",
  governorateCode: "EG-C",
  cityDistrictCode: "maadi",
  street: "Road 9",
  building: "4",
  floor: "2",
  apartment: "5",
  landmark: "Opposite the metro",
  mapPin: PIN,
  ...over,
});

export interface StoreContext {
  readonly store: AddressStore;
  ensureUser(id: string): Promise<void>;
  clock: { ms: number };
}

/** Same service-level behaviour on every store adapter. */
export function describeAddressContract(name: string, fresh: () => Promise<StoreContext>): void {
  const make = async () => {
    const c = await fresh();
    let n = 0;
    const svc = new AddressService(
      c.store,
      new LocalKeyFieldCipher(randomBytes(32)),
      { nowMs: () => c.clock.ms },
      { uuidV7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`, hex: (b: number) => "ab".repeat(b) },
      () => randomBytes(16).toString("base64url"),
    );
    return { ...c, svc };
  };
  const created = async (svc: AddressService, user: string, over: Partial<AddressInput> = {}) => {
    const r = await svc.create(user, input(over));
    if (r.kind !== "ok") throw new Error(`create failed: ${r.kind}`);
    return r.address;
  };

  describe(`addresses contract: ${name}`, () => {
    it("the first address becomes the default; later ones do not", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      c.clock.ms += 10;
      const b = await created(c.svc, U(1), { building: "5" });
      expect([a.isDefault, b.isDefault]).toEqual([true, false]);
    });

    it("round-trips encrypted fields and derives coverage, COD flag and quality", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      expect(a).toMatchObject({ recipientName: "Nada Khalifa", phoneE164: "+201001234567", street: "Road 9", landmark: "Opposite the metro", courierCoverage: "covered", codEligible: true, qualityScore: 100 });
      expect(a.mapPin).toEqual(PIN);
      const got = await c.svc.get(U(1), a.id);
      expect(got).toEqual(a);
    });

    it("no landmark or no pin => not COD eligible; uncovered governorate is flagged, not guessed", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      expect((await created(c.svc, U(1), { landmark: undefined })).codEligible).toBe(false);
      expect((await created(c.svc, U(1), { building: "6", mapPin: undefined })).codEligible).toBe(false);
      const far = await created(c.svc, U(1), { governorateCode: "EG-WAD", cityDistrictCode: "kharga" });
      expect(far).toMatchObject({ courierCoverage: "not_covered", codEligible: false });
    });

    it("rejects bad phone, unknown governorate or city, pin outside Egypt, short fields", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const r = await c.svc.create(U(1), input({ phone: "123", governorateCode: "EG-XX", mapPin: { lat: 10, lng: 10 }, street: "a" }));
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.errors.map((e) => e.field).sort()).toEqual(["governorate_code", "map_pin", "phone_e164", "street"]);
      const r2 = await c.svc.create(U(1), input({ cityDistrictCode: "atlantis" }));
      expect(r2).toMatchObject({ kind: "invalid", errors: [{ field: "city_district_code", code: "unknown_city" }] });
    });

    it("caps at 10 addresses and refuses duplicates (blind index)", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      for (let i = 1; i <= 10; i += 1) {
        c.clock.ms += 1;
        await created(c.svc, U(1), { building: String(i) });
      }
      expect((await c.svc.create(U(1), input({ building: "11" }))).kind).toBe("limit_reached");
      await c.ensureUser(U(2));
      await created(c.svc, U(2));
      expect((await c.svc.create(U(2), input({ street: "  ROAD   9 " }))).kind).toBe("duplicate");
      // the same address under a different user is fine
      await c.ensureUser(U(3));
      await created(c.svc, U(3));
    });

    it("concurrent creates keep exactly one default and never exceed the cap", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => c.svc.create(U(1), input({ building: String(100 + i) }))));
      expect(rs.filter((r) => r.kind === "ok")).toHaveLength(10);
      expect(rs.filter((r) => r.kind === "limit_reached")).toHaveLength(4);
      const all = await c.svc.list(U(1), null, 50);
      expect(all.filter((a) => a.isDefault)).toHaveLength(1);
    });

    it("setDefault moves the single default; deleting the default promotes the most recent", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      c.clock.ms += 10;
      const b = await created(c.svc, U(1), { building: "5" });
      c.clock.ms += 10;
      const d = await created(c.svc, U(1), { building: "6" });
      expect((await c.svc.setDefault(U(1), b.id))?.isDefault).toBe(true);
      expect((await c.svc.list(U(1), null, 10)).filter((x) => x.isDefault).map((x) => x.id)).toEqual([b.id]);
      expect(await c.svc.remove(U(1), b.id)).toBe(true);
      expect((await c.svc.list(U(1), null, 10)).filter((x) => x.isDefault).map((x) => x.id)).toEqual([d.id]);
      expect(await c.svc.remove(U(1), a.id)).toBe(true); // non-default: default unchanged
      expect((await c.svc.get(U(1), d.id))?.isDefault).toBe(true);
      expect(await c.svc.remove(U(1), d.id)).toBe(true);
      expect(await c.svc.list(U(1), null, 10)).toEqual([]);
      expect(await c.svc.remove(U(1), d.id)).toBe(false);
    });

    it("owner isolation: another user's id is simply absent", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      const a = await created(c.svc, U(1));
      expect(await c.svc.get(U(2), a.id)).toBeNull();
      expect(await c.svc.setDefault(U(2), a.id)).toBeNull();
      expect(await c.svc.remove(U(2), a.id)).toBe(false);
      expect((await c.svc.update(U(2), a.id, { street: "Hacked street" })).kind).toBe("not_found");
      expect((await c.svc.get(U(1), a.id))?.street).toBe("Road 9");
    });

    it("patch recomputes derived fields, clears optionals with null and re-validates", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      const r = await c.svc.update(U(1), a.id, { landmark: null, floor: null });
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") {
        expect(r.address.landmark).toBeUndefined();
        expect(r.address.floor).toBeUndefined();
        expect(r.address.codEligible).toBe(false);
        expect(r.address.qualityScore).toBe(100 - 15 - 5);
      }
      const bad = await c.svc.update(U(1), a.id, { governorateCode: "EG-GZ" });
      expect(bad.kind).toBe("invalid"); // maadi is not a Giza city
      const moved = await c.svc.update(U(1), a.id, { governorateCode: "EG-GZ", cityDistrictCode: "dokki", phone: "+20 111 234 5678" });
      expect(moved).toMatchObject({ kind: "ok", address: { governorateCode: "EG-GZ", phoneE164: "+201112345678" } });
      c.clock.ms += 5;
      const b = await created(c.svc, U(1), { building: "9" });
      expect((await c.svc.update(U(1), b.id, { governorateCode: "EG-GZ", cityDistrictCode: "dokki", building: "4", floor: null })).kind).toBe("duplicate");
    });

    it("keyset pages newest first without gaps or repeats", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const ids: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        c.clock.ms += 1;
        ids.unshift((await created(c.svc, U(1), { building: String(i) })).id);
      }
      const p1 = await c.svc.list(U(1), null, 2);
      const p2 = await c.svc.list(U(1), { createdAtMs: p1[1]?.createdAtMs ?? 0, id: p1[1]?.id ?? "" }, 2);
      const p3 = await c.svc.list(U(1), { createdAtMs: p2[1]?.createdAtMs ?? 0, id: p2[1]?.id ?? "" }, 2);
      expect([...p1, ...p2, ...p3].map((a) => a.id)).toEqual(ids);
    });

    it("snapshots are immutable copies: edits and deletes of the address never change them; replay is idempotent", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      const s1 = await c.svc.snapshotForOrder(U(1), "og-1", a.id);
      expect(s1).toMatchObject({ kind: "ok", snapshot: { gift: false, governorateCode: "EG-C", codEligible: true } });
      if (s1.kind !== "ok") return;
      await c.svc.update(U(1), a.id, { street: "Completely different street" });
      await c.svc.remove(U(1), a.id);
      const courier = await c.svc.courierSnapshot(s1.snapshot.id);
      expect(courier).toMatchObject({ street: "Road 9", recipientName: "Nada Khalifa", phoneE164: "+201001234567", gift: false });
      const replay = await c.svc.snapshotForOrder(U(1), "og-1", a.id);
      expect(replay.kind).toBe("not_found"); // address gone: but the stored snapshot is still the same one
      expect((await c.svc.courierSnapshot(s1.snapshot.id))?.street).toBe("Road 9");
    });

    it("snapshot of another user's address is not_found; uncovered is not_covered", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      const a = await created(c.svc, U(1));
      expect((await c.svc.snapshotForOrder(U(2), "og-x", a.id)).kind).toBe("not_found");
      const far = await created(c.svc, U(1), { governorateCode: "EG-WAD", cityDistrictCode: "kharga" });
      expect((await c.svc.snapshotForOrder(U(1), "og-y", far.id)).kind).toBe("not_covered");
    });

    it("a replayed snapshot for the same order returns the first one", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      const s1 = await c.svc.snapshotForOrder(U(1), "og-1", a.id);
      const s2 = await c.svc.snapshotForOrder(U(1), "og-1", a.id);
      expect(s1.kind === "ok" && s2.kind === "ok" && s1.snapshot.id === s2.snapshot.id).toBe(true);
    });

    it("gift token: buyer gets coverage only; the courier snapshot holds the owner's address; never COD", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      const a = await created(c.svc, U(1));
      const t = await c.svc.issueGiftToken(U(1), a.id, 3_600_000);
      expect(t?.token.startsWith("gift_")).toBe(true);
      expect(await c.svc.issueGiftToken(U(2), a.id, 3_600_000)).toBeNull();
      const token = t?.token ?? "";
      expect(await c.svc.giftDestination(token)).toEqual({ governorateCode: "EG-C", courierCoverage: "covered" });
      const s = await c.svc.snapshotForOrder(U(2), "og-gift", token);
      expect(s.kind).toBe("ok");
      if (s.kind !== "ok") return;
      expect(s.snapshot).toMatchObject({ gift: true, codEligible: false });
      expect(JSON.stringify(s)).not.toContain("Road 9");
      expect(await c.svc.courierSnapshot(s.snapshot.id)).toMatchObject({ street: "Road 9", gift: true });
      // revoke and expiry
      expect(await c.svc.revokeGiftToken(U(2), token)).toBe(false);
      expect(await c.svc.revokeGiftToken(U(1), token)).toBe(true);
      expect(await c.svc.giftDestination(token)).toBeNull();
      expect((await c.svc.snapshotForOrder(U(2), "og-gift-2", token)).kind).toBe("not_found");
      const t2 = await c.svc.issueGiftToken(U(1), a.id, 60_000);
      c.clock.ms += 61_000;
      expect(await c.svc.giftDestination(t2?.token ?? "")).toBeNull();
      expect(await c.svc.giftDestination("gift_nonsense")).toBeNull();
    });

    it("coverage listings: 27 governorates, cities for a governorate, unknown is null", async () => {
      const c = await make();
      const g = await c.store.coverage.governorates();
      expect(g).toHaveLength(27);
      expect(g.find((x) => x.code === "EG-C")).toMatchObject({ nameEn: "Cairo", nameAr: "القاهرة", covered: true });
      expect(g.find((x) => x.code === "EG-WAD")?.covered).toBe(false);
      const cities = await c.store.coverage.cities("EG-BA");
      expect(cities?.map((x) => x.code)).toEqual(["hurghada", "el-gouna", "marsa-alam", "safaga"]);
      expect(cities?.find((x) => x.code === "marsa-alam")?.covered).toBe(true); // aramex still covers
      expect(await c.store.coverage.cities("EG-NOPE")).toBeNull();
    });

    it("a store transaction that throws rolls back", async () => {
      const c = await make();
      await c.ensureUser(U(1));
      const a = await created(c.svc, U(1));
      const row = await c.store.find(U(1), a.id);
      await expect(
        c.store.run(U(1), async (tx) => {
          await tx.remove(a.id);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(row).not.toBeNull();
      expect(await c.store.find(U(1), a.id)).not.toBeNull();
    });
  });
}
