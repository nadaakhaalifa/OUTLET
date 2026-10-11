import type { ModerationItemWire, PriceActionWire, PromotionWire } from "../api/schemas";
import { parseMinor } from "../lib/format";

// ---- price integrity ---------------------------------------------------------------------
export interface PriceActionRow {
  readonly id: string;
  readonly storeId: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly appliedAtMs: number;
  readonly evidenceCount: number;
  /** Enforcement that suspends needs a human review inside 5 business days (spec 9.5). */
  readonly reviewDueAtMs: number | null;
  readonly reviewOverdue: boolean;
}

export interface PriceMonitor {
  readonly log: readonly PriceActionRow[];
  /** Actions awaiting the human fairness review (appeals land here), overdue first. */
  readonly appeals: readonly PriceActionRow[];
}

export function priceMonitor(items: readonly PriceActionWire[], serverNowMs: number): PriceMonitor {
  const rows = items.map((a): PriceActionRow => {
    const due = a.human_review_due_at === null || a.human_review_due_at === undefined ? null : Date.parse(a.human_review_due_at);
    return {
      id: a.id,
      storeId: a.store_id,
      action: a.action,
      reasonCode: a.reason_code,
      appliedAtMs: Date.parse(a.applied_at),
      evidenceCount: a.evidence_ids?.length ?? 0,
      reviewDueAtMs: due,
      reviewOverdue: due !== null && serverNowMs > due,
    };
  });
  const log = [...rows].sort((a, b) => b.appliedAtMs - a.appliedAtMs || a.id.localeCompare(b.id));
  const appeals = rows
    .filter((r) => r.reviewDueAtMs !== null)
    .sort((a, b) => Number(b.reviewOverdue) - Number(a.reviewOverdue) || (a.reviewDueAtMs ?? 0) - (b.reviewDueAtMs ?? 0));
  return { log, appeals };
}

// ---- moderation --------------------------------------------------------------------------
export interface ModerationRow {
  readonly targetType: ModerationItemWire["target_type"];
  readonly targetId: string;
  readonly holdReason: string | null;
  readonly text: string | null;
  readonly photoCount: number;
  readonly createdAtMs: number;
  readonly status: string;
}

/** Oldest first: the queue is FIFO so nothing starves. Text is untrusted and is rendered as text only. */
export function moderationRows(items: readonly ModerationItemWire[]): readonly ModerationRow[] {
  return items
    .map((i): ModerationRow => ({
      targetType: i.target_type,
      targetId: i.target_id,
      holdReason: i.hold_reason,
      text: i.text,
      photoCount: i.photo_ids.length,
      createdAtMs: Date.parse(i.created_at),
      status: i.status,
    }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.targetId.localeCompare(b.targetId));
}

// ---- promotions --------------------------------------------------------------------------
export interface PromotionRow {
  readonly id: string;
  readonly type: string;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly code: string | null;
  readonly status: PromotionWire["status"];
  readonly platformPct: number;
  readonly sellerPct: number;
  /** Funding must total 100; anything else is flagged, never silently displayed as fine. */
  readonly fundingOk: boolean;
  readonly budgetMinor: bigint | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

const STATUS_ORDER: readonly PromotionWire["status"][] = ["active", "scheduled", "paused", "draft", "ended"];

export function promotionRows(items: readonly PromotionWire[]): readonly PromotionRow[] {
  return items
    .map((p): PromotionRow => ({
      id: p.id,
      type: p.type,
      titleAr: p.title.ar,
      titleEn: p.title.en ?? null,
      code: p.code ?? null,
      status: p.status,
      platformPct: p.funding.platform_pct,
      sellerPct: p.funding.seller_pct,
      fundingOk: p.funding.platform_pct + p.funding.seller_pct === 100,
      budgetMinor: p.total_budget === undefined ? null : parseMinor(p.total_budget.amount),
      startsAtMs: Date.parse(p.starts_at),
      endsAtMs: Date.parse(p.ends_at),
    }))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id));
}
