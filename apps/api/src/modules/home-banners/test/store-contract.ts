import { describe, expect, it } from "vitest";
import type { HomeBannerStore } from "../domain/ports";
import { H, NOW, banner, sponsored, U } from "./fixtures";

export function describeHomeBannerStoreContract(name: string, fresh: () => Promise<{ store: HomeBannerStore }>): void {
  describe(`HomeBannerStore contract: ${name}`, () => {
    it("round-trips every CTA shape and sponsorship", async () => {
      const { store } = await fresh();
      const rows = [
        banner(1, { cta: { kind: "drop", targetId: "drop_1" }, subtitleAr: "وصف", subtitleEn: "desc", imageKey: "home-banners/2026/10/abc-123", artVariant: null }),
        banner(2, { cta: { kind: "category", targetId: "dresses", priceMin: 10_000n, priceMax: 99_900n } }),
        banner(3, { cta: { kind: "search", query: "linen dress", priceMin: null, priceMax: 150_000n } }),
        sponsored(4, { cta: { kind: "voucher", targetId: "WELCOME-10" } }),
      ];
      for (const r of rows) await store.insert(r);
      for (const r of rows) expect(await store.get(r.id)).toMatchObject({ ...r, updatedAtMs: expect.any(Number) });
      expect(await store.get(U(404))).toBeNull();
    });

    it("compare-and-sets on version and removes", async () => {
      const { store } = await fresh();
      await store.insert(banner(1));
      const next = { ...banner(1), status: "paused" as const, titleAr: "جديد" };
      expect(await store.replace(next, 2)).toBeNull();
      const saved = await store.replace(next, 1);
      expect(saved).toMatchObject({ status: "paused", titleAr: "جديد", version: 2 });
      expect(await store.replace(next, 1)).toBeNull();
      expect(await store.remove(U(1))).toBe(true);
      expect(await store.remove(U(1))).toBe(false);
      expect(await store.get(U(1))).toBeNull();
    });

    it("lists scheduled rows by server window in display order", async () => {
      const { store } = await fresh();
      await store.insert(banner(1, { priority: 10 }));
      await store.insert(banner(2, { priority: 90 }));
      await store.insert(banner(3, { status: "paused" }));
      await store.insert(banner(4, { status: "draft" }));
      await store.insert(banner(5, { startsAtMs: NOW + H, endsAtMs: NOW + 2 * H }));
      await store.insert(banner(6, { startsAtMs: NOW - 2 * H, endsAtMs: NOW }));
      expect((await store.listScheduledAt(NOW, 10)).map((b) => b.id)).toEqual([U(2), U(1)]);
      expect((await store.listScheduledAt(NOW + H, 10)).map((b) => b.id)).toEqual([U(5)]);
      expect((await store.listScheduledAt(NOW, 1)).map((b) => b.id)).toEqual([U(2)]);
      expect((await store.list(10)).length).toBe(6);
    });
  });
}
