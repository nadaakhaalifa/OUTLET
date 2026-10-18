import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../domain/machine";
import type { ProductMediaJob, ProductMediaStore } from "../domain/ports";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = "00000000-0000-4000-a000-000000000001";
const B = "00000000-0000-4000-a000-000000000002";

export const job = (n: number, o: Partial<ProductMediaJob> = {}): ProductMediaJob => ({
  id: U(n),
  storeId: A,
  createdBy: U(900),
  originalRef: `product-media/2026/10/${U(n)}`,
  contentType: "image/png",
  sizeBytes: 1234,
  status: "PENDING",
  decision: "none",
  requestedModel: null,
  modelId: null,
  modelVersion: null,
  qualityScore: null,
  qualityReasons: [],
  pngRef: null,
  whiteJpgRef: null,
  shadowRef: null,
  latencyMs: null,
  errorCode: null,
  attempts: 0,
  attachedProductId: null,
  promotedImageRef: null,
  promotedCutoutRef: null,
  currentVersion: 0,
  editCount: 0,
  promotedVersion: 0,
  backgroundRenderRef: null,
  version: 1,
  createdAtMs: Date.UTC(2026, 9, 12, 10, n),
  updatedAtMs: Date.UTC(2026, 9, 12, 10, n),
  ...o,
});

export function describeProductMediaStoreContract(name: string, fresh: () => Promise<{ store: ProductMediaStore }>): void {
  describe(`ProductMediaStore contract: ${name}`, () => {
    it("inserts once per (store, original) and reads back every field", async () => {
      const { store } = await fresh();
      expect(await store.insertJob(job(1))).toBe("created");
      expect(await store.insertJob(job(1, { id: U(99) }))).toBe("duplicate");
      expect(await store.insertJob(job(1, { id: U(98), storeId: B }))).toBe("created");
      expect(await store.getJob(U(1))).toEqual(job(1));
      expect(await store.getJob(U(404))).toBeNull();
    });

    it("compare-and-sets on version and enforces the state machine", async () => {
      const { store } = await fresh();
      await store.insertJob(job(2));
      const t = Date.UTC(2026, 9, 12, 11);
      const p = await store.update(U(2), 1, { status: "PROCESSING", attempts: 1, updatedAtMs: t });
      expect(p).toMatchObject({ status: "PROCESSING", attempts: 1, version: 2 });
      expect(await store.update(U(2), 1, { status: "FAILED", updatedAtMs: t })).toBeNull();
      const done = await store.update(U(2), 2, {
        status: "READY",
        modelId: "u2netp",
        modelVersion: "rembg-2.0.57+u2netp",
        qualityScore: 91,
        qualityReasons: ["slightly_soft_edges"],
        pngRef: "product-media-derived/2026/10/a",
        whiteJpgRef: "product-media-derived/2026/10/b",
        shadowRef: null,
        latencyMs: 812,
        updatedAtMs: t + 1,
      });
      expect(done).toMatchObject({ status: "READY", qualityScore: 91, qualityReasons: ["slightly_soft_edges"], version: 3, latencyMs: 812 });
      await expect(store.update(U(2), 3, { status: "FAILED", updatedAtMs: t + 2 })).rejects.toBeInstanceOf(InvalidTransitionError);
      const again = await store.update(U(2), 3, { status: "PENDING", decision: "none", requestedModel: "u2net", pngRef: null, whiteJpgRef: null, qualityScore: null, updatedAtMs: t + 3 });
      expect(again).toMatchObject({ status: "PENDING", requestedModel: "u2net", pngRef: null });
    });

    it("lists newest first, per store, bounded", async () => {
      const { store } = await fresh();
      for (const n of [3, 4, 5]) await store.insertJob(job(n));
      await store.insertJob(job(6, { storeId: B }));
      const l = await store.listByStore(A, 2);
      expect(l.map((j) => j.id)).toEqual([U(5), U(4)]);
      expect((await store.listByStore(B, 10)).map((j) => j.id)).toEqual([U(6)]);
    });

    it("claims an attachment compare-and-set: free or same product wins, another product or store loses", async () => {
      const { store } = await fresh();
      const P1 = U(901);
      const P2 = U(902);
      await store.insertJob(job(7));
      expect(await store.claimAttachment(U(7), B, P1)).toBeNull(); // other store
      expect(await store.claimAttachment(U(404), A, P1)).toBeNull();
      const results = await Promise.all([store.claimAttachment(U(7), A, P1), store.claimAttachment(U(7), A, P2)]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const winner = results.find((r) => r !== null)?.attachedProductId as string;
      expect(await store.claimAttachment(U(7), A, winner)).toMatchObject({ attachedProductId: winner }); // idempotent
      const loser = winner === P1 ? P2 : P1;
      await store.releaseAttachment(U(7), A, loser); // not the owner: no effect
      expect((await store.getJob(U(7)))?.attachedProductId).toBe(winner);
      await store.releaseAttachment(U(7), A, winner);
      expect((await store.getJob(U(7)))?.attachedProductId).toBeNull();
      expect((await store.claimAttachment(U(7), A, loser))?.attachedProductId).toBe(loser);
    });

    it("records the promoted keys once: the first writer wins", async () => {
      const { store } = await fresh();
      await store.insertJob(job(8));
      const first = await store.setPromoted(U(8), { image: "catalog/2026/10/img-first", cutout: "catalog/2026/10/cut-first" });
      expect(first).toMatchObject({ promotedImageRef: "catalog/2026/10/img-first", promotedCutoutRef: "catalog/2026/10/cut-first" });
      const second = await store.setPromoted(U(8), { image: "catalog/2026/10/img-second", cutout: null });
      expect(second).toMatchObject({ promotedImageRef: "catalog/2026/10/img-first", promotedCutoutRef: "catalog/2026/10/cut-first" });
      expect(await store.setPromoted(U(404), { image: "catalog/2026/10/x-img", cutout: null })).toBeNull();
    });

    it("takes quota atomically up to the limit, per store and day", async () => {
      const { store } = await fresh();
      expect(await Promise.all([1, 2, 3, 4].map(() => store.consumeQuota(A, "2026-10-12", 3)))).toEqual([true, true, true, false]);
      expect(await store.consumeQuota(B, "2026-10-12", 3)).toBe(true);
      expect(await store.consumeQuota(A, "2026-10-13", 3)).toBe(true);
    });
  });
}
