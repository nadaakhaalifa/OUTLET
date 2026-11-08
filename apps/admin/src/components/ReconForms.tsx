"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTranslator, type Locale, type MessageKey, type Translator } from "@outlet/i18n";
import { adminCall } from "../client/admin-api";
import { problemKey } from "../lib/problem";

export const SOURCES = ["psp_settlement", "cod_remittance", "bnpl_settlement", "eta", "store_credit"] as const;
const RESOLUTIONS = ["matched_manually", "adjustment_requested", "write_off_requested"] as const;

type Result = { readonly ok: boolean; readonly key: MessageKey } | null;

function Status({ t, result }: { t: Translator; result: Result }) {
  return result === null ? null : <p className={result.ok ? "success" : "error"} role={result.ok ? "status" : "alert"}>{t(result.key)}</p>;
}

export function ResolveForm({ locale, market, itemId }: { locale: Locale; market: string; itemId: string }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>("matched_manually");
  const [ticket, setTicket] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await adminCall(market, `reconciliation/items/${itemId}/resolve`, { method: "POST", body: { resolution, ticket_ref: ticket.trim(), note: note.trim() } });
    setBusy(false);
    if (!r.ok) { setResult({ ok: false, key: problemKey(r.code, r.status) }); return; }
    const approval = typeof r.data === "object" && r.data !== null && typeof (r.data as { approval_request_id?: unknown }).approval_request_id === "string";
    setResult({ ok: true, key: approval ? "admin.recon.resolve.pendingApproval" : "admin.recon.resolve.done" });
    router.refresh();
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="stepForm resolveForm">
      <label className="field">
        <span>{t("admin.recon.resolve.choice")}</span>
        <select value={resolution} onChange={(e) => { setResolution(e.target.value as (typeof RESOLUTIONS)[number]); }}>
          {RESOLUTIONS.map((r) => (<option key={r} value={r}>{t(`admin.recon.resolve.${r}` as MessageKey)}</option>))}
        </select>
      </label>
      <label className="field"><span>{t("admin.recon.resolve.ticket")}</span><input value={ticket} onChange={(e) => { setTicket(e.target.value); }} dir="ltr" required maxLength={60} /></label>
      <label className="field"><span>{t("admin.recon.resolve.note")}</span><textarea value={note} onChange={(e) => { setNote(e.target.value); }} rows={2} required maxLength={500} /></label>
      <p className="hint">{t("admin.recon.resolve.noUnmatch")}</p>
      <button type="submit" className="btn btnPrimary" disabled={busy}>{busy ? t("admin.action.working") : t("admin.recon.resolve.submit")}</button>
      <Status t={t} result={result} />
    </form>
  );
}

export function StartRunForm({ locale, market, today }: { locale: Locale; market: string; today: string }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [source, setSource] = useState<(typeof SOURCES)[number]>("psp_settlement");
  const [counterparty, setCounterparty] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await adminCall(market, "reconciliation/runs", { method: "POST", body: { source, counterparty: counterparty.trim(), business_date: date } });
    setBusy(false);
    setResult(r.ok ? { ok: true, key: "admin.recon.start.done" } : { ok: false, key: problemKey(r.code, r.status) });
    if (r.ok) router.refresh();
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="row filterRow">
      <label className="field">
        <span>{t("admin.recon.col.source")}</span>
        <select value={source} onChange={(e) => { setSource(e.target.value as (typeof SOURCES)[number]); }}>
          {SOURCES.map((s) => (<option key={s} value={s}>{t(`admin.recon.source.${s}` as MessageKey)}</option>))}
        </select>
      </label>
      <label className="field"><span>{t("admin.recon.start.counterparty")}</span><input value={counterparty} onChange={(e) => { setCounterparty(e.target.value); }} dir="ltr" required maxLength={60} /></label>
      <label className="field"><span>{t("admin.recon.start.date")}</span><input type="date" value={date} onChange={(e) => { setDate(e.target.value); }} required /></label>
      <button type="submit" className="btn btnSecondary" disabled={busy}>{busy ? t("admin.action.working") : t("admin.recon.start.submit")}</button>
      <Status t={t} result={result} />
    </form>
  );
}
