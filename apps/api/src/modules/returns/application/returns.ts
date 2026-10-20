import {
  GuardRejectedError,
  InvalidReturnAllocationError,
  InvalidTransitionError,
  MS_PER_DAY,
  RETURN_POLICY,
  addBusinessDays,
  allocateRefund,
  disputeWindowEndsAtMs,
  evaluateReturnRequest,
  evaluateReturnerStanding,
  ineligibleReason,
  inspectionDueAtMs,
  isInspectionOverdue,
  isNoFaultOfShopper,
  returnMachine,
  type IneligibleCode,
  type LocalizedReason,
  type Money,
  type RefundAllocation,
  type RefundPreference,
  type RejectionReason,
  type ReturnMachineEvent,
  type ReturnMethod,
  type ReturnReason,
  type ReturnResolution,
  type ReturnState,
} from "../domain/bridge";
import {
  RefundIntentEventSchema,
  ReturnsDependencyUnavailableError,
  type EvidenceKind,
  type EvidencePort,
  type ExchangeStockPort,
  type MembershipPort,
  type Page,
  type RefundIntentEvent,
  type ReturnEvent,
  type ReturnEventPublisher,
  type ReturnRecord,
  type ReturnRepository,
  type ReturnableLinePort,
  type ReturnerHistoryPort,
  type UploaderType,
} from "../domain/ports";
import { decodeCursor } from "../domain/cursor";

export interface Clock {
  nowMs(): number;
}
export interface Ids {
  uuidV7(): string;
}

export interface ReturnsDeps {
  readonly repo: ReturnRepository;
  readonly lines: ReturnableLinePort;
  readonly membership: MembershipPort;
  readonly history: ReturnerHistoryPort;
  readonly evidence: EvidencePort;
  readonly exchangeStock: ExchangeStockPort;
  readonly events: ReturnEventPublisher;
  readonly clock: Clock;
  readonly ids: Ids;
}

const MAX_RETRIES = 3;
/** Six calendar months, approximated for the history window handed to the adapter. */
const STANDING_WINDOW_MS = 183 * MS_PER_DAY;

export type RefusalCode = IneligibleCode | "exchange_unavailable" | "invalid_evidence";

const EXTRA_REASONS: Readonly<Record<"exchange_unavailable" | "invalid_evidence", LocalizedReason>> = {
  exchange_unavailable: {
    ar: "المنتج البديل غير متوفر حاليًا. اختر استرداد المبلغ أو مقاسًا آخر.",
    en: "The replacement item is not in stock right now. Choose a refund or another size.",
  },
  invalid_evidence: {
    ar: "إحدى الصور المرفقة غير صالحة.",
    en: "One of the attached photos is not valid.",
  },
};

const unavailable = (what: string): never => {
  throw new ReturnsDependencyUnavailableError(what);
};

function evidenceRows(
  ids: readonly string[],
  kind: EvidenceKind,
  by: UploaderType,
  actorId: string,
  nowMs: number,
): ReturnRecord["evidence"] {
  return [...new Set(ids)].map((uploadId) => ({
    uploadId,
    kind,
    uploadedByType: by,
    uploadedById: actorId,
    uploadedAtMs: nowMs,
  }));
}

const str = (m: Money): string => m.amount.toString();

export function refundAllocationWire(a: RefundAllocation): RefundIntentEvent["allocation"] {
  return {
    lines: a.lines.map((l) => ({
      orderLineId: l.orderLineId,
      qty: l.qty,
      itemAmount: str(l.itemAmount),
      voucherShare: str(l.voucherShare),
      deliveryFeeShare: str(l.deliveryFeeShare),
      netAmount: str(l.netAmount),
    })),
    itemTotal: str(a.itemTotal),
    voucherTotal: str(a.voucherTotal),
    deliveryFeeTotal: str(a.deliveryFeeTotal),
    netTotal: str(a.netTotal),
  };
}

