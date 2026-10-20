import type { AttributeSuggestion, ImageMime, IssuedUpload, ScanState, VisionAttributePort, WardrobeImageStorePort } from "../domain/ports";

/** Production default until a bucket exists: fails closed (503 storage_unconfigured), stores nothing. */
export class UnconfiguredWardrobeImages implements WardrobeImageStorePort {
  readonly configured = false;
  async issue(): Promise<IssuedUpload> {
    throw new Error("wardrobe image store not configured");
  }
  async owns(): Promise<boolean> {
    return false;
  }
  async scanState(): Promise<ScanState | null> {
    return null;
  }
  async read(): Promise<Uint8Array | null> {
    return null;
  }
  async signGet(): Promise<null> {
    return null;
  }
  async delete(): Promise<void> {
    /* nothing was stored */
  }
}

/** Production default: no vision vendor is contracted (VR-P3-13). Suggestions answer 503. */
export class UnconfiguredVision implements VisionAttributePort {
  readonly configured = false;
  readonly residency = "in_region" as const;
  async suggest(_input: { readonly image: Uint8Array; readonly contentType: ImageMime }): Promise<AttributeSuggestion | null> {
    throw new Error("wardrobe vision not configured");
  }
}
