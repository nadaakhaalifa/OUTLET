"use client";
import { Fragment, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { createSellerApi, STOCK_REASONS, type ApiFailure, type SellerApi, type StockReason } from "../../client/seller-api";

export interface InventoryRow {
  readonly sku_id: string;
  readonly seller_sku: string;
  readonly size_label: string | null;
  readonly product_title_ar: string;
  readonly on_hand: number;
  readonly committed: number;
  readonly available: number;
  readonly low_stock: boolean;
  readonly version: number;
}

const REASON: Readonly<Record<StockReason, MessageKey>> = {
  recount: "seller.inventory.reason.recount", damage: "seller.inventory.reason.damage", received: "seller.inventory.reason.received", correction: "seller.inventory.reason.correction",
};

const errorKey = (f: ApiFailure): MessageKey => {
  if (f.code === "version-conflict") return "seller.inventory.err.version";
  if (f.code === "insufficient-stock" || f.code === "conflict") return "seller.inventory.err.below";
  if (f.status === 403) return "seller.error.forbidden";
  if (f.status === 404) return "seller.error.notFound";
  if (f.status === 401) return "seller.error.unauthenticated";
  if (f.status === 429) return "seller.error.rate";
  return "error.generic";
};

/** Stock per variant from the real levels. The low-stock badge comes from the server's `low_stock` flag, never from the browser. */
export function InventoryTable({ locale, marketId, rows, api: apiProp }: { locale: Locale; marketId: string; rows: readonly InventoryRow[]; api?: SellerApi }) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const api = useMemo(() => apiProp ?? createSellerApi(marketId.toLowerCase()), [apiProp, marketId]);
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState<StockReason | "">("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const submit = async (row: InventoryRow): Promise<void> => {
    const n = /^[+-]?\d{1,6}$/.test(delta.trim()) ? Number(delta.trim()) : 0;
    if (n === 0 || reason === "") {
      setProblem("seller.inventory.adjust.invalid");
      return;
    }
    setProblem(null);
    setBusy(true);
    const r = await api.adjustStock({ sku_id: row.sku_id, delta: n, reason, expected_version: row.version });
    setBusy(false);
    if (!r.ok) {
      setProblem(errorKey(r));
      if (r.code === "version-conflict") router.refresh();
      return;
    }
    setOpen(null);
    setDelta("");
    setReason("");
    setSaved(t("seller.inventory.adjust.saved", { onHand: r.data.on_hand }));
    router.refresh();
  };

  return (
    <>
      <div role="status" aria-live="polite">{saved === null ? null : <p className="resultNote">{saved}</p>}</div>
      <table className="table">
        <caption className="srOnly">{t("seller.inventory.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("seller.inventory.col.product")}</th>
            <th scope="col">{t("seller.inventory.col.sku")}</th>
            <th scope="col">{t("seller.inventory.col.size")}</th>
            <th scope="col">{t("seller.inventory.col.onHand")}</th>
            <th scope="col">{t("seller.inventory.col.committed")}</th>
            <th scope="col">{t("seller.inventory.col.available")}</th>
            <th scope="col">{t("seller.inventory.col.status")}</th>
            <th scope="col">{t("seller.inventory.col.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open === r.sku_id;
            const status = r.available === 0 ? "out" : r.low_stock ? "low" : "ok";
            return (
              <Fragment key={r.sku_id}>
                <tr>
                  <th scope="row">{r.product_title_ar}</th>
                  <td dir="ltr">{r.seller_sku}</td>
                  <td>{r.size_label ?? ""}</td>
                  <td>{r.on_hand}</td>
                  <td>{r.committed}</td>
                  <td>{r.available}</td>
                  <td>
                    <span className="chip" data-tone={status === "ok" ? "plain" : status === "low" ? "action" : "bad"} data-stock={status}>
                      {t(status === "ok" ? "seller.inventory.status.ok" : status === "low" ? "seller.inventory.status.low" : "seller.inventory.status.out")}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btnSecondary"
                      aria-expanded={isOpen}
                      aria-controls={`${id}-${r.sku_id}`}
                      onClick={() => { setOpen(isOpen ? null : r.sku_id); setProblem(null); setSaved(null); setDelta(""); setReason(""); }}
                    >
                      {t("seller.inventory.adjust")}
                      <span className="srOnly"> {r.seller_sku}</span>
                    </button>
                  </td>
                </tr>
                {isOpen ? (
                  <tr>
                    <td colSpan={8} id={`${id}-${r.sku_id}`}>
                      <form
                        className="adjustForm"
                        noValidate
                        aria-label={t("seller.inventory.adjust.title", { sku: r.seller_sku })}
                        onSubmit={(e) => { e.preventDefault(); void submit(r); }}
                      >
                        <div className="field">
                          <label htmlFor={`${id}-d`}>{t("seller.inventory.adjust.delta")}</label>
                          <input id={`${id}-d`} type="text" inputMode="numeric" maxLength={7} dir="ltr" value={delta} onChange={(e) => { setDelta(e.target.value); }} />
                        </div>
                        <div className="field">
                          <label htmlFor={`${id}-r`}>{t("seller.inventory.adjust.reason")}</label>
                          <select id={`${id}-r`} value={reason} aria-required="true" onChange={(e) => { setReason(e.target.value as StockReason | ""); }}>
                            <option value="">{t("seller.inventory.adjust.choose")}</option>
                            {STOCK_REASONS.map((x) => (
                              <option key={x} value={x}>
                                {t(REASON[x])}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button type="submit" className="btn btnPrimary" disabled={busy}>
                          {busy ? t("seller.inventory.adjust.working") : t("seller.inventory.adjust.submit")}
                        </button>
                        <button type="button" className="btn btnGhost" disabled={busy} onClick={() => { setOpen(null); }}>
                          {t("seller.inventory.adjust.cancel")}
                        </button>
                        {problem === null ? null : <p role="alert" className="problems">{t(problem)}</p>}
                      </form>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
