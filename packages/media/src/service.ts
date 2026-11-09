import { contextClient, withDbContext } from "@outlet/db";
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
  /** Store-scoped work runs through contextClient (RLS on store_id). */
  readonly app: RoleSqlClient<"outlet_app">;
  /** Platform-owned assets (store_id NULL) only, through the named exception policy media_assets__worker_platform (job 'media.platform'). */
  readonly worker: RoleSqlClient<"outlet_worker">;
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

const PUBLIC = "public/";
/** Renditions are written here first and promoted to their final public/ key only when the asset is ready. */
const quarantineKey = (finalKey: string): string => `quarantine/${finalKey.startsWith(PUBLIC) ? finalKey.slice(PUBLIC.length) : finalKey}`;

export class MediaService {
  private readonly outbox = new OutboxWriter(pgTransactionalWriter);
  constructor(private readonly deps: MediaDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Store assets run in the store context; platform assets (storeId undefined) in the media.platform worker context. */
  private db(storeId: string | undefined, actor: Principal): SqlClient {
    const userId = actor.userId === undefined ? {} : { userId: actor.userId };
    if (storeId === undefined) return contextClient(this.deps.worker, { kind: "worker", marketId: this.deps.marketId, job: "media.platform", ...userId });
    return contextClient(this.deps.app, { kind: "store", marketId: this.deps.marketId, storeId, ...userId });
  }

  private authorizeIngest(actor: Principal, storeId: string | undefined, kind: MediaKind): void {
    if (storeId === undefined) {
      // An applicant uploads their own KYC document as themselves (no store exists yet): policy action seller.onboard on their own application.
      if (kind === "document" && actor.kind === "shopper" && actor.userId !== undefined) {
        const d = authorize(actor, "seller.onboard", { type: "seller_application", ownerUserId: actor.userId, marketId: this.deps.marketId });
        if (d.effect === "deny") throw new MediaError("not_found");
        return;
      }
      if (actor.kind !== "system" || !actor.scopes.includes("media.platform_write") || actor.marketId !== this.deps.marketId) throw new MediaError("not_found");
      return;
    }
    const d = authorize(actor, "listing.write", { type: "media", storeId, marketId: this.deps.marketId });
    if (d.effect === "deny") throw new MediaError(d.reason === "forbidden" ? "forbidden" : "not_found");
  }

  /**
   * Order: sniff -> pending row -> AV scan of the raw bytes (before any libvips decode) -> decode and render -> record the planned
   * keys on the row -> write (private original, renditions under quarantine/) -> promote to public/ -> ready + outbox.
   * A scanner failure leaves the pending row (fail closed; purgeStalePending reaps it).
   */
  async ingest(input: IngestInput): Promise<MediaAsset> {
    const { bytes, kind, actor, storeId } = input;
    this.authorizeIngest(actor, storeId, kind);
    const mime = await sniff(bytes, input.declaredMime, kind);
    const id = uuidv7();
    const prefix = `${this.deps.marketId}/${storeId ?? "platform"}/${id}`;
    const originalKey = `private/${prefix}/original`;
    const db = this.db(storeId, actor);
    await db.query(
      `INSERT INTO media_assets (id, market_id, store_id, kind, status, sha256, mime, bytes, width, height, variants, storage_key, created_by, created_at)
       VALUES ($1,$2,$3,$4,'pending_scan',$5,$6,$7,NULL,NULL,'[]'::jsonb,$8,$9,$10)`,
      [id, this.deps.marketId, storeId ?? null, kind, sha256Hex(bytes), mime, bytes.byteLength, originalKey, actor.userId ?? null, this.now()],
    );
    // Fail closed: if the scanner throws, the asset stays pending_scan (never ready) and the error propagates.
    const verdict = await this.deps.scanner.scan(bytes);
    if (!verdict.clean) return this.finish(id, storeId, actor, kind, false, verdict.signature);

    const written: string[] = [];
    const put = async (key: string, data: Uint8Array, ct: string): Promise<void> => {
      await this.deps.storage.put(key, data, ct);
      written.push(key);
    };
    const cleanup = async (): Promise<void> => {
      for (const k of written) await this.deps.storage.delete(k);
    };
    try {
      let img: Awaited<ReturnType<typeof processImage>> | undefined;
      try {
        img = kind === "document" ? undefined : await processImage(bytes);
      } catch (e) {
        await this.finish(id, storeId, actor, kind, false, e instanceof MediaError ? e.code : "invalid_image").catch(() => undefined);
        throw e;
      }
      const variants: Variant[] = [];
      const pending: { from: string; to: string }[] = [];
      if (img !== undefined) {
        for (const r of img.renditions) {
          const key = variantKey(`${PUBLIC}${prefix}`, r.format, r.width);
          variants.push({ format: r.format, width: r.width, height: r.height, key, bytes: r.bytes });
          pending.push({ from: quarantineKey(key), to: key });
          await put(quarantineKey(key), r.data, CONTENT_TYPE[r.format]);
        }
      }
      await put(originalKey, img === undefined ? bytes : img.master, img === undefined ? mime : "image/jpeg");
      // Promote only now that the verdict is clean and every rendition exists.
      for (const m of pending) {
        const data = await this.deps.storage.get(m.from);
        if (data === null) throw new MediaError("invalid_image", "rendition missing at promotion");
        await put(m.to, data, m.to.endsWith(".avif") ? CONTENT_TYPE.avif : m.to.endsWith(".webp") ? CONTENT_TYPE.webp : CONTENT_TYPE.jpeg);
        await this.deps.storage.delete(m.from);
      }
      return await this.finish(id, storeId, actor, kind, true, undefined, { width: img?.width ?? null, height: img?.height ?? null, variants });
    } catch (e) {
      await cleanup();
      throw e;
    }
  }

  /**
   * Marks the pending row ready or rejected with its outbox event in one transaction. A rejected asset has every stored object
   * deleted (the row keeps the reason as evidence).
   */
  private async finish(id: string, storeId: string | undefined, actor: Principal, kind: MediaKind, clean: boolean, signature?: string, ready?: { width: number | null; height: number | null; variants: Variant[] }): Promise<MediaAsset> {
    const db = this.db(storeId, actor);
    const status = clean ? "ready" : "rejected";
    const asset = await db.transaction(async (tx) => {
      const { rows } = await tx.query<Row>(
        `UPDATE media_assets SET status = $2, rejected_reason = $3,
                width = COALESCE($4::int, width), height = COALESCE($5::int, height), variants = COALESCE($6::jsonb, variants)
          WHERE id = $1 AND status = 'pending_scan' RETURNING ${COLS}`,
        [id, status, clean ? null : (signature ?? "av_infected"), ready?.width ?? null, ready?.height ?? null, ready === undefined ? null : JSON.stringify(ready.variants)],
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
    if (!clean) await this.deleteObjects(asset);
    return asset;
  }

  private async deleteObjects(a: { storageKey: string; variants: readonly Variant[] }): Promise<void> {
    for (const v of a.variants) {
      await this.deps.storage.delete(v.key);
      await this.deps.storage.delete(quarantineKey(v.key));
    }
    await this.deps.storage.delete(a.storageKey);
  }

  /**
   * Janitor: pending_scan rows older than `olderThanMs` (a scanner that never answered, a crashed ingest) get their storage
   * objects deleted and are marked rejected ('stale_pending'). Platform rows run in the media.platform worker context, store
   * rows once per store in that store's context. Returns the number purged.
   */
  async purgeStalePending(now: Date, olderThanMs: number): Promise<number> {
    if (!Number.isInteger(olderThanMs) || olderThanMs < 1) throw new MediaError("ttl_invalid");
    const cutoff = new Date(now.getTime() - olderThanMs);
    let n = await this.purgeIn(this.db(undefined, { kind: "system", marketId: this.deps.marketId, roles: [], scopes: [] }), undefined, cutoff);
    const stores = await withDbContext(this.deps.app, { kind: "user", marketId: this.deps.marketId }, (tx) =>
      tx.query<{ id: string }>("SELECT id FROM catalog_public_stores WHERE market_id = $1 ORDER BY id", [this.deps.marketId]),
    );
    for (const st of stores.rows) n += await this.purgeIn(this.db(st.id, { kind: "system", marketId: this.deps.marketId, roles: [], scopes: [] }), st.id, cutoff);
    return n;
  }

  private async purgeIn(db: SqlClient, storeId: string | undefined, cutoff: Date): Promise<number> {
    const stale = await db.query<Row>(`SELECT ${COLS} FROM media_assets WHERE status = 'pending_scan' AND created_at <= $1 AND market_id = $2 ORDER BY created_at LIMIT 500`, [cutoff, this.deps.marketId]);
    let n = 0;
    for (const r of stale.rows) {
      const a = toAsset(r);
      await this.deleteObjects(a);
      const done = await db.transaction(async (tx) => {
        const u = await tx.query("UPDATE media_assets SET status = 'rejected', rejected_reason = 'stale_pending' WHERE id = $1 AND status = 'pending_scan' RETURNING id", [a.id]);
        if (u.rows.length === 0) return false;
        await this.outbox.append(tx, {
          id: uuidv7(), type: "media.rejected", aggregateType: "media_asset", aggregateId: a.id, marketId: this.deps.marketId, occurredAt: this.now().toISOString(),
          payload: { assetId: a.id, kind: a.kind, reason: "stale_pending", ...(storeId === undefined ? {} : { storeId }) },
        });
        return true;
      });
      if (done) n += 1;
    }
    return n;
  }

  /**
   * The lookup runs in the CALLER's store context (opts.storeId, else the actor's own stores), or the media.platform worker
   * context for platform assets (system actor with media.platform_write, no storeId). A document view also commits a
   * media.document_viewed outbox event (actor, asset id, reason code; never content) in the same transaction.
   */
  async signedUrl(assetId: string, actor: Principal, ttlSeconds: number, opts: { reasonCode?: string; storeId?: string } = {}): Promise<{ url: string; expiresAt: Date }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) throw new MediaError("ttl_invalid");
    const reason = opts.reasonCode?.trim() ?? "";
    const platform = opts.storeId === undefined && actor.kind === "system" && actor.scopes.includes("media.platform_write");
    const candidates: (string | undefined)[] = platform ? [undefined] : opts.storeId !== undefined ? [opts.storeId] : (actor.storeIds ?? []);
    for (const storeId of candidates) {
      const found = await this.db(storeId, actor).transaction(async (tx): Promise<MediaAsset | null> => {
        const { rows } = await tx.query<Row>(`SELECT ${COLS} FROM media_assets WHERE id = $1 AND market_id = $2`, [assetId, this.deps.marketId]);
        const row = rows[0];
        if (row?.status !== "ready") return null;
        const asset = toAsset(row);
        if (asset.storeId !== null) {
          const d = authorize(actor, "listing.read", { type: "media", id: asset.id, storeId: asset.storeId, marketId: asset.marketId });
          if (d.effect === "deny") throw new MediaError(d.reason === "forbidden" ? "forbidden" : "not_found");
          if (actor.kind === "admin" && asset.kind === "document" && reason === "") throw new MediaError("reason_required");
        }
        if (asset.kind === "document") {
          await this.outbox.append(tx, {
            id: uuidv7(), type: "media.document_viewed", aggregateType: "media_asset", aggregateId: asset.id, marketId: asset.marketId, occurredAt: this.now().toISOString(),
            payload: { assetId: asset.id, actorId: actor.userId ?? null, actorKind: actor.kind, reasonCode: reason === "" ? null : reason, ...(asset.storeId === null ? {} : { storeId: asset.storeId }) },
          });
        }
        return asset;
      });
      if (found !== null) {
        const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
        return { url: this.deps.signer.sign(found.storageKey, expiresAt), expiresAt };
      }
    }
    throw new MediaError("not_found");
  }
}
