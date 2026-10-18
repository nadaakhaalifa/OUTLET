import { isComplete, mergeAttributes, type PartialAttributes } from "../domain/attributes";
import type { ImageMime, IssuedUpload, Page, UploadRecord, WardrobeEvent, WardrobeItem } from "../domain/ports";
import { FLAG_WARDROBE, FLAG_WARDROBE_VISION, flagOn, type ItemView, type WardrobeDeps } from "./shared";

export const viewOf = (item: WardrobeItem): ItemView => ({
  item,
  complete: isComplete(item.attributes),
  needsReview: item.attributesSource === "vision",
});

/** Pending photos are re-checked against the scanner on read; a verdict is persisted. */
async function refreshed(d: WardrobeDeps, item: WardrobeItem): Promise<WardrobeItem> {
  if (item.imageRef === null || item.imageState !== "pending_scan" || !d.images.configured) return item;
  let state: Awaited<ReturnType<typeof d.images.scanState>>;
  try {
    state = await d.images.scanState(item.imageRef);
  } catch {
    return item;
  }
  if (state === null || state === "pending_scan") return item;
  const now = d.clock.nowMs();
  await d.store.setImageState(item.id, state, now);
  return { ...item, imageState: state, updatedAtMs: now };
}

export type GateOutcome = { readonly kind: "disabled" } | { readonly kind: "consent_required" };

/** Writes and processing need the kill switch on and the `personalization` consent (ADR-0043). */
export async function gate(d: WardrobeDeps, userId: string): Promise<GateOutcome | null> {
  if (!(await flagOn(d.flags, FLAG_WARDROBE))) return { kind: "disabled" };
  if (!(await d.consent.personalizationGranted(userId))) return { kind: "consent_required" };
  return null;
}

// ---- uploads -------------------------------------------------------------------------------------

export type IssueUploadOutcome =
  | { readonly kind: "ok"; readonly upload: IssuedUpload }
  | GateOutcome
  | { readonly kind: "storage_unconfigured" }
  | { readonly kind: "too_many_pending" };

export class IssueWardrobeUpload {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly contentType: ImageMime; readonly sizeBytes: number }): Promise<IssueUploadOutcome> {
    const d = this.d;
    const blocked = await gate(d, input.userId);
    if (blocked !== null) return blocked;
    if (!d.images.configured) return { kind: "storage_unconfigured" };
    if (input.sizeBytes < 1 || input.sizeBytes > d.cfg.maxImageBytes) throw new RangeError("size out of range");
    const issued = await d.images.issue({ ownerId: input.userId, contentType: input.contentType, sizeBytes: input.sizeBytes });
    const rec: UploadRecord = {
      id: d.ids.uuidV7(),
      userId: input.userId,
      uploadId: issued.uploadId,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      issuedAtMs: d.clock.nowMs(),
      consumedAtMs: null,
    };
    const stored = await d.store.insertUpload(rec, d.cfg.maxPendingUploads);
    if (stored === "quota") {
      // The signed URL is never returned, so nothing can be written to it; drop the (empty) key.
      await d.images.delete(issued.uploadId).catch(() => undefined);
      return { kind: "too_many_pending" };
    }
    return { kind: "ok", upload: issued };
  }
}

// ---- items ---------------------------------------------------------------------------------------

export type CreateItemOutcome =
  | { readonly kind: "ok"; readonly view: ItemView }
  | GateOutcome
  | { readonly kind: "limit_reached" }
  | { readonly kind: "upload_unavailable" }
  | { readonly kind: "upload_rejected" };

export class CreateWardrobeItem {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly uploadId: string | null; readonly attributes: PartialAttributes }): Promise<CreateItemOutcome> {
    const d = this.d;
    const blocked = await gate(d, input.userId);
    if (blocked !== null) return blocked;
    let imageRef: string | null = null;
    let imageState: WardrobeItem["imageState"] = "none";
    if (input.uploadId !== null) {
      const up = await d.store.getUpload(input.userId, input.uploadId);
      if (up === null || up.consumedAtMs !== null || !d.images.configured || !(await d.images.owns(input.userId, input.uploadId))) {
        return { kind: "upload_unavailable" };
      }
      const state = await d.images.scanState(input.uploadId);
      if (state === null) return { kind: "upload_unavailable" };
      if (state === "infected") return { kind: "upload_rejected" };
      imageRef = input.uploadId;
      imageState = state;
    }
    const now = d.clock.nowMs();
    const item: WardrobeItem = {
      id: d.ids.uuidV7(),
      userId: input.userId,
      imageRef,
      imageState,
      attributes: mergeAttributes({}, input.attributes),
      attributesSource: "user",
      visionModelVersion: null,
      version: 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const ev: WardrobeEvent = { type: "wardrobe.item_added", userId: input.userId, itemId: item.id, hasPhoto: imageRef !== null };
    const r = await d.store.insertItem(item, input.uploadId, d.cfg.maxItems, [ev]);
    if (r === "limit_reached") return { kind: "limit_reached" };
    if (r === "upload_unavailable") return { kind: "upload_unavailable" };
    return { kind: "ok", view: viewOf(item) };
  }
}

export class ListWardrobeItems {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly limit: number; readonly cursor: string | null }): Promise<Page<ItemView>> {
    const page = await this.d.store.list(input.userId, input.limit, input.cursor);
    const items = await Promise.all(page.items.map((i) => refreshed(this.d, i)));
    return { items: items.map(viewOf), nextCursor: page.nextCursor };
  }
}

