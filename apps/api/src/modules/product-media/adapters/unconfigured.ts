import { BackgroundRemovalError, type BackgroundRemovalPort, type IssuedUpload, type ProductMediaBlobPort, type ScanState } from "../domain/ports";

/** Production default: no sidecar is bound. Every call fails closed with provider_not_configured (503). */
export class UnconfiguredBackgroundRemoval implements BackgroundRemovalPort {
  readonly configured = false;
  readonly residency = "in_region" as const;
  async cutout(): Promise<never> {
    throw new BackgroundRemovalError("provider_not_configured", "background removal is not configured");
  }
  async refine(): Promise<never> {
    throw new BackgroundRemovalError("provider_not_configured", "background removal is not configured");
  }
}

/** Production default until a bucket exists: stores nothing. */
export class UnconfiguredProductMediaBlobs implements ProductMediaBlobPort {
  readonly configured = false;
  async issueUpload(): Promise<IssuedUpload> {
    throw new Error("product media storage not configured");
  }
  async owns(): Promise<boolean> {
    return false;
  }
  async scanState(): Promise<ScanState | null> {
    return null;
  }
  async read(): Promise<null> {
    return null;
  }
  async writeDerivative(): Promise<string> {
    throw new Error("product media storage not configured");
  }
  async promote(): Promise<string> {
    throw new Error("product media storage not configured");
  }
  async signGet(): Promise<null> {
    return null;
  }
  async delete(): Promise<void> {
    /* nothing was stored */
  }
}
