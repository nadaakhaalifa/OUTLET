import { addresses } from "@outlet/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { AddressRow, AddressStore, AddressTx, CityRow, CoverageSource, GiftTokenRow, GovernorateRow, SnapshotRow } from "./ports";

export type AddressDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array).transform((v) => new Uint8Array(v));
const Cov = z.enum(["covered", "not_covered", "unknown"]);

const AddrRow = z.object({
  id: z.string(),
  user_id: z.string(),
  label: z.string().nullable(),
  recipient_name_enc: Bytes,
  phone_enc: Bytes,
  phone_blind: Bytes,
  governorate_code: z.string(),
  city_code: z.string(),
  street_enc: Bytes,
  building_enc: Bytes,
  floor_enc: Bytes.nullable(),
  apartment_enc: Bytes.nullable(),
  landmark_enc: Bytes.nullable(),
  map_pin_enc: Bytes.nullable(),
  dedupe_blind: Bytes,
  courier_coverage: Cov,
  cod_eligible: z.boolean(),
  quality_score: z.number().int(),
  is_default: z.boolean(),
  created_ms: Ms,
  updated_ms: Ms,
});
const SnapRow = z.object({
  id: z.string(),
  user_id: z.string(),
  order_ref: z.string(),
  source_address_id: z.string().nullable(),
  gift: z.boolean(),
  recipient_name_enc: Bytes,
  phone_enc: Bytes,
  governorate_code: z.string(),
  city_code: z.string(),
  street_enc: Bytes,
  building_enc: Bytes,
  floor_enc: Bytes.nullable(),
  apartment_enc: Bytes.nullable(),
  landmark_enc: Bytes.nullable(),
  map_pin_enc: Bytes.nullable(),
  courier_coverage: Cov,
  cod_eligible: z.boolean(),
  created_ms: Ms,
});
const TokRow = z.object({ token_hash: Bytes, owner_user_id: z.string(), address_id: z.string(), expires_ms: Ms, revoked_ms: Ms.nullable() });

const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const iso = (ms: number): string => new Date(ms).toISOString();
const buf = (b: Uint8Array | null): Buffer | null => (b === null ? null : Buffer.from(b));

const ADDR_COLS = sql`id::text as id, user_id::text as user_id, label, recipient_name_enc, phone_enc, phone_blind,
  governorate_code, city_code, street_enc, building_enc, floor_enc, apartment_enc, landmark_enc, map_pin_enc,
  dedupe_blind, courier_coverage, cod_eligible, quality_score::int as quality_score, is_default,
  ${EPOCH("created_at")} as created_ms, ${EPOCH("updated_at")} as updated_ms`;
const SNAP_COLS = sql`id::text as id, user_id::text as user_id, order_ref, source_address_id::text as source_address_id, gift,
  recipient_name_enc, phone_enc, governorate_code, city_code, street_enc, building_enc, floor_enc, apartment_enc,
  landmark_enc, map_pin_enc, courier_coverage, cod_eligible, ${EPOCH("created_at")} as created_ms`;

const toAddr = (raw: unknown): AddressRow => {
  const r = AddrRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    recipientNameEnc: r.recipient_name_enc,
    phoneEnc: r.phone_enc,
    phoneBlind: r.phone_blind,
    governorateCode: r.governorate_code,
    cityCode: r.city_code,
    streetEnc: r.street_enc,
    buildingEnc: r.building_enc,
    floorEnc: r.floor_enc,
    apartmentEnc: r.apartment_enc,
    landmarkEnc: r.landmark_enc,
    mapPinEnc: r.map_pin_enc,
    dedupeBlind: r.dedupe_blind,
    courierCoverage: r.courier_coverage,
    codEligible: r.cod_eligible,
    qualityScore: r.quality_score,
    isDefault: r.is_default,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};
const toSnap = (raw: unknown): SnapshotRow => {
  const r = SnapRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    orderRef: r.order_ref,
    sourceAddressId: r.source_address_id,
    gift: r.gift,
    recipientNameEnc: r.recipient_name_enc,
    phoneEnc: r.phone_enc,
    governorateCode: r.governorate_code,
    cityCode: r.city_code,
    streetEnc: r.street_enc,
    buildingEnc: r.building_enc,
    floorEnc: r.floor_enc,
    apartmentEnc: r.apartment_enc,
    landmarkEnc: r.landmark_enc,
    mapPinEnc: r.map_pin_enc,
    courierCoverage: r.courier_coverage,
    codEligible: r.cod_eligible,
    createdAtMs: r.created_ms,
  };
};

const system = async <T>(db: AddressDb, fn: (trx: Transaction<Record<string, never>>) => Promise<T>, readOnly = false): Promise<T> =>
  db.transaction().execute(async (trx) => {
    if (readOnly) await sql`set transaction read only`.execute(trx);
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return fn(trx);
  });

