/** Versioned schema chain: one pure function per bump. */
import {
  GUEST_SCHEMA_VERSION, GuestStateV1Schema, GuestStateV2Schema, GuestStateV3Schema, GuestStateV4Schema,
  type GuestState, type GuestStateV1, type GuestStateV2, type GuestStateV3,
} from "./schema";

export function migrateV1ToV2(s: GuestStateV1): GuestStateV2 {
  return { ...s, v: 2, installId: "legacy-v1-placeholder", consentBanner: "unanswered" };
}

/** Drops installId (never persisted from v3 on). */
export function migrateV2ToV3(s: GuestStateV2): GuestStateV3 {
  const { installId: _dropped, ...rest } = s;
  void _dropped;
  return { ...rest, v: 3 };
}

/** Additive: empty alerts. */
export function migrateV3ToV4(s: GuestStateV3): GuestState {
  return { ...s, v: 4, alerts: [], settings: { coolOff: false, historyPaused: false } };
}

export type MigrateResult =
  | { readonly kind: "ok"; readonly state: GuestState; readonly migrated: boolean }
  | { readonly kind: "newer" }
  | { readonly kind: "invalid" };

/** raw is parsed JSON. A version above the app's is "newer" (read-only empty view, file untouched). */
export function migrate(raw: unknown): MigrateResult {
  if (typeof raw !== "object" || raw === null) return { kind: "invalid" };
  const v = (raw as { v?: unknown }).v;
  if (typeof v === "number" && v > GUEST_SCHEMA_VERSION) return { kind: "newer" };
  if (v === 1) {
    const p = GuestStateV1Schema.safeParse(raw);
    return p.success ? { kind: "ok", state: migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(p.data))), migrated: true } : { kind: "invalid" };
  }
  if (v === 2) {
    const p = GuestStateV2Schema.safeParse(raw);
    return p.success ? { kind: "ok", state: migrateV3ToV4(migrateV2ToV3(p.data)), migrated: true } : { kind: "invalid" };
  }
  if (v === 3) {
    const p = GuestStateV3Schema.safeParse(raw);
    return p.success ? { kind: "ok", state: migrateV3ToV4(p.data), migrated: true } : { kind: "invalid" };
  }
  if (v === 4) {
    const p = GuestStateV4Schema.safeParse(raw);
    return p.success ? { kind: "ok", state: p.data, migrated: false } : { kind: "invalid" };
  }
  return { kind: "invalid" };
}
