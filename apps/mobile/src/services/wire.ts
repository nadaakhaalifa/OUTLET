import { AbortedError, ApiError, NetworkError, TimeoutError, type ContractDriftError, type OutletClient, type schemas } from "./api-client";
import { PortError } from "../features/worlds/model";

export type Lang = "ar" | "en";
export type WireMoney = schemas.Money;

/** Everything an adapter needs from the app. Injected, so tests can pass a fake-fetch client. */
export interface AdapterContext {
  readonly client: OutletClient;
  readonly locale: () => Lang;
  readonly nowMs: () => number;
  /** Stable per-install id (>= 8 chars) sent as X-Device-Id on drop queue joins. */
  readonly deviceId: () => string | Promise<string>;
  /** Called when the server breaks the contract but the screen can still degrade safely. Never swallowed silently. */
  readonly onDrift?: (e: ContractDriftError) => void;
  /** True while no one is signed in (ADR-0055). Adapters of public surfaces then call the `/v1/public/*` reads, never a bearer route. Absent = signed in. */
  readonly isGuest?: () => Promise<boolean>;
  /** Device-only guest signals for on-device re-ranking (ADR-0055). Never sent anywhere. Absent outside the guest wiring. */
  readonly guestSignals?: () => Promise<GuestSignals>;
}

export interface GuestSignals {
  readonly stores: Readonly<Record<string, number>>;
  readonly categories: Readonly<Record<string, number>>;
  /** Product ids, most recent first. */
  readonly viewed: readonly string[];
  /** The shopper paused history: nothing new is recorded, existing counters still order the picks. */
  readonly historyPaused?: boolean;
}

/** Wire money `{amount, currency}` (integer minor units as a decimal string) to bigint piastres. */
export function money(m: { readonly amount: string }): bigint {
  return BigInt(m.amount);
}
/** Wire piastres string (`"12345"`) to bigint. */
export function piastres(s: string): bigint {
  return BigInt(s);
}
export function toMoney(b: bigint): WireMoney {
  return { amount: b.toString(), currency: "EGP" };
}
export function ms(ts: string): number {
  return Date.parse(ts);
}
export function msOrNull(ts: string | null | undefined): number | null {
  return ts === null || ts === undefined ? null : Date.parse(ts);
}

export interface Localized {
  readonly ar: string;
  readonly en?: string | undefined;
}
export function pick(t: Localized, lang: Lang): string {
  return lang === "en" ? (t.en ?? t.ar) : t.ar;
}
/** Both languages for view models that carry a LocalizedText (wire `en` is optional: fall back to Arabic). */
export function bilingual(t: Localized): { readonly ar: string; readonly en: string } {
  return { ar: t.ar, en: t.en ?? t.ar };
}

/**
 * Expected failures become `PortError` (the screens already render offline/failed). Contract drift is
 * a bug, never an expected failure: it is kept as the `cause` so it is observable.
 */
export function toPortError(e: unknown): PortError {
  if (e instanceof PortError) return e;
  const offline = e instanceof NetworkError || e instanceof TimeoutError;
  const err = new PortError(offline ? "offline" : "failed");
  if (!(e instanceof AbortedError)) (err as { cause?: unknown }).cause = e;
  return err;
}

export async function guard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw toPortError(e);
  }
}

export function problemCode(e: unknown): string | undefined {
  return e instanceof ApiError ? e.code : undefined;
}

/** Declared unsupported until the OpenAPI gains what the app needs. See docs/plan/api-client-gap.md. */
export function unsupported(gap: string): PortError {
  const err = new PortError("failed");
  (err as { cause?: unknown }).cause = new Error(`unsupported by the API contract: ${gap}`);
  return err;
}

/** Builds an object without keys whose value is undefined (exactOptionalPropertyTypes). */
export function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** The ETag of a GET response, required as If-Match on the matching PATCH. A missing ETag is a contract gap. */
export function etagOf(res: { readonly etag: string | null }): string {
  if (res.etag === null) throw new Error("unsupported by the API contract: the GET response carried no ETag for If-Match");
  return res.etag;
}