/** The integer piastre allocation for a return, computed from the snapshot taken at request time. */
export function computeRefundAllocation(rec: ReturnRecord): RefundAllocation {
  const s = rec.lineSnapshot;
  return allocateRefund([
    {
      orderLineId: rec.orderLineId,
      qtyOrdered: s.qtyOrdered,
      unitPrice: s.unitPrice,
      discountAlloc: s.discountAlloc,
      deliveryFeeAlloc: s.deliveryFeeAlloc,
      alreadyReturnedQty: rec.priorQty,
      returningQty: rec.qty,
      deliveryFeeRefundable: rec.deliveryFeeRefundable,
    },
  ]);
}

/** The output event for an approved return: a refund intent or an exchange intent. Never money execution. */
export function intentEventFor(rec: ReturnRecord): ReturnEvent | null {
  if (rec.resolution === "refund") {
    const allocation = rec.refundIntent;
    if (allocation === null) return null;
    return RefundIntentEventSchema.parse({
      name: "return.refund_intent",
      returnId: rec.id,
      userId: rec.userId,
      storeId: rec.storeId,
      sellerOrderId: rec.sellerOrderId,
      orderLineId: rec.orderLineId,
      reason: rec.reason,
      refundPreference: rec.refundPreference,
      shippingPayer: rec.shippingPayer,
      currency: "EGP",
      allocation: refundAllocationWire(allocation),
      idempotencyKey: `refund-intent:${rec.id}`,
      occurredAtMs: rec.inspectedAtMs ?? rec.createdAtMs,
    });
  }
  if (rec.exchangeSkuId === null) return null;
  return {
    name: "return.exchange_intent",
    returnId: rec.id,
    userId: rec.userId,
    storeId: rec.storeId,
    sellerOrderId: rec.sellerOrderId,
    orderLineId: rec.orderLineId,
    exchangeSkuId: rec.exchangeSkuId,
    qty: rec.qty,
    shippingPayer: rec.shippingPayer,
    idempotencyKey: `exchange-intent:${rec.id}`,
    occurredAtMs: rec.inspectedAtMs ?? rec.createdAtMs,
  };
}

async function safePublish(deps: ReturnsDeps, events: readonly ReturnEvent[]): Promise<void> {
  for (const e of events) {
    try {
      await deps.events.publish(e);
    } catch {
      // Intent events are re-published by the sweeper from the persisted row; others are best effort.
    }
  }
}

/** Publishes the persisted intent of an APPROVED return, then stamps it. Safe to call repeatedly. */
async function publishIntent(deps: ReturnsDeps, rec: ReturnRecord): Promise<void> {
  if (rec.state !== "APPROVED" || rec.intentPublishedAtMs !== null) return;
  const event = intentEventFor(rec);
  if (event === null) return;
  try {
    await deps.events.publish(event);
  } catch {
    return;
  }
  const stamped = { ...rec, intentPublishedAtMs: deps.clock.nowMs(), version: rec.version + 1 };
  await deps.repo.save(stamped, rec.version);
}

type Step<R> =
  | { readonly kind: "write"; readonly next: ReturnRecord; readonly result: R; readonly events: readonly ReturnEvent[] }
  | { readonly kind: "stop"; readonly result: R };

type Mutated<R> = { readonly kind: "not_found" } | { readonly kind: "conflict" } | { readonly kind: "done"; readonly result: R; readonly record: ReturnRecord };

/** Load, decide, compare-and-set, retry on a lost race. */
async function mutate<R>(
  deps: ReturnsDeps,
  id: string,
  guardRecord: (r: ReturnRecord) => boolean,
  step: (r: ReturnRecord) => Step<R>,
): Promise<Mutated<R>> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const rec = await deps.repo.findById(id);
    if (rec === null || !guardRecord(rec)) return { kind: "not_found" };
    const s = step(rec);
    if (s.kind === "stop") return { kind: "done", result: s.result, record: rec };
    const next: ReturnRecord = { ...s.next, version: rec.version + 1 };
    if (!(await deps.repo.save(next, rec.version))) continue;
    await safePublish(deps, s.events);
    if (next.state === "APPROVED") await publishIntent(deps, next);
    return { kind: "done", result: s.result, record: next };
  }
  return { kind: "conflict" };
}

