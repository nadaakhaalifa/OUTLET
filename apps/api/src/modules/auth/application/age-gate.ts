import {
  AGE_BLOCK_MS,
  MINIMUM_AGE_YEARS,
  MS,
  ageBlockKey,
  ageOn,
  isFutureDate,
  parseCalendarDate,
  type AttestationVerifier,
  type CalendarDate,
} from "@outlet/auth-core";
import type { AgeBand, AgeGateStore, AgePassInfo, AuthEventPublisher, FieldCipher } from "../domain/ports";
import { attestDevice, type Attestation, type Clock } from "./common";

/** How long a passed gate stays valid for the OTP / social sign-in that follows it. */
export const AGE_GATE_PASS_TTL_MS = 24 * MS.hour;
const DOB_SALT = "outlet-nk/age-gate/dob/v1";

export interface AgeGateDeps {
  readonly attestation: AttestationVerifier;
  readonly store: AgeGateStore;
  readonly events: AuthEventPublisher;
  readonly clock: Clock;
  /** HMAC key for every identifier the store sees. Never logged, never returned. */
  readonly secret: Uint8Array;
  /** Encrypts the DOB kept (24 h at most) with the pass so the account can store it as P3. Optional in dev. */
  readonly cipher?: FieldCipher;
}

/** 18 to 20 year olds are `limited_capacity` (spec B6); 21 is the Civil Code majority. */
export const ADULT_AGE_YEARS = 21;
export function ageBandOf(ageYears: number): AgeBand {
  return ageYears >= ADULT_AGE_YEARS ? "21_plus" : "18_20";
}

export type AgeGateSubmitResult =
  | { readonly kind: "passed"; readonly expiresAtMs: number }
  | { readonly kind: "blocked"; readonly blockedUntilMs: number }
  | { readonly kind: "invalid_dob" };

export type AgeGateStatus =
  | { readonly kind: "cleared" }
  | { readonly kind: "required" }
  | { readonly kind: "blocked"; readonly blockedUntilMs: number };

/** The calendar date in Egypt at `nowMs`, so a birthday turns over at local midnight. */
export function cairoToday(nowMs: number): CalendarDate {
  const text = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
  const parsed = parseCalendarDate(text);
  if (parsed === null) throw new Error("could not compute the Cairo date");
  return parsed;
}

export class AgeGate {
  constructor(private readonly deps: AgeGateDeps) {}

  /** The attested device key for a request, or null when attestation is missing or invalid. */
  resolveDevice(attestation: Attestation | null): Promise<string | null> {
    return attestDevice(this.deps.attestation, attestation);
  }

  private attestedKey(attestedDeviceKey: string): string {
    return ageBlockKey(this.deps.secret, "attested_device", attestedDeviceKey);
  }

  /**
   * Evaluates the DOB server side. Stores only HMAC identifiers and expiry times: no DOB, no age,
   * no phone. A block is keyed on the attested device key, the client's device id hash and the
   * keyed DOB, so changing one of them does not lift it.
   */
  async submit(input: {
    readonly dob: string;
    readonly deviceIdHash: string;
    readonly attestedDeviceKey: string;
  }): Promise<AgeGateSubmitResult> {
    const d = this.deps;
    const nowMs = d.clock.nowMs();
    const dob = parseCalendarDate(input.dob);
    const today = cairoToday(nowMs);
    if (dob === null || isFutureDate(dob, today)) return { kind: "invalid_dob" };

    const deviceKeys = [
      this.attestedKey(input.attestedDeviceKey),
      ageBlockKey(d.secret, "device_id_hash", input.deviceIdHash),
    ];
    const dobKey = ageBlockKey(d.secret, "dob", input.dob, DOB_SALT);

    const existing = await d.store.activeBlock([...deviceKeys, dobKey], nowMs);
    if (existing !== null) return { kind: "blocked", blockedUntilMs: existing };

    const age = ageOn(dob, today);
    if (age < MINIMUM_AGE_YEARS) {
      const until = nowMs + AGE_BLOCK_MS;
      await d.store.block([...deviceKeys, dobKey], until);
      await d.events.publish({ type: "user.age_blocked", occurredAtMs: nowMs });
      return { kind: "blocked", blockedUntilMs: until };
    }

    const expiresAtMs = nowMs + AGE_GATE_PASS_TTL_MS;
    const dobCiphertext = d.cipher === undefined ? null : await d.cipher.encrypt(input.dob, "users.dob");
    await d.store.markPassed(this.attestedKey(input.attestedDeviceKey), expiresAtMs, { ageBand: ageBandOf(age), dobCiphertext });
    return { kind: "passed", expiresAtMs };
  }

  /** Called before any OTP is sent and before social or passkey sign-in. */
  async status(attestedDeviceKey: string): Promise<AgeGateStatus> {
    const nowMs = this.deps.clock.nowMs();
    const key = this.attestedKey(attestedDeviceKey);
    const blocked = await this.deps.store.activeBlock([key], nowMs);
    if (blocked !== null) return { kind: "blocked", blockedUntilMs: blocked };
    return (await this.deps.store.hasPassed(key, nowMs)) ? { kind: "cleared" } : { kind: "required" };
  }

  /** Age band (and encrypted DOB) of the pass this device holds, for the account created next. */
  passInfo(attestedDeviceKey: string): Promise<AgePassInfo | null> {
    return this.deps.store.passInfo(this.attestedKey(attestedDeviceKey), this.deps.clock.nowMs());
  }

  /** Same key derivation, exposed so tests and dev tooling can grant a pass without a request. */
  passKeyFor(attestedDeviceKey: string): string {
    return this.attestedKey(attestedDeviceKey);
  }
}
