"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Translator, MessageKey } from "@outlet/i18n";
import { REASON_CODES, reasonHeader } from "../lib/reason-codes";

/**
 * Modal that collects an X-Reason-Code before any P2/P3 data is opened or revealed.
 * onConfirm receives the finished header value (`code` or `code:ticket`); nothing is fetched until then.
 */
export function ReasonDialog({ t, open, onConfirm, onCancel }: { t: Translator; open: boolean; onConfirm: (header: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
    if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
      setCode("");
      setTicket("");
      setError(null);
    }
  }, [open]);

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const header = reasonHeader(code, ticket);
    if (header === null) {
      setError(code === "" ? "admin.reason.choose" : "admin.reason.refRequired");
      return;
    }
    onConfirm(header);
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-t`} onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <form onSubmit={submit} className="stepForm">
        <h2 id={`${id}-t`} className="panelTitle">{t("admin.reason.title")}</h2>
        <p className="hint">{t("admin.reason.lead")}</p>
        <label className="field">
          <span>{t("admin.reason.code")}</span>
          <select value={code} onChange={(e) => { setCode(e.target.value); }} aria-describedby={error !== null ? `${id}-e` : undefined}>
            <option value="">{t("admin.reason.choose")}</option>
            {REASON_CODES.map((c) => (
              <option key={c} value={c}>{t(`admin.reason.codes.${c}` as MessageKey)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("admin.reason.ticket")}</span>
          <input value={ticket} onChange={(e) => { setTicket(e.target.value); }} dir="ltr" maxLength={40} autoComplete="off" aria-describedby={`${id}-h`} />
        </label>
        <p id={`${id}-h`} className="hint">{t("admin.reason.ticketHint")}</p>
        {error !== null ? <p id={`${id}-e`} className="error" role="alert">{t(error)}</p> : null}
        <div className="withActions">
          <button type="submit" className="btn btnPrimary">{t("admin.action.confirm")}</button>
          <button type="button" className="btn btnSecondary" onClick={onCancel}>{t("admin.action.cancel")}</button>
        </div>
      </form>
    </dialog>
  );
}
