"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { adminCall } from "../../client/admin-api";
import { queueOrder, RESOLUTION_CODES, type AttentionItemView, type ResolutionCode } from "../../lib/attention";
import { fmtDateTime } from "../../lib/fmt";
import { label } from "../../lib/labels";
import { problemKey } from "../../lib/problem";
import { uuidv7 } from "../../lib/uuid7";

interface Msg { readonly ok: boolean; readonly key: MessageKey }

/** The open ops-attention items with Acknowledge and Resolve. Each write goes through the same-origin BFF with its own UUIDv7 Idempotency-Key; the server decides (409 = someone got there first). */
export function AttentionQueue({ locale, market, items, canWrite }: { locale: Locale; market: string; items: readonly AttentionItemView[]; canWrite: boolean }) {
  const t = createTranslator(locale);
  const router = useRouter();
  const rows = queueOrder(items);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Readonly<Record<string, ResolutionCode>>>({});
  const [msgs, setMsgs] = useState<Readonly<Record<string, Msg>>>({});

  const send = async (id: string, action: "ack" | "resolve", code: ResolutionCode) => {
    setBusy(id);
    const r = await adminCall(market, `attention/${id}/${action}`, { method: "POST", idempotencyKey: uuidv7(), ...(action === "resolve" ? { body: { resolution_code: code } } : {}) });
    setBusy(null);
    const msg: Msg = r.ok ? { ok: true, key: "admin.attention.done" } : { ok: false, key: r.status === 409 ? "admin.attention.conflict" : problemKey(r.code, r.status) };
    setMsgs((m) => ({ ...m, [id]: msg }));
    if (r.ok) router.refresh();
  };

  if (rows.length === 0) return <p className="hint" data-testid="attention-empty">{t("admin.attention.empty")}</p>;
  return (
    <div className="stack">
      {!canWrite ? <p className="hint">{t("admin.attention.readOnly")}</p> : null}
      <div className="tableWrap card">
        <table className="table" data-testid="attention-table">
          <caption className="srOnly">{t("admin.attention.title")}</caption>
          <thead><tr>
            <th scope="col">{t("admin.attention.colKind")}</th><th scope="col">{t("admin.attention.colRef")}</th><th scope="col">{t("admin.attention.colStatus")}</th><th scope="col">{t("admin.attention.colSince")}</th>
            {canWrite ? <th scope="col">{t("admin.attention.colActions")}</th> : null}
          </tr></thead>
          <tbody>
            {rows.map((i) => {
              const code = codes[i.id] ?? RESOLUTION_CODES[0];
              const m = msgs[i.id];
              return (
                <tr key={i.id} data-attention-id={i.id}>
                  <td>{label(t, "admin.attention.kind", i.kind)}</td>
                  <td dir="ltr"><bdi>{i.ref_id ?? ""}</bdi></td>
                  <td>{label(t, "admin.attention.status", i.status)}</td>
                  <td><bdi>{fmtDateTime(i.created_at, locale)}</bdi></td>
                  {canWrite ? (
                    <td>
                      <div className="rowActions">
                        {i.status === "OPEN" ? <button type="button" className="btn btnSecondary" disabled={busy === i.id} onClick={() => { void send(i.id, "ack", code); }}>{t("admin.attention.ack")}</button> : null}
                        <label className="field">
                          <span className="srOnly">{t("admin.attention.reason")}</span>
                          <select value={code} onChange={(e) => { const v = RESOLUTION_CODES.find((c) => c === e.target.value); if (v) setCodes((c) => ({ ...c, [i.id]: v })); }}>
                            {RESOLUTION_CODES.map((c) => <option key={c} value={c}>{t(`admin.attention.reason.${c}` as MessageKey)}</option>)}
                          </select>
                        </label>
                        <button type="button" className="btn btnPrimary" disabled={busy === i.id} onClick={() => { void send(i.id, "resolve", code); }}>{t("admin.attention.resolve")}</button>
                      </div>
                      {m ? <p className="hint" role={m.ok ? "status" : "alert"}>{t(m.key)}</p> : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
