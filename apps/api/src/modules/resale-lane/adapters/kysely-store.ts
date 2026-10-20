import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { GRADES } from "../domain/bridge";
import type { ListingCursor, ListingRecord, ProceedsRecord, ResaleEvent, ResaleStore } from "../domain/ports";

export type ResaleDb = Kysely<Record<string, never>>;
export interface IdPort {
  uuidV7(): string;
}

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();

const ListingRow = z.object({
  id: z.string(),
  return_id: z.string(),
  unit_ref: z.string(),
  store_id: z.string(),
  source_sku_id: z.string(),
  resale_sku_id: z.string(),
  grade: z.enum(GRADES),
  photo_ids: z.array(z.string()),
  defect_note: z.string().nullable(),
  price: Big,
  ownership: z.enum(["seller", "platform_rtv"]),
  status: z.enum(["LISTED", "SOLD", "WITHDRAWN"]),
  listed_ms: Ms,
  sold_ms: Ms.nullable(),
  created_by: z.string(),
});
const COLS = sql`id::text as id, return_id::text as return_id, unit_ref::text as unit_ref, store_id::text as store_id,
  source_sku_id::text as source_sku_id, resale_sku_id::text as resale_sku_id, grade, photo_ids::text[] as photo_ids,
  defect_note, price_piastres::text as price, ownership, status, ${EPOCH("listed_at")} as listed_ms,
  ${EPOCH("sold_at")} as sold_ms, created_by::text as created_by`;
const toListing = (raw: unknown): ListingRecord => {
  const r = ListingRow.parse(raw);
  return {
    id: r.id,
    returnId: r.return_id,
    unitRef: r.unit_ref,
    storeId: r.store_id,
    sourceSkuId: r.source_sku_id,
    resaleSkuId: r.resale_sku_id,
    grade: r.grade,
    photoIds: r.photo_ids,
    defectNote: r.defect_note,
    price: r.price,
    ownership: r.ownership,
    status: r.status,
    listedAtMs: r.listed_ms,
    soldAtMs: r.sold_ms,
    createdBy: r.created_by,
  };
};
const ProceedsRow = z.object({ listing_id: z.string(), gross: Big, seller: Big, platform: Big, ledger: z.string().nullable(), rec_ms: Ms });

const payloadOf = (e: ResaleEvent): Record<string, string> =>
  e.type === "resale.listed" ? { listing_id: e.listingId, store_id: e.storeId, grade: e.grade } : { listing_id: e.listingId, store_id: e.storeId };

