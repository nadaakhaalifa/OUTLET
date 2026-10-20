import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { PartialAttributesSchema, type PartialAttributes } from "../domain/attributes";
import type {
  AttributesSource,
  CreateItemResult,
  IdPort,
  Page,
  ScanState,
  UpdateItemResult,
  UploadRecord,
  WardrobeEvent,
  WardrobeItem,
  WardrobeStore,
} from "../domain/ports";
import { decodeCursor, encodeCursor } from "./in-memory";

/** Raw SQL with Zod validated rows, as in the stylist and calendar adapters. */
export type WardrobeDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const ItemRow = z.object({
  id: z.string(),
  user_id: z.string(),
  image_ref: z.string().nullable(),
  image_state: z.enum(["none", "pending_scan", "clean", "infected"]),
  attributes: PartialAttributesSchema,
  attributes_source: z.enum(["user", "vision"]),
  vision_model_version: z.string().nullable(),
  version: z.number().int(),
  created_ms: Int,
  updated_ms: Int,
});
const UploadRow = z.object({
  id: z.string(),
  user_id: z.string(),
  upload_id: z.string(),
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size_bytes: z.number().int(),
  issued_ms: Int,
  consumed_ms: Int.nullable(),
});

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const ITEM_COLS = sql`id::text as id, user_id::text as user_id, image_ref, image_state, attributes, attributes_source,
  vision_model_version, version, ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("updated_at")} as updated_ms`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toItem = (raw: unknown): WardrobeItem => {
  const r = ItemRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    imageRef: r.image_ref,
    imageState: r.image_state,
    attributes: r.attributes,
    attributesSource: r.attributes_source,
    visionModelVersion: r.vision_model_version,
    version: r.version,
    createdAtMs: Number(r.created_ms),
    updatedAtMs: Number(r.updated_ms),
  };
};
const toUpload = (raw: unknown): UploadRecord => {
  const r = UploadRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    uploadId: r.upload_id,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    issuedAtMs: Number(r.issued_ms),
    consumedAtMs: r.consumed_ms === null ? null : Number(r.consumed_ms),
  };
};

class Stop extends Error {
  constructor(readonly outcome: string) {
    super(outcome);
  }
}

function aggregateOf(e: WardrobeEvent): { type: string; id: string } {
  return e.type === "wardrobe.cleared" ? { type: "wardrobe", id: e.userId } : { type: "wardrobe_item", id: e.itemId };
}

