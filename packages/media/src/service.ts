import { contextClient } from "@outlet/db";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { uuidv7 } from "@outlet/ids";
import { MediaError } from "./errors.js";
import { CONTENT_TYPE, processImage, sha256Hex, sniff, variantKey } from "./pipeline.js";
import type { MediaKind, Variant } from "./pipeline.js";
import type { AvScanPort, SignerPort, StoragePort } from "./ports.js";
import type { MediaAsset } from "./urls.js";

export const MAX_SIGNED_URL_TTL_SECONDS = 900;

export interface MediaDeps {
  /** Store-scoped writes run through contextClient (RLS on store_id). */
  readonly app: RoleSqlClient<"outlet_app">;
  /** Privileged client: platform-owned assets (store_id NULL) and id lookups; every use is gated by policy.authorize. */
  readonly privileged: SqlClient;
  readonly storage: StoragePort;
  readonly scanner: AvScanPort;
  readonly signer: SignerPort;
  readonly marketId: string;
  readonly now?: () => Date;
}

export interface IngestInput {
  readonly bytes: Uint8Array;
  readonly declaredMime: string;
  readonly kind: MediaKind;
  readonly actor: Principal;
  readonly storeId?: string;
}

interface Row {
  id: string; market_id: string; store_id: string | null; kind: MediaKind; status: MediaAsset["status"]; sha256: string; mime: string;
  bytes: string | number; width: number | null; height: number | null; variants: Variant[]; storage_key: string;
}
const COLS = "id, market_id, store_id, kind, status, sha256, mime, bytes, width, height, variants, storage_key";
const toAsset = (r: Row): MediaAsset => ({
  id: r.id, marketId: r.market_id, storeId: r.store_id, kind: r.kind, status: r.status, sha256: r.sha256, mime: r.mime,
  bytes: Number(r.bytes), width: r.width, height: r.height, variants: r.variants, storageKey: r.storage_key,
});

export class MediaService {
  private readonly outbox = new OutboxWriter(pgTransactionalWriter);
  constructor(private readonly deps: MediaDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private db(storeId: string | undefined, actor: Principal): SqlClient {
    if (storeId === undefined) return this.deps.privileged;
    return contextClient(this.deps.app, { kind: "store", marketId: this.deps.marketId, storeId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) });
  }

  private authorizeIngest(actor: Principal, storeId: string | undefined): void {
    if (storeId === undefined) {
      if (actor.kind !== "system" || !actor.scopes.includes("media.platform_write") || actor.marketId !== this.deps.marketId) throw new MediaError("not_found");
      return;
    }
    const d = authorize(actor, "listing.write", { type: "media", storeId, marketId: this.deps.marketId });
    if (d.effect === "deny") throw new MediaError(d.reason === "forbidden" ? "forbidden" : "not_found");
  }

  async ingest(input: IngestInput): Promise<MediaAsset> {
    const { bytes, kind, actor, storeId } = input;
    this.authorizeIngest(actor, storeId);
    const mime = await sniff(bytes, input.declaredMime, kind);
    const id = uuidv7();
    const prefix = `${this.deps.marketId}/${storeId ?? "platform"}/${id}`;
    const originalKey = `private/${prefix}/original`;
    const written: string[] = [];
    const put = async (key: string, data: Uint8Array, ct: string): Promise<void> => {
      await this.deps.storage.put(key, data, ct);
      written.push(key);
    };
    const cleanup = async (): Promise<void> => {
      for (const k of written) await this.deps.storage.delete(k);
    };

    let width: number | null = null;
    let height: number | null = null;
    const variants: Variant[] = [];
    try {
      if (kind === "document") {
        await put(originalKey, bytes, mime);
      } else {
        const img = await processImage(bytes);
        width = img.width;
        height = img.height;
        await put(originalKey, img.master, "image/jpeg");
        for (const r of img.renditions) {
          const key = variantKey(`public/${prefix}`, r.format, r.width);
          await put(key, r.data, CONTENT_TYPE[r.format]);
          variants.push({ format: r.format, width: r.width, height: r.height, key, bytes: r.bytes });
        }
      }
      const db = this.db(storeId, actor);
      await db.query(
        `INSERT INTO media_assets (id, market_id, store_id, kind, status, sha256, mime, bytes, width, height, variants, storage_key, created_by, created_at)
         VALUES ($1,$2,$3,$4,'pending_scan',$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
        [id, this.deps.marketId, storeId ?? null, kind, sha256Hex(bytes), mime, bytes.byteLength, width, height, JSON.stringify(variants), originalKey, actor.userId ?? null, this.now()],
      );
    } catch (e) {
      await cleanup();
      throw e;
    }
    // Fail closed: if the scanner throws, the asset stays pending_scan (never ready) and the error propagates.
    const verdict = await this.deps.scanner.scan(bytes);
    return this.finish(id, storeId, actor, kind, verdict.clean, verdict.signature);
  }

  private async finish(id: string, storeId: string | undefined, actor: Principal, kind: MediaKind, clean: boolean, signature?: string): Promise<MediaAsset> {
    const db = this.db(storeId, actor);
    const status = clean ? "ready" : "rejected";
    return db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        `UPDATE media_assets SET status = $2, rejected_reason = $3 WHERE id = $1 AND status = 'pending_scan' RETURNING ${COLS}`,
        [id, status, clean ? null : (signature ?? "av_infected")],
      );
      const row = rows[0];
      if (row === undefined) throw new MediaError("not_found");
      await this.outbox.append(tx, {
        id: uuidv7(),
        type: clean ? "media.ready" : "media.rejected",
        aggregateType: "media_asset",
        aggregateId: id,
        marketId: this.deps.marketId,
        occurredAt: this.now().toISOString(),
        payload: { assetId: id, kind, ...(storeId === undefined ? {} : { storeId }) },
      });
      return toAsset(row);
    });
  }

  async signedUrl(assetId: string, actor: Principal, ttlSeconds: number, reasonCode?: string): Promise<{ url: string; expiresAt: Date }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) throw new MediaError("ttl_invalid");
    const { rows } = await this.deps.privileged.query<Row>(`SELECT ${COLS} FROM media_assets WHERE id = $1 AND market_id = $2`, [assetId, this.deps.marketId]);
    const row = rows[0];
    if (row?.status !== "ready") throw new MediaError("not_found");
    const asset = toAsset(row);
    if (asset.storeId === null) {
      if (actor.kind !== "system" || !actor.scopes.includes("media.platform_write")) throw new MediaError("not_found");
    } else {
      const d = authorize(actor, "listing.read", { type: "media", id: asset.id, storeId: asset.storeId, marketId: asset.marketId });
      if (d.effect === "deny") throw new MediaError(d.reason === "forbidden" ? "forbidden" : "not_found");
      if (actor.kind === "admin" && asset.kind === "document" && (reasonCode?.trim() ?? "") === "") throw new MediaError("reason_required");
    }
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    return { url: this.deps.signer.sign(asset.storageKey, expiresAt), expiresAt };
  }
}
