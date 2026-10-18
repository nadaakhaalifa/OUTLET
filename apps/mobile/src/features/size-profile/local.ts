/**
 * Device-local size profile for a signed-out shopper (spec guest-browsing section 2, "Size profile"). Measurements are
 * P3 data: they live in SecureStore (Keychain) under one key, never in the guest SQLite file and never on the network.
 * One profile ("Me"). It is synced after the checkout sign-up only with `measurements` consent (not built here).
 */
import { z } from "zod";
import type { SecureStorage } from "../../platform/secure-storage";
import { GUEST_SIZE_PROFILE_KEY } from "../guest/session";
import { MEASUREMENT_KEYS, PortError, type NewProfile, type SizeProfile, type SizeProfilePort } from "./model";

export { GUEST_SIZE_PROFILE_KEY };
export const LOCAL_PROFILE_ID = "local";

const Tenths = z.number().int().nonnegative();
const LocalProfileSchema = z.object({
  label: z.string().min(1).max(30),
  fitPreference: z.enum(["snug", "regular", "loose"]),
  modestFit: z.boolean(),
  measurements: z.object(Object.fromEntries(MEASUREMENT_KEYS.map((k) => [k, Tenths.optional()])) as Record<(typeof MEASUREMENT_KEYS)[number], z.ZodOptional<typeof Tenths>>).strict(),
  usualSize: z.string().max(12).nullable(),
}).strict();

export class LocalSizeProfilePort implements SizeProfilePort {
  constructor(private readonly storage: SecureStorage) {}

  async list(): Promise<readonly SizeProfile[]> {
    let stored: z.infer<typeof LocalProfileSchema> | null;
    try { stored = await this.storage.getJson(GUEST_SIZE_PROFILE_KEY, LocalProfileSchema); } catch { throw new PortError("failed"); }
    if (stored === null) return [];
    const measurements: Partial<Record<(typeof MEASUREMENT_KEYS)[number], number>> = {};
    for (const k of MEASUREMENT_KEYS) { const v = stored.measurements[k]; if (v !== undefined) measurements[k] = v; }
    return [{ id: LOCAL_PROFILE_ID, kind: "me", label: stored.label, fitPreference: stored.fitPreference, modestFit: stored.modestFit, measurements, usualSize: stored.usualSize }];
  }

  async save(profile: NewProfile | SizeProfile): Promise<SizeProfile> {
    const body = {
      label: profile.label.trim().slice(0, 30), fitPreference: profile.fitPreference, modestFit: profile.modestFit,
      measurements: { ...profile.measurements }, usualSize: profile.usualSize,
    };
    const parsed = LocalProfileSchema.safeParse(body);
    if (!parsed.success) throw new PortError("failed");
    try { await this.storage.setJson(GUEST_SIZE_PROFILE_KEY, parsed.data); } catch { throw new PortError("failed"); }
    return { id: LOCAL_PROFILE_ID, kind: "me", ...body };
  }

  async remove(_id: string): Promise<void> {
    try { await this.storage.remove(GUEST_SIZE_PROFILE_KEY); } catch { throw new PortError("failed"); }
  }
}
