import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookInput, WebhookVerification } from "../domain/ports";
import { WEBHOOK_TOLERANCE_MS, withinTolerance } from "../domain/seam";

export interface HmacWebhookConfig {
  /** Active secrets, newest first. More than one allows rotation without a window of rejects. */
  readonly secrets: readonly string[];
  readonly signatureHeader: string;
  readonly timestampHeader: string;
  readonly algorithm: "sha256" | "sha512";
  readonly toleranceMs?: number;
}

export const hmacHex = (algorithm: "sha256" | "sha512", secret: string, data: Uint8Array | string): string =>
  createHmac(algorithm, secret).update(data).digest("hex");

/** Constant-time compare of two hex digests. Unequal lengths are rejected without a timing signal on content. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Signed material is `<timestamp-ms> "." <raw body bytes>`: the timestamp is covered by the MAC so
 * an old signed body cannot be replayed under a fresh header. The MAC is computed over the RAW
 * bytes the PSP sent, never over re-serialized JSON.
 */
export function signedPayload(timestampMs: string, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${timestampMs}.`, "utf8"), Buffer.from(rawBody)]);
}

export function signBody(cfg: Pick<HmacWebhookConfig, "algorithm">, secret: string, timestampMs: number, rawBody: Uint8Array): string {
  return hmacHex(cfg.algorithm, secret, signedPayload(String(timestampMs), rawBody));
}

/** Authenticates and freshness-checks a webhook. `extractEventId` reads the PSP event id from the (authentic) body. */
export function verifyHmacWebhook(
  cfg: HmacWebhookConfig,
  input: WebhookInput,
  extractEventId: (rawBody: Uint8Array) => string | null,
): WebhookVerification {
  const sig = input.headers[cfg.signatureHeader];
  if (sig === undefined || sig.length === 0) return { ok: false, reason: "missing_signature" };
  const tsRaw = input.headers[cfg.timestampHeader];
  if (tsRaw === undefined || tsRaw.length === 0) return { ok: false, reason: "missing_timestamp" };
  if (!/^\d{10,16}$/.test(tsRaw)) return { ok: false, reason: "missing_timestamp" };
  const payload = signedPayload(tsRaw, input.rawBody);
  let matched = false;
  for (const secret of cfg.secrets) {
    // Evaluate every secret (no early exit) so the number of secrets is the only timing variable.
    if (timingSafeHexEqual(sig.toLowerCase(), hmacHex(cfg.algorithm, secret, payload))) matched = true;
  }
  if (!matched) return { ok: false, reason: "bad_signature" };
  // A 10-digit value is epoch SECONDS. The window is in milliseconds, so it would always read as
  // ~55 years stale and look like a clock problem. The MAC is valid, so say what it actually is
  // (VR-PAY-07: confirm the PSP's timestamp unit before enabling the provider).
  if (/^\d{10}$/.test(tsRaw)) return { ok: false, reason: "timestamp_in_seconds" };
  const ts = Number(tsRaw);
  if (!withinTolerance(ts, input.nowMs, cfg.toleranceMs ?? WEBHOOK_TOLERANCE_MS)) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  const eventId = extractEventId(input.rawBody);
  if (eventId === null) return { ok: false, reason: "unparseable" };
  return { ok: true, eventId, timestampMs: ts };
}
