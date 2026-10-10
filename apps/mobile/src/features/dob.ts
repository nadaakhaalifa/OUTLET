import {
  evaluateOnboardingAge,
  parseCivilDate,
  type CivilDate,
  type DeviceSoftBlock,
  type PrivacyClock,
} from "../workspace";
import { toAsciiDigits } from "./phone";

export interface DobFields {
  readonly day: string;
  readonly month: string;
  readonly year: string;
}

export type DobParse =
  | { readonly ok: true; readonly dob: CivilDate }
  | { readonly ok: false; readonly reason: "incomplete" | "invalid" };

export function parseDobFields(fields: DobFields): DobParse {
  const d = toAsciiDigits(fields.day).trim();
  const m = toAsciiDigits(fields.month).trim();
  const y = toAsciiDigits(fields.year).trim();
  if (d === "" || m === "" || y === "") return { ok: false, reason: "incomplete" };
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^\d{4}$/.test(y)) return { ok: false, reason: "invalid" };
  try {
    return { ok: true, dob: parseCivilDate({ year: Number(y), month: Number(m), day: Number(d) }) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export type AgeGateOutcome =
  | { readonly kind: "invalid_date" }
  | { readonly kind: "needs_attestation" }
  | { readonly kind: "accepted"; readonly limitedCapacity: boolean; readonly dob: CivilDate }
  | { readonly kind: "blocked_under_18"; readonly block: DeviceSoftBlock }
  | { readonly kind: "blocked_device" };

export interface AgeGateDeps {
  readonly hasher: (input: string) => string;
  readonly clock: PrivacyClock;
}

/**
 * The DOB step. A refusal returns nothing derived from the date of birth (no age, no DOB): the
 * caller persists the soft block only. The date is returned only on acceptance, to be sent to the
 * server once and never stored on the device.
 */
export function assessAge(
  fields: DobFields,
  attestedAtLeast18: boolean,
  deviceId: string,
  existingBlock: DeviceSoftBlock | undefined,
  deps: AgeGateDeps,
): AgeGateOutcome {
  const parsed = parseDobFields(fields);
  if (!parsed.ok) return { kind: "invalid_date" };
  let result;
  try {
    result = evaluateOnboardingAge(
      { dob: parsed.dob, attestedAtLeast18, deviceId, existingBlock },
      deps.hasher,
      deps.clock,
    );
  } catch {
    // DOB in the future or similar: treat as an invalid date, never as acceptance.
    return { kind: "invalid_date" };
  }
  switch (result.outcome) {
    case "accepted":
      return { kind: "accepted", limitedCapacity: result.limitedCapacity, dob: parsed.dob };
    case "refused_under_18":
      return { kind: "blocked_under_18", block: result.block };
    case "refused_no_attestation":
      return { kind: "needs_attestation" };
    case "refused_device_blocked":
      return { kind: "blocked_device" };
  }
}
