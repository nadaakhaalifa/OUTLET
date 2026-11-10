import type { Locale, Translator } from "@outlet/i18n";
import type { z } from "zod";
import { fmtDateTime, fmtNumber } from "../lib/fmt";
import { label } from "../lib/labels";
import type { AdminFinding, EnforcementAction, PriceTrust } from "../lib/schemas";

type Action = z.infer<typeof EnforcementAction>;
type Finding = z.infer<typeof AdminFinding>;
type Trust = z.infer<typeof PriceTrust>;

const short = (id: string): string => id.slice(0, 8);

/** Read-only: enforcement log, Price Trust Score per store, appeals (findings in APPEALED). No action buttons until the review route is wired. */
export function PriceView({ t, locale, actions, trust, findings }: { t: Translator; locale: Locale; actions: readonly Action[]; trust: readonly Trust[]; findings: readonly Finding[] }) {
  const appeals = findings.filter((f) => f.finding.status === "APPEALED");
  return (
    <div className="stack">
      <section aria-labelledby="pi-actions" className="card">
        <h2 id="pi-actions" className="panelTitle">{t("admin.price.actions.title")}</h2>
        {actions.length === 0 ? <p className="empty">{t("admin.price.actions.empty")}</p> : (
          <div className="tableWrap" tabIndex={0} role="group" aria-labelledby="pi-actions">
          <table className="table">
            <thead><tr>
              <th scope="col">{t("admin.price.col.action")}</th><th scope="col">{t("admin.price.col.store")}</th><th scope="col">{t("admin.price.col.starts")}</th>
              <th scope="col">{t("admin.price.col.expires")}</th><th scope="col">{t("admin.price.col.status")}</th><th scope="col">{t("admin.price.col.review")}</th>
            </tr></thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td>{label(t, "admin.price.action", a.action)}</td><td dir="ltr">{short(a.store_id)}</td><td>{fmtDateTime(a.starts_at, locale)}</td>
                  <td>{fmtDateTime(a.expires_at, locale)}</td><td>{a.status}</td>
                  <td>{a.human_review_required ? (a.reviewed_at ? t("admin.price.review.done") : t("admin.price.review.needed")) : t("admin.price.review.none")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section aria-labelledby="pi-trust" className="card">
        <h2 id="pi-trust" className="panelTitle">{t("admin.price.trust.title")}</h2>
        {trust.length === 0 ? <p className="empty">{t("admin.price.trust.empty")}</p> : (
          <div className="tableWrap" tabIndex={0} role="group" aria-labelledby="pi-trust">
          <table className="table">
            <thead><tr><th scope="col">{t("admin.price.col.store")}</th><th scope="col">{t("admin.price.trust.score")}</th><th scope="col">{t("admin.price.trust.violations")}</th><th scope="col">{t("admin.price.trust.computed")}</th></tr></thead>
            <tbody>
              {trust.map((s) => (
                <tr key={s.store_id}><td dir="ltr">{short(s.store_id)}</td><td>{fmtNumber(s.score, locale)}</td><td>{fmtNumber(s.violations_90d, locale)}</td><td>{fmtDateTime(s.computed_at, locale)}</td></tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section aria-labelledby="pi-appeals" className="card">
        <h2 id="pi-appeals" className="panelTitle">{t("admin.price.appeals.title")}</h2>
        {appeals.length === 0 ? <p className="empty">{t("admin.price.appeals.empty")}</p> : <FindingsTable t={t} locale={locale} rows={appeals} />}
      </section>

      <section aria-labelledby="pi-findings" className="card">
        <h2 id="pi-findings" className="panelTitle">{t("admin.price.findings.title")}</h2>
        {findings.length === 0 ? <p className="empty">{t("admin.price.findings.empty")}</p> : <FindingsTable t={t} locale={locale} rows={findings} />}
      </section>
    </div>
  );
}

function FindingsTable({ t, locale, rows }: { t: Translator; locale: Locale; rows: readonly Finding[] }) {
  return (
    <div className="tableWrap" tabIndex={0} role="group" aria-labelledby="pi-findings">
    <table className="table">
      <thead><tr><th scope="col">{t("admin.price.col.rule")}</th><th scope="col">{t("admin.price.col.severity")}</th><th scope="col">{t("admin.price.col.status")}</th><th scope="col">{t("admin.price.col.store")}</th><th scope="col">{t("admin.price.col.detected")}</th></tr></thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.finding.id}>
            <td>{label(t, "admin.price.rule", f.finding.rule)}</td><td>{label(t, "admin.price.severity", f.finding.severity)}</td>
            <td>{label(t, "admin.price.status", f.finding.status)}</td><td dir="ltr">{short(f.store_id)}</td><td>{fmtDateTime(f.finding.detected_at, locale)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
