import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import { fmtDateTime, fmtMoney, fmtNumber } from "../../lib/fmt";
import { flattenTiles, tileState, type DashboardResponse, type TileKey, type Tiles } from "../../lib/dashboard";
import type { IconName } from "../kit/Icon";

/** What one tile shows when it has data. Plain strings only (already formatted for the locale). */
export interface TileBody {
  readonly icon: IconName;
  readonly value?: string;
  readonly notes: readonly string[];
  /** true = needs a person, false = all good, undefined = neutral figure. */
  readonly alert?: boolean;
  /** Console path under the segment, or null. */
  readonly href: string | null;
}

export interface Ctx { readonly t: Translator; readonly locale: Locale }
type Data = { [K in TileKey]: Extract<Tiles[K], { status: "ok" }>["data"] };
type Describers = { [K in TileKey]?: (d: Data[K], c: Ctx) => TileBody };

const n = (c: Ctx, v: number): string => fmtNumber(v, c.locale);
const oldest = (c: Ctx, at: string | null): readonly string[] => (at === null ? [] : [c.t("admin.home.oldest", { time: fmtDateTime(at, c.locale) })]);
const body = (icon: IconName, href: string | null, value: string | undefined, notes: readonly string[], alert?: boolean): TileBody => ({ icon, href, notes, ...(value !== undefined ? { value } : {}), ...(alert !== undefined ? { alert } : {}) });
const names = (c: Ctx, list: readonly string[]): string => (list.length === 0 ? c.t("admin.home.note.none") : list.join(", "));

