import { MediaError } from "./errors.js";
import type { AvScanPort, AvScanResult } from "./ports.js";

/**
 * Local-development scanner. Marks everything clean ONLY when MEDIA_AV_SCAN=disabled-local; otherwise throws, so a
 * deployment that forgot to wire a real scanner never publishes an upload (fail closed).
 */
export class NoopAvScanner implements AvScanPort {
  constructor(private readonly env: { readonly MEDIA_AV_SCAN?: string | undefined } = process.env) {}
  scan(): Promise<AvScanResult> {
    if (this.env.MEDIA_AV_SCAN !== "disabled-local") return Promise.reject(new MediaError("av_unavailable", "no antivirus scanner configured"));
    return Promise.resolve({ clean: true });
  }
}