function apply(rec: ReturnRecord, event: ReturnMachineEvent, ctx: { photos: boolean; slaElapsed: boolean }): ReturnState | null {
  try {
    return returnMachine.transition(rec.state, event, {
      rejectionPhotosAttached: ctx.photos,
      inspectionSlaElapsed: ctx.slaElapsed,
    });
  } catch (e) {
    if (e instanceof InvalidTransitionError || e instanceof GuardRejectedError) return null;
    throw e;
  }
}

function approve(rec: ReturnRecord, state: ReturnState, nowMs: number, result: "approved" | "auto_approved"): ReturnRecord {
  let allocation: RefundAllocation | null = null;
  if (rec.resolution === "refund") {
    try {
      allocation = computeRefundAllocation(rec);
    } catch (e) {
      if (e instanceof InvalidReturnAllocationError) return unavailable("order allocation");
      throw e;
    }
  }
  return {
    ...rec,
    state,
    inspectedAtMs: nowMs,
    inspectionResult: result,
    refundIntent: allocation,
    intentPublishedAtMs: null,
  };
}

// ---------------------------------------------------------------- request

export interface RequestReturnInput {
  readonly userId: string;
  readonly orderLineId: string;
  readonly qty: number;
  readonly reason: ReturnReason;
  readonly resolution: ReturnResolution;
  readonly method: ReturnMethod;
  readonly exchangeSkuId?: string;
  readonly refundPreference?: RefundPreference;
  readonly photoUploadIds: readonly string[];
  readonly note?: string;
  readonly idempotencyKey: string;
}

export type RequestReturnResult =
  | { readonly kind: "ok"; readonly record: ReturnRecord; readonly replayed: boolean }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "refused";
      readonly code: RefusalCode;
      readonly reason: LocalizedReason;
      readonly windowEndsAtMs: number | null;
    }
  | { readonly kind: "conflict" };

export class RequestReturn {
  constructor(private readonly deps: ReturnsDeps) {}

