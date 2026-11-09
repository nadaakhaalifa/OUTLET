import { z } from "zod";
import { flattenTiles, tileState, type DashboardResponse, type TileKey } from "./dashboard";

/** Ops attention queue wire shapes (packages/ops-attention README, snake_case like the other admin lists). */
export const RESOLUTION_CODES = ["FIXED_MANUALLY", "REFUNDED_OFFLINE", "RETRIED_OK", "NOT_AN_ISSUE", "DUPLICATE", "ESCALATED"] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const AttentionItem = z.object({
  id: z.uuid(),
  kind: z.string(),
  ref_type: z.string().nullable().optional(),
  ref_id: z.string().nullable().optional(),
  status: z.enum(["OPEN", "ACKED", "RESOLVED"]),
  created_at: z.string(),
  acked_at: z.string().nullable().optional(),
  resolution_code: z.string().nullable().optional(),
});
export type AttentionItemView = z.infer<typeof AttentionItem>;
export const AttentionPage = z.object({ items: z.array(AttentionItem), next_cursor: z.string().nullable().optional() });

/** Open work first (OPEN before ACKED), newest first inside a status; resolved items are never shown in the queue. */
export function queueOrder(items: readonly AttentionItemView[]): AttentionItemView[] {
  const rank = (s: string): number => (s === "OPEN" ? 0 : 1);
  return items.filter((i) => i.status !== "RESOLVED").sort((a, b) => rank(a.status) - rank(b.status) || Date.parse(b.created_at) - Date.parse(a.created_at));
}

export type NeedId = "breach" | "dsar" | "refundsOverdue" | "recon" | "disputes" | "attention" | "approvals" | "kyc" | "enforcement" | "sla" | "cod" | "payouts" | "killSwitches";
export interface NeedRow {
  readonly id: NeedId;
  readonly count: number;
  readonly urgent: boolean;
  /** Console path under the segment, or null when no page behind it exists yet. */
  readonly href: string | null;
}
export interface Needs {
  readonly rows: readonly NeedRow[];
  /** At least one check feeding this list could not be read: the panel must not claim "all clear". */
  readonly incomplete: boolean;
}

const HOUR = 3_600_000;

/**
 * "Needs you today", urgent first (plan 3.3). Only count > 0. A tile the caller may not see is simply absent; a tile that failed,
 * is stale or is not connected removes the all-clear claim instead of counting as zero.
 */
export function buildNeeds(resp: DashboardResponse, now: Date): Needs {
  const tiles = flattenTiles(resp);
  let incomplete = false;
  const rows: NeedRow[] = [];
  const read = <K extends TileKey>(key: K) => {
    const s = tileState(key, tiles[key], now);
    if (s.kind === "unavailable" || (s.kind === "ok" && s.staleSince !== null)) incomplete = true;
    return s.kind === "ok" && s.staleSince === null ? s.data : null;
  };
  const push = (id: NeedId, count: number, urgent: boolean, href: string | null) => { if (count > 0) rows.push({ id, count, urgent, href }); };

  const breach = read("breaches_open");
  if (breach !== null) {
    const due = breach.next_pdpc_deadline_at;
    push("breach", breach.open, due !== null && Date.parse(due) - now.getTime() < 24 * HOUR, "/privacy");
  }
  const dsar = read("dsar_queue");
  if (dsar !== null) push("dsar", dsar.overdue, true, "/privacy");
  const overdue = read("refunds_overdue");
  if (overdue !== null) push("refundsOverdue", overdue.count, true, "/today/refunds-waiting");
  const recon = read("recon_unmatched");
  if (recon !== null) push("recon", recon.aged_over_3d, true, "/reconciliation");
  const disputes = read("disputes_open");
  if (disputes !== null) push("disputes", disputes.past_sla, true, null);
  const attention = read("attention_open");
  if (attention !== null) push("attention", attention.open, false, "/attention");
  const approvals = read("approvals_pending");
  if (approvals !== null) push("approvals", approvals.for_me, false, "/today/approvals");
  const kyc = read("kyc_queue");
  if (kyc !== null) push("kyc", kyc.submitted, false, "/kyc");
  const enforcement = read("price_enforcement");
  if (enforcement !== null) push("enforcement", enforcement.pending_review, false, "/price-integrity");
  const sla = read("seller_sla_breaches");
  if (sla !== null) push("sla", sla.late_accept + (sla.late_dispatch ?? 0), false, "/today/seller-sla-breaches");
  const cod = read("cod_awaiting_confirmation");
  if (cod !== null) push("cod", cod.count, false, "/today/cod-awaiting-confirmation");
  const payouts = read("payouts");
  if (payouts !== null) push("payouts", payouts.on_hold_count, false, null);
  const ks = read("kill_switches");
  if (ks !== null) push("killSwitches", ks.engaged_money.length + ks.engaged_ui.length, false, null);
  return { rows: [...rows.filter((r) => r.urgent), ...rows.filter((r) => !r.urgent)], incomplete };
}