class KyselyCoverage implements CoverageSource {
  constructor(private readonly db: AddressDb) {}
  async entries(): Promise<readonly addresses.CoverageEntry[]> {
    const r = await sql<unknown>`select cc.courier, cc.governorate_code, cc.city_code, cc.covered, c.cod_supported
      from courier_coverage cc join couriers c on c.code = cc.courier where c.active`.execute(this.db);
    return z
      .array(z.object({ courier: z.string(), governorate_code: z.string(), city_code: z.string().nullable(), covered: z.boolean(), cod_supported: z.boolean() }))
      .parse(r.rows)
      .map((x) => ({ courier: x.courier, governorateCode: x.governorate_code, cityCode: x.city_code, covered: x.covered, codSupported: x.cod_supported }));
  }
  async governorates(): Promise<readonly (GovernorateRow & { covered: boolean })[]> {
    const g = await sql<unknown>`select code, name_ar, name_en from coverage_governorates order by position`.execute(this.db);
    const entries = await this.entries();
    return z
      .array(z.object({ code: z.string(), name_ar: z.string(), name_en: z.string() }))
      .parse(g.rows)
      .map((x) => ({ code: x.code, nameAr: x.name_ar, nameEn: x.name_en, covered: entries.some((e) => e.governorateCode === x.code && e.cityCode === null && e.covered) }));
  }
  async cities(governorateCode: string): Promise<readonly (CityRow & { covered: boolean })[] | null> {
    const g = await sql<{ code: string }>`select code from coverage_governorates where code = ${governorateCode}`.execute(this.db);
    if (g.rows.length === 0) return null;
    const r = await sql<unknown>`select code, name_ar, name_en from coverage_cities where governorate_code = ${governorateCode} order by position`.execute(this.db);
    const entries = await this.entries();
    return z
      .array(z.object({ code: z.string(), name_ar: z.string(), name_en: z.string() }))
      .parse(r.rows)
      .map((x) => ({
        governorateCode,
        code: x.code,
        nameAr: x.name_ar,
        nameEn: x.name_en,
        covered: addresses.evaluateCoverage(entries, governorateCode, x.code).coverage === "covered",
      }));
  }
}

/**
 * Postgres adapter. One transaction per call under the `system` role (authorization is the policy
 * guard and the owner-only query shape; RLS stays on for every other role). `run` takes a
 * transaction advisory lock per user so count, default and dedupe checks serialize.
 */
export class KyselyAddressStore implements AddressStore {
  readonly coverage: CoverageSource;
  constructor(private readonly db: AddressDb) {
    this.coverage = new KyselyCoverage(db);
  }