  async execute(input: RequestReturnInput): Promise<RequestReturnResult> {
    const d = this.deps;
    const prior = await d.repo.findByIdempotencyKey(input.userId, input.idempotencyKey);
    if (prior !== null) return { kind: "ok", record: prior, replayed: true };

    const line = await d.lines.find(input.orderLineId);
    if (line === null || line.userId !== input.userId) return { kind: "not_found" };

    const now = d.clock.nowMs();
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const committed = await d.repo.committedQty(line.orderLineId);
      const [plus, standing, exchanges] = await Promise.all([
        d.membership.isPlusMember(input.userId),
        this.standing(input.userId, now),
        d.repo.exchangeCount(line.orderLineId),
      ]);
      const verdict = evaluateReturnRequest({
        reason: input.reason,
        resolution: input.resolution,
        qty: input.qty,
        openQty: Math.max(0, line.qtyOrdered - committed),
        returnClass: line.returnClass,
        deliveredAtMs: line.deliveredAtMs,
        nowMs: now,
        photoCount: new Set(input.photoUploadIds).size,
        hasExchangeSku: input.exchangeSkuId !== undefined,
        plusMember: plus,
        freeReturnsRemoved: standing,
        firstExchangeForLine: exchanges === 0,
      });
      if (!verdict.eligible) {
        return { kind: "refused", code: verdict.code, reason: verdict.reason, windowEndsAtMs: verdict.windowEndsAtMs };
      }
      if (input.photoUploadIds.length > 0 && !(await d.evidence.ownedBy(input.userId, input.photoUploadIds))) {
        return { kind: "refused", code: "invalid_evidence", reason: EXTRA_REASONS.invalid_evidence, windowEndsAtMs: verdict.windowEndsAtMs };
      }
      if (input.resolution === "exchange") {
        const sku = input.exchangeSkuId;
        if (sku === undefined || !(await d.exchangeStock.inStock(sku, input.qty))) {
          return {
            kind: "refused",
            code: "exchange_unavailable",
            reason: EXTRA_REASONS.exchange_unavailable,
            windowEndsAtMs: verdict.windowEndsAtMs,
          };
        }
      }
      const wholeOrder = committed + input.qty === line.qtyOrdered && line.otherLinesOpenQty === 0;
      const feeRefundable =
        isNoFaultOfShopper(input.reason) ||
        (wholeOrder &&
          line.deliveredAtMs !== null &&
          now <= line.deliveredAtMs + RETURN_POLICY.wholeOrderDeliveryFeeDays * MS_PER_DAY);
      const snapshot = {
        qtyOrdered: line.qtyOrdered,
        unitPrice: line.unitPrice,
        discountAlloc: line.discountAlloc,
        deliveryFeeAlloc: line.deliveryFeeAlloc,
      };
      // Fail closed on inconsistent order data before anything is stored.
      try {
        allocateRefund([
          {
            orderLineId: line.orderLineId,
            qtyOrdered: snapshot.qtyOrdered,
            unitPrice: snapshot.unitPrice,
            discountAlloc: snapshot.discountAlloc,
            deliveryFeeAlloc: snapshot.deliveryFeeAlloc,
            alreadyReturnedQty: committed,
            returningQty: input.qty,
            deliveryFeeRefundable: feeRefundable,
          },
        ]);
      } catch (e) {
        if (e instanceof InvalidReturnAllocationError) return unavailable("order allocation");
        throw e;
      }
      const record: ReturnRecord = {
        id: d.ids.uuidV7(),
        userId: input.userId,
        orderLineId: line.orderLineId,
        sellerOrderId: line.sellerOrderId,
        storeId: line.storeId,
        qty: input.qty,
        priorQty: committed,
        reason: input.reason,
        resolution: input.resolution,
        exchangeSkuId: input.exchangeSkuId ?? null,
        refundPreference: input.refundPreference ?? "original_method",
        method: input.method,
        state: returnMachine.initial,
        shippingPayer: verdict.shippingPayer,
        deliveredAtMs: line.deliveredAtMs ?? now,
        windowEndsAtMs: verdict.windowEndsAtMs,
        note: input.note ?? null,
        receivedAtMs: null,
        inspectionDueAtMs: null,
        inspectedAtMs: null,
        inspectionNote: null,
        inspectionResult: null,
        rejectionReason: null,
        disputeWindowEndsAtMs: null,
        deliveryFeeRefundable: feeRefundable,
        lineSnapshot: snapshot,
        refundIntent: null,
        intentPublishedAtMs: null,
        idempotencyKey: input.idempotencyKey,
        version: 0,
        createdAtMs: now,
        evidence: evidenceRows(input.photoUploadIds, "shopper_photo", "shopper", input.userId, now),
        dispute: null,
      };
      const out = await d.repo.createIfCapacity(record, line.qtyOrdered);
      switch (out.kind) {
        case "created":
          await safePublish(d, [
            {
              name: "return.requested",
              returnId: out.record.id,
              userId: out.record.userId,
              storeId: out.record.storeId,
              orderLineId: out.record.orderLineId,
              reason: out.record.reason,
              resolution: out.record.resolution,
              occurredAtMs: now,
            },
          ]);
          return { kind: "ok", record: out.record, replayed: false };
        case "duplicate":
          return { kind: "ok", record: out.record, replayed: true };
        case "over_capacity":
          return {
            kind: "refused",
            code: "qty_exceeds_returnable",
            reason: ineligibleReason("qty_exceeds_returnable"),
            windowEndsAtMs: verdict.windowEndsAtMs,
          };
        case "conflict":
          continue;
      }
    }
    return { kind: "conflict" };
  }

  /** Evaluates and persists the published standing; emits the notice once on the first flip. */
  private async standing(userId: string, nowMs: number): Promise<boolean> {
    const d = this.deps;
    const h = await d.history.history(userId, nowMs - STANDING_WINDOW_MS, nowMs);
    const s = evaluateReturnerStanding(h);
    const before = await d.repo.getStanding(userId);
    let noticeSentAtMs = before?.noticeSentAtMs ?? null;
    if (s.freeReturnsRemoved && noticeSentAtMs === null) {
      noticeSentAtMs = nowMs;
      await safePublish(d, [
        {
          name: "return.serial_returner_notice",
          userId,
          rateBps: s.rateBps,
          deliveredOrders: s.deliveredOrders,
          returnedOrders: s.returnedOrders,
          occurredAtMs: nowMs,
        },
      ]);
    }
    await d.repo.saveStanding({
      userId,
      deliveredOrders: s.deliveredOrders,
      returnedOrders: s.returnedOrders,
      rateBps: s.rateBps,
      freeReturnsRemoved: s.freeReturnsRemoved,
      noticeSentAtMs,
      evaluatedAtMs: nowMs,
    });
    return s.freeReturnsRemoved;
  }
}


