"use client";
import { useEffect, useState, type SyntheticEvent } from "react";
import type { Locale } from "@outlet/i18n";
import { Button, Field } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import { normalizeCode } from "../../lib/phone";
import type { OrderGroup } from "../../lib/wire";
import { isSafeRedirect } from "./CheckoutView";
import { SellerOrders } from "./SellerOrders";
import { Alert, isProblem, Status, useShared } from "./shared";

export interface OrderStatusProps {
  readonly locale: Locale;
  readonly orderId: string;
  readonly api?: ShopperApi;
  /** Poll period while payment is pending (the webhook may land before or after the shopper returns from the PSP). */
  readonly pollMs?: number;
}
const FINAL = new Set<OrderGroup["status"]>(["PAID", "CONFIRMED_COD", "PAYMENT_FAILED", "EXPIRED", "PARTIALLY_FULFILLED", "COMPLETED", "CANCELLED"]);

export function OrderStatus({ locale, orderId, api = browserApi(), pollMs = 3000 }: OrderStatusProps) {
  const { t, money, date, base } = useShared(locale);
  const [order, setOrder] = useState<OrderGroup | null>(null);
  const [state, setState] = useState<"loading" | "out" | "error" | "ready">("loading");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      api.getOrderGroup(orderId).then((o) => {
        if (!live) return;
        setOrder(o); setState("ready");
        if (!FINAL.has(o.status)) timer = setTimeout(tick, pollMs);
      }, (e: unknown) => {
        if (!live) return;
        if (isProblem(e, 401)) setState("out");
        else { setState((s) => (s === "ready" ? s : "error")); timer = setTimeout(tick, pollMs * 2); }
      });
    };
    tick();
    return () => { live = false; if (timer !== undefined) clearTimeout(timer); };
  }, [api, orderId, pollMs]);

  async function confirm(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    const c = normalizeCode(code);
    if (c === null) { setCodeError(t("auth.code.invalid", { digits: 6 })); return; }
    setBusy(true); setCodeError(null);
    try { setOrder(await api.confirmCod(orderId, c)); } catch { setCodeError(t("checkout.order.cod.wrong")); } finally { setBusy(false); }
  }

  if (state === "loading") return <p role="status">{t("checkout.order.checking")}</p>;
  if (state === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/orders/${orderId}`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (state === "error" || order === null) return <Alert>{t("checkout.order.loadError")}</Alert>;
  const a = order.client_action;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const pending = order.status === "PENDING_PAYMENT";

  return (
    <div className="shopStack">
      <section className="shopCard" aria-labelledby="order-status">
        <h2 id="order-status">{t(`checkout.order.status.${order.status}`)}</h2>
        {pending ? <Status>{t("checkout.order.checking")}</Status> : null}
        {a !== null && pending && a.kind === "fawry_reference" && a.reference !== null ? (
          <p>{t("checkout.order.fawryRef", { reference: a.reference })}{a.expires_at === null ? null : <span className="hint"> · {t("checkout.order.expires", { date: date(a.expires_at) })}</span>}</p>
        ) : null}
        {a !== null && pending && a.kind === "instapay_qr" && a.reference !== null ? <p dir="ltr">{a.reference}</p> : null}
        {a !== null && pending && a.url !== null && (a.kind === "redirect" || a.kind === "wallet_redirect" || a.kind === "iframe") && isSafeRedirect(a.url, origin) ? (
          <a className="shopButton" href={a.url}>{t("checkout.order.continuePay")}</a>
        ) : null}
        {a !== null && a.kind === "cod_confirmation" ? (
          <form noValidate className="shopForm" onSubmit={(e) => { void confirm(e); }} aria-label={t("checkout.order.cod.title")}>
            <Field label={t("checkout.order.cod.code", { digits: 6 })} value={code} onChange={(e) => { setCode(e.target.value); }} inputMode="numeric" autoComplete="one-time-code" dir="ltr" required {...(codeError === null ? {} : { error: codeError })} />
            <Button type="submit" loading={busy}>{t("checkout.order.cod.submit")}</Button>
          </form>
        ) : null}
      </section>
      <SellerOrders locale={locale} order={order} api={api} onOrder={setOrder} />
      <section className="shopCard" aria-label={t("checkout.review.title")}>
        <dl className="shopSummary">
          <div><dt>{t("checkout.review.items")}</dt><dd>{money(order.items_subtotal)}</dd></div>
          <div><dt>{t("checkout.review.shipping")}</dt><dd>{money(order.shipping)}</dd></div>
          <div><dt>{t("checkout.review.vat")}</dt><dd>{money(order.vat)}</dd></div>
          <div className="shopGrand"><dt>{t("checkout.review.total")}</dt><dd>{money(order.total)}</dd></div>
        </dl>
      </section>
    </div>
  );
}
