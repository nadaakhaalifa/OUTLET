"use client";
import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { createSellerApi, CANCEL_REASONS, REJECT_REASONS, type ApiFailure, type CancelReason, type RejectReason, type SellerApi } from "../../client/seller-api";
import { safeHref } from "../../lib/sla";
import { DISPATCH_SLA_HOURS, PARCEL_WEIGHT_G } from "../../lib/policy-limits";

type Action = "accept" | "reject" | "pack" | "ship" | "cancel";
const CANCELLABLE_STATUS: ReadonlySet<string> = new Set(["PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"]);
const LABEL: Readonly<Record<Action, MessageKey>> = { accept: "seller.orders.action.accept", reject: "seller.orders.action.reject", pack: "seller.orders.action.pack", ship: "seller.orders.action.ship", cancel: "seller.orders.action.cancel" };
const CONFIRM: Readonly<Record<Action, MessageKey>> = { accept: "seller.orders.confirm.accept", reject: "seller.orders.confirm.reject", pack: "seller.orders.confirm.pack", ship: "seller.orders.confirm.ship", cancel: "seller.orders.confirm.cancel_order" };
const DONE: Readonly<Partial<Record<Action, MessageKey>>> = { accept: "seller.orders.result.accepted", reject: "seller.orders.result.rejected", pack: "seller.orders.result.packed", cancel: "seller.orders.result.cancelled" };
const CANCEL_REASON_KEY: Readonly<Record<CancelReason, MessageKey>> = {
  out_of_stock: "seller.orders.cancel.out_of_stock", cannot_fulfil: "seller.orders.cancel.cannot_fulfil", pricing_error: "seller.orders.cancel.pricing_error", other: "seller.orders.cancel.other",
};
const REASON_KEY: Readonly<Record<RejectReason, MessageKey>> = {
  out_of_stock: "seller.orders.reject.out_of_stock", damaged: "seller.orders.reject.damaged", pricing_error: "seller.orders.reject.pricing_error", other: "seller.orders.reject.other",
};

const errorKey = (f: ApiFailure): MessageKey => {
  if (f.code === "cancel-after-shipping") return "seller.orders.err.cancelAfterShipping";
  if (f.code === "order-not-cancellable") return "seller.orders.err.notCancellable";
  if (f.code === "invalid-transition") return "seller.orders.err.invalid";
  if (f.code === "courier-unconfigured" || f.code === "courier-unavailable") return "seller.orders.err.courier";
  if (f.code === "delivery-data-unavailable") return "seller.orders.err.delivery";
  if (f.code === "payment-kind-unavailable") return "seller.orders.err.payment";
  if (f.status === 403) return "seller.error.forbidden";
  if (f.status === 404) return "seller.error.notFound";
  if (f.status === 401) return "seller.error.unauthenticated";
  if (f.status === 429) return "seller.error.rate";
  return "error.generic";
};

export interface OrderActionsProps {
  readonly locale: Locale;
  readonly marketId: string;
  readonly orderId: string;
  /** What the server says can happen next; the server still decides when the button is pressed. */
  readonly actions: readonly string[];
  /** Order status; "Cancel order" is offered only from PAID to PACKED (the server still decides). */
  readonly status?: string;
  readonly api?: SellerApi;
}

/**
 * Accept, reject, pack and ship. Every action first asks for confirmation and is never optimistic: the page changes only after the
 * server answered, then the server-rendered page is refreshed.
 */