export const DESCRIBERS: Describers = {
  orders_today: (d, c) => body("orders", null, n(c, d.count), []),
  gmv_today: (d, c) => body("money", null, fmtMoney(d.gmv, c.locale), [c.t("admin.home.note.gmv", { refunded: fmtMoney(d.refunded, c.locale), week: fmtMoney(d.gmv_7d, c.locale), days: 7 }), c.t("admin.home.note.gmvBasis")]),
  orders_by_step: (d, c) => body("orders", null, n(c, d.paid_awaiting_accept + d.accepted + d.packed + d.in_transit + d.delivery_failed), [`${c.t("admin.home.steps.delivery_failed")}: ${n(c, d.delivery_failed)}`]),
  seller_sla_breaches: (d, c) => body("alert", null, n(c, d.late_accept + (d.late_dispatch ?? 0)), [d.late_dispatch === null ? c.t("admin.home.note.slaNoDispatch", { accept: n(c, d.late_accept) }) : c.t("admin.home.note.sla", { accept: n(c, d.late_accept), dispatch: n(c, d.late_dispatch) }), ...oldest(c, d.oldest_at)], d.late_accept + (d.late_dispatch ?? 0) > 0),
  cod_awaiting_confirmation: (d, c) => body("orders", null, n(c, d.count), oldest(c, d.oldest_at), d.count > 0),
  returns_pipeline: (d, c) => body("orders", null, n(c, d.requested + d.in_transit + d.awaiting_inspection), [c.t("admin.home.note.returns", { requested: n(c, d.requested), transit: n(c, d.in_transit), inspect: n(c, d.awaiting_inspection), overdue: n(c, d.inspection_overdue) })], d.inspection_overdue > 0),
  disputes_open: (d, c) => body("trust", null, n(c, d.open), [c.t("admin.home.note.disputes", { past: n(c, d.past_sla) }), ...oldest(c, d.oldest_at)], d.past_sla > 0),
  refunds_waiting: (d, c) => body("money", null, n(c, d.count), [c.t("admin.home.note.refundsWaiting", { amount: fmtMoney(d.amount, c.locale), manual: n(c, d.manual_review), failed: n(c, d.failed) }), ...oldest(c, d.oldest_at)], d.count > 0),
  refunds_overdue: (d, c) => body("alert", null, n(c, d.count), [c.t("admin.home.note.refundsOverdue", { amount: fmtMoney(d.amount, c.locale) }), ...oldest(c, d.oldest_due_at)], d.count > 0),
  payouts: (d, c) => body("money", null, n(c, d.due_count), [c.t("admin.home.note.payouts", { net: fmtMoney(d.due_net, c.locale), hold: n(c, d.on_hold_count), holdNet: fmtMoney(d.on_hold_net, c.locale), failed: n(c, d.failed), holds: n(c, d.open_holds) })], d.on_hold_count > 0 || d.failed > 0),
  recon_unmatched: (d, c) => body("money", "/reconciliation", n(c, d.open), [c.t("admin.home.note.recon", { escalated: n(c, d.escalated), aged: n(c, d.aged_over_3d), days: 3 }), ...oldest(c, d.oldest_at)], d.open > 0),
  cod_unremitted: (d, c) => body("money", null, n(c, d.parcels), [c.t("admin.home.note.codUnremitted", { amount: fmtMoney(d.amount, c.locale) })], d.parcels > 0),
  ledger_integrity: (d, c) => body("trust", null, c.t(d.balanced ? "admin.home.ledger.balanced" : "admin.home.ledger.unbalanced"), [c.t("admin.home.note.ledgerChain", { chain: c.t(d.chain_ok ? "admin.home.ledger.chainOk" : "admin.home.ledger.chainBroken"), time: fmtDateTime(d.checked_at, c.locale) })], !d.balanced || !d.chain_ok),
  kyc_queue: (d, c) => body("sellers", "/kyc", n(c, d.submitted + d.needs_info), [c.t("admin.home.note.kyc", { submitted: n(c, d.submitted), needs: n(c, d.needs_info) }), ...oldest(c, d.oldest_at)], d.submitted > 0),
  stores_moderation: (d, c) => body("sellers", null, n(c, d.pending_review), [c.t("admin.home.note.stores", { suspended: n(c, d.suspended) })], d.pending_review > 0),
  price_enforcement: (d, c) => body("catalog", "/price-integrity", n(c, d.active), [c.t("admin.home.note.enforcement", { pending: n(c, d.pending_review), suspensions: n(c, d.suspensions_awaiting_review) })], d.pending_review > 0 || d.suspensions_awaiting_review > 0),
  listings_by_status: (d, c) => body("catalog", null, n(c, d.published), [c.t("admin.home.note.listings", { inReview: n(c, d.in_review), paused: n(c, d.paused), blocked: n(c, d.blocked) })]),
  breaches_open: (d, c) => body("trust", "/privacy", n(c, d.open), d.next_pdpc_deadline_at === null ? [] : [c.t("admin.home.note.breach", { time: fmtDateTime(d.next_pdpc_deadline_at, c.locale) })], d.open > 0),
  dsar_queue: (d, c) => body("trust", "/privacy", n(c, d.open), [c.t("admin.home.note.dsar", { due: n(c, d.due_7d), overdue: n(c, d.overdue), days: 7 })], d.overdue > 0),
  attention_open: (d, c) => body("alert", "/attention", n(c, d.open), [c.t("admin.home.note.attention", { acked: n(c, d.acked) }), ...oldest(c, d.oldest_at)], d.open > 0),
  approvals_pending: (d, c) => body("access", "/today/approvals", n(c, d.for_me), d.soonest_expires_at === null ? [] : [c.t("admin.home.note.approvals", { time: fmtDateTime(d.soonest_expires_at, c.locale) })], d.for_me > 0),
  elevations_active: (d, c) => body("access", "/access", n(c, d.active), [c.t("admin.home.note.elevations", { pending: n(c, d.pending) }), ...(d.scope === "own" ? [c.t("admin.home.note.elevationsOwn")] : [])]),
  kill_switches: (d, c) => body("alert", null, n(c, d.engaged_money.length + d.engaged_ui.length), d.engaged_money.length + d.engaged_ui.length === 0 ? [c.t("admin.home.note.noneEngaged")] : [c.t("admin.home.note.killSwitches", { money: names(c, d.engaged_money), ui: names(c, d.engaged_ui) })], d.engaged_money.length + d.engaged_ui.length > 0),
};

export const tileLabel = (t: Translator, key: TileKey): string => t(`admin.home.tile.${key}` as MessageKey);

/** "All checks" sections (plan 3.3 with the marketplace names): tile order inside each. */
export const CHECK_SECTIONS: readonly { readonly id: "sellers" | "orders" | "money" | "catalog" | "trust" | "platform"; readonly tiles: readonly TileKey[] }[] = [
  { id: "sellers", tiles: ["kyc_queue", "stores_moderation"] },
  { id: "orders", tiles: ["orders_by_step", "seller_sla_breaches", "cod_awaiting_confirmation", "returns_pipeline", "disputes_open"] },
  { id: "money", tiles: ["refunds_waiting", "refunds_overdue", "payouts", "recon_unmatched", "cod_unremitted", "ledger_integrity"] },
  { id: "catalog", tiles: ["price_enforcement", "listings_by_status"] },
  { id: "trust", tiles: ["breaches_open", "dsar_queue"] },
  { id: "platform", tiles: ["attention_open", "approvals_pending", "elevations_active", "kill_switches"] },
];

/** True when at least one tile of the response is visible (not forbidden). */
export const anyVisible = (r: DashboardResponse, now: Date): boolean => {
  const tiles = flattenTiles(r);
  return (Object.keys(tiles) as TileKey[]).some((k) => tileState(k, tiles[k], now).kind !== "hidden");
};
