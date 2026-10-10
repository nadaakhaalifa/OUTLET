import { z } from "zod";
import { sha256Hex } from "@outlet/idempotency";
import type { Position } from "../domain/directory";
import { healthBadge, publicDiscountPct, publicRating, SORTS, WORLDS, type Sort, type World } from "../domain/store";
import type { StoreView } from "../application/views";
import type { HiddenFavorite } from "../application/favorites";

export const UuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const ListStoresQuerySchema = z
  .object({
    world: z.enum(WORLDS),
    sort: z.enum(SORTS).optional(),
    cursor: z.string().max(512).optional(),
    limit: z
      .string()
      .regex(/^[0-9]{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(50))
      .optional(),
  })
  .strict();

export const FavoriteStoresUpdateSchema = z
  .object({ store_ids: z.array(UuidSchema).max(30) })
  .strict();

export const StoreIdParamSchema = z.object({ storeId: UuidSchema }).strict();

// ---- Cursor ------------------------------------------------------------------------------

const CursorSchema = z
  .object({
    w: z.enum(WORLDS),
    o: z.string().max(40),
    k: z.union([z.number().finite(), z.string().max(400), z.null()]),
    i: UuidSchema,
  })
  .strict();

export function encodeCursor(world: World, ordering: string, last: Position): string {
  return Buffer.from(JSON.stringify({ w: world, o: ordering, k: last.key, i: last.id })).toString("base64url");
}

/** Returns null for anything that is not a cursor for this exact (world, ordering). */
export function decodeCursor(raw: string, world: World, ordering: string): Position | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = CursorSchema.safeParse(json);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.w !== world || c.o !== ordering) return null;
  return { key: c.k, id: c.i };
}

// ---- Representations ---------------------------------------------------------------------

function localized(ar: string, en: string | null): { ar: string; en?: string } {
  return en === null ? { ar } : { ar, en };
}

export function toSummary(v: StoreView) {
  const s = v.store;
  return {
    id: s.id,
    slug: s.slug,
    name: localized(s.nameAr, s.nameEn),
    kind: s.kind,
    ...(s.logoUrl !== null ? { logo_url: s.logoUrl } : {}),
    ...(s.coverUrl !== null ? { cover_url: s.coverUrl } : {}),
    verified_badge: s.verifiedBadge,
    max_verified_discount_pct: publicDiscountPct(s.stats.maxVerifiedDiscountPct),
    rating: publicRating(s.stats.ratingAvg, s.stats.ratingCount),
    rating_count: s.stats.ratingCount,
    follower_count: v.followerCount,
    live_drop: s.stats.liveDrop,
    is_favorite: v.isFavorite,
  };
}

export function toStore(v: StoreView) {
  const s = v.store;
  const li = s.legalIdentity;
  const badge = healthBadge(s.healthScore);
  return {
    ...toSummary(v),
    ...(s.descriptionAr !== null ? { description: localized(s.descriptionAr, s.descriptionEn) } : {}),
    legal_identity: {
      legal_name: li === null ? "" : li.legalNameAr,
      ...(li !== null && li.commercialRegisterNo !== null ? { commercial_register_no: li.commercialRegisterNo } : {}),
      ...(li !== null && li.taxCardNo !== null ? { tax_id: li.taxCardNo } : {}),
      ...(li !== null ? { governorate: li.governorate } : {}),
    },
    free_delivery_threshold: { amount: s.freeDeliveryThresholdAmount.toString(), currency: "EGP" as const },
    status: s.status === "PAUSED" ? ("vacation" as const) : ("active" as const),
    ...(badge !== undefined ? { health_badge: badge } : {}),
  };
}

const HIDDEN_MESSAGES = {
  suspended: { ar: "هذا المتجر موقوف مؤقتا ولن يظهر حتى تتم إعادة تفعيله.", en: "This store is temporarily suspended and is hidden until it is reinstated." },
  unavailable: { ar: "هذا المتجر غير متاح حاليا.", en: "This store is currently unavailable." },
} as const;

export function toHidden(h: HiddenFavorite) {
  return { store_id: h.storeId, reason: h.reason, message: HIDDEN_MESSAGES[h.reason] };
}

export function etagOf(wire: unknown): string {
  return `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
}

function tokens(header: string): string[] {
  return header.split(",").map((t) => t.trim().replace(/^W\//, ""));
}

export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return tokens(header).some((t) => t === etag || t === "*");
}

export function matchesIfMatch(header: string, etag: string): boolean {
  return tokens(header).some((t) => t === etag);
}

export type { Sort };
