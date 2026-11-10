"use client";
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import type { Locale } from "@outlet/i18n";
import { Button } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import { returnReasonLabel, returnStatusLabel } from "../../lib/orders-labels";
import type { ReturnRequest } from "../../lib/wire";
import { Alert, isProblem, Status, useShared } from "./shared";

/** Statuses the API lets the shopper cancel (before pickup). */
const CANCELLABLE = new Set<ReturnRequest["status"]>(["REQUESTED", "APPROVED"]);
const MIN_STATEMENT = 10;
const REVIEW_DAYS = 5;

export function ReturnDetail({ locale, returnId, api = browserApi() }: { readonly locale: Locale; readonly returnId: string; readonly api?: ShopperApi }) {
  const { t, date, base } = useShared(locale);
  const sid = useId();
  const [r, setR] = useState<ReturnRequest | null>(null);
  const [state, setState] = useState<"loading" | "out" | "error" | "ready">("loading");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statement, setStatement] = useState("");

  useEffect(() => {
    let live = true;
    api.getReturn(returnId).then((x) => { if (live) { setR(x); setState("ready"); } }, (e: unknown) => { if (live) setState(isProblem(e, 401) ? "out" : "error"); });
    return () => { live = false; };
  }, [api, returnId]);

  async function cancel(): Promise<void> {
    setBusy(true); setError(null);
    try { setR(await api.cancelReturn(returnId)); setConfirmCancel(false); } catch { setError(t("returns.detail.cancelError")); } finally { setBusy(false); }
  }
  async function dispute(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (statement.trim().length < MIN_STATEMENT) { setError(t("returns.dispute.error")); return; }
    setBusy(true); setError(null);
    try { await api.openDispute(returnId, { statement: statement.trim(), mediaIds: [] }); setNotice(t("returns.dispute.done")); setR(await api.getReturn(returnId)); } catch { setError(t("returns.dispute.error")); } finally { setBusy(false); }
  }

  if (state === "loading") return <p role="status">{t("returns.list.loading")}</p>;
  if (state === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/returns/${returnId}`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (state === "error" || r === null) return <Alert>{t("returns.detail.error")}</Alert>;

  return (
    <div className="shopStack">
      <a className="shopLink" href={`${base}/returns`}>{t("returns.detail.back")}</a>
      <section className="shopCard" aria-labelledby="ret-status">
        <h2 id="ret-status">{returnStatusLabel(t, r.status)}</h2>
        <p>{t("returns.detail.reason", { reason: returnReasonLabel(t, r.reason_code) })}</p>
        <p>{t("returns.detail.resolution", { resolution: t(r.resolution === "exchange" ? "returns.resolution.exchange" : "returns.resolution.refund") })}</p>
        <p>{t("returns.detail.method", { method: t(r.method === "pickup" ? "returns.method.pickup" : "returns.method.dropoff") })}</p>
        <p className="hint">{t("returns.detail.windowEnds", { date: date(r.window_ends_at) })}</p>
        {r.received_at === null ? null : <p className="hint">{t("returns.detail.received", { date: date(r.received_at) })}</p>}
        {r.inspection_due_at === null ? null : <p className="hint">{t("returns.detail.inspectionDue", { date: date(r.inspection_due_at) })}</p>}
        {r.refund_due_at === null ? null : <p className="hint">{t("returns.detail.refundDue", { date: date(r.refund_due_at) })}</p>}
        <ul className="shopList" aria-label={t("returns.detail.items")}>
          {r.lines.map((l) => <li key={l.id}>{t("returns.detail.lineQty", { qty: l.qty })}</li>)}
        </ul>
      </section>
      {notice === null ? null : <Status>{notice}</Status>}
      {error === null ? null : <Alert>{error}</Alert>}
      {CANCELLABLE.has(r.status) ? (
        confirmCancel ? (
          <div role="group" aria-label={t("returns.detail.cancelConfirm")} className="shopRow">
            <Button loading={busy} onClick={() => { void cancel(); }}>{t("returns.detail.cancelConfirm")}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setConfirmCancel(false); }}>{t("returns.detail.cancelKeep")}</Button>
          </div>
        ) : <Button variant="secondary" onClick={() => { setConfirmCancel(true); }}>{t("returns.detail.cancel")}</Button>
      ) : null}
      {r.status === "REJECTED" ? (
        <section className="shopCard" aria-labelledby="ret-dispute">
          <h2 id="ret-dispute">{t("returns.dispute.title")}</h2>
          <p>{r.rejection_reason === null ? t("returns.dispute.noReason") : t("returns.dispute.reason", { reason: r.rejection_reason })}</p>
          <form noValidate className="shopForm" onSubmit={(e) => { void dispute(e); }}>
            <div className="shopField">
              <label htmlFor={sid}>{t("returns.dispute.statement")}</label>
              <textarea id={sid} className="shopInput shopTextarea" rows={4} maxLength={2000} required value={statement} aria-describedby={`${sid}-h`} onChange={(e) => { setStatement(e.target.value); }} />
              <p id={`${sid}-h`} className="hint">{t("returns.dispute.hint", { min: MIN_STATEMENT, days: REVIEW_DAYS })}</p>
            </div>
            <Button type="submit" loading={busy}>{t("returns.dispute.submit")}</Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