// ------------------------------------------------- fulfillment bookkeeping

export type BookkeepingResult =
  | { readonly kind: "ok"; readonly record: ReturnRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "conflict" };

async function runBookkeeping(
  deps: ReturnsDeps,
  returnId: string,
  event: ReturnMachineEvent,
  patch: (r: ReturnRecord, nowMs: number) => Partial<ReturnRecord>,
  emit?: (r: ReturnRecord, nowMs: number) => ReturnEvent,
): Promise<BookkeepingResult> {
  const now = deps.clock.nowMs();
  const r = await mutate<"ok" | "invalid">(deps, returnId, () => true, (rec) => {
    const to = apply(rec, event, { photos: false, slaElapsed: false });
    if (to === null) return { kind: "stop", result: "invalid" };
    const next: ReturnRecord = { ...rec, ...patch(rec, now), state: to };
    return { kind: "write", next, result: "ok", events: emit === undefined ? [] : [emit(next, now)] };
  });
  if (r.kind === "not_found") return { kind: "not_found" };
  if (r.kind === "conflict") return { kind: "conflict" };
  return r.result === "invalid" ? { kind: "invalid_transition" } : { kind: "ok", record: r.record };
}

/** Fulfillment: a pickup or drop-off slot was booked. */
export class ScheduleReturnPickup {
  constructor(private readonly deps: ReturnsDeps) {}
  execute(returnId: string): Promise<BookkeepingResult> {
    return runBookkeeping(this.deps, returnId, "SCHEDULE_PICKUP", () => ({}));
  }
}

/** Fulfillment: the courier failed to collect; the return goes back to REQUESTED. */
export class RecordReturnPickupFailed {
  constructor(private readonly deps: ReturnsDeps) {}
  execute(returnId: string): Promise<BookkeepingResult> {
    return runBookkeeping(this.deps, returnId, "PICKUP_FAILED", () => ({}));
  }
}

/** Fulfillment: the parcel left the shopper. */
export class RecordReturnPickedUp {
  constructor(private readonly deps: ReturnsDeps) {}
  execute(returnId: string): Promise<BookkeepingResult> {
    return runBookkeeping(this.deps, returnId, "PICK_UP", () => ({}));
  }
}

/** Fulfillment: the seller or hub has the parcel; starts the 48 h inspection clock. */
export class RecordReturnReceived {
  constructor(private readonly deps: ReturnsDeps) {}
  execute(returnId: string): Promise<BookkeepingResult> {
    return runBookkeeping(
      this.deps,
      returnId,
      "RECEIVE",
      (_r, now) => ({ receivedAtMs: now, inspectionDueAtMs: inspectionDueAtMs(now) }),
      (r, now) => ({ name: "return.received", returnId: r.id, storeId: r.storeId, occurredAtMs: now }),
    );
  }
}

// ---------------------------------------------------------------- inspect

export interface InspectReturnInput {
  readonly returnId: string;
  readonly actorId: string;
  readonly storeIds: readonly string[];
  readonly decision: "approve" | "reject";
  readonly rejectionReason?: RejectionReason;
  readonly photoUploadIds: readonly string[];
  readonly note?: string;
}

export type InspectReturnResult =
  | { readonly kind: "ok"; readonly record: ReturnRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "inspection_window_elapsed"; readonly record: ReturnRecord }
  | { readonly kind: "rejection_reason_required" }
  | { readonly kind: "photos_required" }
  | { readonly kind: "invalid_evidence" }
  | { readonly kind: "conflict" };

