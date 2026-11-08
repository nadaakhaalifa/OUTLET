"use client";
import { useId, useState } from "react";
import type { Locale } from "@outlet/i18n";
import { Button } from "@outlet/ui-web";
import type { ShopperApi } from "../../lib/client-api";
import { CANCEL_REASONS, cancelReasonLabel, sellerStatusLabel, trackingLabel } from "../../lib/orders-labels";
import type { OrderGroup, ShopperSellerOrder } from "../../lib/wire";
import { Alert, pickName, Status, useShared } from "./shared";

export interface SellerOrdersProps {
  readonly locale: Locale;
  readonly order: OrderGroup;
  readonly api: ShopperApi;
  readonly onOrder: (o: OrderGroup) => void;
}

function Tracking({ so, locale }: { readonly so: ShopperSellerOrder; readonly locale: Locale }) {
  const { t, date } = useShared(locale);
  const sh = so.shipment;
  if (sh === null) return <p className="hint">{t("orders.tracking.none")}</p>;
  return (
    <div>
      <h4>{t("orders.tracking.title")}</h4>
      <p className="hint">{t("orders.tracking.courier", { courier: sh.courier_code })}{sh.awb === null ? null : <> · <span dir="ltr">{t("orders.tracking.awb", { awb: sh.awb })}</span></>}</p>
      <p><strong>{trackingLabel(t, sh.status)}</strong></p>
      {sh.events.length === 0 ? <p className="hint">{t("orders.tracking.noEvents")}</p> : (
        <ol className="shopTimeline">
          {sh.events.map((e) => (
            <li key={`${e.occurred_at}-${e.normalized_status}`}>
              <span>{trackingLabel(t, e.normalized_status)}</span>
              <span className="hint"> · <time dateTime={e.occurred_at}>{date(e.occurred_at)}</time>{e.location_text === null ? null : ` · ${e.location_text}`}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CancelFlow({ so, orderId, locale, api, onOrder }: { readonly so: ShopperSellerOrder; readonly orderId: string; readonly locale: Locale; readonly api: ShopperApi; readonly onOrder: (o: OrderGroup) => void }) {
  const { t } = useShared(locale);
  const reasonId = useId();
  const [step, setStep] = useState<"idle" | "confirm">("idle");
  const [reason, setReason] = useState<(typeof CANCEL_REASONS)[number]>("changed_mind");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function confirm(): Promise<void> {
    setBusy(true); setError(false);
    try {
      // Never optimistic: the order only changes once the server confirms the cancellation.
      onOrder(await api.cancelSellerOrder(orderId, so.id, { reasonCode: reason }));
      setStep("idle");
    } catch { setError(true); } finally { setBusy(false); }
  }

  if (step === "idle") return (
    <>
      <Button variant="secondary" aria-label={t("orders.cancel.btnFor", { store: so.store_display_name_ar })} onClick={() => { setStep("confirm"); }}>{t("orders.cancel.btn")}</Button>
      {error ? <Alert>{t("orders.cancel.error")}</Alert> : null}
    </>
  );
  return (
    <div role="group" aria-label={t("orders.cancel.title")} className="shopCard shopWarn">
      <h4>{t("orders.cancel.title")}</h4>
      <p className="hint">{t("orders.cancel.hint")}</p>
      <div className="shopField">
        <label htmlFor={reasonId}>{t("orders.cancel.reason")}</label>
        <select id={reasonId} className="shopSelect" value={reason} onChange={(e) => { const v = CANCEL_REASONS.find((r) => r === e.target.value); if (v !== undefined) setReason(v); }}>
          {CANCEL_REASONS.map((r) => <option key={r} value={r}>{cancelReasonLabel(t, r)}</option>)}
        </select>
      </div>
      {error ? <Alert>{t("orders.cancel.error")}</Alert> : null}
      <div className="shopRow">
        <Button loading={busy} onClick={() => { void confirm(); }}>{t("orders.cancel.confirm")}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setStep("idle"); setError(false); }}>{t("orders.cancel.keep")}</Button>
      </div>
    </div>
  );
}

/** One card per store: status, lines (with the return entry while the server says the line is returnable), tracking, and a confirm-first cancel while the server says the order is cancellable. */
export function SellerOrders({ locale, order, api, onOrder }: SellerOrdersProps) {
  const { t, money, date, base } = useShared(locale);
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set());
  return (
    <ul className="shopList" aria-label={t("orders.detail.shipments")}>
      {order.seller_orders.map((so) => (
        <li key={so.id} className="shopCard">
          <div className="shopListRow">
            <h3>{t("checkout.order.store", { store: so.store_display_name_ar })}</h3>
            <span className="shopChip shopChipGood">{sellerStatusLabel(t, so.status)}</span>
          </div>
          <strong>{money(so.total)}</strong>
          {so.lines.length === 0 ? null : (
            <ul className="shopList">
              {so.lines.map((l) => {
                const name = pickName(locale, l.title_ar_snapshot, l.title_en_snapshot);
                return (
                  <li key={l.id} className="shopListRow">
                    <span>{name} · {t("orders.line.qty", { qty: l.qty })}</span>
                    {so.returnable ? <a className="shopLink" aria-label={t("orders.return.ctaFor", { item: name })} href={`${base}/returns/new?line=${encodeURIComponent(l.id)}&order=${encodeURIComponent(order.id)}`}>{t("orders.return.cta")}</a> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {so.delivered_at === null ? null : <p className="hint">{t("orders.delivered", { date: date(so.delivered_at) })}</p>}
          {so.returnable && so.return_window_ends_at !== null ? <p className="hint">{t("orders.return.window", { date: date(so.return_window_ends_at) })}</p> : null}
          <Tracking so={so} locale={locale} />
          {cancelled.has(so.id) ? <Status>{t("orders.cancel.done")}</Status> : null}
          {so.cancellable ? <CancelFlow so={so} orderId={order.id} locale={locale} api={api} onOrder={(o) => { setCancelled((c) => new Set(c).add(so.id)); onOrder(o); }} /> : null}
        </li>
      ))}
    </ul>
  );
}
