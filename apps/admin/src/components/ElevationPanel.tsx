"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { adminCall } from "../client/admin-api";
import { fmtDateTime } from "../lib/fmt";
import { label } from "../lib/labels";
import { problemKey } from "../lib/problem";
import type { z } from "zod";
import type { ApprovalRequest } from "../lib/schemas";
import { ADMIN_ROLES } from "../lib/roles";

type Result = { readonly ok: boolean; readonly key: MessageKey } | null;

/** JIT elevation: request a time-boxed role, and approve or reject other people's requests (the server rejects self-approval). */
export function ElevationPanel({ locale, market, requests, canDecide, selfId }: {
  locale: Locale; market: string; requests: readonly z.infer<typeof ApprovalRequest>[]; canDecide: boolean; selfId: string;
}) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [role, setRole] = useState<string>(ADMIN_ROLES[0]);
  const [minutes, setMinutes] = useState("30");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [rowResult, setRowResult] = useState<Result>(null);

  const request = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await adminCall(market, "elevations", { method: "POST", body: { role_code: role, duration_minutes: Number(minutes), reason: reason.trim() } });
    setBusy(false);
    if (r.status === 404 || r.status === 405) { setResult({ ok: false, key: "admin.access.request.unavailable" }); return; }
    if (!r.ok) { setResult({ ok: false, key: problemKey(r.code, r.status) }); return; }
    setResult({ ok: true, key: "admin.access.request.sent" });
    router.refresh();
  };

  const decide = async (id: string, decision: "approve" | "reject") => {
    const r = await adminCall(market, `approval-requests/${id}/decision`, { method: "POST", body: { decision, reason: decisionReason.trim() } });
    setRowResult(r.ok ? { ok: true, key: "admin.action.done" } : { ok: false, key: problemKey(r.code, r.status) });
    if (r.ok) router.refresh();
  };

  return (
    <div className="stack">
      <section aria-labelledby="el-req" className="card">
        <h2 id="el-req" className="panelTitle">{t("admin.access.request.title")}</h2>
        <form onSubmit={(e) => void request(e)} className="stepForm">
          <label className="field">
            <span>{t("admin.access.request.role")}</span>
            <select value={role} onChange={(e) => { setRole(e.target.value); }}>{ADMIN_ROLES.map((r) => (<option key={r} value={r}>{t(`admin.role.${r}` as MessageKey)}</option>))}</select>
          </label>
          <label className="field"><span>{t("admin.access.request.minutes")}</span><input type="number" min={5} max={60} step={5} value={minutes} onChange={(e) => { setMinutes(e.target.value); }} required /></label>
          <label className="field"><span>{t("admin.access.request.reason")}</span><textarea rows={2} value={reason} onChange={(e) => { setReason(e.target.value); }} required maxLength={500} /></label>
          <div className="withActions"><button type="submit" className="btn btnPrimary" disabled={busy}>{busy ? t("admin.action.working") : t("admin.access.request.submit")}</button></div>
          {result !== null ? <p className={result.ok ? "success" : "error"} role={result.ok ? "status" : "alert"}>{t(result.key)}</p> : null}
        </form>
      </section>

      <section aria-labelledby="el-list" className="card">
        <h2 id="el-list" className="panelTitle">{t("admin.access.pending.title")}</h2>
        {requests.length === 0 ? <p className="empty">{t("admin.access.pending.none")}</p> : (
          <>
            {canDecide ? <label className="field"><span>{t("admin.access.decision.reason")}</span><input value={decisionReason} onChange={(e) => { setDecisionReason(e.target.value); }} maxLength={500} /></label> : null}
            <div className="tableWrap" tabIndex={0} role="group" aria-labelledby="el-list">
            <table className="table">
              <thead><tr><th scope="col">{t("admin.access.col.action")}</th><th scope="col">{t("admin.access.col.target")}</th><th scope="col">{t("admin.access.col.status")}</th><th scope="col">{t("admin.access.col.expires")}</th><th scope="col">{t("admin.access.col.decide")}</th></tr></thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td dir="ltr">{r.action}</td><td dir="ltr">{r.target_type}:{r.target_id.slice(0, 8)}</td><td>{label(t, "admin.access.status", r.status)}</td><td>{fmtDateTime(r.expires_at, locale)}</td>
                    <td>{canDecide && r.status === "PENDING" && r.requested_by !== selfId ? (
                      <span className="withActions">
                        <button type="button" className="btn btnPrimary" disabled={decisionReason.trim() === ""} onClick={() => void decide(r.id, "approve")}>{t("admin.access.approve")}</button>
                        <button type="button" className="btn btnSecondary" disabled={decisionReason.trim() === ""} onClick={() => void decide(r.id, "reject")}>{t("admin.access.reject")}</button>
                      </span>
                    ) : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {rowResult !== null ? <p className={rowResult.ok ? "success" : "error"} role={rowResult.ok ? "status" : "alert"}>{t(rowResult.key)}</p> : null}
          </>
        )}
      </section>
    </div>
  );
}
