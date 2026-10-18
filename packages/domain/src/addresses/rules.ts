export const MAX_ADDRESSES_PER_USER = 10;

export type CourierCoverage = "covered" | "not_covered" | "unknown";

export interface CoverageEntry {
  readonly courier: string;
  readonly governorateCode: string;
  /** Null = governorate-level row. */
  readonly cityCode: string | null;
  readonly covered: boolean;
  readonly codSupported: boolean;
}

export interface CoverageResult {
  readonly coverage: CourierCoverage;
  readonly codSupported: boolean;
}

/**
 * A city-level row overrides the governorate-level row of the same courier. The address is covered
 * if ANY courier covers it; COD collection is supported if a covering courier supports it. With no
 * rows for the governorate at all the answer is `unknown` (never a guess).
 */
export function evaluateCoverage(entries: readonly CoverageEntry[], governorateCode: string, cityCode: string): CoverageResult {
  const rows = entries.filter((e) => e.governorateCode === governorateCode);
  if (rows.length === 0) return { coverage: "unknown", codSupported: false };
  const couriers = new Set(rows.map((r) => r.courier));
  let covered = false;
  let cod = false;
  for (const courier of couriers) {
    const mine = rows.filter((r) => r.courier === courier);
    const eff = mine.find((r) => r.cityCode === cityCode) ?? mine.find((r) => r.cityCode === null);
    if (eff?.covered === true) {
      covered = true;
      if (eff.codSupported) cod = true;
    }
  }
  return { coverage: covered ? "covered" : "not_covered", codSupported: cod };
}

export interface MapPin {
  readonly lat: number;
  readonly lng: number;
}

/** Bounding box of Egypt (with margin). A pin outside it is a client bug or abuse, not a delivery address. */
export function isValidEgyptMapPin(pin: MapPin): boolean {
  return Number.isFinite(pin.lat) && Number.isFinite(pin.lng) && pin.lat >= 21.5 && pin.lat <= 32 && pin.lng >= 24.5 && pin.lng <= 37;
}

/** COD needs a landmark AND a map pin AND a covering courier that collects cash (spec 20.7). */
export function isCodEligible(a: { readonly landmark?: string | undefined; readonly mapPin?: MapPin | undefined; readonly coverage: CourierCoverage; readonly codSupported: boolean }): boolean {
  return a.coverage === "covered" && a.codSupported && a.landmark !== undefined && a.landmark.trim().length > 0 && a.mapPin !== undefined;
}

export interface QualityInput {
  readonly recipientName?: string | undefined;
  readonly phoneE164?: string | undefined;
  readonly governorateCode?: string | undefined;
  readonly cityDistrictCode?: string | undefined;
  readonly street?: string | undefined;
  readonly building?: string | undefined;
  readonly floor?: string | undefined;
  readonly apartment?: string | undefined;
  readonly landmark?: string | undefined;
  readonly mapPin?: MapPin | undefined;
}

const present = (s: string | undefined, min = 1): boolean => s !== undefined && s.trim().length >= min;

/** Completeness 0 to 100 (pure). Weights: pin 20, street 15, landmark 15, phone 10, recipient 10, building 10, gov 5, city 5, floor 5, apartment 5. */
export function addressQualityScore(a: QualityInput): number {
  let s = 0;
  if (a.mapPin !== undefined && isValidEgyptMapPin(a.mapPin)) s += 20;
  if (present(a.street, 5)) s += 15;
  if (present(a.landmark, 3)) s += 15;
  if (a.phoneE164 !== undefined && E164.test(a.phoneE164)) s += 10;
  if (present(a.recipientName, 2)) s += 10;
  if (present(a.building)) s += 10;
  if (present(a.governorateCode)) s += 5;
  if (present(a.cityDistrictCode)) s += 5;
  if (present(a.floor)) s += 5;
  if (present(a.apartment)) s += 5;
  return s;
}
const E164 = /^\+201[0125]\d{8}$/;

export interface DefaultCandidate {
  readonly id: string;
  readonly createdAtMs: number;
  readonly isDefault: boolean;
}

/** Id to promote after deleting `deletedId`: only if it was the default; the most recent remaining address wins. */
export function promoteAfterDelete(all: readonly DefaultCandidate[], deletedId: string): string | null {
  const deleted = all.find((a) => a.id === deletedId);
  if (deleted === undefined || !deleted.isDefault) return null;
  const rest = all.filter((a) => a.id !== deletedId).sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1));
  return rest[0]?.id ?? null;
}

/** Normalizes the dedupe key input (case, whitespace, Arabic/Latin digits are left as typed beyond trim and collapse). */
export function dedupeKey(a: { governorateCode: string; cityDistrictCode: string; street: string; building: string; floor?: string | undefined; apartment?: string | undefined }): string {
  const n = (v: string | undefined): string => (v ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return [a.governorateCode, a.cityDistrictCode, n(a.street), n(a.building), n(a.floor), n(a.apartment)].join("|");
}

/** First name for courier-facing contact: first whitespace token of the recipient name, or null. */
export function firstNameOf(full: string): string | null {
  const t = full.trim().split(/\s+/)[0];
  return t === undefined || t === "" ? null : t;
}
