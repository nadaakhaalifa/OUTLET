import { collectPages, dataOf, type schemas } from "../../services/api-client";
import { etagOf, guard, type AdapterContext } from "../../services/wire";
import { MEASUREMENT_KEYS, type MeasurementKey, type NewProfile, type SizeProfile, type SizeProfilePort } from "./model";

type WireKey = keyof schemas.Measurements;
/** App key -> wire key. `wrist` has no wire field (gap). */
const KEY_MAP: Readonly<Record<MeasurementKey, WireKey | null>> = {
  height: "height_cm", weight: "weight_kg", bust: "bust_cm", underBust: "under_bust_cm", waist: "waist_cm", highHip: "high_hip_cm",
  hip: "hip_cm", shoulders: "shoulders_cm", sleeve: "sleeve_cm", inseam: "inseam_cm", thigh: "thigh_cm", neck: "neck_cm",
  footLength: "foot_length_cm", footWidth: "foot_width_cm", wrist: null,
};

/** Tenths in the app (cm*10, kg*10) <-> cm/kg numbers on the wire. Integers only on the app side. */
export function toWireMeasurements(m: Readonly<Partial<Record<MeasurementKey, number>>>): schemas.Measurements {
  const out: Record<string, number> = {};
  for (const k of MEASUREMENT_KEYS) {
    const v = m[k];
    const w = KEY_MAP[k];
    if (v !== undefined && w !== null) out[w] = v / 10;
  }
  return out as schemas.Measurements;
}
export function fromWireMeasurements(m: schemas.Measurements | undefined): Partial<Record<MeasurementKey, number>> {
  const out: Partial<Record<MeasurementKey, number>> = {};
  if (m === undefined) return out;
  for (const k of MEASUREMENT_KEYS) {
    const w = KEY_MAP[k];
    const v = w === null ? undefined : m[w];
    if (v !== undefined) out[k] = Math.round(v * 10);
  }
  return out;
}

function fromWire(p: schemas.SizeProfile): SizeProfile {
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    fitPreference: p.fit_preference,
    modestFit: p.modest_fit ?? false,
    measurements: fromWireMeasurements(p.measurements),
    usualSize: p.usual_size?.size_label ?? null,
  };
}

function toBody(p: NewProfile): schemas.SizeProfileInput {
  return {
    label: p.label,
    kind: p.kind,
    fit_preference: p.fitPreference,
    modest_fit: p.modestFit,
    measurements: toWireMeasurements(p.measurements),
    ...(p.usualSize !== null ? { usual_size: { size_label: p.usualSize } } : {}),
  };
}

/** /v1/me/size-profiles. Measurements are P3 data: they stay inside this adapter and the request body. */
export class ApiSizeProfilePort implements SizeProfilePort {
  constructor(private readonly ctx: AdapterContext) {}

  list(): Promise<readonly SizeProfile[]> {
    return guard(async () => {
      const all = await collectPages((cursor) => this.ctx.client.listSizeProfiles({ query: { limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }), 5);
      return all.map(fromWire);
    });
  }

  save(profile: NewProfile | SizeProfile): Promise<SizeProfile> {
    return guard(async () => {
      const body = toBody(profile);
      if ("id" in profile) {
        const current = await this.ctx.client.getSizeProfile({ path: { profileId: profile.id } });
        return fromWire(dataOf(await this.ctx.client.updateSizeProfile({ path: { profileId: profile.id }, headers: { "If-Match": etagOf(current) }, body })));
      }
      return fromWire(dataOf(await this.ctx.client.createSizeProfile({ body })));
    });
  }

  remove(id: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.deleteSizeProfile({ path: { profileId: id } }));
    });
  }
}
