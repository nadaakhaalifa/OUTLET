import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { DynamicForm, type FieldSpec } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { DocumentSlots, type DocSlotView } from "../../../components/Uploads";
import { formatDateTime } from "../../../lib/format";
import { getOnboarding } from "../../../onboarding-context";
import {
  buildFormModel, DOC_STATE_KEY, docNeedsUpload, documentSlots, fieldsBySection, initialValues, SECTION_KEY, STEPS, submitBlockers, domainRequired,
  type StepId,
} from "../../../view-models/application-form";
import { isEditable, STATUS_KEY, statusVM } from "../../../view-models/application-status";
import {
  appealApplicationAction, confirmDocumentAction, createDocumentAction, deleteDocumentAction, domainAction, saveDetailsFormAction,
  submitApplicationAction, withdrawApplicationAction,
} from "../../actions-onboarding";

const stepSchema = z.enum(["details", "documents", "domain", "review"]);

export default async function ApplicationPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const { api, t, locale } = await getOnboarding();
  if (api === null) return <ErrorNotice kind="not_configured" locale={locale} />;
  const appRes = await api.getApplication(id);
  if (!appRes.ok) {
    if (appRes.error.kind === "not_found") notFound();
    return <ErrorNotice error={appRes.error} locale={locale} />;
  }
  const app = appRes.value.data;
  const vm = statusVM(app, locale);
  const editable = isEditable(app);

  /* ---------------- status view ---------------- */
  const statusView = (
    <>
      <p className="zm-tag" role="status">{t(STATUS_KEY[app.status])}</p>
      <ol className="zm-timeline" aria-label={t("ob.status.timeline")}>
        {vm.timeline.map((s) => (
          <li key={s.id} data-state={s.state}>
            {t(s.labelKey)}
            <span className="vh"> — {t(`ob.timeline.state.${s.state}` as const)}</span>
          </li>
        ))}
      </ol>
      {vm.decisionDueAt === null || app.status === "APPROVED" || app.status === "REJECTED" ? null : (
        <p className="zm-hint">{t("ob.status.due", { date: formatDateTime(vm.decisionDueAt, locale) })}</p>
      )}
      {app.status === "APPROVED" ? (
        <div className="zm-notice">
          <p>{t("ob.status.approvedBody")}</p>
          <p><a className="zm-btn primary" href="/start">{t("ob.status.continue")}</a></p>
        </div>
      ) : null}
      {vm.decision === null ? null : (
        <section className="zm-section" aria-labelledby="dec-h">
          <h2 id="dec-h">{t("ob.status.decision")}</h2>
          <p><strong>{t(vm.decision.reasonKey)}</strong></p>
          <p dir="auto">{vm.decision.message}</p>
          {vm.decision.reapplyAfter === null ? null : <p className="zm-hint">{t("ob.status.reapply", { date: formatDateTime(vm.decision.reapplyAfter, locale) })}</p>}
        </section>
      )}
      {vm.requested.length === 0 ? null : (
        <section className="zm-section" aria-labelledby="req-h">
          <h2 id="req-h">{t("ob.status.requested")}</h2>
          <ul className="zm-list">
            {vm.requested.map((r) => (
              <li key={r.code}><span dir="auto">{r.message}</span> <span className="zm-tag">{r.satisfied ? t("ob.status.satisfied") : t(`ob.item.${r.kind}` as const)}</span></li>
            ))}
          </ul>
        </section>
      )}
      {vm.canAppeal ? (
        <section className="zm-section" aria-labelledby="appeal-h">
          <h2 id="appeal-h">{t("ob.appeal.title")}</h2>
          <p className="zm-hint">{t("ob.appeal.body")}</p>
          <DynamicForm action={appealApplicationAction} locale={locale} hidden={{ id }} submitLabel={t("ob.appeal.submit")} nextPath={`/apply/${id}`}
            fields={[{ name: "statement", label: t("ob.appeal.statement"), type: "textarea", required: true, maxLength: 2000 }]} />
        </section>
      ) : vm.appealUsed ? <p className="zm-hint">{t("ob.appeal.used")}</p> : null}
      {vm.canWithdraw ? (
        <section className="zm-section">
          <DynamicForm action={withdrawApplicationAction} locale={locale} hidden={{ id }} submitLabel={t("ob.apply.withdraw")} variant="danger" fields={[]} nextPath={`/apply/${id}`} />
        </section>
      ) : null}
    </>
  );

  if (!editable) {
    return (
      <section aria-labelledby="app-h">
        <h1 id="app-h"><span dir="auto">{app.brand_name}</span></h1>
        <p className="zm-lead">{t("ob.status.lead")}</p>
        {statusView}
      </section>
    );
  }

  /* ---------------- wizard ---------------- */
  const reqRes = await api.requirements(app.brand_kind, app.country);
  if (!reqRes.ok) return <ErrorNotice error={reqRes.error} locale={locale} />;
  const req = reqRes.value.data;
  const model = buildFormModel(req, locale);
  const values = initialValues(app, model);
  const stepParsed = stepSchema.safeParse(typeof sp.step === "string" ? sp.step : "details");
  const step: StepId = stepParsed.success ? stepParsed.data : "details";
  const slots = documentSlots(req, app, locale);
  const blockers = submitBlockers({ req, app, model, values, nowMs: Date.now(), acks: { agreement: true, dpa: true, monitoring: true } });
  const needsDomain = domainRequired(req, values.website_domain ?? app.website_domain ?? "");
  const stepLabel: Record<StepId, string> = {
    details: t("ob.step.details"), documents: t("ob.step.documents"), domain: t("ob.step.domain"), review: t("ob.step.review"),
  };
  const slotViews: DocSlotView[] = slots.map((s) => ({
    code: s.code, label: s.label, help: s.help, required: s.required, group: s.group, accepts: s.accepts, acceptAttr: s.acceptAttr,
    maxBytes: s.maxBytes, stateLabel: t(DOC_STATE_KEY[s.state]), needsUpload: docNeedsUpload(s.state), scanning: s.state === "scanning" || s.state === "awaiting",
    filename: s.document?.original_filename ?? null,
  }));

  const detailFields = (section: ReturnType<typeof fieldsBySection>[number]): FieldSpec[] =>
    section.fields.map((f) => ({
      name: f.code, label: f.label, required: f.required, dir: f.dir, inputMode: f.inputMode, autoComplete: f.autoComplete, maxLength: f.maxLength,
      type: f.input === "select" ? "select" : f.input === "date" ? "text" : f.input === "tel" ? "tel" : f.input === "email" ? "email" : "text",
      value: values[f.code] ?? (f.input === "date" ? "" : ""),
      ...(f.input === "select" ? { options: f.options.map((o) => ({ value: o.value, label: t(o.labelKey) })) } : {}),
      ...(f.writeOnly ? { hint: t("ob.form.writeOnly") } : f.input === "date" ? { hint: t("ob.form.dateHint") } : {}),
    }));
  const allDetailFields: FieldSpec[] = fieldsBySection(model).flatMap((s) => detailFields(s));
  const sectionLegend = fieldsBySection(model).map((s) => t(SECTION_KEY[s.section])).join(" · ");

  return (
    <section aria-labelledby="app-h">
      <h1 id="app-h"><span dir="auto">{app.brand_name}</span></h1>
      <p className="zm-lead">{app.status === "NEEDS_INFO" ? t("ob.apply.fixLead") : t("ob.apply.wizardLead")}</p>
      {app.status === "NEEDS_INFO" ? statusView : null}
      <nav aria-label={t("ob.step.nav")}>
        <ol className="zm-steps">
          {STEPS.filter((s) => s !== "domain" || needsDomain || app.website_domain !== undefined).map((s) => (
            <li key={s}><Link className="zm-link" href={`/apply/${id}?step=${s}`} aria-current={s === step ? "step" : undefined}>{stepLabel[s]}</Link></li>
          ))}
        </ol>
      </nav>

      {step === "details" ? (
        <section aria-labelledby="det-h">
          <h2 id="det-h">{sectionLegend}</h2>
          {model.unmapped.length > 0 ? <p role="status" className="zm-notice">{t("ob.form.unmapped", { n: model.unmapped.length })}</p> : null}
          <DynamicForm action={saveDetailsFormAction} locale={locale} hidden={{ id, ifMatch: appRes.value.etag ?? "" }} fields={allDetailFields} submitLabel={t("ob.apply.save")} nextPath={`/apply/${id}`} />
          <p><Link className="zm-link" href={`/apply/${id}?step=documents`}>{t("ob.apply.next")}</Link></p>
        </section>
      ) : null}

      {step === "documents" ? (
        <section aria-labelledby="doc-h">
          <h2 id="doc-h">{t("ob.step.documents")}</h2>
          <p className="zm-hint">{t("ob.doc.intro")}</p>
          <DocumentSlots applicationId={id} slots={slotViews} locale={locale} createDocument={createDocumentAction} confirmDocument={confirmDocumentAction} />
          {app.documents.length === 0 ? null : (
            <>
              <h2>{t("ob.doc.uploadedTitle")}</h2>
              <ul className="zm-list">
                {app.documents.map((d) => (
                  <li key={d.id}>
                    <span dir="auto">{d.original_filename ?? d.requirement_code}</span>
                    <DynamicForm action={deleteDocumentAction} locale={locale} hidden={{ id, documentId: d.id }} fields={[]} submitLabel={t("ob.doc.remove")} variant="quiet" nextPath={`/apply/${id}?step=documents`} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <p><Link className="zm-link" href={`/apply/${id}?step=domain`}>{t("ob.apply.next")}</Link></p>
        </section>
      ) : null}

      {step === "domain" ? (
        <section aria-labelledby="dom-h">
          <h2 id="dom-h">{t("ob.step.domain")}</h2>
          <p className="zm-hint">{needsDomain ? t("ob.domain.required") : t("ob.domain.optional")}</p>
          {app.website_domain === undefined ? <p role="status" className="zm-notice">{t("ob.domain.noDomain")}</p> : (
            <>
              <p>{t("ob.domain.for")} <code dir="ltr">{app.website_domain}</code></p>
              {app.domain_verification === undefined ? null : (
                <p className="zm-tag" role="status">{t(`ob.domain.status.${app.domain_verification.status}` as const)}</p>
              )}
              {app.domain_verification?.method === "dns_txt" && app.domain_verification.status === "pending" ? (
                <dl className="zm-notice">
                  <dt className="zm-tag">{t("ob.domain.txtName")}</dt><dd><code dir="ltr">{app.domain_verification.txt_record_name}</code></dd>
                  <dt className="zm-tag">{t("ob.domain.txtValue")}</dt><dd><code dir="ltr">{app.domain_verification.txt_record_value}</code></dd>
                </dl>
              ) : null}
              {app.domain_verification?.method === "email" && app.domain_verification.status === "pending" ? (
                <p className="zm-hint">{t("ob.domain.emailSent", { to: app.domain_verification.email_sent_to_masked ?? "" })}</p>
              ) : null}
              {app.domain_verification?.status === "verified" ? null : (
                <>
                  <DynamicForm action={domainAction} locale={locale} hidden={{ id, op: "start" }} submitLabel={t("ob.domain.start")} nextPath={`/apply/${id}?step=domain`}
                    fields={[
                      { name: "method", label: t("ob.domain.method"), type: "select", required: true, value: "dns_txt", options: [{ value: "dns_txt", label: t("ob.domain.method.dns") }, { value: "email", label: t("ob.domain.method.email") }] },
                      { name: "localPart", label: t("ob.domain.localPart"), type: "select", options: ["admin", "info", "webmaster", "hostmaster"].map((v) => ({ value: v, label: `${v}@` })), hint: t("ob.domain.localPartHint") },
                    ]} />
                  {app.domain_verification === undefined ? null : (
                    <DynamicForm action={domainAction} locale={locale} hidden={{ id, op: "confirm" }} submitLabel={t("ob.domain.check")} variant="quiet" nextPath={`/apply/${id}?step=domain`}
                      fields={app.domain_verification.method === "email" ? [{ name: "code", label: t("ob.domain.code"), type: "text", dir: "ltr", inputMode: "numeric", maxLength: 12, autoComplete: "one-time-code" }] : []} />
                  )}
                </>
              )}
            </>
          )}
          <p><Link className="zm-link" href={`/apply/${id}?step=review`}>{t("ob.apply.next")}</Link></p>
        </section>
      ) : null}

      {step === "review" ? (
        <section aria-labelledby="rev-h">
          <h2 id="rev-h">{t("ob.step.review")}</h2>
          {blockers.length > 0 ? (
            <div role="alert" className="zm-alert">
              <p>{t("ob.review.blocked")}</p>
              <ul>
                {blockers.map((b) => (
                  <li key={`${b.step}-${b.code}`}><Link className="zm-link" href={`/apply/${id}?step=${b.step}`}>{stepLabel[b.step]}</Link>: {t(b.messageKey)}</li>
                ))}
              </ul>
            </div>
          ) : <p className="zm-ok" role="status">{t("ob.review.ready")}</p>}
          <DynamicForm action={submitApplicationAction} locale={locale} hidden={{ id }} nextPath={`/apply/${id}?step=review`}
            submitLabel={app.status === "NEEDS_INFO" ? t("ob.apply.resubmit") : t("ob.apply.submit")} disabled={blockers.length > 0 && blockers.some((b) => b.step !== "review")}
            fields={[
              ...(app.status === "NEEDS_INFO" ? [{ name: "note", label: t("ob.apply.note"), type: "textarea", maxLength: 1000 } as const] : []),
              { name: "ack_agreement", label: t("ob.ack.agreement"), type: "checkbox" },
              { name: "ack_dpa", label: t("ob.ack.dpa"), type: "checkbox" },
              { name: "ack_monitoring", label: t("ob.ack.monitoring"), type: "checkbox", hint: t("ob.ack.monitoringHint") },
            ]} />
          <p className="zm-hint">{t("ob.review.strongFactor")}</p>
        </section>
      ) : null}
    </section>
  );
}
