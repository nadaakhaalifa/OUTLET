import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  FULFILLMENT_TRACKING_KINDS,
  money,
  withinWebhookTolerance,
  type FulfillmentTrackingKind,
} from "../../domain/bridge";
import type { CourierWebhookAdapter, ParsedCourierWebhook, WebhookVerification } from "../../domain/ports";
import statesFixture from "./fixtures/webhook-states.json";

/**
 * Bosta-STYLE webhook adapter. Every field name, header, status string and unit below is an
 * ASSUMPTION built from `fixtures/` and is marked VERIFY BEFORE LAUNCH in docs/specs/fulfillment.md
 * (register rows 2, 3, 5). No live API has been consulted.
 */
export const BOSTA_STATUS_MAP_VERSION: string = statesFixture.version;

const KINDS: ReadonlySet<string> = new Set(FULFILLMENT_TRACKING_KINDS);
const STATUS_MAP: ReadonlyMap<string, FulfillmentTrackingKind> = new Map(
  Object.entries(statesFixture.map).flatMap(([raw, kind]): [string, FulfillmentTrackingKind][] =>
    KINDS.has(kind) ? [[raw, kind as FulfillmentTrackingKind]] : [],
  ),
);

export function mapBostaStatus(raw: string): FulfillmentTrackingKind | null {
  return STATUS_MAP.get(raw.trim().toLowerCase()) ?? null;
}

const Id = z.string().min(1).max(128);
const Awb = z.string().min(3).max(64);
const Piastres = z.number().int().min(0).max(10_000_000_000);
/** Epoch seconds or milliseconds. */
const EpochAny = z.number().int().positive();

const TrackingBody = z.object({
  event: z.literal("delivery.state_changed"),
  id: Id,
  trackingNumber: Awb,
  state: z.object({ code: z.number().int().optional(), value: z.string().min(1).max(64) }),
  timestamp: EpochAny,
  exceptionReason: z.string().max(64).nullish(),
});

const CodBody = z.object({
  event: z.literal("cod.remitted"),
  id: Id,
  cashRef: Id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliveries: z
    .array(z.object({ trackingNumber: Awb, collected: Piastres, fee: Piastres.default(0) }))
    .min(1)
    .max(500),
});

const toMs = (t: number): number => (t > 1_000_000_000_000 ? t : t * 1000);

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export const BOSTA_SIGNATURE_HEADER = "x-signature";
export const BOSTA_TIMESTAMP_HEADER = "x-timestamp";

/** Signs a body the way the adapter verifies it. Used by tests and fixtures. */
export function signBostaWebhook(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

export class BostaStyleWebhookAdapter implements CourierWebhookAdapter {
  readonly code = "bosta";
  readonly maxBodyBytes = 262_144;

  verify(
    input: { readonly rawBody: string; readonly headers: Readonly<Record<string, string | undefined>> },
    secrets: readonly string[],
    nowMs: number,
  ): WebhookVerification {
    const sig = input.headers[BOSTA_SIGNATURE_HEADER];
    const ts = input.headers[BOSTA_TIMESTAMP_HEADER];
    if (sig === undefined || ts === undefined || !/^\d{10,13}$/.test(ts)) return "missing_headers";
    if (!/^[0-9a-f]{64}$/i.test(sig)) return "bad_signature";
    // The signature covers the header value exactly as sent, so check it before judging freshness.
    let ok = false;
    for (const secret of secrets) {
      const expected = createHmac("sha256", secret).update(`${ts}.${input.rawBody}`).digest("hex");
      if (safeEqualHex(expected, sig.toLowerCase())) ok = true;
    }
    if (!ok) return "bad_signature";
    return withinWebhookTolerance(toMs(Number(ts)), nowMs) ? "ok" : "stale_timestamp";
  }

  parse(rawBody: string): ParsedCourierWebhook {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { kind: "invalid" };
    }
    const t = TrackingBody.safeParse(json);
    if (t.success) {
      const reason = t.data.exceptionReason ?? null;
      const rawStatus = t.data.state.value;
      let tracking = mapBostaStatus(rawStatus);
      if (tracking === "delivery_failed" && reason !== null && /refus/i.test(reason)) tracking = "customer_refused";
      return {
        kind: "tracking",
        courierEventId: t.data.id,
        awb: t.data.trackingNumber,
        rawStatus,
        tracking,
        occurredAtMs: toMs(t.data.timestamp),
        reasonCode: reason,
      };
    }
    const c = CodBody.safeParse(json);
    if (c.success) {
      const awbs = new Set(c.data.deliveries.map((d) => d.trackingNumber));
      if (awbs.size !== c.data.deliveries.length) return { kind: "invalid" };
      return {
        kind: "cod_remitted",
        courierEventId: c.data.id,
        courierRef: c.data.cashRef,
        remittanceDate: c.data.date,
        lines: c.data.deliveries.map((d) => ({
          awb: d.trackingNumber,
          collected: money(BigInt(d.collected)),
          fee: money(BigInt(d.fee)),
        })),
      };
    }
    return { kind: "invalid" };
  }
}
