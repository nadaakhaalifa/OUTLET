import { describe, expect, it } from "vitest";
import type { UploadRecord, WardrobeEvent, WardrobeItem, WardrobeStore } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const I = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const ATTRS = { category: "top", palette: ["white"], pattern: "solid", formality: 2, seasons: ["all"], material: "cotton", modest: true } as const;

export const item = (n: number, userId: string, over: Partial<WardrobeItem> = {}): WardrobeItem => ({
  id: I(n),
  userId,
  imageRef: null,
  imageState: "none",
  attributes: { ...ATTRS, palette: [...ATTRS.palette], seasons: [...ATTRS.seasons] },
  attributesSource: "user",
  visionModelVersion: null,
  version: 1,
  createdAtMs: T0 + n * 1000,
  updatedAtMs: T0 + n * 1000,
  ...over,
});
export const upload = (n: number, userId: string, over: Partial<UploadRecord> = {}): UploadRecord => ({
  id: I(500 + n),
  userId,
  uploadId: `wardrobe/2026/10/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  contentType: "image/jpeg",
  sizeBytes: 1000,
  issuedAtMs: T0,
  consumedAtMs: null,
  ...over,
});
const ev = (userId: string, itemId: string): WardrobeEvent => ({ type: "wardrobe.item_added", userId, itemId, hasPhoto: false });

export interface ContractEnv {
  readonly store: WardrobeStore;
  ensureUser(id: string): Promise<void>;
  /** Object keys waiting to be erased (graveyard rows or the in-memory equivalent). */
  graveyard(): Promise<readonly string[]>;
  eventTypes(): Promise<readonly string[]>;
}

export function describeWardrobeStoreContract(name: string, fresh: () => Promise<ContractEnv>): void {
  describe(`WardrobeStore contract: ${name}`, () => {
    it("round trips an item with its attributes and lists newest first with a cursor", async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      for (const n of [1, 2, 3]) expect(await c.store.insertItem(item(n, U(1)), null, 10, [ev(U(1), I(n))])).toBe("created");
      expect(await c.store.getItem(I(2))).toEqual(item(2, U(1)));
      const p1 = await c.store.list(U(1), 2, null);
      expect(p1.items.map((i) => i.id)).toEqual([I(3), I(2)]);
      const p2 = await c.store.list(U(1), 2, p1.nextCursor);
      expect(p2.items.map((i) => i.id)).toEqual([I(1)]);
      expect(p2.nextCursor).toBeNull();
      expect((await c.eventTypes()).filter((t) => t === "wardrobe.item_added")).toHaveLength(3);
    });

    it("enforces the item cap and keeps users apart", async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      expect(await c.store.insertItem(item(1, U(1)), null, 1, [])).toBe("created");
      expect(await c.store.insertItem(item(2, U(1)), null, 1, [])).toBe("limit_reached");
      expect(await c.store.insertItem(item(3, U(2)), null, 1, [])).toBe("created");
      expect((await c.store.all(U(2))).map((i) => i.id)).toEqual([I(3)]);
    });

    it("consumes an upload once, only for its owner, and caps pending uploads", async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      const up = upload(1, U(1));
      expect(await c.store.insertUpload(up, 2)).toBe("stored");
      expect(await c.store.getUpload(U(2), up.uploadId)).toBeNull();
      const withPhoto = item(1, U(1), { imageRef: up.uploadId, imageState: "pending_scan" });
      expect(await c.store.insertItem({ ...withPhoto, userId: U(2), id: I(9) }, up.uploadId, 10, [])).toBe("upload_unavailable");
      expect(await c.store.insertItem(withPhoto, up.uploadId, 10, [])).toBe("created");
      expect(await c.store.insertItem(item(2, U(1), { imageRef: up.uploadId, imageState: "pending_scan" }), up.uploadId, 10, [])).toBe("upload_unavailable");
      expect((await c.store.getUpload(U(1), up.uploadId))?.consumedAtMs).not.toBeNull();
      expect(await c.store.insertUpload(upload(2, U(1)), 2)).toBe("stored");
      expect(await c.store.insertUpload(upload(3, U(1)), 2)).toBe("stored");
      expect(await c.store.insertUpload(upload(4, U(1)), 2)).toBe("quota");
    });

    it("updates with compare and set on version and never across users", async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      await c.store.insertItem(item(1, U(1)), null, 10, []);
      const next = { ...ATTRS, palette: ["navy" as const], seasons: ["all" as const] };
      const ok = await c.store.updateAttributes(I(1), U(1), 1, next, "user", null, T0 + 5000, []);
      expect(ok.kind).toBe("updated");
      if (ok.kind === "updated") expect(ok.item).toMatchObject({ version: 2, attributesSource: "user", attributes: { palette: ["navy"] } });
      expect((await c.store.updateAttributes(I(1), U(1), 1, next, "user", null, T0, [])).kind).toBe("conflict");
      expect((await c.store.updateAttributes(I(1), U(2), null, next, "user", null, T0, [])).kind).toBe("not_found");
      expect((await c.store.updateAttributes(I(77), U(1), null, next, "vision", "m-1", T0, [])).kind).toBe("not_found");
    });

    it("records scan verdicts only for items that have a photo", async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      const up = upload(1, U(1));
      await c.store.insertUpload(up, 5);
      await c.store.insertItem(item(1, U(1), { imageRef: up.uploadId, imageState: "pending_scan" }), up.uploadId, 10, []);
      await c.store.insertItem(item(2, U(1)), null, 10, []);
      await c.store.setImageState(I(1), "clean", T0 + 9000);
      await c.store.setImageState(I(2), "clean", T0 + 9000);
      expect((await c.store.getItem(I(1)))?.imageState).toBe("clean");
      expect((await c.store.getItem(I(2)))?.imageState).toBe("none");
    });

    it("deletes an item and queues its photo for erasure; clear removes everything of one user only", async () => {
      const c = await fresh();
      await c.ensureUser(U(1));
      await c.ensureUser(U(2));
      const a = upload(1, U(1));
      const orphan = upload(2, U(1));
      const other = upload(3, U(2));
      for (const u of [a, orphan, other]) await c.store.insertUpload(u, 5);
      await c.store.insertItem(item(1, U(1), { imageRef: a.uploadId, imageState: "clean" }), a.uploadId, 10, []);
      await c.store.insertItem(item(2, U(2), { imageRef: other.uploadId, imageState: "clean" }), other.uploadId, 10, []);
      expect(await c.store.deleteItem(I(1), U(2), [])).toEqual({ deleted: false, imageRef: null });
      expect(await c.store.deleteItem(I(1), U(1), [])).toEqual({ deleted: true, imageRef: a.uploadId });
      expect(await c.graveyard()).toContain(a.uploadId);
      await c.store.insertItem(item(3, U(1)), null, 10, []);
      const r = await c.store.clear(U(1));
      expect(r.count).toBe(1);
      expect(r.imageRefs).toContain(orphan.uploadId);
      expect(await c.graveyard()).toContain(orphan.uploadId);
      expect((await c.store.all(U(1))).length).toBe(0);
      expect((await c.store.all(U(2))).length).toBe(1);
      expect(await c.graveyard()).not.toContain(other.uploadId);
      expect(await c.eventTypes()).toContain("wardrobe.cleared");
    });
  });
}
