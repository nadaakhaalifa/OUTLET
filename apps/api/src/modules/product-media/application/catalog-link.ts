import type { ProductMediaBlobPort, ProductMediaStore } from "../domain/ports";

/**
 * Links a seller's background-removal job to a catalog product image. The catalog module owns the product
 * record and calls this port (bound under the string token "catalog.ImageJobs"); this module never imports
 * the catalog.
 *
 *   accepted      -> default image = white-background JPG, cutout = transparent PNG
 *   use_original  -> default image = the (scanned, EXIF-stripped) original, no cutout
 *
 * The chosen private object is copied once to the catalog image purpose (`catalog/yyyy/mm/uuid`) so the
 * product keeps working when the job's own objects are re-run or erased. The copies stay private in the
 * bucket: shoppers only ever receive short-lived signed links, and only for an active product.
 */
export interface LinkedProductImage {
  readonly jobId: string;
  /** Catalog-purpose object key of the default image. */
  readonly imageRef: string;
  /** Catalog-purpose object key of the transparent PNG, only for an accepted cutout. */
  readonly cutoutRef: string | null;
  /** True when this call attached the job (false when it was already attached to this product). */
  readonly newlyClaimed: boolean;
}

export type ClaimImageResult =
  | { readonly kind: "ok"; readonly image: LinkedProductImage }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_decided" }
  | { readonly kind: "attached_elsewhere" }
  | { readonly kind: "storage_unavailable" };

export class ProductImageLinker {
  constructor(
    private readonly store: ProductMediaStore,
    private readonly blobs: ProductMediaBlobPort,
  ) {}

  async claim(storeId: string, productId: string, jobId: string): Promise<ClaimImageResult> {
    const job = await this.store.getJob(jobId);
    // Another store's job is indistinguishable from a missing one (BOLA).
    if (job === null || job.storeId !== storeId) return { kind: "not_found" };
    const accepted = job.decision === "accepted" && job.pngRef !== null && job.whiteJpgRef !== null;
    if (!accepted && job.decision !== "use_original") return { kind: "not_decided" };
    if (job.attachedProductId !== null && job.attachedProductId !== productId) return { kind: "attached_elsewhere" };
    if (!this.blobs.configured) return { kind: "storage_unavailable" };

    const newlyClaimed = job.attachedProductId === null;
    const claimed = await this.store.claimAttachment(jobId, storeId, productId);
    if (claimed === null) return { kind: "attached_elsewhere" }; // lost a concurrent claim
    const undo = async (): Promise<void> => {
      if (newlyClaimed) await this.store.releaseAttachment(jobId, storeId, productId);
    };

    let current = claimed;
    if (current.promotedImageRef === null) {
      const copies: string[] = [];
      try {
        const image = await this.blobs.promote({ storeId, key: accepted ? (job.whiteJpgRef as string) : job.originalRef });
        copies.push(image);
        const cutout = accepted ? await this.blobs.promote({ storeId, key: job.pngRef as string }) : null;
        if (cutout !== null) copies.push(cutout);
        const stored = await this.store.setPromoted(jobId, { image, cutout });
        if (stored === null) throw new Error("job vanished");
        current = stored;
        if (stored.promotedImageRef !== image) {
          // A concurrent claim promoted first: drop our duplicate copies and use the stored keys.
          await Promise.allSettled(copies.map((k) => this.blobs.delete(k)));
        }
      } catch {
        await Promise.allSettled(copies.map((k) => this.blobs.delete(k)));
        await undo();
        return { kind: "storage_unavailable" };
      }
    }
    // The cutout was edited after it was promoted: copy the current version again (superseded copies are left to the
    // retention sweep because the product row may still reference them until this save completes).
    if (accepted && current.promotedImageRef !== null && current.currentVersion > 0 && current.promotedVersion !== current.currentVersion) {
      const copies: string[] = [];
      try {
        const image = await this.blobs.promote({ storeId, key: current.whiteJpgRef as string });
        copies.push(image);
        const cutout = await this.blobs.promote({ storeId, key: current.pngRef as string });
        copies.push(cutout);
        const swapped = await this.store.replacePromoted(jobId, current.promotedImageRef, { image, cutout }, current.currentVersion);
        if (swapped === null) {
          await Promise.allSettled(copies.map((k) => this.blobs.delete(k)));
          const again = await this.store.getJob(jobId);
          if (again === null) throw new Error("job vanished");
          current = again;
        } else {
          current = swapped;
        }
      } catch {
        await Promise.allSettled(copies.map((k) => this.blobs.delete(k)));
        await undo();
        return { kind: "storage_unavailable" };
      }
    }
    if (current.promotedImageRef === null) {
      await undo();
      return { kind: "storage_unavailable" };
    }
    return { kind: "ok", image: { jobId, imageRef: current.promotedImageRef, cutoutRef: accepted ? current.promotedCutoutRef : null, newlyClaimed } };
  }

  /** Frees the jobs a product no longer references. Idempotent; a job attached elsewhere is left alone. */
  async release(storeId: string, productId: string, jobIds: readonly string[]): Promise<void> {
    for (const id of jobIds) await this.store.releaseAttachment(id, storeId, productId);
  }
}