export class InspectReturn {
  constructor(private readonly deps: ReturnsDeps) {}

  async execute(i: InspectReturnInput): Promise<InspectReturnResult> {
    const d = this.deps;
    const now = d.clock.nowMs();
    const first = await d.repo.findById(i.returnId);
    if (first === null || !i.storeIds.includes(first.storeId)) return { kind: "not_found" };
    if (first.state !== "RECEIVED") return { kind: "invalid_transition" };

    // Silence past the deadline approved the return; a late verdict must not undo that.
    if (first.inspectionDueAtMs !== null && isInspectionOverdue(first.inspectionDueAtMs, now)) {
      const swept = await autoApproveOne(d, first.id);
      return swept === null ? { kind: "conflict" } : { kind: "inspection_window_elapsed", record: swept };
    }

    const photos = [...new Set(i.photoUploadIds)];
    if (i.decision === "reject") {
      if (i.rejectionReason === undefined) return { kind: "rejection_reason_required" };
      if (photos.length === 0) return { kind: "photos_required" };
    }
    if (photos.length > 0 && !(await d.evidence.ownedBy(i.actorId, photos))) return { kind: "invalid_evidence" };

    const r = await mutate<"ok" | "invalid">(d, i.returnId, (rec) => i.storeIds.includes(rec.storeId), (rec) => {
      const reject = i.decision === "reject";
      const to = apply(rec, reject ? "REJECT" : "APPROVE", { photos: photos.length > 0, slaElapsed: false });
      if (to === null) return { kind: "stop", result: "invalid" };
      const base: ReturnRecord = {
        ...rec,
        inspectionNote: i.note ?? null,
        evidence: [...rec.evidence, ...evidenceRows(photos, "inspection_photo", "seller", i.actorId, now)],
      };
      const next: ReturnRecord = reject
        ? {
            ...base,
            state: to,
            inspectedAtMs: now,
            inspectionResult: "rejected",
            rejectionReason: i.rejectionReason ?? "other",
            disputeWindowEndsAtMs: disputeWindowEndsAtMs(now),
          }
        : approve(base, to, now, "approved");
      return {
        kind: "write",
        next,
        result: "ok",
        events: [
          { name: "return.inspected", returnId: rec.id, storeId: rec.storeId, result: reject ? "rejected" : "approved", occurredAtMs: now },
        ],
      };
    });
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "conflict" };
    return r.result === "invalid" ? { kind: "invalid_transition" } : { kind: "ok", record: r.record };
  }
}

async function autoApproveOne(deps: ReturnsDeps, id: string): Promise<ReturnRecord | null> {
  const now = deps.clock.nowMs();
  const r = await mutate<"ok" | "skip">(deps, id, () => true, (rec) => {
    if (rec.state !== "RECEIVED" || rec.inspectionDueAtMs === null) return { kind: "stop", result: "skip" };
    const elapsed = isInspectionOverdue(rec.inspectionDueAtMs, now);
    const to = apply(rec, "AUTO_APPROVE", { photos: false, slaElapsed: elapsed });
    if (to === null) return { kind: "stop", result: "skip" };
    return {
      kind: "write",
      next: approve(rec, to, now, "auto_approved"),
      result: "ok",
      events: [{ name: "return.inspected", returnId: rec.id, storeId: rec.storeId, result: "auto_approved", occurredAtMs: now }],
    };
  });
  return r.kind === "done" ? r.record : null;
}

/** Scheduled sweeper: spec 22, "silence = auto-approve". Idempotent and bounded. */
export class AutoApproveOverdueInspections {
  constructor(private readonly deps: ReturnsDeps) {}
  async run(limit = 100): Promise<number> {
    const due = await this.deps.repo.listInspectionOverdue(this.deps.clock.nowMs(), limit);
    let n = 0;
    for (const rec of due) {
      const done = await autoApproveOne(this.deps, rec.id);
      if (done !== null && done.state === "APPROVED") n += 1;
    }
    return n;
  }
}

// ---------------------------------------------------------------- dispute