/** Postgres adapter: one transaction per method under the `system` role; outbox in the same tx. */
export class KyselyResaleStore implements ResaleStore {
  constructor(
    private readonly db: ResaleDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: ResaleDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as ResaleDb);
    });
  }

  private async emit(trx: ResaleDb, events: readonly ResaleEvent[]): Promise<void> {
    for (const e of events) {
      await sql`insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'resale_listing', ${e.listingId}::uuid, ${e.type},
                ${`resale_listing:${e.listingId}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  async insertListing(l: ListingRecord, events: readonly ResaleEvent[]) {
    return this.tx(async (trx) => {
      const byReturn = await sql`select 1 from resale_listings where return_id = ${l.returnId}::uuid`.execute(trx);
      if (byReturn.rows.length > 0) return "duplicate_return" as const;
      const byUnit = await sql`select 1 from resale_listings where unit_ref = ${l.unitRef}::uuid`.execute(trx);
      if (byUnit.rows.length > 0) return "duplicate_unit" as const;
      await sql`insert into resale_listings (id, return_id, unit_ref, store_id, source_sku_id, resale_sku_id, grade, photo_ids,
          defect_note, price_piastres, ownership, status, listed_at, created_by)
        values (${l.id}::uuid, ${l.returnId}::uuid, ${l.unitRef}::uuid, ${l.storeId}::uuid, ${l.sourceSkuId}::uuid,
          ${l.resaleSkuId}::uuid, ${l.grade}, ${`{${l.photoIds.map((p) => `"${p.replace(/["\\]/g, "")}"`).join(",")}}`}::text[],
          ${l.defectNote}, ${l.price.toString()}::bigint, ${l.ownership}, ${l.status}, ${iso(l.listedAtMs)}::timestamptz,
          ${l.createdBy}::uuid)`.execute(trx);
      await this.emit(trx, events);
      return "created" as const;
    });
  }

  async getListing(id: string) {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COLS} from resale_listings where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toListing(r.rows[0]);
    });
  }

  async countForUnit(unitRef: string) {
    if (!UUID.test(unitRef)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from resale_listings where unit_ref = ${unitRef}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  async listLive(limit: number, after: ListingCursor | null) {
    return this.tx(async (trx) => {
      const lim = Math.max(1, Math.min(limit, 50));
      const r =
        after === null
          ? await sql<unknown>`select ${COLS} from resale_listings where status = 'LISTED'
              order by listed_at desc, id desc limit ${lim}`.execute(trx)
          : await sql<unknown>`select ${COLS} from resale_listings where status = 'LISTED'
              and (listed_at, id) < (${iso(after.listedAtMs)}::timestamptz, ${after.id}::uuid)
              order by listed_at desc, id desc limit ${lim}`.execute(trx);
      return r.rows.map(toListing);
    });
  }

  async listAll(limit: number, after: ListingCursor | null, status: ListingRecord["status"] | null) {
    return this.tx(async (trx) => {
      const lim = Math.max(1, Math.min(limit, 101));
      const r = await sql<unknown>`select ${COLS} from resale_listings
        where (${status}::text is null or status = ${status})
          and (${after === null ? null : iso(after.listedAtMs)}::timestamptz is null
               or (listed_at, id) < (${after === null ? null : iso(after.listedAtMs)}::timestamptz, ${after === null ? null : after.id}::uuid))
        order by listed_at desc, id desc limit ${lim}`.execute(trx);
      return r.rows.map(toListing);
    });
  }

  async listForStore(storeId: string, limit: number) {
    if (!UUID.test(storeId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COLS} from resale_listings where store_id = ${storeId}::uuid
        order by listed_at desc, id desc limit ${Math.max(1, Math.min(limit, 200))}`.execute(trx);
      return r.rows.map(toListing);
    });
  }

  async getProceeds(listingId: string): Promise<ProceedsRecord | null> {
    if (!UUID.test(listingId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select listing_id::text as listing_id, gross_piastres::text as gross,
        seller_payable::text as seller, platform_retained::text as platform, ledger_entry_id::text as ledger,
        ${EPOCH("recorded_at")} as rec_ms from resale_proceeds where listing_id = ${listingId}::uuid`.execute(trx);
      if (r.rows[0] === undefined) return null;
      const p = ProceedsRow.parse(r.rows[0]);
      return { listingId: p.listing_id, gross: p.gross, sellerPayable: p.seller, platformRetained: p.platform, ledgerEntryId: p.ledger, recordedAtMs: p.rec_ms };
    });
  }

  async markSold(i: { listingId: string; nowMs: number; proceeds: ProceedsRecord; events: readonly ResaleEvent[] }) {
    if (!UUID.test(i.listingId)) return "not_found" as const;
    return this.tx(async (trx) => {
      const upd = await sql`update resale_listings set status = 'SOLD', sold_at = ${iso(i.nowMs)}::timestamptz
        where id = ${i.listingId}::uuid and status = 'LISTED' returning id`.execute(trx);
      if (upd.rows.length === 0) {
        const ex = await sql`select 1 from resale_listings where id = ${i.listingId}::uuid`.execute(trx);
        return ex.rows.length === 0 ? ("not_found" as const) : ("not_listed" as const);
      }
      await sql`insert into resale_proceeds (listing_id, gross_piastres, seller_payable, platform_retained, ledger_entry_id, recorded_at)
        values (${i.listingId}::uuid, ${i.proceeds.gross.toString()}::bigint, ${i.proceeds.sellerPayable.toString()}::bigint,
          ${i.proceeds.platformRetained.toString()}::bigint, ${i.proceeds.ledgerEntryId}::uuid, ${iso(i.proceeds.recordedAtMs)}::timestamptz)`.execute(trx);
      await this.emit(trx, i.events);
      return "ok" as const;
    });
  }

  async withdraw(i: { listingId: string; events: readonly ResaleEvent[] }) {
    if (!UUID.test(i.listingId)) return "not_found" as const;
    return this.tx(async (trx) => {
      const upd = await sql`update resale_listings set status = 'WITHDRAWN' where id = ${i.listingId}::uuid and status = 'LISTED' returning id`.execute(trx);
      if (upd.rows.length === 0) {
        const ex = await sql`select 1 from resale_listings where id = ${i.listingId}::uuid`.execute(trx);
        return ex.rows.length === 0 ? ("not_found" as const) : ("not_listed" as const);
      }
      await this.emit(trx, i.events);
      return "ok" as const;
    });
  }
}
