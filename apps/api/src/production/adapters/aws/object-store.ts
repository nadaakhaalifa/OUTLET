import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CatalogObjectStore } from "../../../modules/catalog";
import type { ObjectStorePort } from "../../../modules/privacy";

type SignedUrl = Awaited<ReturnType<ObjectStorePort["signGetUrl"]>>;
import type { BlobDeletePort } from "../../../modules/retention";
import type { EvidencePort } from "../../../modules/returns";
import type { PhotoUploadPort } from "../../../modules/reviews";
import type { ProductMediaBlobPort } from "../../../modules/product-media";
import type { WardrobeImageStorePort } from "../../../modules/wardrobe";
import { callAws, isMissing, probe } from "./errors";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_GET_TTL_SECONDS = 15 * 60;
export const PUT_TTL_SECONDS = 10 * 60;

export type UploadPurpose = "catalog" | "return-evidence" | "review-photo" | "kyc" | "import" | "wardrobe" | "product-media" | "product-media-derived";
export type ScanState = "pending_scan" | "clean" | "infected";

const IMAGES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const ALLOWED: Readonly<Record<UploadPurpose, readonly string[]>> = {
  catalog: IMAGES,
  "return-evidence": IMAGES,
  "review-photo": IMAGES,
  kyc: [...IMAGES, "application/pdf"],
  import: ["text/csv"],
  // Wardrobe photos: no AVIF (the strip and scan pipeline re-encodes only these three).
  wardrobe: ["image/jpeg", "image/png", "image/webp"],
  // Seller product photos (background removal): originals from the signed upload, derivatives written by the server.
  "product-media": ["image/jpeg", "image/png", "image/webp"],
  "product-media-derived": ["image/jpeg", "image/png"],
};
/** Per-purpose size cap. Product originals may be up to 12 MB (spec); every other purpose keeps 10 MB. */
const maxBytesFor = (p: UploadPurpose): number => (p === "product-media" ? 12 * 1024 * 1024 : MAX_UPLOAD_BYTES);
/** `{purpose}/{yyyy}/{mm}/{uuid}`: no user, store, file name or any other personal data in a key. */
const KEY_RE = /^(catalog|return-evidence|review-photo|kyc|import|wardrobe|product-media|product-media-derived)\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXPORT_RE = /^exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.zip$/;

/** Scanner and EXIF/GPS stripper are ports. Without a scanner objects stay `pending_scan` and are never served. */
export interface VirusScanner {
  scan(bytes: Uint8Array): Promise<"clean" | "infected">;
}
export interface MetadataStripper {
  strip(bytes: Uint8Array, contentType: string): Promise<Uint8Array>;
}

export interface S3Settings {
  readonly bucket: string;
  /** SSE-KMS key id; undefined means SSE-S3 (AES256), only when explicitly allowed by config. */
  readonly kmsKeyId: string | undefined;
  readonly probeTimeoutMs?: number;
}

export interface PresignedUpload {
  readonly key: string;
  readonly url: string;
  /** Headers the client MUST send verbatim (they are signed). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

const OWNER = "owner";

/** Content type from magic bytes (the object was validated as one of these by the upload pipeline). */
function sniffImageType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "application/octet-stream";
}

/**
 * S3-compatible private-bucket store. Every write carries SSE; every upload starts `pending_scan`.
 * The ObjectStorePort / BlobDeletePort / CatalogObjectStore / EvidencePort / PhotoUploadPort views
 * are thin facades over this one class. An upload id IS the object key (see ADR-0032).
 */
export class S3ObjectStore {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly s: S3Settings,
    private readonly presignClient: S3Client | undefined,
    private readonly scanner?: VirusScanner,
    private readonly stripper?: MetadataStripper,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  private sse() {
    return this.s.kmsKeyId === undefined
      ? ({ ServerSideEncryption: "AES256" } as const)
      : ({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.s.kmsKeyId } as const);
  }
  private opts(idempotent: boolean) {
    return { idempotent, ...(this.sleep === undefined ? {} : { sleep: this.sleep }) };
  }