export interface DisputeReturnInput {
  readonly userId: string;
  readonly returnId: string;
  readonly statement: string;
  readonly photoUploadIds: readonly string[];
}

export type DisputeReturnResult =
  | { readonly kind: "ok"; readonly record: ReturnRecord; readonly disputeId: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "dispute_window_elapsed" }
  | { readonly kind: "invalid_evidence" }
  | { readonly kind: "conflict" };

export class DisputeReturn {
  constructor(private readonly deps: ReturnsDeps) {}

  async execute(i: DisputeReturnInput): Promise<DisputeReturnResult> {
    const d = this.deps;
    const now = d.clock.nowMs();
    const first = await d.repo.findById(i.returnId);
    if (first === null || first.userId !== i.userId) return { kind: "not_found" };
    if (first.state !== "REJECTED") return { kind: "invalid_transition" };
    if (first.disputeWindowEndsAtMs !== null && now > first.disputeWindowEndsAtMs) {
      return { kind: "dispute_window_elapsed" };
    }
    const photos = [...new Set(i.photoUploadIds)];
    if (photos.length > 0 && !(await d.evidence.ownedBy(i.userId, photos))) return { kind: "invalid_evidence" };

    const disputeId = d.ids.uuidV7();
    const r = await mutate<"ok" | "invalid">(d, i.returnId, (rec) => rec.userId === i.userId, (rec) => {
      const to = apply(rec, "OPEN_DISPUTE", { photos: false, slaElapsed: false });
      if (to === null || rec.dispute !== null) return { kind: "stop", result: "invalid" };
      return {
        kind: "write",
        next: {
          ...rec,
          state: to,
          evidence: [...rec.evidence, ...evidenceRows(photos, "dispute_photo", "shopper", i.userId, now)],
          dispute: {
            id: disputeId,
            returnId: rec.id,
            status: "OPEN",
            statement: i.statement,
            reviewDueAtMs: addBusinessDays(now, RETURN_POLICY.disputeReviewBusinessDays),
            decidedAtMs: null,
            createdAtMs: now,
          },
        },
        result: "ok",
        events: [{ name: "return.disputed", returnId: rec.id, storeId: rec.storeId, occurredAtMs: now }],
      };
    });
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "conflict" };
    if (r.result === "invalid") return { kind: "invalid_transition" };
    return { kind: "ok", record: r.record, disputeId: r.record.dispute?.id ?? disputeId };
  }
}

export type ResolveDisputeResult =
  | { readonly kind: "ok"; readonly record: ReturnRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "conflict" };

/** Trust and safety verdict (internal, no HTTP route in this wave). */
export class ResolveReturnDispute {
  constructor(private readonly deps: ReturnsDeps) {}
  async execute(returnId: string, outcome: "for_shopper" | "for_seller"): Promise<ResolveDisputeResult> {
    const now = this.deps.clock.nowMs();
    const r = await mutate<"ok" | "invalid">(this.deps, returnId, () => true, (rec) => {
      const to = apply(rec, outcome === "for_shopper" ? "UPHOLD_FOR_SHOPPER" : "UPHOLD_FOR_SELLER", {
        photos: false,
        slaElapsed: false,
      });
      if (to === null || rec.dispute === null) return { kind: "stop", result: "invalid" };
      const decided = {
        ...rec.dispute,
        status: outcome === "for_shopper" ? ("RESOLVED_FOR_SHOPPER" as const) : ("RESOLVED_FOR_SELLER" as const),
        decidedAtMs: now,
      };
      const next =
        outcome === "for_shopper" ? { ...approve(rec, to, now, "approved"), dispute: decided } : { ...rec, state: to, dispute: decided };
      return { kind: "write", next, result: "ok", events: [] };
    });
    if (r.kind === "not_found") return { kind: "not_found" };
    if (r.kind === "conflict") return { kind: "conflict" };
    return r.result === "invalid" ? { kind: "invalid_transition" } : { kind: "ok", record: r.record };
  }
}