export class GetWardrobeItem {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly itemId: string }): Promise<ItemView | null> {
    const i = await this.d.store.getItem(input.itemId);
    if (i === null || i.userId !== input.userId) return null;
    return viewOf(await refreshed(this.d, i));
  }
}

export type UpdateItemOutcome = { readonly kind: "ok"; readonly view: ItemView } | { readonly kind: "not_found" } | { readonly kind: "conflict" };

/** The shopper's edit always wins: it becomes the `user` source and clears any pending vision review. */
export class UpdateWardrobeAttributes {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: {
    readonly userId: string;
    readonly itemId: string;
    readonly patch: PartialAttributes;
    readonly expectedVersion: number | null;
  }): Promise<UpdateItemOutcome> {
    const d = this.d;
    const cur = await d.store.getItem(input.itemId);
    if (cur === null || cur.userId !== input.userId) return { kind: "not_found" };
    const merged = mergeAttributes(cur.attributes, input.patch);
    const ev: WardrobeEvent = { type: "wardrobe.item_updated", userId: input.userId, itemId: cur.id, source: "user" };
    const r = await d.store.updateAttributes(cur.id, input.userId, input.expectedVersion ?? cur.version, merged, "user", null, d.clock.nowMs(), [ev]);
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "conflict" };
    return { kind: "ok", view: viewOf(r.item) };
  }
}

export type SuggestOutcome =
  | { readonly kind: "ok"; readonly view: ItemView }
  | GateOutcome
  | { readonly kind: "not_found" }
  | { readonly kind: "vision_disabled" }
  | { readonly kind: "vision_unconfigured" }
  | { readonly kind: "no_photo" }
  | { readonly kind: "photo_not_ready" }
  | { readonly kind: "already_edited" }
  | { readonly kind: "no_suggestion" }
  | { readonly kind: "external_consent_required" };

/**
 * Applies a vision suggestion only to an item the shopper has not edited. Fails closed when the
 * vision port is Unconfigured (production default) or the kill switch is off. Photo bytes are read
 * only after the scanner marked the object clean.
 */
export class SuggestWardrobeAttributes {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly itemId: string }): Promise<SuggestOutcome> {
    const d = this.d;
    const blocked = await gate(d, input.userId);
    if (blocked !== null) return blocked;
    const cur = await d.store.getItem(input.itemId);
    if (cur === null || cur.userId !== input.userId) return { kind: "not_found" };
    if (!(await flagOn(d.flags, FLAG_WARDROBE_VISION))) return { kind: "vision_disabled" };
    if (!d.vision.configured) return { kind: "vision_unconfigured" };
    if (d.vision.residency === "external" && !(await d.consent.crossBorderMlGranted(input.userId))) {
      return { kind: "external_consent_required" };
    }
    const item = await refreshed(d, cur);
    if (item.imageRef === null) return { kind: "no_photo" };
    if (item.imageState !== "clean") return { kind: "photo_not_ready" };
    if (item.attributesSource === "user" && Object.keys(item.attributes).length > 0) return { kind: "already_edited" };
    const bytes = await d.images.read(item.imageRef);
    const up = await d.store.getUpload(input.userId, item.imageRef);
    if (bytes === null || up === null) return { kind: "photo_not_ready" };
    const s = await d.vision.suggest({ image: bytes, contentType: up.contentType });
    if (s === null) return { kind: "no_suggestion" };
    const ev: WardrobeEvent = { type: "wardrobe.item_updated", userId: input.userId, itemId: item.id, source: "vision" };
    const r = await d.store.updateAttributes(item.id, input.userId, item.version, s.attributes, "vision", s.modelVersion, d.clock.nowMs(), [ev]);
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "already_edited" };
    return { kind: "ok", view: viewOf(r.item) };
  }
}

export class DeleteWardrobeItem {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly itemId: string }): Promise<"deleted" | "not_found"> {
    const d = this.d;
    const ev: WardrobeEvent = { type: "wardrobe.item_deleted", userId: input.userId, itemId: input.itemId };
    const r = await d.store.deleteItem(input.itemId, input.userId, [ev]);
    if (!r.deleted) return "not_found";
    // Immediate erasure of the photo; the graveyard trigger and the retention job are the safety net.
    if (r.imageRef !== null && d.images.configured) await d.images.delete(r.imageRef).catch(() => undefined);
    return "deleted";
  }
}

export class ClearWardrobe {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string }): Promise<{ readonly count: number }> {
    const r = await this.d.store.clear(input.userId);
    if (this.d.images.configured) {
      for (const ref of r.imageRefs) await this.d.images.delete(ref).catch(() => undefined);
    }
    return { count: r.count };
  }
}

export class GetWardrobeImageUrl {
  constructor(private readonly d: WardrobeDeps) {}
  async execute(input: { readonly userId: string; readonly itemId: string }): Promise<
    | { readonly kind: "ok"; readonly url: string; readonly expiresAtMs: number }
    | { readonly kind: "not_found" }
    | { readonly kind: "not_ready" }
    | { readonly kind: "storage_unconfigured" }
  > {
    const d = this.d;
    const cur = await d.store.getItem(input.itemId);
    if (cur === null || cur.userId !== input.userId || cur.imageRef === null) return { kind: "not_found" };
    if (!d.images.configured) return { kind: "storage_unconfigured" };
    const item = await refreshed(d, cur);
    if (item.imageState !== "clean") return { kind: "not_ready" };
    const u = await d.images.signGet(item.imageRef ?? "", d.cfg.signedGetTtlSeconds);
    return u === null ? { kind: "not_ready" } : { kind: "ok", url: u.url, expiresAtMs: u.expiresAtMs };
  }
}
