import type { Locale, Translator } from "@outlet/i18n";
import type { z } from "zod";
import { fmtDateTime } from "../lib/fmt";
import type { AuditEntry } from "../lib/schemas";
import { VerifyChain } from "./VerifyChain";

export interface AuditFilters { readonly actor_id: string; readonly action: string; readonly target_type: string; readonly from: string; readonly to: string }

export function AuditView({ t, locale, market, entries, filters }: { t: Translator; locale: Locale; market: string; entries: readonly z.infer<typeof AuditEntry>[]; filters: AuditFilters }) {
  return (
    <div className="stack">
      <form method="get" className="row filterRow">
        <label className="field"><span>{t("admin.audit.filter.actor")}</span><input name="actor_id" defaultValue={filters.actor_id} dir="ltr" /></label>
        <label className="field"><span>{t("admin.audit.filter.action")}</span><input name="action" defaultValue={filters.action} dir="ltr" /></label>
        <label className="field"><span>{t("admin.audit.filter.target")}</span><input name="target_type" defaultValue={filters.target_type} dir="ltr" /></label>
        <label className="field"><span>{t("admin.audit.filter.from")}</span><input name="from" type="date" defaultValue={filters.from} /></label>
        <label className="field"><span>{t("admin.audit.filter.to")}</span><input name="to" type="date" defaultValue={filters.to} /></label>
        <button type="submit" className="btn btnSecondary">{t("admin.action.apply")}</button>
        <a className="btn btnGhost" href="?">{t("admin.action.reset")}</a>
      </form>
      <VerifyChain locale={locale} market={market} />
      {entries.length === 0 ? <p className="empty">{t("admin.audit.empty")}</p> : (
        <table className="table">
          <thead><tr><th scope="col">{t("admin.audit.col.when")}</th><th scope="col">{t("admin.audit.col.actor")}</th><th scope="col">{t("admin.audit.col.action")}</th><th scope="col">{t("admin.audit.col.target")}</th><th scope="col">{t("admin.audit.col.reason")}</th><th scope="col">{t("admin.audit.col.request")}</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.occurred_at, locale)}</td><td dir="ltr">{e.actor_id ? e.actor_id.slice(0, 8) : t("admin.audit.system")}</td><td dir="ltr">{e.action}</td>
                <td dir="ltr">{e.target_type}:{e.target_id.slice(0, 8)}</td><td dir="ltr">{e.reason_code ?? ""}</td><td dir="ltr">{e.request_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
