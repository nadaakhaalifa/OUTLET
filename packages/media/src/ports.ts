/** S3-compatible object store. Buckets are private; public access is only via derived CDN keys. */
export interface StoragePort {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface AvScanResult {
  readonly clean: boolean;
  readonly signature?: string;
}
/** Antivirus hook. Must throw (not return clean) when it cannot scan: the pipeline fails closed. */
export interface AvScanPort {
  scan(bytes: Uint8Array): Promise<AvScanResult>;
}

/** Produces a time-limited URL for a private object. */
export interface SignerPort {
  sign(key: string, expiresAt: Date): string;
}
