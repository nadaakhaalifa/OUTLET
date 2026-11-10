"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { adminCall } from "../client/admin-api";
import { ageLabel, DISCARD_REASONS, DLQ_MAX_IDS, isMoneyType, type DiscardReason, type DlqEntryView } from "../lib/dlq";
import { fmtDateTime } from "../lib/fmt";
import { problemKey } from "../lib/problem";
import { uuidv7 } from "../lib/uuid7";

interface Msg { readonly ok: boolean; readonly key: MessageKey }

const isResult = (d: unknown): d is { changed: number; results?: readonly { outcome?: unknown }[] } => typeof d === "object" && d !== null && typeof (d as { changed?: unknown }).changed === "number";
const hasExpired = (d: { results?: readonly { outcome?: unknown }[] }): boolean => (d.results ?? []).some((x) => x.outcome === "expired");

/**
 * The relay dead-letter queue: select rows, Replay (idempotent redelivery) or Discard with a fixed reason. Each write goes through the same-origin BFF with its
 * own UUIDv7 Idempotency-Key. A discard that includes a money event type is filed for a second approver by the server (409 dual-approval-required): the page says so.
 */
export function DlqQueue({ locale, market, items, now, canManage }: { locale: Locale; market: string; items: readonly DlqEntryView[]; now: string; canManage: boolean }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState<DiscardReason>(DISCARD_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const nowDate = new Date(now);

  const toggle = (id: string) => {
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else if (n.size < DLQ_MAX_IDS) n.add(id); return n; });
  };
  const ids = [...picked];
  const hasMoney = items.some((i) => picked.has(i.id) && isMoneyType(i.event_type));

  const send = async (action: "replay" | "discard") => {
    if (ids.length === 0) return;
    setBusy(true);
    const r = await adminCall(market, `dlq/${action}`, { method: "POST", idempotencyKey: uuidv7(), body: action === "discard" ? { ids, reason_code: reason } : { ids } });
    setBusy(false);
    if (r.ok) {
      setMsg({ ok: true, key: isResult(r.data) && hasExpired(r.data) ? "admin.dlq.expired" : isResult(r.data) && r.data.changed === 0 ? "admin.dlq.nothingChanged" : "admin.dlq.done" });
      setPicked(new Set());
      router.refresh();
    } else if (r.status === 409 && r.code === "dual-approval-required") setMsg({ ok: true, key: "admin.dlq.needsApproval" });
    else setMsg({ ok: false, key: problemKey(r.code, r.status) });
  };

  if (items.length === 0) return <p className="hint" data-testid="dlq-empty">{t("admin.dlq.empty")}</p>;
  return (
    <div className="stack">
      {!canManage ? <p className="hint">{t("admin.dlq.readOnly")}</p> : null}
      {canManage ? (
        <div className="rowActions" data-testid="dlq-toolbar">
          <span className="hint" role="status">{t("admin.dlq.selected", { n: picked.size })}</span>
          <button type="button" className="btn btnPrimary" disabled={busy || picked.size === 0} onClick={() => { void send("replay"); }}>{t("admin.dlq.replay")}</button>
          <label className="field">
            <span className="srOnly">{t("admin.dlq.reason")}</span>
            <select value={reason} onChange={(e) => { const v = DISCARD_REASONS.find((c) => c === e.target.value); if (v) setReason(v); }}>
              {DISCARD_REASONS.map((c) => <option key={c} value={c}>{t(`admin.dlq.reason.${c}` as MessageKey)}</option>)}
            </select>
          </label>
          <button type="button" className="btn btnSecondary" disabled={busy || picked.size === 0} onClick={() => { void send("discard"); }}>{t("admin.dlq.discard")}</button>
        </div>
      ) : null}
      {hasMoney ? <p className="hint" data-testid="dlq-money-hint">{t("admin.dlq.moneyHint")}</p> : null}
      {msg ? <p className="hint" role={msg.ok ? "status" : "alert"} data-testid="dlq-msg">{t(msg.key, { days: 45 })}</p> : null}
      <div className="tableWrap card">
        <table className="table" data-testid="dlq-table">
          <caption className="srOnly">{t("admin.dlq.title")}</caption>
          <thead><tr>
            {canManage ? <th scope="col"><span className="srOnly">{t("admin.dlq.colSelect")}</span></th> : null}
            <th scope="col">{t("admin.dlq.colType")}</th><th scope="col">{t("admin.dlq.colAttempts")}</th><th scope="col">{t("admin.dlq.colError")}</th><th scope="col">{t("admin.dlq.colAge")}</th>
          </tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} data-dlq-id={i.id}>
                {canManage ? <td><input type="checkbox" checked={picked.has(i.id)} onChange={() => { toggle(i.id); }} aria-label={t("admin.dlq.selectRow", { type: i.event_type })} /></td> : null}
                <td dir="ltr"><bdi>{i.event_type}</bdi></td>
                <td><bdi>{i.attempts}</bdi></td>
                <td dir="ltr"><bdi>{i.last_error ?? ""}</bdi></td>
                <td><bdi title={fmtDateTime(i.dead_lettered_at, locale)}>{ageLabel(i.dead_lettered_at, nowDate, locale)}</bdi></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
