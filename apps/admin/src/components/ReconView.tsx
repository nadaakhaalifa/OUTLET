import Link from "next/link";
import type { Locale, Translator } from "@outlet/i18n";
import type { z } from "zod";
import { fmtDate, fmtMoney } from "../lib/fmt";
import { label } from "../lib/labels";
import type { ReconItem, ReconRun } from "../lib/schemas";
import { ResolveForm, StartRunForm } from "./ReconForms";

type Run = z.infer<typeof ReconRun>;
type Item = z.infer<typeof ReconItem>;

/** Items older than this many days are escalated to Finance (spec T4: aging above 3 days). */
export const ESCALATION_DAYS = 3;
export const isEscalated = (item: Pick<Item, "age_days" | "status">): boolean => item.status !== "RESOLVED" && item.age_days > ESCALATION_DAYS;

export function ReconView({ t, locale, market, base, today, runs, items, selectedRun, canRun }: {
  t: Translator; locale: Locale; market: string; base: string; today: string; runs: readonly Run[]; items: readonly Item[] | null; selectedRun: string | null; canRun: boolean;
}) {
  return (
    <div className="stack">
      <section aria-labelledby="rc-integrity" className="card">
        <h2 id="rc-integrity" className="panelTitle">{t("admin.recon.integrity.title")}</h2>
        <dl className="facts">
          <dt>{t("admin.recon.integrity.trial")}</dt><dd data-testid="trial-balance">{t("admin.recon.integrity.notRun")}</dd>
          <dt>{t("admin.recon.integrity.chain")}</dt><dd data-testid="hash-chain">{t("admin.recon.integrity.notRun")}</dd>
        </dl>
        <p className="hint">{t("admin.recon.integrity.hint")}</p>
      </section>

      <section aria-labelledby="rc-runs" className="card">
        <h2 id="rc-runs" className="panelTitle">{t("admin.recon.runs.title")}</h2>
        {canRun ? <StartRunForm locale={locale} market={market} today={today} /> : null}
        {runs.length === 0 ? <p className="empty">{t("admin.recon.runs.empty")}</p> : (
          <div className="tableWrap" tabIndex={0} role="group" aria-labelledby="rc-runs">
          <table className="table">
            <thead><tr>
              <th scope="col">{t("admin.recon.col.source")}</th><th scope="col">{t("admin.recon.col.counterparty")}</th><th scope="col">{t("admin.recon.col.date")}</th><th scope="col">{t("admin.recon.col.mode")}</th>
              <th scope="col">{t("admin.recon.col.status")}</th><th scope="col">{t("admin.recon.col.matched")}</th><th scope="col">{t("admin.recon.col.unmatched")}</th><th scope="col"><span className="srOnly">{t("admin.recon.run.items")}</span></th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} {...(selectedRun === r.id ? { "aria-selected": true } : {})}>
                  <td>{label(t, "admin.recon.source", r.source)}</td><td>{r.counterparty}</td><td>{fmtDate(r.business_date, locale)}</td><td>{label(t, "admin.recon.mode", r.mode)}</td>
                  <td>{label(t, "admin.recon.run.status", r.status)}</td><td>{r.matched_count}</td><td>{r.unmatched_count}</td>
                  <td><Link href={`${base}/reconciliation?run=${r.id}`}>{t("admin.recon.run.items")}<span className="srOnly"> {r.counterparty}</span></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section aria-labelledby="rc-items" className="card">
        <h2 id="rc-items" className="panelTitle">{t("admin.recon.items.title")}</h2>
        {items === null ? <p className="empty">{t("admin.recon.items.pickRun")}</p> : items.length === 0 ? <p className="empty">{t("admin.recon.items.empty")}</p> : (
          <div className="tableWrap" tabIndex={0} role="group" aria-labelledby="rc-items">
          <table className="table">
            <thead><tr>
              <th scope="col">{t("admin.recon.col.ref")}</th><th scope="col">{t("admin.recon.col.expected")}</th><th scope="col">{t("admin.recon.col.actual")}</th><th scope="col">{t("admin.recon.col.status")}</th>
              <th scope="col">{t("admin.recon.col.age")}</th><th scope="col">{t("admin.recon.col.ticket")}</th><th scope="col">{t("admin.recon.col.resolve")}</th>
            </tr></thead>
            <tbody>
              {items.map((i) => {
                const escalated = isEscalated(i);
                return (
                  <tr key={i.id} data-aging={escalated ? "escalated" : "ok"} className={escalated ? "rowEscalated" : undefined}>
                    <td dir="ltr">{i.source_ref_type}{i.source_ref_id ? ` ${i.source_ref_id.slice(0, 8)}` : ""}</td><td>{fmtMoney(i.expected, locale)}</td><td>{fmtMoney(i.actual, locale)}</td>
                    <td>{label(t, "admin.recon.item.status", i.status)}</td>
                    <td>{t("admin.recon.age.days", { days: i.age_days })} <span className={escalated ? "tag tagCritical" : "tag"}>{escalated ? t("admin.recon.age.escalated") : t("admin.recon.age.watch")}</span></td>
                    <td dir="ltr">{i.ticket_ref ?? ""}</td>
                    <td>{i.status === "RESOLVED" ? null : (<details><summary>{t("admin.recon.resolve.submit")}</summary><ResolveForm locale={locale} market={market} itemId={i.id} /></details>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