/** Scheduled sweeper: a rejection nobody disputed becomes final. */
export class CloseElapsedDisputeWindows {
  constructor(private readonly deps: ReturnsDeps) {}
  async run(limit = 100): Promise<number> {
    const rows = await this.deps.repo.listDisputeWindowElapsed(this.deps.clock.nowMs(), limit);
    let n = 0;
    for (const row of rows) {
      const r = await mutate<"ok" | "skip">(this.deps, row.id, () => true, (rec) => {
        const to = apply(rec, "DISPUTE_WINDOW_ELAPSED", { photos: false, slaElapsed: false });
        if (to === null) return { kind: "stop", result: "skip" };
        return { kind: "write", next: { ...rec, state: to }, result: "ok", events: [] };
      });
      if (r.kind === "done" && r.result === "ok") n += 1;
    }
    return n;
  }
}

// ----------------------------------------------- completion (state only)

async function runCompletion(
  deps: ReturnsDeps,
  returnId: string,
  event: "COMPLETE_REFUND" | "SHIP_EXCHANGE",
  resolution: ReturnResolution,
): Promise<BookkeepingResult> {
  const r = await mutate<"ok" | "invalid">(deps, returnId, () => true, (rec) => {
    const to = rec.resolution === resolution ? apply(rec, event, { photos: false, slaElapsed: false }) : null;
    if (to === null) return { kind: "stop", result: "invalid" };
    return { kind: "write", next: { ...rec, state: to }, result: "ok", events: [] };
  });
  if (r.kind === "not_found") return { kind: "not_found" };
  if (r.kind === "conflict") return { kind: "conflict" };
  return r.result === "invalid" ? { kind: "invalid_transition" } : { kind: "ok", record: r.record };
}

/** Called by the money module after it executed the refund. Moves state only. */
export class CompleteReturnRefund {
  constructor(private readonly deps: ReturnsDeps) {}
  execute(returnId: string): Promise<BookkeepingResult> {
    return runCompletion(this.deps, returnId, "COMPLETE_REFUND", "refund");
  }
}

/** Called by orders and fulfillment after the replacement shipped. Moves state only. */
export class CompleteReturnExchange {
  constructor(private readonly deps: ReturnsDeps) {}
  execute(returnId: string): Promise<BookkeepingResult> {
    return runCompletion(this.deps, returnId, "SHIP_EXCHANGE", "exchange");
  }
}

/** Scheduled sweeper: at-least-once re-publication of persisted intents. */
export class PublishPendingIntents {
  constructor(private readonly deps: ReturnsDeps) {}
  async run(limit = 100): Promise<number> {
    const rows = await this.deps.repo.listUnpublishedIntents(limit);
    let n = 0;
    for (const rec of rows) {
      await publishIntent(this.deps, rec);
      const after = await this.deps.repo.findById(rec.id);
      if (after !== null && after.intentPublishedAtMs !== null) n += 1;
    }
    return n;
  }
}

// ------------------------------------------------------------------ reads

export type ListResult =
  | { readonly kind: "ok"; readonly page: Page<ReturnRecord> }
  | { readonly kind: "invalid_cursor" };

export class ListMyReturns {
  constructor(private readonly deps: ReturnsDeps) {}
  async execute(userId: string, cursor: string | null, limit: number): Promise<ListResult> {
    if (cursor !== null && decodeCursor(cursor) === null) return { kind: "invalid_cursor" };
    return { kind: "ok", page: await this.deps.repo.listForUser(userId, cursor, limit) };
  }
}

export class ListSellerReturns {
  constructor(private readonly deps: ReturnsDeps) {}
  async execute(storeIds: readonly string[], cursor: string | null, limit: number): Promise<ListResult> {
    if (cursor !== null && decodeCursor(cursor) === null) return { kind: "invalid_cursor" };
    if (storeIds.length === 0) return { kind: "ok", page: { items: [], nextCursor: null } };
    return { kind: "ok", page: await this.deps.repo.listForStores(storeIds, cursor, limit) };
  }
}

export class GetMyReturn {
  constructor(private readonly deps: ReturnsDeps) {}
  async execute(userId: string, returnId: string): Promise<ReturnRecord | null> {
    const r = await this.deps.repo.findById(returnId);
    return r !== null && r.userId === userId ? r : null;
  }
}
