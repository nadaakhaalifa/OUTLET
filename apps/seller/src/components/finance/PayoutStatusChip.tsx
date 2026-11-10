import type { MessageKey, Translator } from "@outlet/i18n";
import type { PayoutStatus } from "../../lib/finance-model";

const KEY: Readonly<Record<PayoutStatus, MessageKey>> = {
  SCHEDULED: "seller.finance.payouts.status.SCHEDULED", ON_HOLD: "seller.finance.payouts.status.ON_HOLD", APPROVED: "seller.finance.payouts.status.APPROVED",
  SENT: "seller.finance.payouts.status.SENT", SETTLED: "seller.finance.payouts.status.SETTLED", FAILED: "seller.finance.payouts.status.FAILED", CANCELLED: "seller.finance.payouts.status.CANCELLED",
};
const TONE = (s: PayoutStatus): "action" | "bad" | "plain" => (s === "ON_HOLD" ? "action" : s === "FAILED" || s === "CANCELLED" ? "bad" : "plain");

/** The label is always text; colour only backs it up. */
export function PayoutStatusChip({ t, status }: { t: Translator; status: PayoutStatus }) {
  return (
    <span className="chip" data-tone={TONE(status)} data-status={status}>
      {t(KEY[status])}
    </span>
  );
}
