import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import type { GeoArea, GeoAreaRow, GeoPort } from "./services.js";

interface Row { id: string; parent_id: string | null; level: string; code: string }
const toArea = (r: Row): GeoArea => ({ id: r.id, parentId: r.parent_id, level: r.level, code: r.code });

export class GeoReader implements GeoPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  async list(q: { readonly parentId?: string; readonly level?: string; readonly limit: number; readonly cursor?: string }): Promise<{ readonly items: readonly GeoAreaRow[]; readonly nextCursor: string | null }> {
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, 2);
    const rows = await withDbContext(this.client, { kind: "user", marketId: this.marketId }, async (tx) =>
      (
        await tx.query<Row & { name_ar: string; name_en: string | null; shipping_zone_code: string | null }>(
          `SELECT id, parent_id, level, code, name_ar, name_en, shipping_zone_code FROM geo_areas
            WHERE market_id = $1 AND active AND ($2::uuid IS NULL OR parent_id = $2) AND ($3::text IS NULL OR level = $3)
              AND ($4::text IS NULL OR (code, id) > ($4::text, $5::uuid))
            ORDER BY code, id LIMIT $6`,
          [this.marketId, q.parentId ?? null, q.level ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
        )
      ).rows,
    );
    const shown = rows.slice(0, q.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((r) => ({ ...toArea(r), nameAr: r.name_ar, nameEn: r.name_en, shippingZoneCode: r.shipping_zone_code })),
      nextCursor: rows.length > q.limit && last !== undefined ? encodeCursor(last.code, last.id) : null,
    };
  }

  async byIds(ids: readonly string[]): Promise<readonly GeoArea[]> {
    const rows = await withDbContext(this.client, { kind: "user", marketId: this.marketId }, async (tx) =>
      (await tx.query<Row>("SELECT id, parent_id, level, code FROM geo_areas WHERE market_id = $1 AND active AND id = ANY($2::uuid[])", [this.marketId, ids])).rows,
    );
    return rows.map(toArea);
  }

  async byCodes(codes: readonly string[]): Promise<readonly GeoArea[]> {
    const rows = await withDbContext(this.client, { kind: "user", marketId: this.marketId }, async (tx) =>
      (await tx.query<Row>("SELECT id, parent_id, level, code FROM geo_areas WHERE market_id = $1 AND code = ANY($2::text[])", [this.marketId, codes])).rows,
    );
    return rows.map(toArea);
  }

  async stamps(userId: string, ids: readonly string[]): Promise<ReadonlyMap<string, { readonly createdAt: Date; readonly validatedAt: Date | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) =>
      (await tx.query<{ id: string; created_at: Date; validated_at: Date | null }>("SELECT id, created_at, validated_at FROM addresses WHERE id = ANY($1::uuid[])", [ids])).rows,
    );
    return new Map(rows.map((r) => [r.id, { createdAt: new Date(r.created_at), validatedAt: r.validated_at === null ? null : new Date(r.validated_at) }]));
  }
}
