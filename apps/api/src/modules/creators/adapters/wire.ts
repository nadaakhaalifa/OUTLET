import { moneyToWire } from "@outlet/validation";
import type { CreatorDashboard } from "../application/commissions";
import type { AffiliateLink, Commission, CreatorAccount, CreatorLook, CreatorPayout } from "../domain/ports";

const money = (amount: bigint) => moneyToWire({ amount, currency: "EGP" });
const at = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Honest disclosure label key. Wording is pending VR-P3-04 (Legal); the key is stable. */
export const DISCLOSURE_KEY = "creator.affiliate_disclosure";

export const accountWire = (a: CreatorAccount) => ({
  handle: a.handle,
  display_name: a.displayName,
  status: a.status,
  kyc_state: a.kycState,
  payout_preference: a.payoutPref,
  applied_at: at(a.appliedAtMs),
});

export const adminAccountWire = (a: CreatorAccount) => ({
  id: a.id,
  user_id: a.userId,
  handle: a.handle,
  display_name: a.displayName,
  status: a.status,
  kyc_state: a.kycState,
  status_reason: a.statusReason,
  applied_at: at(a.appliedAtMs),
  decided_at: at(a.decidedAtMs),
});

export const linkWire = (l: AffiliateLink, base: string) => ({
  id: l.id,
  target_type: l.targetType,
  target_id: l.targetId,
  status: l.status,
  share_url: `${base}/${l.slug}`,
  disclosure_key: DISCLOSURE_KEY,
  created_at: at(l.createdAtMs),
});

export const lookWire = (l: CreatorLook) => ({
  id: l.id,
  title: l.title,
  status: l.status,
  product_ids: l.productIds,
  disclosure_key: DISCLOSURE_KEY,
  created_at: at(l.createdAtMs),
  updated_at: at(l.updatedAtMs),
});

/** No buyer, order or line identity: a creator sees amounts and states only. */
export const commissionWire = (c: Commission) => ({
  id: c.id,
  state: c.state,
  amount: money(c.amount),
  clawed_back: money(c.clawedBack),
  net: money(c.amount - c.clawedBack),
  on_hold: c.state === "ACCRUING",
  closed_at: at(c.closedAtMs),
  accrued_at: at(c.accruedAtMs),
});

export const payoutWire = (p: CreatorPayout) => ({
  id: p.id,
  amount: money(p.amount),
  state: p.state,
  hold_reason: p.holdReason,
  failure_reason: p.failureReason,
  created_at: at(p.createdAtMs),
  updated_at: at(p.updatedAtMs),
});

export const adminPayoutWire = (p: CreatorPayout) => ({ ...payoutWire(p), creator_id: p.creatorId, attempt: p.attempt, created_by: p.createdBy });

export const dashboardWire = (d: CreatorDashboard) => ({
  handle: d.handle,
  display_name: d.displayName,
  status: d.status,
  kyc_state: d.kycState,
  payout_preference: d.payoutPref,
  earning_blocked_reason: d.earnIneligibleReason,
  payout_blocked_reason: d.payoutIneligibleReason,
  payable: money(d.balance.payable),
  owes_platform: money(d.balance.owesPlatform),
  balance_negative: d.balance.negative,
  pending: money(d.totals.pending),
  accrued_total: money(d.totals.accrued),
  clawed_back_total: money(d.totals.clawedBack),
  paid_total: money(d.totals.paid),
  held: money(d.totals.held),
  month_accrued: money(d.monthAccrued),
  monthly_cap: money(d.monthlyCap),
  clicks_30d: d.clicks30d.total,
  counted_clicks_30d: d.clicks30d.counted,
  active_links: d.activeLinks,
  payouts_enabled: d.payoutsEnabled,
  disclosure_key: DISCLOSURE_KEY,
});
