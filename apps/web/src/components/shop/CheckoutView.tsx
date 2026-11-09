"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, MessageKey } from "@outlet/i18n";
import type { Money } from "@outlet/money";
import { Button } from "@outlet/ui-web";
import { ApiProblem, browserApi, type ShopperApi } from "../../lib/client-api";
import { uuidv7 } from "../../lib/uuid7";
import { quoteSchema, type Address, type Cart, type CheckoutResult, type PaymentMethod, type Quote } from "../../lib/wire";
import { AddressForm } from "./AddressForm";
import { Alert, isProblem, Status, useShared } from "./shared";

type Load = "loading" | "out" | "error" | "ready";
export interface CheckoutViewProps {
  readonly locale: Locale;
  readonly api?: ShopperApi;
  readonly navigate?: (href: string) => void;
}

const METHOD_KEYS = {
  card: "checkout.method.card", apple_pay: "checkout.method.apple_pay", meeza: "checkout.method.meeza", mobile_wallet: "checkout.method.mobile_wallet",
  instapay: "checkout.method.instapay", fawry: "checkout.method.fawry", bnpl: "checkout.method.bnpl", cod: "checkout.method.cod",
} as const satisfies Record<PaymentMethod, MessageKey>;
const FEE_KEYS: Readonly<Record<string, MessageKey>> = { cod_fee: "checkout.fee.cod_fee", payment_fee: "checkout.fee.payment_fee", service_fee: "checkout.fee.service_fee" };

