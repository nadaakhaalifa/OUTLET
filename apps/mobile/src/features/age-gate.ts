import type { AgeGateFailure, AgeGatePort } from "../api/age-gate";
import { SoftBlockSchema, type CivilDate, type DeviceSoftBlock, type PrivacyClock } from "../workspace";
import { assessAge, parseDobFields, type DobFields } from "./dob";

export type AgeGateViewOutcome =
  | { readonly kind: "invalid_date"; readonly incomplete: boolean }
  | { readonly kind: "needs_attestation" }
  | { readonly kind: "allowed"; readonly dob: CivilDate; readonly limitedCapacity: boolean }
  | { readonly kind: "blocked"; readonly blockedUntil: string; readonly source: "device" | "server" | "local_rule" }
  | { readonly kind: "error"; readonly reason: AgeGateFailure; readonly retryable: true };

export interface AgeGateRunDeps {
  readonly port: AgeGatePort;
  readonly hasher: (input: string) => string;
  readonly clock: PrivacyClock;
  readonly loadBlock: () => Promise<DeviceSoftBlock | null>;
  readonly saveBlock: (block: DeviceSoftBlock) => Promise<void>;
}

function isIncomplete(f: DobFields): boolean {
  return f.day.trim() === "" || f.month.trim() === "" || f.year.trim() === "";
}

/**
 * The age-gate step end to end. Order of authority:
 *  1. input validation and the attestation (local);
 *  2. an unexpired local device block (fast path, no network);
 *  3. the server, which decides for everyone, including a reinstalled app with no local state.
 * Fail closed: when the local rule says under 18 the user is blocked even if the server is
 * unreachable or disagrees (a skewed device clock must never turn a refusal into an acceptance).
 * An adult-looking date with no server answer is an error, not an acceptance.
 * The DOB is returned only for `allowed`, for a single later submission, and never persisted here.
 */
export async function runAgeGate(
  fields: DobFields,
  attested: boolean,
  installId: string,
  deps: AgeGateRunDeps,
): Promise<AgeGateViewOutcome> {
  const existing = (await deps.loadBlock()) ?? undefined;
  const local = assessAge(fields, attested, installId, existing, { hasher: deps.hasher, clock: deps.clock });
  switch (local.kind) {
    case "invalid_date":
      return { kind: "invalid_date", incomplete: isIncomplete(fields) };
    case "needs_attestation":
      return { kind: "needs_attestation" };
    case "blocked_device":
      return { kind: "blocked", blockedUntil: existing?.blockedUntil ?? deps.clock.now().toISOString(), source: "device" };
    default:
      break;
  }

  const parsed = local.kind === "accepted" ? local.dob : null;
  // For a local refusal the DOB is not exposed by assessAge; re-parse the typed fields for the server only.
  const dob = parsed ?? parseForServer(fields);
  if (dob === null) return { kind: "invalid_date", incomplete: isIncomplete(fields) };

  const response = await deps.port.check({ dob, deviceIdHash: deps.hasher(installId) });

  if (local.kind === "blocked_under_18") {
    await deps.saveBlock(local.block);
    const serverUntil = response.ok && !response.allowed ? validBlockUntil(response.blockedUntil) : null;
    if (serverUntil !== null && serverUntil > local.block.blockedUntil) {
      await deps.saveBlock({ deviceHash: local.block.deviceHash, blockedUntil: serverUntil });
      return { kind: "blocked", blockedUntil: serverUntil, source: "server" };
    }
    return { kind: "blocked", blockedUntil: local.block.blockedUntil, source: "local_rule" };
  }

  if (!response.ok) return { kind: "error", reason: response.error, retryable: true };
  if (!response.allowed) {
    const until = validBlockUntil(response.blockedUntil);
    if (until === null) return { kind: "error", reason: "unavailable", retryable: true };
    await deps.saveBlock({ deviceHash: deps.hasher(installId), blockedUntil: until });
    return { kind: "blocked", blockedUntil: until, source: "server" };
  }
  if (local.kind !== "accepted") return { kind: "error", reason: "unavailable", retryable: true };
  return { kind: "allowed", dob: local.dob, limitedCapacity: local.limitedCapacity };
}

function validBlockUntil(iso: string): string | null {
  const r = SoftBlockSchema.shape.blockedUntil.safeParse(iso);
  return r.success ? r.data : null;
}

function parseForServer(fields: DobFields): CivilDate | null {
  const p = parseDobFields(fields);
  return p.ok ? p.dob : null;
}

/** i18n key for a failed age check. Offline is distinguished so the screen can offer a retry. */
export function ageGateErrorKey(reason: AgeGateFailure): string {
  switch (reason) {
    case "network":
      return "errors.offline";
    case "rate_limited":
      return "errors.rateLimited";
    case "unavailable":
      return "errors.generic";
  }
}

/** Calendar date for the blocked screen, Cairo time, in the user's language. Never throws. */
export function formatBlockedUntil(iso: string, locale: "ar" | "en"): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Africa/Cairo",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