  newKey(purpose: UploadPurpose): string {
    const d = this.now();
    return `${purpose}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
  }

  /** Presigned PUT: content type allow-listed per purpose, exact content-length (<= 10 MB) and SSE headers are SIGNED. */
  async presignUpload(input: { purpose: UploadPurpose; ownerId: string; contentType: string; sizeBytes: number }): Promise<PresignedUpload> {
    if (!ALLOWED[input.purpose].includes(input.contentType)) throw new RangeError("content type not allowed");
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxBytesFor(input.purpose)) throw new RangeError("size out of range");
    if (this.presignClient === undefined) throw new Error("presign client missing");
    const key = this.newKey(input.purpose);
    const headers: Record<string, string> = {
      "content-type": input.contentType,
      "content-length": String(input.sizeBytes),
      "x-amz-tagging": "scan=pending_scan",
      [`x-amz-meta-${OWNER}`]: input.ownerId,
      "x-amz-server-side-encryption": this.s.kmsKeyId === undefined ? "AES256" : "aws:kms",
    };
    if (this.s.kmsKeyId !== undefined) headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.s.kmsKeyId;
    const cmd = new PutObjectCommand({
      Bucket: this.s.bucket,
      Key: key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
      Tagging: "scan=pending_scan",
      Metadata: { [OWNER]: input.ownerId },
      ...this.sse(),
    });
    const url = await callAws("object.store", "presignPut", () =>
      getSignedUrl(this.presignClient as S3Client, cmd, {
        expiresIn: PUT_TTL_SECONDS,
        signableHeaders: new Set(["content-type", "content-length"]),
        unhoistableHeaders: new Set(Object.keys(headers).filter((h) => h.startsWith("x-amz-"))),
      }),
    { idempotent: false });
    return { key, url, headers, expiresAtMs: this.now().getTime() + PUT_TTL_SECONDS * 1000 };
  }

  /** Presigned GET, <= 15 min, only for objects whose scan state is `clean`. Returns null otherwise. */
  async presignDownload(key: string, ttlSeconds: number): Promise<SignedUrl | null> {
    if (this.presignClient === undefined) throw new Error("presign client missing");
    if (!(await this.isClean(key))) return null;
    const ttl = Math.max(1, Math.min(ttlSeconds, MAX_GET_TTL_SECONDS));
    const url = await callAws("object.store", "presignGet", () => getSignedUrl(this.presignClient as S3Client, new GetObjectCommand({ Bucket: this.s.bucket, Key: key }), { expiresIn: ttl }), { idempotent: false });
    return { url, expiresAtMs: this.now().getTime() + ttl * 1000 };
  }

  async scanState(key: string): Promise<ScanState | null> {
    try {
      const r = await callAws("object.store", "getTags", () => this.client.send(new GetObjectTaggingCommand({ Bucket: this.s.bucket, Key: key })), this.opts(true));
      const v = r.TagSet?.find((t) => t.Key === "scan")?.Value;
      return v === "clean" || v === "infected" ? v : "pending_scan";
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }
  async isClean(key: string): Promise<boolean> {
    return (await this.scanState(key)) === "clean";
  }

  async head(key: string): Promise<{ readonly size: number; readonly contentType: string | undefined; readonly ownerId: string | undefined } | null> {
    try {
      const r = await callAws("object.store", "head", () => this.client.send(new HeadObjectCommand({ Bucket: this.s.bucket, Key: key })), this.opts(true));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType, ownerId: r.Metadata?.[OWNER] };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string, opts: { ownerId?: string; scan?: ScanState } = {}): Promise<void> {
    if (bytes.length > MAX_UPLOAD_BYTES * 10) throw new RangeError("object too large");
    await callAws(
      "object.store",
      "put",
      () =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.s.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            Tagging: `scan=${opts.scan ?? "pending_scan"}`,
            ...(opts.ownerId === undefined ? {} : { Metadata: { [OWNER]: opts.ownerId } }),
            ...this.sse(),
          }),
        ),
      this.opts(true),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const r = await callAws("object.store", "get", () => this.client.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: key })), this.opts(true));
      return r.Body === undefined ? null : await r.Body.transformToByteArray();
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await callAws("object.store", "delete", () => this.client.send(new DeleteObjectCommand({ Bucket: this.s.bucket, Key: key })), this.opts(true));
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
      const r = await callAws("object.store", "deleteMany", () => this.client.send(new DeleteObjectsCommand({ Bucket: this.s.bucket, Delete: { Objects: batch, Quiet: true } })), this.opts(true));
      if ((r.Errors?.length ?? 0) > 0) throw (await import("./errors")).mapAwsError("object.store", "deleteMany", new Error("partial_delete"));
    }
  }

  /**
   * Post-upload pipeline (run by a worker on the upload event): strip EXIF/GPS, scan, then tag. With
   * no scanner configured the object stays `pending_scan` and is never served.
   */
  async processUpload(key: string): Promise<ScanState> {
    if (this.scanner === undefined) return "pending_scan";
    const bytes = await this.get(key);
    if (bytes === null) throw new RangeError("no such object");
    const meta = await this.head(key);
    let body = bytes;
    if (this.stripper !== undefined && meta?.contentType?.startsWith("image/") === true) {
      body = await this.stripper.strip(bytes, meta.contentType);
      await this.put(key, body, meta.contentType, { ...(meta.ownerId === undefined ? {} : { ownerId: meta.ownerId }), scan: "pending_scan" });
    }
    const verdict = await this.scanner.scan(body);
    await callAws("object.store", "setTags", () => this.client.send(new PutObjectTaggingCommand({ Bucket: this.s.bucket, Key: key, Tagging: { TagSet: [{ Key: "scan", Value: verdict }] } })), this.opts(true));
    return verdict;
  }

  /** True when `key` has our key scheme, exists and is owned by `ownerId`. */
  async owns(ownerId: string, key: string): Promise<boolean> {
    if (!KEY_RE.test(key)) return false;
    const h = await this.head(key);
    return h !== undefined && h !== null && h.ownerId === ownerId;
  }

  ready(): Promise<boolean> {
    return probe((signal) => this.client.send(new HeadBucketCommand({ Bucket: this.s.bucket }), { abortSignal: signal }), this.s.probeTimeoutMs ?? 2000);
  }

  // Port facades -------------------------------------------------------------------------------

  privacy(): ObjectStorePort {
    return {
      configured: true,
      put: async (key, bytes, contentType) => {
        if (!EXPORT_RE.test(key)) throw new RangeError("unsupported export key");
        // Server-generated artifacts need no scan.
        await this.put(key, bytes, contentType, { scan: "clean" });
      },
      delete: (key) => this.delete(key),
      signGetUrl: async (key, ttlSeconds) => {
        const u = await this.presignDownload(key, ttlSeconds);
        if (u === null) throw new RangeError("object not servable");
        return u;
      },
    };
  }
  blobDelete(): BlobDeletePort {
    return { deleteMany: (refs) => this.deleteMany(refs) };
  }
  catalog(): CatalogObjectStore {
    return {
      ownedBy: async (storeId, ids) => {
        const out = new Set<string>();
        for (const id of ids) if (id.startsWith("catalog/") || id.startsWith("import/") ? await this.owns(storeId, id) : false) out.add(id);
        return out;
      },
      readText: async (storeId, id) => {
        if (!id.startsWith("import/") || !(await this.owns(storeId, id)) || !(await this.isClean(id))) return null;
        const b = await this.get(id);
        return b === null ? null : new TextDecoder().decode(b);
      },
    };
  }
  evidence(): EvidencePort {
    return { ownedBy: async (actor, ids) => (await Promise.all(ids.map((i) => i.startsWith("return-evidence/") && this.owns(actor, i)))).every(Boolean) };
  }
  /** Wardrobe photos: private, SSE, EXIF/GPS stripped and scanned before they can be read or served. */
  wardrobeImages(): WardrobeImageStorePort {
    return {
      configured: true,
      issue: async (i) => {
        const u = await this.presignUpload({ purpose: "wardrobe", ownerId: i.ownerId, contentType: i.contentType, sizeBytes: i.sizeBytes });
        return { uploadId: u.key, url: u.url, headers: u.headers, expiresAtMs: u.expiresAtMs };
      },
      owns: (ownerId, key) => (key.startsWith("wardrobe/") ? this.owns(ownerId, key) : Promise.resolve(false)),
      scanState: (key) => (key.startsWith("wardrobe/") ? this.scanState(key) : Promise.resolve(null)),
      read: async (key) => (key.startsWith("wardrobe/") && (await this.isClean(key)) ? this.get(key) : null),
      signGet: (key, ttl) => (key.startsWith("wardrobe/") ? this.presignDownload(key, ttl) : Promise.resolve(null)),
      delete: (key) => (key.startsWith("wardrobe/") ? this.delete(key) : Promise.resolve()),
    };
  }
  /** Seller product photos: private, SSE, EXIF/GPS stripped and scanned before use; derivatives are server-written, never public. */
  productMedia(): ProductMediaBlobPort {
    const mine = (key: string) => key.startsWith("product-media/") || key.startsWith("product-media-derived/");
    return {
      configured: true,
      issueUpload: async (i) => {
        const u = await this.presignUpload({ purpose: "product-media", ownerId: i.storeId, contentType: i.contentType, sizeBytes: i.sizeBytes });
        return { uploadId: u.key, url: u.url, headers: u.headers, expiresAtMs: u.expiresAtMs };
      },
      owns: (storeId, key) => (mine(key) ? this.owns(storeId, key) : Promise.resolve(false)),
      scanState: (key) => (mine(key) ? this.scanState(key) : Promise.resolve(null)),
      read: async (key) => (mine(key) && (await this.isClean(key)) ? this.get(key) : null),
      writeDerivative: async (i) => {
        const key = this.newKey("product-media-derived");
        // Produced by our own re-encoding pipeline from a scanned original: no further scan needed.
        await this.put(key, i.bytes, i.kind === "png" ? "image/png" : "image/jpeg", { ownerId: i.storeId, scan: "clean" });
        return key;
      },
      promote: async (i) => {
        if (!mine(i.key) || !(await this.owns(i.storeId, i.key)) || !(await this.isClean(i.key))) throw new RangeError("object cannot be promoted");
        const bytes = await this.get(i.key);
        if (bytes === null) throw new RangeError("object cannot be promoted");
        const key = this.newKey("catalog");
        // Copy of an already scanned, re-encoded object: it keeps the clean verdict and the store as owner.
        await this.put(key, bytes, sniffImageType(bytes), { ownerId: i.storeId, scan: "clean" });
        return key;
      },
      signGet: (key, ttl) => (mine(key) ? this.presignDownload(key, ttl) : Promise.resolve(null)),
      delete: (key) => (mine(key) ? this.delete(key) : Promise.resolve()),
    };
  }
  photos(): PhotoUploadPort {
    return { areOwnedImages: async (user, ids) => (await Promise.all(ids.map((i) => i.startsWith("review-photo/") && this.owns(user, i)))).every(Boolean) };
  }
}