export class KyselyWardrobeStore implements WardrobeStore {
  constructor(
    private readonly db: WardrobeDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: WardrobeDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as WardrobeDb);
    });
  }

  private async writeEvents(trx: WardrobeDb, events: readonly WardrobeEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(e)}::jsonb)`.execute(trx);
    }
  }

  async insertUpload(u: UploadRecord, max: number): Promise<"stored" | "quota"> {
    try {
      return await this.tx(async (trx) => {
        // Serialises one shopper's writes so the cap cannot be raced past.
        await sql`select id from users where id = ${u.userId}::uuid for update`.execute(trx);
        const c = await sql`select count(*)::int as n from wardrobe_uploads where user_id = ${u.userId}::uuid and consumed_at is null`.execute(trx);
        if (z.object({ n: z.number() }).parse(c.rows[0]).n >= max) throw new Stop("quota");
        await sql`
          insert into wardrobe_uploads (id, user_id, upload_id, content_type, size_bytes, issued_at)
          values (${u.id}::uuid, ${u.userId}::uuid, ${u.uploadId}, ${u.contentType}, ${u.sizeBytes},
                  to_timestamp(${u.issuedAtMs}::double precision / 1000))`.execute(trx);
        return "stored" as const;
      });
    } catch (e) {
      if (e instanceof Stop) return "quota";
      throw e;
    }
  }

  async getUpload(userId: string, uploadId: string): Promise<UploadRecord | null> {
    if (!UUID_RE.test(userId)) return null;
    return this.tx(async (trx) => {
      const res = await sql`
        select id::text as id, user_id::text as user_id, upload_id, content_type, size_bytes,
               ${EPOCH_MS("issued_at")} as issued_ms,
               case when consumed_at is null then null else ${EPOCH_MS("consumed_at")} end as consumed_ms
        from wardrobe_uploads where user_id = ${userId}::uuid and upload_id = ${uploadId}`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : toUpload(row);
    });
  }

  async insertItem(item: WardrobeItem, uploadId: string | null, maxItems: number, events: readonly WardrobeEvent[]): Promise<CreateItemResult> {
    try {
      return await this.tx(async (trx) => {
        await sql`select id from users where id = ${item.userId}::uuid for update`.execute(trx);
        const c = await sql`select count(*)::int as n from wardrobe_items where user_id = ${item.userId}::uuid`.execute(trx);
        if (z.object({ n: z.number() }).parse(c.rows[0]).n >= maxItems) throw new Stop("limit_reached");
        if (uploadId !== null) {
          const used = await sql`
            update wardrobe_uploads set consumed_at = to_timestamp(${item.createdAtMs}::double precision / 1000)
            where upload_id = ${uploadId} and user_id = ${item.userId}::uuid and consumed_at is null
            returning id`.execute(trx);
          if (used.rows.length === 0) throw new Stop("upload_unavailable");
        }
        await sql`
          insert into wardrobe_items (id, user_id, image_ref, image_state, attributes, attributes_source,
                                      vision_model_version, version, created_at, updated_at)
          values (${item.id}::uuid, ${item.userId}::uuid, ${item.imageRef}, ${item.imageState},
                  ${JSON.stringify(item.attributes)}::jsonb, ${item.attributesSource}, ${item.visionModelVersion}, ${item.version},
                  to_timestamp(${item.createdAtMs}::double precision / 1000), to_timestamp(${item.updatedAtMs}::double precision / 1000))`.execute(trx);
        await this.writeEvents(trx, events);
        return "created" as const;
      });
    } catch (e) {
      if (e instanceof Stop) return e.outcome === "limit_reached" ? "limit_reached" : "upload_unavailable";
      throw e;
    }
  }

  async getItem(id: string): Promise<WardrobeItem | null> {
    if (!UUID_RE.test(id)) return null;
    return this.tx(async (trx) => {
      const res = await sql`select ${ITEM_COLS} from wardrobe_items where id = ${id}::uuid`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : toItem(row);
    });
  }

  async all(userId: string): Promise<readonly WardrobeItem[]> {
    return this.tx(async (trx) => {
      const res = await sql`select ${ITEM_COLS} from wardrobe_items where user_id = ${userId}::uuid order by created_at desc, id desc limit 1000`.execute(trx);
      return res.rows.map(toItem);
    });
  }

  async list(userId: string, limit: number, cursor: string | null): Promise<Page<WardrobeItem>> {
    const c = cursor === null ? null : decodeCursor(cursor);
    if (cursor !== null && c === null) throw new RangeError("bad cursor");
    return this.tx(async (trx) => {
      const after =
        c === null
          ? sql``
          : sql`and (floor(extract(epoch from created_at) * 1000)::bigint, id) < (${c.ms}::bigint, ${c.id}::uuid)`;
      const res = await sql`
        select ${ITEM_COLS} from wardrobe_items where user_id = ${userId}::uuid ${after}
        order by created_at desc, id desc limit ${limit + 1}`.execute(trx);
      const rows = res.rows.map(toItem);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return { items: page, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.createdAtMs, last.id) : null };
    });
  }

  async updateAttributes(
    id: string,
    userId: string,
    expectedVersion: number | null,
    attributes: PartialAttributes,
    source: AttributesSource,
    modelVersion: string | null,
    atMs: number,
    events: readonly WardrobeEvent[],
  ): Promise<UpdateItemResult> {
    if (!UUID_RE.test(id)) return { kind: "not_found" };
    return this.tx(async (trx) => {
      const ver = expectedVersion === null ? sql`` : sql`and version = ${expectedVersion}`;
      const res = await sql`
        update wardrobe_items set attributes = ${JSON.stringify(attributes)}::jsonb, attributes_source = ${source},
               vision_model_version = ${modelVersion}, version = version + 1,
               updated_at = to_timestamp(${atMs}::double precision / 1000)
        where id = ${id}::uuid and user_id = ${userId}::uuid ${ver}
        returning ${ITEM_COLS}`.execute(trx);
      const row = res.rows[0];
      if (row === undefined) {
        const ex = await sql`select 1 as one from wardrobe_items where id = ${id}::uuid and user_id = ${userId}::uuid`.execute(trx);
        return ex.rows.length === 0 ? { kind: "not_found" } : { kind: "conflict" };
      }
      await this.writeEvents(trx, events);
      return { kind: "updated", item: toItem(row) };
    });
  }

  async setImageState(id: string, state: ScanState, atMs: number): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        update wardrobe_items set image_state = ${state}, updated_at = to_timestamp(${atMs}::double precision / 1000)
        where id = ${id}::uuid and image_ref is not null and image_state = 'pending_scan'`.execute(trx);
    });
  }

  async deleteItem(id: string, userId: string, events: readonly WardrobeEvent[]): Promise<{ readonly deleted: boolean; readonly imageRef: string | null }> {
    if (!UUID_RE.test(id)) return { deleted: false, imageRef: null };
    return this.tx(async (trx) => {
      const res = await sql`delete from wardrobe_items where id = ${id}::uuid and user_id = ${userId}::uuid returning image_ref`.execute(trx);
      const row = res.rows[0];
      if (row === undefined) return { deleted: false, imageRef: null };
      await this.writeEvents(trx, events);
      return { deleted: true, imageRef: z.object({ image_ref: z.string().nullable() }).parse(row).image_ref };
    });
  }

  async clear(userId: string): Promise<{ readonly count: number; readonly imageRefs: readonly string[] }> {
    return this.tx(async (trx) => {
      const items = await sql`delete from wardrobe_items where user_id = ${userId}::uuid returning image_ref`.execute(trx);
      const ups = await sql`delete from wardrobe_uploads where user_id = ${userId}::uuid and consumed_at is null returning upload_id`.execute(trx);
      await sql`delete from wardrobe_uploads where user_id = ${userId}::uuid`.execute(trx);
      const Ref = z.object({ image_ref: z.string().nullable() });
      const refs = [
        ...items.rows.flatMap((r) => {
          const v = Ref.parse(r).image_ref;
          return v === null ? [] : [v];
        }),
        ...ups.rows.map((r) => z.object({ upload_id: z.string() }).parse(r).upload_id),
      ];
      await this.writeEvents(trx, [{ type: "wardrobe.cleared", userId, count: items.rows.length }]);
      return { count: items.rows.length, imageRefs: refs };
    });
  }
}
