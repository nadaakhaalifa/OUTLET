import type { AddressService } from "@outlet/shipping";

/** The shopper's own address book (P3, field-encrypted by the package). Every call binds the user context: a foreign id is invisible under RLS. */
export interface AddressesServices {
  readonly addresses: Pick<AddressService, "create" | "list" | "get" | "update" | "remove">;
  /** Geo picker lookups (public configuration, no tenant key). */
  readonly geo: GeoPort;
}

export interface GeoAreaRow extends GeoArea {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly shippingZoneCode: string | null;
}

export interface GeoArea {
  readonly id: string;
  readonly parentId: string | null;
  readonly level: string;
  readonly code: string;
}

export interface GeoPort {
  list(q: { readonly parentId?: string; readonly level?: string; readonly limit: number; readonly cursor?: string }): Promise<{ readonly items: readonly GeoAreaRow[]; readonly nextCursor: string | null }>;
  byIds(ids: readonly string[]): Promise<readonly GeoArea[]>;
  byCodes(codes: readonly string[]): Promise<readonly GeoArea[]>;
  /** created_at and validated_at of the caller's own addresses (not part of the package view). */
  stamps(userId: string, ids: readonly string[]): Promise<ReadonlyMap<string, { readonly createdAt: Date; readonly validatedAt: Date | null }>>;
}
