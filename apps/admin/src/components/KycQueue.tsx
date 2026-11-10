import Link from "next/link";
import type { Locale, Translator } from "@outlet/i18n";
import { fmtDateTime } from "../lib/fmt";
import { label } from "../lib/labels";
import type { z } from "zod";
import type { KycSummary } from "../lib/schemas";

export const KYC_STATUSES = ["SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED", "DRAFT"] as const;

export function KycQueue({ t, locale, base, items, status }: { t: Translator; locale: Locale; base: string; items: readonly z.infer<typeof KycSummary>[]; status: string }) {
  return (
    <>
      <form method="get" className="row filterRow">
        <label className="field">
          <span>{t("admin.kyc.filter.status")}</span>
          <select name="status" defaultValue={status}>
            <option value="">{t("admin.kyc.filter.all")}</option>
            {KYC_STATUSES.map((s) => (<option key={s} value={s}>{label(t, "admin.kyc.status", s)}</option>))}
          </select>
        </label>
        <button type="submit" className="btn btnSecondary">{t("admin.action.apply")}</button>
      </form>
      {items.length === 0 ? (
        <p className="empty">{t("admin.kyc.empty")}</p>
      ) : (
        <div className="tableWrap" tabIndex={0} role="group" aria-label={t("admin.nav.kyc")}>
<table className="table">
          <thead><tr><th scope="col">{t("admin.kyc.col.seller")}</th><th scope="col">{t("admin.kyc.col.status")}</th><th scope="col">{t("admin.kyc.col.submitted")}</th><th scope="col"><span className="srOnly">{t("admin.kyc.open")}</span></th></tr></thead>
          <tbody>
            {items.map((k) => (
              <tr key={k.id}>
                <td>{k.legal_name_ar}</td>
                <td>{label(t, "admin.kyc.status", k.status)}</td>
                <td>{k.submitted_at ? fmtDateTime(k.submitted_at, locale) : t("admin.kyc.notSubmitted")}</td>
                <td><Link href={`${base}/kyc/${k.id}`}>{t("admin.kyc.open")}<span className="srOnly"> {k.legal_name_ar}</span></Link></td>
              </tr>
            ))}
          </tbody>
        </table>
</div>
      )}
    </>
  );
}