/** PSP hosts a redirect may leave to (build-time env, comma separated, exact host match). Empty = fail closed: this origin only. */
export const pspRedirectHosts = (raw: string | undefined = process.env.NEXT_PUBLIC_PSP_REDIRECT_HOSTS): readonly string[] =>
  (raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");

/** A redirect is followed only to this very origin or to https on a configured PSP host (never javascript:, data:, plain http or an unlisted host). */
export function isSafeRedirect(url: string, origin: string, hosts: readonly string[] = pspRedirectHosts()): boolean {
  try {
    const u = new URL(url, origin);
    return u.origin === origin || (u.protocol === "https:" && hosts.includes(u.hostname.toLowerCase()));
  } catch {
    return false;
  }
}
/** The fresh quote a 409 `price-changed` carries (top level or under `quote`). */
export function freshQuoteFrom(body: unknown): Quote | null {
  const inner = typeof body === "object" && body !== null && "quote" in body ? body.quote : body;
  const p = quoteSchema.safeParse(inner);
  return p.success ? p.data : null;
}

interface PriceChange { readonly was: Quote; readonly now: Quote }

export function CheckoutView({ locale, api = browserApi(), navigate = (h) => { window.location.assign(h); } }: CheckoutViewProps) {
  const sh = useShared(locale);
  const { t, money, base } = sh;
  const [load, setLoad] = useState<Load>("loading");
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<readonly Address[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [wallet, setWallet] = useState<Money | null>(null);
  const [useCredit, setUseCredit] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [vouchers, setVouchers] = useState<readonly string[]>([]);
  const [voucherInput, setVoucherInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [change, setChange] = useState<PriceChange | null>(null);
  const seq = useRef(0);
  const placingRef = useRef(false);
  const attempt = useRef<{ token: string; key: string } | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.getCart(), api.listAddresses(), api.walletBalance()]).then(([c, a, w]) => {
      if (!live) return;
      setCart(c); setAddresses(a); setWallet(w);
      setAddressId((a.find((x) => x.is_default) ?? a[0])?.id ?? null);
      setLoad("ready");
    }, (e: unknown) => { if (live) setLoad(isProblem(e, 401) ? "out" : "error"); });
    return () => { live = false; };
  }, [api]);

  const requote = useCallback(async (): Promise<Quote | null> => {
    if (addressId === null) { setQuote(null); return null; }
    const mine = ++seq.current;
    setQuoting(true);
    setError(null);
    try {
      const q = await api.quote({ addressId, method, voucherCodes: vouchers, ...(useCredit && wallet !== null ? { storeCredit: wallet } : {}) });
      if (mine !== seq.current) return null;
      setQuote(q);
      return q;
    } catch (e) {
      if (mine === seq.current) { if (isProblem(e, 401)) setLoad("out"); else { setQuote(null); setError(t("checkout.quote.error")); } }
      return null;
    } finally { if (mine === seq.current) setQuoting(false); }
  }, [api, addressId, method, vouchers, useCredit, wallet, t]);
  useEffect(() => { if (load === "ready") void requote(); }, [load, requote]);

  const keyFor = (q: Quote): string => {
    if (attempt.current?.token === q.quote_token) return attempt.current.key;
    const next = { token: q.quote_token, key: uuidv7() };
    attempt.current = next;
    return next.key;
  };

  async function place(q: Quote, acceptPriceChange: boolean): Promise<void> {
    if (addressId === null || placingRef.current) return;
    placingRef.current = true;
    setPlacing(true);
    setError(null);
    try {
      const r = await api.placeOrder({ addressId, method, voucherCodes: vouchers, ...(useCredit && wallet !== null ? { storeCredit: wallet } : {}), quoteToken: q.quote_token, clientTotal: q.total, acceptPriceChange, idempotencyKey: keyFor(q) });
      follow(r);
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 409 && e.type === "price-changed") {
        const fresh = freshQuoteFrom(e.body) ?? (await api.quote({ addressId, method, voucherCodes: vouchers, ...(useCredit && wallet !== null ? { storeCredit: wallet } : {}) }).catch(() => null));
        if (fresh !== null) { setChange({ was: q, now: fresh }); setQuote(fresh); } else setError(t("checkout.error.generic"));
      } else if (e instanceof ApiProblem && e.status === 409 && e.type === "stock-shortfall") setError(t("checkout.error.stock"));
      else if (e instanceof ApiProblem && e.type === "defect-ack-missing") setError(t("checkout.error.defectAck"));
      else if (e instanceof ApiProblem && e.type === "cod-not-allowed") setError(t("checkout.error.cod"));
      else if (e instanceof ApiProblem && e.type === "age-capacity") setError(t("checkout.error.age"));
      else if (isProblem(e, 401)) setLoad("out");
      else setError(t("checkout.error.generic"));
    } finally { placingRef.current = false; setPlacing(false); }
  }

  function follow(r: CheckoutResult): void {
    const a = r.client_action;
    const origin = window.location.origin;
    if ((a.kind === "redirect" || a.kind === "wallet_redirect" || a.kind === "iframe") && a.url !== null && isSafeRedirect(a.url, origin)) { navigate(a.url); return; }
    navigate(`${base}/orders/${r.order_group_id}`);
  }

  if (load === "loading") return <p role="status">{t("state.loading")}</p>;
  if (load === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/checkout`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (load === "error") return <Alert>{t("bag.error.load")}</Alert>;
  if (cart === null || cart.groups.every((g) => g.lines.length === 0)) return <div className="empty" role="status"><p>{t("checkout.empty")}</p></div>;

  const storeName = (id: string): string => cart.groups.find((g) => g.store_id === id)?.display_name_ar ?? t("bag.line.fallbackName");
  const zero = (m: Money): boolean => m.amountMinor === 0n;
  const selected = addresses.find((a) => a.id === addressId) ?? null;

  return (
    <div className="shopStack">
      <section className="shopCard" aria-labelledby="co-address">
        <h2 id="co-address">{t("checkout.address.title")}</h2>
        {addresses.length > 0 ? (
          <fieldset className="shopFieldset">
            <legend>{t("checkout.address.saved")}</legend>
            {addresses.map((a) => (
              <label key={a.id} className="shopCheck">
                <input type="radio" name="address" checked={a.id === addressId} onChange={() => { setAddressId(a.id); setChange(null); }} />
                <span>{t("checkout.address.deliverTo", { name: a.recipient_name, street: a.fields.street })}</span>
              </label>
            ))}
          </fieldset>
        ) : <p className="hint">{t("checkout.address.none")}</p>}
        {addresses.length > 0 && !adding ? <Button variant="secondary" onClick={() => { setAdding(true); }}>{t("checkout.address.new")}</Button> : null}
        {adding || addresses.length === 0 ? <AddressForm locale={locale} api={api} onSaved={(a) => { setAddresses((p) => [a, ...p]); setAddressId(a.id); setAdding(false); }} /> : null}
      </section>

      {selected === null ? null : (
        <>
          <section className="shopCard" aria-labelledby="co-delivery">
            <h2 id="co-delivery">{t("checkout.delivery.title")}</h2>
            {quote === null ? <p role="status" className="hint">{quoting ? t("checkout.quote.loading") : t("checkout.quote.error")}</p> : (
              <ul className="shopList">
                {quote.stores.flatMap((s) => s.parcels.map((p, i) => (
                  <li key={`${s.store_id}-${String(i)}`}>
                    {t(p.free_delivery_applied || zero(p.fee) ? "checkout.delivery.free" : "checkout.delivery.parcel", { store: storeName(s.store_id), fee: money(p.fee), min: p.days_min, max: p.days_max })}
                  </li>
                )))}
              </ul>
            )}
          </section>

          <section className="shopCard" aria-labelledby="co-payment">
            <h2 id="co-payment">{t("checkout.payment.title")}</h2>
            {quote === null ? null : (
              <fieldset className="shopFieldset">
                <legend className="shopSr">{t("checkout.payment.title")}</legend>
                {quote.payment_options.map((o) => {
                  const usable = o.available && o.method !== "bnpl";
                  return (
                    <label key={o.method} className="shopCheck">
                      <input type="radio" name="method" disabled={!usable} checked={method === o.method} onChange={() => { setMethod(o.method); setChange(null); }} />
                      <span>{t(METHOD_KEYS[o.method])}{usable ? null : <span className="hint"> · {t("checkout.method.unavailable")}</span>}</span>
                    </label>
                  );
                })}
                {method === "cod" && quote.cod_requires_confirmation ? <p className="hint">{t("checkout.method.codConfirm")}</p> : null}
              </fieldset>
            )}
          </section>

          <section className="shopCard" aria-labelledby="co-vouchers">
            <h2 id="co-vouchers">{t("checkout.vouchers.title")}</h2>
            <form className="shopRow" onSubmit={(e) => { e.preventDefault(); const c = voucherInput.trim(); if (c !== "" && !vouchers.includes(c)) { setVouchers((v) => [...v, c]); setVoucherInput(""); } }}>
              <label className="shopSr" htmlFor="voucher-code">{t("checkout.voucher.label")}</label>
              <input id="voucher-code" className="shopInput" value={voucherInput} onChange={(e) => { setVoucherInput(e.target.value); }} autoComplete="off" dir="ltr" />
              <Button type="submit" variant="secondary">{t("checkout.voucher.apply")}</Button>
            </form>
            {vouchers.map((c) => <Button key={c} variant="ghost" aria-label={t("checkout.voucher.remove", { code: c })} onClick={() => { setVouchers((v) => v.filter((x) => x !== c)); }}>{c} ×</Button>)}
            {wallet === null ? null : (
              <label className="shopCheck"><input type="checkbox" checked={useCredit} onChange={(e) => { setUseCredit(e.target.checked); }} /><span>{t("checkout.credit.use", { amount: money(wallet) })}</span></label>
            )}
          </section>

          <section className="shopCard" aria-labelledby="co-review" aria-busy={quoting || undefined}>
            <h2 id="co-review">{t("checkout.review.title")}</h2>
            {quote === null ? <p role="status" className="hint">{quoting ? t("checkout.quote.loading") : t("checkout.quote.error")}</p> : (
              <dl className="shopSummary">
                <div><dt>{t("checkout.review.items")}</dt><dd>{money(quote.items_subtotal)}</dd></div>
                {zero(quote.discount) ? null : <div><dt>{t("checkout.review.discount")}</dt><dd>−{money(quote.discount)}</dd></div>}
                <div><dt>{t("checkout.review.shipping")}</dt><dd>{money(quote.shipping)}</dd></div>
                {quote.fees.map((f) => <div key={f.code}><dt>{t(FEE_KEYS[f.code] ?? "checkout.fee.other")}</dt><dd>{money(f.amount)}</dd></div>)}
                <div><dt>{t("checkout.review.vat")}</dt><dd>{money(quote.vat_included)}</dd></div>
                {zero(quote.store_credit) ? null : <div><dt>{t("checkout.review.credit")}</dt><dd>−{money(quote.store_credit)}</dd></div>}
                <div className="shopGrand"><dt>{t("checkout.review.total")}</dt><dd>{money(quote.total)}</dd></div>
              </dl>
            )}
            {quote !== null && quote.verified_savings.amountMinor > 0n ? <p className="shopSaved">{t("checkout.review.saved", { amount: money(quote.verified_savings) })}</p> : null}
            {error === null ? null : <Alert>{error}</Alert>}
            {change === null ? null : (
              <div role="alert" className="shopCard shopWarn">
                <h3>{t("checkout.priceChanged.title")}</h3>
                <p>{t("checkout.priceChanged.hint")}</p>
                <ul className="shopList">
                  {([["checkout.review.items", "items_subtotal"], ["checkout.review.shipping", "shipping"], ["checkout.review.discount", "discount"], ["checkout.review.total", "total"]] as const)
                    .filter(([, k]) => change.was[k].amountMinor !== change.now[k].amountMinor)
                    .map(([label, k]) => <li key={k}>{t("checkout.priceChanged.row", { label: t(label), was: money(change.was[k]), now: money(change.now[k]) })}</li>)}
                </ul>
                <Button loading={placing} onClick={() => { void place(change.now, true); }}>{t("checkout.priceChanged.accept")}</Button>
              </div>
            )}
            {change !== null ? null : <Button loading={placing} disabled={quote === null || quoting} onClick={() => { if (quote !== null) void place(quote, false); }}>{placing ? t("checkout.placing") : t("checkout.placeOrder")}</Button>}
            {placing ? <Status>{t("checkout.placing")}</Status> : null}
          </section>
        </>
      )}
    </div>
  );
}
