import { z } from "zod";

export const ATTENTION_KINDS = ["refund.attention", "promotions.settle_attention", "shipment.cancel_attention"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export const ATTENTION_STATUSES = ["OPEN", "ACKED", "RESOLVED"] as const;
export type AttentionStatus = (typeof ATTENTION_STATUSES)[number];
export const RESOLUTION_CODES = ["FIXED_MANUALLY", "REFUNDED_OFFLINE", "RETRIED_OK", "NOT_AN_ISSUE", "DUPLICATE", "ESCALATED"] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];
export type AttentionRefType = "refund" | "order_group" | "shipment" | "event";

export const ATTENTION_OPENED_EVENT = "ops.attention_opened";
export const ATTENTION_CONSUMER = "ops.attention";

/** Free text from a failure never reaches the queue: only a short code-like token survives (no spaces, no punctuation beyond _ . : -, no digit runs of 6 or more). */
const code = z.string().min(1).transform((s) => s.replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/\d{6,}/g, "#").slice(0, 64));
const optionalUuid = z.uuid().nullish().transform((v) => v ?? null);

const refundPayload = z.object({ order_group_id: optionalUuid, seller_order_id: optionalUuid, refund_id: optionalUuid, status: code.nullish().transform((v) => v ?? null), error: code, source_event_id: optionalUuid });
const settlePayload = z.object({ order_group_id: optionalUuid, action: code, error: code, source_event_id: optionalUuid });
const shipmentPayload = z.object({ shipment_id: optionalUuid, seller_order_id: optionalUuid, reason: code, source_event_id: optionalUuid });

export interface AttentionDraft {
  readonly kind: AttentionKind;
  readonly refType: AttentionRefType;
  readonly refId: string;
  /** Whitelisted, PII-free fields only. */
  readonly payload: Readonly<Record<string, string>>;
}

const compact = (o: Record<string, string | null>): Record<string, string> => Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => e[1] !== null));
const join = (...p: (string | null)[]): string => p.filter((x): x is string => x !== null).join(":");

/** Maps one attention event to a queue item, or null when the payload is malformed. `eventId` is the fallback reference when the event names no entity. */
export const draftFor = (kind: AttentionKind, payload: Readonly<Record<string, unknown>>, eventId: string): AttentionDraft | null => {
  if (kind === "refund.attention") {
    const p = refundPayload.safeParse(payload);
    if (!p.success) return null;
    const d = p.data;
    const [refType, refId] = d.refund_id !== null ? (["refund", d.refund_id] as const) : d.order_group_id !== null ? (["order_group", join(d.order_group_id, d.seller_order_id)] as const) : (["event", d.source_event_id ?? eventId] as const);
    return { kind, refType, refId, payload: compact({ order_group_id: d.order_group_id, seller_order_id: d.seller_order_id, refund_id: d.refund_id, status: d.status, error: d.error, source_event_id: d.source_event_id }) };
  }
  if (kind === "promotions.settle_attention") {
    const p = settlePayload.safeParse(payload);
    if (!p.success) return null;
    const d = p.data;
    const [refType, refId] = d.order_group_id !== null ? (["order_group", join(d.order_group_id, d.action)] as const) : (["event", d.source_event_id ?? eventId] as const);
    return { kind, refType, refId, payload: compact({ order_group_id: d.order_group_id, action: d.action, error: d.error, source_event_id: d.source_event_id }) };
  }
  const p = shipmentPayload.safeParse(payload);
  if (!p.success) return null;
  const d = p.data;
  const [refType, refId] = d.shipment_id !== null ? (["shipment", d.shipment_id] as const) : (["event", d.source_event_id ?? eventId] as const);
  return { kind, refType, refId, payload: compact({ shipment_id: d.shipment_id, seller_order_id: d.seller_order_id, reason: d.reason, source_event_id: d.source_event_id }) };
};

export const isAttentionKind = (t: string): t is AttentionKind => (ATTENTION_KINDS as readonly string[]).includes(t);
