import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import type { z } from "zod";
import { fmtDate, fmtDateTime, fmtNumber, hoursUntil } from "../lib/fmt";
import { label } from "../lib/labels";
import type { Breach, ConsentStats, PrivacyRequest, Transfer } from "../lib/schemas";
import { BreachStubForm } from "./BreachStubForm";

type Req = z.infer<typeof PrivacyRequest>;

/** Statutory windows shown next to each kind (hours for export per master prompt B1, days for the default DSAR SLA). */
export const SLA = { exportHours: 72, deleteDays: 30 } as const;

export function dueText(t: Translator, req: Pick<Req, "due_at" | "completed_at">, now: Date, locale: Locale): { readonly text: string; readonly overdue: boolean } {
  if (req.completed_at) return { text: t("admin.dpo.due.done"), overdue: false };
  const h = hoursUntil(req.due_at, now);
  if (h < 0) return { text: t("admin.dpo.due.overdue", { hours: fmtNumber(-h, locale) }), overdue: true };
  return { text: t("admin.dpo.due.left", { hours: fmtNumber(h, locale) }), overdue: false };
}

export function DpoView({ t, locale, now, requests, consent, breaches, transfers }: {
  t: Translator; locale: Locale; now: Date; requests: readonly Req[]; consent: z.infer<typeof ConsentStats> | null; breaches: readonly z.infer<typeof Breach>[]; transfers: readonly z.infer<typeof Transfer>[];
}) {
  return (
    <div className="stack">
      <section aria-labelledby="dpo-req" className="card">
        <h2 id="dpo-req" className="panelTitle">{t("admin.dpo.requests.title")}</h2>
        {requests.length === 0 ? <p className="empty">{t("admin.dpo.requests.empty")}</p> : (
          <table className="table">
            <thead><tr><th scope="col">{t("admin.dpo.col.subject")}</th><th scope="col">{t("admin.dpo.col.kind")}</th><th scope="col">{t("admin.dpo.col.status")}</th><th scope="col">{t("admin.dpo.col.due")}</th><th scope="col">{t("admin.dpo.col.blocked")}</th></tr></thead>
            <tbody>
              {requests.map((r) => {
                const due = dueText(t, r, now, locale);
                const sla: MessageKey = r.kind === "export" ? "admin.dpo.sla.export" : "admin.dpo.sla.delete";
                const slaText = r.kind === "export" ? t(sla, { hours: fmtNumber(SLA.exportHours, locale) }) : t(sla, { days: fmtNumber(SLA.deleteDays, locale) });
                return (
                  <tr key={r.id} data-overdue={due.overdue ? "true" : "false"}>
                    <td dir="ltr">{r.subject_ref}</td>
                    <td>{label(t, "admin.dpo.kind", r.kind)}<br /><span className="hint">{slaText}</span></td>
                    <td>{r.status}</td>
                    <td><span className={due.overdue ? "tag tagCritical" : "tag"}>{due.text}</span><br /><span className="hint">{fmtDateTime(r.due_at, locale)}</span></td>
                    <td>{r.blocked_reason ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="dpo-consent" className="card">
        <h2 id="dpo-consent" className="panelTitle">{t("admin.dpo.consent.title")}</h2>
        <p className="hint">{t("admin.dpo.consent.lead")}</p>
        {consent === null || consent.purposes.length === 0 ? <p className="empty">{t("admin.dpo.consent.empty")}</p> : (
          <>
            <p className="hint">{t("admin.dpo.consent.asOf", { when: fmtDateTime(consent.as_of, locale) })}</p>
            <table className="table">
              <thead><tr><th scope="col">{t("admin.dpo.consent.purpose")}</th><th scope="col">{t("admin.dpo.consent.version")}</th><th scope="col">{t("admin.dpo.consent.granted")}</th><th scope="col">{t("admin.dpo.consent.withdrawn")}</th></tr></thead>
              <tbody>
                {consent.purposes.map((p) => (
                  <tr key={`${p.purpose_code}-${String(p.purpose_version)}`}><td dir="ltr">{p.purpose_code}</td><td>{fmtNumber(p.purpose_version, locale)}</td><td>{fmtNumber(p.granted_count, locale)}</td><td>{fmtNumber(p.withdrawn_30d, locale)}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section aria-labelledby="dpo-breach" className="card">
        <h2 id="dpo-breach" className="panelTitle">{t("admin.dpo.breach.title")}</h2>
        {breaches.length === 0 ? <p className="empty">{t("admin.dpo.breach.empty")}</p> : (
          <table className="table">
            <thead><tr><th scope="col">{t("admin.dpo.breach.col.detected")}</th><th scope="col">{t("admin.dpo.breach.col.severity")}</th><th scope="col">{t("admin.dpo.breach.col.status")}</th><th scope="col">{t("admin.dpo.breach.col.deadline")}</th><th scope="col">{t("admin.dpo.breach.col.summary")}</th></tr></thead>
            <tbody>
              {breaches.map((b) => (
                <tr key={b.id}>
                  <td>{fmtDateTime(b.detected_at, locale)}</td><td>{label(t, "admin.dpo.breach.severity", b.severity)}</td><td>{label(t, "admin.dpo.breach.status", b.status)}</td>
                  <td>{b.pdpc_deadline_at ? fmtDateTime(b.pdpc_deadline_at, locale) : t("admin.dpo.breach.noDeadline")}</td><td>{b.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <BreachStubForm locale={locale} />
      </section>

      <section aria-labelledby="dpo-transfers" className="card">
        <h2 id="dpo-transfers" className="panelTitle">{t("admin.dpo.transfers.title")}</h2>
        {transfers.length === 0 ? <p className="empty">{t("admin.dpo.transfers.empty")}</p> : (
          <table className="table">
            <thead><tr><th scope="col">{t("admin.dpo.transfers.processor")}</th><th scope="col">{t("admin.dpo.transfers.country")}</th><th scope="col">{t("admin.dpo.transfers.mechanism")}</th><th scope="col">{t("admin.dpo.transfers.status")}</th><th scope="col">{t("admin.dpo.transfers.until")}</th></tr></thead>
            <tbody>
              {transfers.map((x) => (
                <tr key={x.id}><td dir="ltr">{x.processor_code}</td><td dir="ltr">{x.destination_country}</td><td>{x.mechanism}</td><td>{x.status}</td><td>{fmtDate(x.valid_until, locale)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
