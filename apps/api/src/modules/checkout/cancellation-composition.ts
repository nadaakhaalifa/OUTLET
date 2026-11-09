import { OrderCancellation, PROMOTIONS_KILL_SWITCH, makePromotionsPort } from "@outlet/checkout";
import type { CancellationLog, OrderCancellationDeps, PromotionsPort, VoucherSettlementPort } from "@outlet/checkout";
import type { RoleSqlClient } from "@outlet/db";
import { PgCancellationAudit } from "./cancellation-audit.js";

/** The one kill-switch read the promotions port needs (FlagService.isKilled). */
export interface PromotionsKillRead { isKilled(name: typeof PROMOTIONS_KILL_SWITCH, ctx: { readonly marketId: string }): Promise<boolean> }

/**
 * Production promotions port (cli.ts and the composition tests). Fails closed: a failed or killed flag read means no discount. The voucher
 * reinstate gate is the shopper-scoped PgOrderFacts on the same app pool (makePromotionsPort default), so a whole cancellation before
 * shipping reinstates the voucher instead of failing with REINSTATE_NOT_ALLOWED (chief review waves 9-10, H).
 */
export const productionPromotionsPort = (app: RoleSqlClient<"outlet_app">, marketId: string, flags: PromotionsKillRead): PromotionsPort & VoucherSettlementPort =>
  makePromotionsPort({ client: app, marketId, kill: { isEnabled: () => flags.isKilled(PROMOTIONS_KILL_SWITCH, { marketId }).then((k) => !k).catch(() => false) } });

/** Production OrderCancellation: audit appended in the cancel transaction (PgCancellationAudit.appendIn), voucher failures logged at error level. */
export const productionOrderCancellation = (d: Pick<OrderCancellationDeps, "client" | "marketId" | "reservations" | "provider" | "credit"> & { readonly vouchers: VoucherSettlementPort; readonly log: CancellationLog }): OrderCancellation =>
  new OrderCancellation({ ...d, audit: new PgCancellationAudit(d.client) });
