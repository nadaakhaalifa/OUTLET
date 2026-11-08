"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { adminCall } from "../client/admin-api";
import { fmtDateTime } from "../lib/fmt";
import { label } from "../lib/labels";
import { problemKey } from "../lib/problem";
import { KycCase, SignedUrl, type KycCaseView } from "../lib/schemas";
import { ReasonDialog } from "./ReasonDialog";

const DECISIONS = ["APPROVED", "NEEDS_INFO", "REJECTED"] as const;
const DECISION_CODES = ["docs_valid", "docs_unreadable", "register_mismatch", "sanctions_hit", "counterfeit_risk", "other"] as const;
const OPEN_STATES = ["SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO"];

type Pending = { readonly kind: "doc"; readonly docId: string } | { readonly kind: "reveal" } | null;

export function KycCasePanel({ locale, market, data, canDecide }: { locale: Locale; market: string; data: KycCaseView; canDecide: boolean }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const c = data.case;
  const [pending, setPending] = useState<Pending>(null);
  const [links, setLinks] = useState<Readonly<Record<string, string>>>({});
  const [linkError, setLinkError] = useState<MessageKey | null>(null);
  const [revealed, setRevealed] = useState(data.signatory_revealed ?? null);
  const [decision, setDecision] = useState<(typeof DECISIONS)[number]>("APPROVED");
  const [code, setCode] = useState<string>(DECISION_CODES[0]);
  const [note, setNote] = useState("");
  const [requested, setRequested] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly key: MessageKey } | null>(null);

  const onReason = async (reason: string) => {
    const p = pending;
    setPending(null);
    setLinkError(null);
    if (p === null) return;
    if (p.kind === "doc") {
      const r = await adminCall(market, `kyc-cases/${c.id}/documents/${p.docId}/url`, { reason });
      const parsed = SignedUrl.safeParse(r.data);
      if (r.ok && parsed.success) setLinks((l) => ({ ...l, [p.docId]: parsed.data.url }));
      else setLinkError(r.ok ? "admin.kyc.doc.failed" : problemKey(r.code, r.status));
    } else {
      const r = await adminCall(market, `kyc-cases/${c.id}`, { reason });
      const parsed = KycCase.safeParse(r.data);
      if (r.ok && parsed.success) setRevealed(parsed.data.signatory_revealed ?? null);
      else setLinkError(r.ok ? "admin.error.generic" : problemKey(r.code, r.status));
    }
  };

  const submitDecision = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const r = await adminCall(market, `kyc-cases/${c.id}/decision`, {
      method: "POST",
      body: { decision, decision_reason: `${code}: ${note.trim()}`, ...(decision === "NEEDS_INFO" && requested.length > 0 ? { requested_documents: requested } : {}) },
    });
    setBusy(false);
    if (!r.ok) { setResult({ ok: false, key: problemKey(r.code, r.status) }); return; }
    const approval = typeof r.data === "object" && r.data !== null && "approval_request_id" in r.data;
    setResult({ ok: true, key: r.status === 202 || approval ? "admin.kyc.decision.pendingApproval" : "admin.kyc.decision.done" });
    router.refresh();
  };

  const open = OPEN_STATES.includes(c.status);
  const toggle = (d: string) => { setRequested((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d])); };

  return (
    <div className="stack">
      <section aria-labelledby="kyc-legal" className="card">
        <h2 id="kyc-legal" className="panelTitle">{t("admin.kyc.case.legal")}</h2>
        <dl className="facts">
          <dt>{t("admin.kyc.case.nameAr")}</dt><dd>{data.seller_legal.legal_name_ar}</dd>
          <dt>{t("admin.kyc.case.register")}</dt><dd dir="ltr">{data.seller_legal.commercial_register_no}</dd>
          <dt>{t("admin.kyc.case.tax")}</dt><dd dir="ltr">{data.seller_legal.tax_card_no}</dd>
          <dt>{t("admin.kyc.case.governorate")}</dt><dd>{data.seller_legal.governorate_name_ar}</dd>
          <dt>{t("admin.kyc.col.status")}</dt><dd>{label(t, "admin.kyc.status", c.status)}</dd>
        </dl>
      </section>

      <section aria-labelledby="kyc-checks" className="card">
        <h2 id="kyc-checks" className="panelTitle">{t("admin.kyc.case.checks")}</h2>
        {data.checks.length === 0 ? (
          <p className="empty">{t("admin.kyc.case.noChecks")}</p>
        ) : (
          <table className="table">
            <thead><tr><th scope="col">{t("admin.kyc.check.type")}</th><th scope="col">{t("admin.kyc.check.result")}</th><th scope="col">{t("admin.kyc.check.provider")}</th><th scope="col">{t("admin.kyc.check.when")}</th></tr></thead>
            <tbody>
              {data.checks.map((k) => (
                <tr key={`${k.check_type}-${k.checked_at}`}><td>{k.check_type}</td><td>{k.result}</td><td>{k.provider ?? ""}</td><td>{fmtDateTime(k.checked_at, locale)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="kyc-docs" className="card">
        <h2 id="kyc-docs" className="panelTitle">{t("admin.kyc.case.docs")}</h2>
        {linkError !== null ? <p className="error" role="alert">{t(linkError)}</p> : null}
        {c.documents.length === 0 ? (
          <p className="empty">{t("admin.kyc.case.noDocs")}</p>
        ) : (
          <ul className="docs">
            {c.documents.map((d) => (
              <li key={d.id}>
                <span>{label(t, "admin.kyc.doc", d.doc_type)}</span>
                <span className="hint">{d.verified ? t("admin.kyc.doc.verified") : t("admin.kyc.doc.unverified")}</span>
                {links[d.id] !== undefined ? (
                  <a href={links[d.id]} target="_blank" rel="noopener noreferrer" className="btn btnSecondary">{t("admin.kyc.doc.openLink")}</a>
                ) : (
                  <button type="button" className="btn btnSecondary" onClick={() => { setPending({ kind: "doc", docId: d.id }); }}>{t("admin.kyc.doc.open")}</button>
                )}
                {links[d.id] !== undefined ? <span className="hint" role="status">{t("admin.kyc.doc.linkReady")}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {c.required_documents.length > 0 ? <p className="hint">{t("admin.kyc.case.required")}: {c.required_documents.map((d) => label(t, "admin.kyc.doc", d)).join(locale === "ar-EG" ? "، " : ", ")}</p> : null}
      </section>

      <section aria-labelledby="kyc-sig" className="card">
        <h2 id="kyc-sig" className="panelTitle">{t("admin.kyc.signatory.title")}</h2>
        {c.signatory === null || c.signatory === undefined ? (
          <p className="empty">{t("admin.kyc.signatory.none")}</p>
        ) : (
          <dl className="facts">
            <dt>{t("admin.kyc.signatory.name")}</dt><dd>{c.signatory.full_name_masked}</dd>
            <dt>{t("admin.kyc.signatory.last4")}</dt><dd dir="ltr">{c.signatory.national_id_last4}</dd>
            {revealed?.full_name !== undefined ? (<><dt>{t("admin.kyc.signatory.fullName")}</dt><dd>{revealed.full_name}</dd></>) : null}
            {revealed?.national_id !== undefined ? (<><dt>{t("admin.kyc.signatory.nationalId")}</dt><dd dir="ltr">{revealed.national_id}</dd></>) : null}
            {revealed?.phone_e164 !== undefined ? (<><dt>{t("admin.kyc.signatory.phone")}</dt><dd dir="ltr">{revealed.phone_e164}</dd></>) : null}
          </dl>
        )}
        {c.signatory !== null && c.signatory !== undefined && revealed === null ? (
          <button type="button" className="btn btnSecondary" onClick={() => { setPending({ kind: "reveal" }); }}>{t("admin.kyc.signatory.reveal")}</button>
        ) : null}
      </section>

      <section aria-labelledby="kyc-decision" className="card">
        <h2 id="kyc-decision" className="panelTitle">{t("admin.kyc.decision.title")}</h2>
        {!canDecide ? <p className="hint">{t("admin.kyc.decision.noRole")}</p> : !open ? <p className="hint">{t("admin.kyc.decision.closed")}</p> : (
          <form onSubmit={(e) => void submitDecision(e)} className="stepForm">
            <fieldset className="conditions">
              <legend>{t("admin.kyc.decision.choice")}</legend>
              <div className="radios">
                {DECISIONS.map((d) => (
                  <label key={d} className="radio"><input type="radio" name="decision" value={d} checked={decision === d} onChange={() => { setDecision(d); }} />{t(`admin.kyc.decision.${d}` as MessageKey)}</label>
                ))}
              </div>
            </fieldset>
            <label className="field">
              <span>{t("admin.kyc.decision.code")}</span>
              <select value={code} onChange={(e) => { setCode(e.target.value); }}>
                {DECISION_CODES.map((k) => (<option key={k} value={k}>{t(`admin.kyc.decision.codes.${k}` as MessageKey)}</option>))}
              </select>
            </label>
            <label className="field">
              <span>{t("admin.kyc.decision.note")}</span>
              <textarea value={note} onChange={(e) => { setNote(e.target.value); }} rows={3} maxLength={500} />
            </label>
            {decision === "NEEDS_INFO" && c.required_documents.length > 0 ? (
              <fieldset className="conditions">
                <legend>{t("admin.kyc.decision.requested")}</legend>
                {c.required_documents.map((d) => (
                  <label key={d} className="check"><input type="checkbox" checked={requested.includes(d)} onChange={() => { toggle(d); }} />{label(t, "admin.kyc.doc", d)}</label>
                ))}
              </fieldset>
            ) : null}
            <div className="withActions">
              <button type="submit" className="btn btnPrimary" disabled={busy}>{busy ? t("admin.action.working") : t("admin.kyc.decision.submit")}</button>
            </div>
          </form>
        )}
        {result !== null ? <p className={result.ok ? "success" : "error"} role={result.ok ? "status" : "alert"}>{t(result.key)}</p> : null}
      </section>

      <ReasonDialog t={t} open={pending !== null} onConfirm={(h) => void onReason(h)} onCancel={() => { setPending(null); }} />
    </div>
  );
}
