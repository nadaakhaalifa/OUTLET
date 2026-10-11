import {
  createJournalEntry,
  entitlementEndsAt,
  entitlementGrants,
  isEntitled,
  money,
  plusCharged,
  selectPlanVersion,
  vatIncluded,
  type EntryMeta,
  type JournalEntry,
  type PlusPlan,
  type PlusSubscription,
} from "../domain/bridge";
import type {
  AgePolicyPort,
  CardVaultPort,
  ChargeOutcome,
  Clock,
  CommitResult,
  EntitlementRow,
  FeatureGatePort,
  IdPort,
  InvoiceKind,
  InvoiceRecord,
  KeyHasherPort,
  LedgerPort,
  MemberNoticePort,
  PersonKeyPort,
  PlusEvent,
  PlusRefundPort,
  RecurringChargePort,
  SubscriptionChange,
  SubscriptionStore,
  TaxReceiptPort,
} from "../domain/ports";

export interface PlusConfig {
  readonly vatBps: bigint;
}

export const DEFAULT_PLUS_CONFIG: PlusConfig = { vatBps: 1_400n };

export interface PlusDeps {
  readonly store: SubscriptionStore;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: PlusConfig;
  readonly ledger: LedgerPort;
  readonly receipts: TaxReceiptPort;
  readonly notices: MemberNoticePort;
  readonly flags: FeatureGatePort;
  readonly charges: RecurringChargePort;
  readonly refunds: PlusRefundPort;
  readonly ages: AgePolicyPort;
  readonly persons: PersonKeyPort;
  readonly vault: CardVaultPort;
  readonly hasher: KeyHasherPort;
}

/** The plan version that bills a period starting at `atMs` for a plan code. */
export async function planFor(d: PlusDeps, code: string, atMs: number): Promise<PlusPlan | null> {
  return selectPlanVersion(await d.store.listPlanVersions(code), atMs);
}

/** Projection of the subscription into entitlement rows: all-or-nothing, until the paid-through instant. */
export function entitlementRowsFor(sub: PlusSubscription, nowMs: number): readonly EntitlementRow[] {
  const end = entitlementEndsAt(sub);
  if (end === null || end <= nowMs) return [];
  return entitlementGrants().map((g) => ({
    userId: sub.userId,
    subscriptionId: sub.id,
    group: g.group,
    key: g.key,
    validFromMs: nowMs,
    validToMs: end,
  }));
}

export function entitlementEvents(prev: PlusSubscription | null, next: PlusSubscription, nowMs: number): PlusEvent[] {
  const was = prev !== null && isEntitled(prev, nowMs);
  const is = isEntitled(next, nowMs);
  if (!was && is) return [{ type: "entitlement.granted", userId: next.userId, subscriptionId: next.id }];
  if (was && !is) return [{ type: "entitlement.revoked", userId: next.userId, subscriptionId: next.id }];
  return [];
}

export async function applyTransition(
  d: PlusDeps,
  prev: PlusSubscription | null,
  next: PlusSubscription,
  nowMs: number,
  events: readonly PlusEvent[],
  extra: Partial<Omit<SubscriptionChange, "subscription" | "entitlements" | "events">> = {},
): Promise<CommitResult> {
  return d.store.commit({
    subscription: { value: next, expectedVersion: prev === null ? null : prev.version },
    entitlements: { subscriptionId: next.id, rows: entitlementRowsFor(next, nowMs) },
    events: [...events, ...entitlementEvents(prev, next, nowMs)],
    ...extra,
  });
}

export function ledgerMeta(d: PlusDeps, idempotencyKey: string, refId: string): EntryMeta {
  return {
    id: d.ids.uuidV7(),
    idempotencyKey,
    occurredAt: new Date(d.clock.nowMs()),
    ref: { type: "subscription_invoice", id: refId },
  };
}

export interface InvoiceInput {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly cycle: number;
  readonly attempt: number;
  readonly kind: InvoiceKind;
  readonly amountMinor: bigint;
  readonly creditAppliedMinor?: bigint;
  readonly periodStartMs: number;
  readonly periodsTotal: number;
  readonly status: "PAID" | "FAILED";
  readonly provider: string | null;
  readonly pspRef: string | null;
}

/**
 * Invoice with VAT-inclusive pricing (B4). net_recognition is what moves from deferred to
 * recognised revenue over the term: the cash net plus the net of any credit carried over.
 */
export function buildInvoice(d: PlusDeps, i: InvoiceInput, nowMs: number): InvoiceRecord {
  const credit = i.creditAppliedMinor ?? 0n;
  const vat = vatIncluded(money(i.amountMinor), d.cfg.vatBps).amount;
  const creditVat = credit === 0n ? 0n : vatIncluded(money(credit), d.cfg.vatBps).amount;
  const paid = i.status === "PAID";
  return {
    id: d.ids.uuidV7(),
    subscriptionId: i.subscriptionId,
    userId: i.userId,
    cycle: i.cycle,
    attempt: i.attempt,
    kind: i.kind,
    amountMinor: i.amountMinor,
    vatMinor: vat,
    creditAppliedMinor: credit,
    netRecognitionMinor: paid ? i.amountMinor - vat + (credit - creditVat) : 0n,
    periodsTotal: i.periodsTotal,
    periodsRecognised: 0,
    periodStartMs: i.periodStartMs,
    status: i.status,
    provider: i.provider,
    pspRef: i.pspRef,
    issuedAtMs: nowMs,
    chargedAtMs: paid ? nowMs : null,
    refundedAtMs: null,
  };
}

export const periodsFor = (interval: "month" | "year"): number => (interval === "year" ? 12 : 1);

/** Deterministic per (subscription, cycle, attempt), so two racers posting the same charge post it once. */
export const chargeLedgerKey = (i: Pick<InvoiceRecord, "subscriptionId" | "cycle" | "attempt">): string =>
  `plus:${i.subscriptionId}:cycle:${i.cycle}:attempt:${i.attempt}:charged`;

/** Posts the charge to the ledger first (idempotent), then the caller commits state, then receipts queue. */
export async function postCharge(d: PlusDeps, inv: InvoiceRecord): Promise<JournalEntry | null> {
  if (inv.amountMinor === 0n) return null;
  // B-5: fail closed. A positive charge with no provider has no clearing account to post to.
  if (inv.provider === null || inv.provider === "") throw new Error(`plus invoice ${inv.id} has no PSP provider`);
  const entry = plusCharged(
    { tender: { kind: "psp", psp: inv.provider, amount: money(inv.amountMinor) }, vatBps: d.cfg.vatBps },
    ledgerMeta(d, chargeLedgerKey(inv), inv.id),
  );
  await d.ledger.post(entry);
  return entry;
}

export async function queueReceipt(d: PlusDeps, inv: InvoiceRecord): Promise<void> {
  if (inv.amountMinor === 0n) return;
  try {
    await d.receipts.queuePlusReceipt({
      invoiceId: inv.id,
      userId: inv.userId,
      grossMinor: inv.amountMinor,
      vatMinor: inv.vatMinor,
    });
  } catch {
    // Retried by the tax-eta queue (reconciliation reports unreceipted invoices); never fails a paid charge.
  }
}

export type ChargeSucceeded = Extract<ChargeOutcome, { kind: "succeeded" }>;

export { createJournalEntry };
