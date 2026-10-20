import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { readDocumentOrigin } from "../../../../api/config";
import { BRAND_REASON_CODES } from "../../../../api/brand-schemas";
import { BrandActions } from "../../../../components/brand-actions";
import { BrandDocumentViewer } from "../../../../components/brand-document-viewer";
import { BrandShortcuts } from "../../../../components/brand-shortcuts";
import { RiskChip, SlaCell, StatusBadge } from "../../../../components/brand-ui";
import { Badge, ErrorBlock, PageHeader } from "../../../../components/ui";
import { formatDateTime } from "../../../../lib/format";
import { getConsole } from "../../../../server/console";
import { pickBrandLabels } from "../../../../view-models/brand-labels";
import {
  approveConsequence, approveNeedsCosign, availability, checkTone, checklist, conflictView, flashFor, needsInfoCandidates,
  primitiveEntries, riskBand, riskScoreOf, slaView, sortedChecks, trademarkViews,
} from "../../../../view-models/brand-review";
import { serverNow } from "../../../../view-models/common";

const Id = z.uuid();

export default async function BrandApplicationPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const c = await getConsole();
  const id = Id.safeParse((await params).id);
  if (!id.success) notFound();
  const sp = await searchParams;
  const flash = flashFor(typeof sp.r === "string" ? sp.r : undefined);
  const r = await c.api.brandApplication(id.data);
  const labels = pickBrandLabels(c.t);
  const back = (
    <nav className="row tabs" aria-label={c.t("brand.views")}>
      <Link className="btn" href="/brand-applications">{c.t("brand.view.queue")}</Link>
      <Link className="btn" href="/brand-applications/mine">{c.t("brand.view.mine")}</Link>
    </nav>
  );
  if (!r.ok) {
    return (
      <>
        <PageHeader title={c.t("brand.detail.title")} />
        {back}
        <ErrorBlock error={r.error} c={c} />
      </>
    );
  }
  const d = r.value.data;
  const app = d.application;
  const now = serverNow(r.value.serverNowMs, c.deviceNowMs);
  const dupes = d.duplicate_claim_application_ids ?? [];
  const gates = availability({
    status: app.status, assigneeId: d.assignee_id, selfId: c.selfId, roles: c.roles, pendingCosign: d.pending_cosign,
    duplicateCount: dupes.length, postureWritesEnabled: c.posture.sensitiveWritesEnabled,
  });
  const g = (x: { allowed: boolean; reasonKey: Parameters<typeof c.t>[0] | null }) => ({ allowed: x.allowed, reason: x.reasonKey === null ? null : c.t(x.reasonKey) });
  const sla = slaView({ status: app.status, submittedAtIso: app.submitted_at ?? null, dueAtIso: d.decision_due_at, ...(d.sla_breached === undefined ? {} : { serverBreached: d.sla_breached }) }, now);
  const score = riskScoreOf(d.auto_checks);
  const rows = checklist(app);
  const needsCosign = approveNeedsCosign(d);
  const tms = trademarkViews(d);

  const compareId = typeof sp.compare === "string" && dupes.includes(sp.compare) ? sp.compare : null;
  const other = compareId === null ? null : await c.api.brandApplication(compareId);
  const cmp = other !== null && other.ok ? conflictView(d, other.value.data) : null;

  const loc = c.locale;
  const reasonLabels = Object.fromEntries(BRAND_REASON_CODES.map((k) => [k, c.t(`brand.reasonCode.${k}`)]));
  const candidates = needsInfoCandidates(app).map((x) => ({
    code: x.code, kind: x.kind,
    label: x.kind === "document" ? c.t("brand.cand.doc", { code: x.code }) : x.kind === "domain_verification" ? c.t("brand.cand.domain_verification") : c.t("brand.cand.clarification"),
  }));
  const idem = {
    claim: crypto.randomUUID(), release: crypto.randomUUID(), decision: crypto.randomUUID(),
    cosign: crypto.randomUUID(), conflict: crypto.randomUUID(), lookup: crypto.randomUUID(),
  };
  const facts: [string, string | null][] = [
    [c.t("brand.f.brand"), app.brand_name], [c.t("brand.f.legal"), app.legal_name ?? null],
    [c.t("brand.f.kind"), `${c.t(`brand.kind.${app.brand_kind}`)} · ${app.country}`],
    [c.t("brand.f.domain"), app.website_domain ?? null],
    [c.t("brand.f.domainStatus"), typeof app.domain_verification?.status === "string" ? app.domain_verification.status : null],
    [c.t("brand.f.basis"), app.ownership_basis ?? null], [c.t("brand.f.eta"), app.eta_registration ?? null],
    [c.t("brand.f.submitted"), app.submitted_at === null || app.submitted_at === undefined ? null : formatDateTime(app.submitted_at, loc)],
  ];

  return (
    <>
      <BrandShortcuts scope="detail" labels={labels} mineHref="/brand-applications/mine" queueHref="/brand-applications" />
      <PageHeader title={app.brand_name} intro={c.t("brand.detail.title")} />
      {back}
      {flash === null ? null : <p role={flash.tone === "ok" ? "status" : "alert"} className={`notice ${flash.tone}`}>{c.t(flash.key)}</p>}
      <div className="row badges">
        <StatusBadge status={app.status} t={c.t} />
        <RiskChip band={riskBand(score)} score={score ?? null} t={c.t} />
        {d.pending_cosign ? <Badge tone="warn">{c.t("brand.badge.pendingCosign")}</Badge> : null}
        {dupes.length > 0 ? <Badge tone="warn">{c.t("brand.badge.conflict", { n: dupes.length })}</Badge> : null}
        {d.high_risk_country === true ? <Badge tone="warn">{c.t("brand.badge.highRiskCountry")}</Badge> : null}
        {app.appeal_used === true ? <Badge tone="neutral">{c.t("brand.badge.appeal")}</Badge> : null}
        <SlaCell sla={sla} t={c.t} />
        <span className="muted">{c.t("brand.sla.due", { at: formatDateTime(d.decision_due_at, loc) })}</span>
      </div>

      <div className="split">
        <div className="main-col">
          <section className="card" aria-labelledby="h-facts">
            <h2 id="h-facts">{c.t("brand.sec.facts")}</h2>
            <dl>{facts.filter((x): x is [string, string] => x[1] !== null).map(([k, v]) => <div className="kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            {([["brand.f.registration", app.registration], ["brand.f.trademark", app.trademark], ["brand.f.contact", app.contact], ["brand.f.signatory", app.signatory_masked], ["brand.f.social", app.social_handles]] as const).map(([k, rec]) => {
              const e = primitiveEntries(rec);
              return e.length === 0 ? null : (
                <details key={k} open><summary>{c.t(k)}</summary>
                  <dl>{e.map(([ek, ev]) => <div className="kv" key={ek}><dt dir="ltr">{ek}</dt><dd dir="auto">{ev}</dd></div>)}</dl>
                </details>
              );
            })}
          </section>

          <section className="card" aria-labelledby="h-check">
            <h2 id="h-check">{c.t("brand.sec.checklist")}</h2>
            <p className="muted">{c.t("brand.checklist.note")}</p>
            {rows.length === 0 ? <p className="muted">{c.t("brand.doc.none")}</p> : (
              <div className="table-wrap"><table className="dense">
                <thead><tr><th scope="col">{c.t("brand.col.requirement")}</th><th scope="col">{c.t("col.status")}</th><th scope="col">{c.t("brand.col.files")}</th></tr></thead>
                <tbody>{rows.map((row) => (
                  <tr key={row.code}>
                    <th scope="row" dir="ltr">{row.code}</th>
                    <td><Badge tone={row.state === "accepted" ? "ok" : row.state === "blocked" || row.state === "rejected" || row.state === "missing" ? "bad" : "warn"}>{c.t(`brand.docstate.${row.state}`)}</Badge>
                      {row.requested === null ? null : <> <Badge tone="neutral">{c.t("brand.badge.requested")}</Badge></>}</td>
                    <td>{row.documents.map((x) => <div key={x.doc.id} className="muted" dir="ltr">{x.doc.original_filename ?? x.doc.id.slice(0, 8)} · {c.t(`brand.docstate.${x.state}`)}</div>)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <BrandDocumentViewer
              applicationId={app.id}
              reviewerId={c.selfId ?? "unknown"}
              labels={labels}
              allowed={gates.readDocuments.allowed}
              gateReason={gates.readDocuments.reasonKey === null ? null : c.t(gates.readDocuments.reasonKey)}
              originConfigured={readDocumentOrigin(process.env) !== null}
              docs={rows.flatMap((row) => row.documents.map((x) => ({
                id: x.doc.id, code: row.code, filename: x.doc.original_filename ?? null, contentType: x.doc.content_type,
                viewable: x.viewable, stateLabel: c.t(`brand.docstate.${x.state}`),
              })))}
            />
          </section>

          <section className="card" aria-labelledby="h-auto">
            <h2 id="h-auto">{c.t("brand.sec.autoChecks")}</h2>
            {d.auto_checks.length === 0 ? <p className="muted">{c.t("brand.autochecks.none")}</p> : (
              <div className="table-wrap"><table className="dense">
                <thead><tr><th scope="col">{c.t("brand.col.check")}</th><th scope="col">{c.t("brand.col.result")}</th><th scope="col">{c.t("brand.col.detail")}</th><th scope="col">{c.t("brand.col.ran")}</th></tr></thead>
                <tbody>{sortedChecks(d.auto_checks).map((x) => (
                  <tr key={x.code}>
                    <th scope="row">{c.t(`brand.check.${x.code}`)}</th>
                    <td><Badge tone={checkTone(x.result)}>{c.t(`brand.result.${x.result}`)}</Badge></td>
                    <td dir="auto">{x.detail ?? "—"}</td>
                    <td className="muted">{formatDateTime(x.ran_at, loc)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          <section className="card" aria-labelledby="h-tm">
            <h2 id="h-tm">{c.t("brand.sec.trademark")}</h2>
            {tms.length === 0 ? <p className="muted">{c.t("brand.tm.none")}</p> : tms.map((tm) => (
              <article key={tm.id} className="tm">
                <div className="row">
                  <strong dir="ltr">{tm.source}</strong>
                  <Badge tone={!tm.found ? "bad" : tm.verdict === "yes" ? "ok" : tm.verdict === "no" ? "bad" : "warn"}>{c.t(`brand.tm.verdict.${tm.found ? tm.verdict : "notfound"}`)}</Badge>
                  <span className="muted">{formatDateTime(new Date(tm.retrievedAtMs).toISOString(), loc)}</span>
                </div>
                <dl>
                  {tm.registerNumber === null ? null : <div className="kv"><dt>{c.t("brand.tm.number")}</dt><dd dir="ltr">{tm.registerNumber}</dd></div>}
                  {tm.ownerName === null ? null : <div className="kv"><dt>{c.t("brand.tm.owner")}</dt><dd dir="auto">{tm.ownerName}</dd></div>}
                  {tm.status === null ? null : <div className="kv"><dt>{c.t("col.status")}</dt><dd>{tm.status}</dd></div>}
                  {tm.classes.length === 0 ? null : <div className="kv"><dt>{c.t("brand.tm.classes")}</dt><dd dir="ltr">{tm.classes.join(", ")}</dd></div>}
                  {tm.score === null ? null : <div className="kv"><dt>{c.t("brand.tm.score")}</dt><dd>{tm.score}/100 <span className="muted">{c.t("brand.tm.scoreNote")}</span></dd></div>}
                </dl>
                <p>{c.t(tm.explanationKey)}</p>
              </article>
            ))}
          </section>

          <section className="card" aria-labelledby="h-dup">
            <h2 id="h-dup">{c.t("brand.sec.conflicts")}</h2>
            {dupes.length === 0 ? <p className="muted">{c.t("brand.conflicts.none")}</p> : (
              <>
                <p className="muted">{c.t("brand.conflicts.note")}</p>
                <ul>{dupes.map((x) => (
                  <li key={x}><span dir="ltr">{x.slice(0, 8)}</span> <Link href={`?compare=${x}`} scroll={false}>{c.t("brand.conflicts.compare")}</Link></li>
                ))}</ul>
              </>
            )}
            {other !== null && !other.ok ? <ErrorBlock error={other.error} c={c} /> : null}
            {cmp === null ? null : (
              <div className="table-wrap"><table className="dense compare">
                <caption>{c.t("brand.conflicts.summary", { agree: cmp.agreeCount, differ: cmp.differCount })}{cmp.currentIsFirst === null ? "" : ` · ${c.t(cmp.currentIsFirst ? "brand.conflicts.thisFirst" : "brand.conflicts.otherFirst")}`}</caption>
                <thead><tr><th scope="col">{c.t("col.difference")}</th><th scope="col">{c.t("brand.conflicts.this")}</th><th scope="col">{c.t("brand.conflicts.other")} <span dir="ltr">{cmp.otherId.slice(0, 8)}</span></th></tr></thead>
                <tbody>{cmp.rows.map((row) => (
                  <tr key={row.field} className={row.same ? undefined : "differs"}>
                    <th scope="row">{c.t(row.field)}</th>
                    <td dir="auto">{row.current}</td>
                    <td dir="auto">{row.other} {row.same ? <Badge tone="warn">{c.t("brand.cmp.same")}</Badge> : null}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          <section className="card" aria-labelledby="h-hist">
            <h2 id="h-hist">{c.t("brand.sec.history")}</h2>
            <ol className="timeline">
              {d.history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <time dateTime={h.at}>{formatDateTime(h.at, loc)}</time> · <Badge tone="neutral">{c.t(`brand.actor.${h.actor_type}`)}</Badge> <span dir="ltr">{h.event}</span>
                  {h.from_status === undefined && h.to_status === undefined ? null : <span className="muted" dir="ltr"> ({h.from_status ?? "—"} → {h.to_status ?? "—"})</span>}
                </li>
              ))}
            </ol>
            {(d.internal_notes ?? []).length === 0 ? null : (
              <>
                <h3>{c.t("brand.sec.notes")}</h3>
                <ul>{(d.internal_notes ?? []).map((n, i) => <li key={i}><span className="muted" dir="ltr">{n.admin_id.slice(0, 8)} · {formatDateTime(n.at, loc)}</span><br />{n.note}</li>)}</ul>
              </>
            )}
          </section>
        </div>

        <aside className="side-col" aria-label={c.t("brand.sec.actions")}>
          <div className="card sticky">
            <h2>{c.t("brand.sec.actions")}</h2>
            <p className="muted">{d.assignee_id === null ? c.t("brand.assignee.unassigned") : d.assignee_id === c.selfId ? c.t("brand.assignee.mine") : c.t("brand.assignee.other")}</p>
            <h3>{c.t("brand.approve.what")}</h3>
            <ul className="consequences">{approveConsequence({ pendingCosignRequired: needsCosign }).map((k) => <li key={k}>{c.t(k)}</li>)}</ul>
            <BrandActions
              applicationId={app.id}
              idem={idem}
              labels={labels}
              reasonLabels={reasonLabels}
              candidates={candidates}
              approveNeedsCosign={needsCosign}
              cosignRequestedBy={d.assignee_id === null ? null : d.assignee_id.slice(0, 8)}
              gates={{
                claim: g(gates.claim), release: g(gates.release), approve: g(gates.approve), reject: g(gates.reject),
                needsInfo: g(gates.needsInfo), cosign: g(gates.cosign), lookup: g(gates.trademarkLookup), resolve: g(gates.resolveConflict),
              }}
            />
          </div>
        </aside>
      </div>
    </>
  );
}