export function OrderActions({ locale, marketId, orderId, actions, status, api: apiProp }: OrderActionsProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const api = useMemo(() => apiProp ?? createSellerApi(marketId.toLowerCase()), [apiProp, marketId]);
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<RejectReason | "">("");
  const [cancelReason, setCancelReason] = useState<CancelReason | "">("");
  const [note, setNote] = useState("");
  const [weight, setWeight] = useState("");
  const [invalid, setInvalid] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const known: Action[] = [...(["accept", "reject", "pack", "ship"] as const).filter((a) => actions.includes(a)), ...(status !== undefined && CANCELLABLE_STATUS.has(status) ? (["cancel"] as const) : [])];

  const open = (a: Action): void => {
    setPending(a);
    setError(null);
    setInvalid(null);
    setDone(null);
    queueMicrotask(() => confirmRef.current?.querySelector<HTMLElement>("select, input, button")?.focus());
  };

  const run = async (a: Action): Promise<void> => {
    if (a === "reject" && reason === "") {
      setInvalid("seller.orders.reject.required");
      return;
    }
    if (a === "cancel" && cancelReason === "") {
      setInvalid("seller.orders.cancel.required");
      return;
    }
    const grams = /^\d{1,5}$/.test(weight.trim()) ? Number(weight.trim()) : 0;
    if (a === "ship" && (grams < PARCEL_WEIGHT_G.min || grams > PARCEL_WEIGHT_G.max)) {
      setInvalid("seller.orders.ship.weightInvalid");
      return;
    }
    setInvalid(null);
    setBusy(true);
    setError(null);
    const r = a === "accept" ? await api.acceptOrder(orderId) : a === "pack" ? await api.packOrder(orderId) : a === "reject" ? await api.rejectOrder(orderId, reason === "" ? "other" : reason, note.trim()) : a === "cancel" ? await api.cancelOrder(orderId, cancelReason === "" ? "other" : cancelReason) : await api.shipOrder(orderId, grams);
    setBusy(false);
    if (!r.ok) {
      setError(errorKey(r));
      return;
    }
    setPending(null);
    if ("awb" in r.data) {
      setDone(t("seller.orders.result.shipped", { awb: r.data.awb }));
      setLabel(safeHref(r.data.label_url));
    } else {
      const key = DONE[a];
      setDone(key === undefined ? "" : t(key));
    }
    router.refresh();
  };

  return (
    <section className="orderActions" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="panelTitle">
        {t("seller.orders.actions.title")}
      </h2>
      {known.length === 0 && done === null ? <p className="hint">{t("seller.orders.actions.none")}</p> : null}
      {pending === null ? (
        <div className="actionRow">
          {known.map((a) => (
            <button key={a} type="button" className={a === "reject" || a === "cancel" ? "btn btnSecondary" : "btn btnPrimary"} onClick={() => { open(a); }}>
              {t(LABEL[a])}
            </button>
          ))}
        </div>
      ) : (
        <div ref={confirmRef} className="confirmBox" role="group" aria-labelledby={`${id}-c`}>
          <p id={`${id}-c`}>{t(CONFIRM[pending], pending === "accept" ? { hours: DISPATCH_SLA_HOURS } : undefined)}</p>
          {pending === "reject" ? (
            <>
              <div className="field">
                <label htmlFor={`${id}-reason`}>{t("seller.orders.reject.reason")}</label>
                <select id={`${id}-reason`} value={reason} onChange={(e) => { setReason(e.target.value as RejectReason | ""); }} aria-required="true">
                  <option value="">{t("seller.orders.reject.choose")}</option>
                  {REJECT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {t(REASON_KEY[r])}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${id}-note`}>{t("seller.orders.reject.note")}</label>
                <input id={`${id}-note`} type="text" maxLength={500} value={note} onChange={(e) => { setNote(e.target.value); }} />
              </div>
            </>
          ) : null}
          {pending === "cancel" ? (
            <div className="field">
              <label htmlFor={`${id}-creason`}>{t("seller.orders.cancel.reason")}</label>
              <select id={`${id}-creason`} value={cancelReason} onChange={(e) => { setCancelReason(e.target.value as CancelReason | ""); }} aria-required="true">
                <option value="">{t("seller.orders.reject.choose")}</option>
                {CANCEL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(CANCEL_REASON_KEY[r])}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {pending === "ship" ? (
            <div className="field">
              <label htmlFor={`${id}-weight`}>{t("seller.orders.ship.weight")}</label>
              <input id={`${id}-weight`} type="text" inputMode="numeric" maxLength={5} value={weight} onChange={(e) => { setWeight(e.target.value); }} />
            </div>
          ) : null}
          {invalid === null ? null : <p role="alert" className="problems">{t(invalid, invalid === "seller.orders.ship.weightInvalid" ? { min: PARCEL_WEIGHT_G.min, max: PARCEL_WEIGHT_G.max } : undefined)}</p>}
          <div className="actionRow">
            <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => void run(pending)}>
              {busy ? t("seller.orders.confirm.working") : t("seller.orders.confirm.yes")}
            </button>
            <button type="button" className="btn btnGhost" disabled={busy} onClick={() => { setPending(null); setInvalid(null); }}>
              {t("seller.orders.confirm.cancel")}
            </button>
          </div>
        </div>
      )}
      {error === null ? null : <div className="banner" role="alert"><p>{t(error)}</p></div>}
      <div role="status" aria-live="polite">
        {done === null ? null : <p className="resultNote">{done}</p>}
        {label === null ? null : (
          <p>
            <a className="btnLink" href={label} download>
              {t("seller.orders.label.download")}
            </a>
          </p>
        )}
      </div>
    </section>
  );
}