  async run<T>(userId: string, fn: (tx: AddressTx) => Promise<T>): Promise<T> {
    return system(this.db, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`addresses:${userId}`}, 0))`.execute(trx);
      const tx: AddressTx = {
        all: async () => (await sql<unknown>`select ${ADDR_COLS} from saved_addresses where user_id = ${userId}::uuid order by created_at desc, id desc`.execute(trx)).rows.map(toAddr),
        get: async (id) => {
          const r = await sql<unknown>`select ${ADDR_COLS} from saved_addresses where user_id = ${userId}::uuid and id = ${id}::uuid`.execute(trx);
          return r.rows[0] === undefined ? null : toAddr(r.rows[0]);
        },
        insert: async (r) => {
          await sql`insert into saved_addresses (id, user_id, label, recipient_name_enc, phone_enc, phone_blind, governorate_code, city_code,
              street_enc, building_enc, floor_enc, apartment_enc, landmark_enc, map_pin_enc, dedupe_blind, courier_coverage, cod_eligible,
              quality_score, is_default, created_at, updated_at)
            values (${r.id}::uuid, ${userId}::uuid, ${r.label}, ${buf(r.recipientNameEnc)}, ${buf(r.phoneEnc)}, ${buf(r.phoneBlind)}, ${r.governorateCode}, ${r.cityCode},
              ${buf(r.streetEnc)}, ${buf(r.buildingEnc)}, ${buf(r.floorEnc)}, ${buf(r.apartmentEnc)}, ${buf(r.landmarkEnc)}, ${buf(r.mapPinEnc)}, ${buf(r.dedupeBlind)},
              ${r.courierCoverage}, ${r.codEligible}, ${r.qualityScore}, ${r.isDefault}, ${iso(r.createdAtMs)}::timestamptz, ${iso(r.updatedAtMs)}::timestamptz)`.execute(trx);
        },
        update: async (r) => {
          await sql`update saved_addresses set label = ${r.label}, recipient_name_enc = ${buf(r.recipientNameEnc)}, phone_enc = ${buf(r.phoneEnc)},
              phone_blind = ${buf(r.phoneBlind)}, governorate_code = ${r.governorateCode}, city_code = ${r.cityCode}, street_enc = ${buf(r.streetEnc)},
              building_enc = ${buf(r.buildingEnc)}, floor_enc = ${buf(r.floorEnc)}, apartment_enc = ${buf(r.apartmentEnc)}, landmark_enc = ${buf(r.landmarkEnc)},
              map_pin_enc = ${buf(r.mapPinEnc)}, dedupe_blind = ${buf(r.dedupeBlind)}, courier_coverage = ${r.courierCoverage}, cod_eligible = ${r.codEligible},
              quality_score = ${r.qualityScore}, is_default = ${r.isDefault}, updated_at = ${iso(r.updatedAtMs)}::timestamptz
            where id = ${r.id}::uuid and user_id = ${userId}::uuid`.execute(trx);
        },
        remove: async (id) => {
          await sql`delete from saved_addresses where id = ${id}::uuid and user_id = ${userId}::uuid`.execute(trx);
        },
      };
      return fn(tx);
    });
  }

  async page(userId: string, after: { createdAtMs: number; id: string } | null, limit: number): Promise<readonly AddressRow[]> {
    return system(
      this.db,
      async (trx) => {
        const r = await sql<unknown>`select ${ADDR_COLS} from saved_addresses where user_id = ${userId}::uuid
          and (${after === null}::boolean or (created_at, id) < (${iso(after?.createdAtMs ?? 0)}::timestamptz, ${after?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
          order by created_at desc, id desc limit ${limit}`.execute(trx);
        return r.rows.map(toAddr);
      },
      true,
    );
  }

  async find(userId: string, id: string): Promise<AddressRow | null> {
    return system(
      this.db,
      async (trx) => {
        const r = await sql<unknown>`select ${ADDR_COLS} from saved_addresses where user_id = ${userId}::uuid and id = ${id}::uuid`.execute(trx);
        return r.rows[0] === undefined ? null : toAddr(r.rows[0]);
      },
      true,
    );
  }

  async insertSnapshot(s: SnapshotRow): Promise<SnapshotRow> {
    return system(this.db, async (trx) => {
      await sql`insert into delivery_snapshots (id, user_id, order_ref, source_address_id, gift, recipient_name_enc, phone_enc, governorate_code, city_code,
          street_enc, building_enc, floor_enc, apartment_enc, landmark_enc, map_pin_enc, courier_coverage, cod_eligible, created_at)
        values (${s.id}::uuid, ${s.userId}::uuid, ${s.orderRef}, ${s.sourceAddressId}::uuid, ${s.gift}, ${buf(s.recipientNameEnc)}, ${buf(s.phoneEnc)}, ${s.governorateCode}, ${s.cityCode},
          ${buf(s.streetEnc)}, ${buf(s.buildingEnc)}, ${buf(s.floorEnc)}, ${buf(s.apartmentEnc)}, ${buf(s.landmarkEnc)}, ${buf(s.mapPinEnc)}, ${s.courierCoverage}, ${s.codEligible},
          ${iso(s.createdAtMs)}::timestamptz) on conflict (user_id, order_ref) do nothing`.execute(trx);
      const r = await sql<unknown>`select ${SNAP_COLS} from delivery_snapshots where user_id = ${s.userId}::uuid and order_ref = ${s.orderRef}`.execute(trx);
      return toSnap(r.rows[0]);
    });
  }

  async findSnapshot(id: string): Promise<SnapshotRow | null> {
    return system(
      this.db,
      async (trx) => {
        const r = await sql<unknown>`select ${SNAP_COLS} from delivery_snapshots where id = ${id}::uuid`.execute(trx);
        return r.rows[0] === undefined ? null : toSnap(r.rows[0]);
      },
      true,
    );
  }

  async insertGiftToken(t: GiftTokenRow): Promise<void> {
    await system(this.db, async (trx) => {
      await sql`insert into gift_address_tokens (token_hash, owner_user_id, address_id, expires_at)
        values (${buf(t.tokenHash)}, ${t.ownerUserId}::uuid, ${t.addressId}::uuid, ${iso(t.expiresAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async findGiftToken(tokenHash: Uint8Array): Promise<GiftTokenRow | null> {
    return system(
      this.db,
      async (trx) => {
        const r = await sql<unknown>`select token_hash, owner_user_id::text as owner_user_id, address_id::text as address_id,
          ${EPOCH("expires_at")} as expires_ms, ${EPOCH("revoked_at")} as revoked_ms from gift_address_tokens where token_hash = ${buf(tokenHash)}`.execute(trx);
        if (r.rows[0] === undefined) return null;
        const x = TokRow.parse(r.rows[0]);
        return { tokenHash: x.token_hash, ownerUserId: x.owner_user_id, addressId: x.address_id, expiresAtMs: x.expires_ms, revokedAtMs: x.revoked_ms };
      },
      true,
    );
  }

  async revokeGiftToken(ownerUserId: string, tokenHash: Uint8Array, atMs: number): Promise<boolean> {
    return system(this.db, async (trx) => {
      const r = await sql<{ n: string }>`with u as (update gift_address_tokens set revoked_at = ${iso(atMs)}::timestamptz
        where token_hash = ${buf(tokenHash)} and owner_user_id = ${ownerUserId}::uuid and revoked_at is null returning 1)
        select count(*)::text as n from u`.execute(trx);
      return r.rows[0]?.n === "1";
    });
  }
}
