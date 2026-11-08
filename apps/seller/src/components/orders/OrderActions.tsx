"use client";
import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { createSellerApi, REJECT_REASONS, type ApiFailure, type RejectReason, type SellerApi } from "../../client/seller-api";
import { safeHref } from "../../lib/sla";
import { DISPATCH_SLA_HOURS, PARCEL_WEIGHT_G } from "../../lib/policy-limits";

type Action = "accept" | "reject" | "pack" | "ship";
const LABEL: Readonly<Record<Action, MessageKey>> = { accept: "seller.orders.action.accept", reject: "seller.orders.action.reject", pack: "seller.orders.action.pack", ship: "seller.orders.action.ship" };
const CONFIRM: Readonly<Record<Action, MessageKey>> = { accept: "seller.orders.confirm.accept", reject: "seller.orders.confirm.reject", pack: "seller.orders.confirm.pack", ship: "seller.orders.confirm.ship" };
const DONE: Readonly<Partial<Record<Action, MessageKey>>> = { accept: "seller.orders.result.accepted", reject: "seller.orders.result.rejected", pack: "seller.orders.result.packed" };
const REASON_KEY: Readonly<Record<RejectReason, MessageKey>> = {
  out_of_stock: "seller.orders.reject.out_of_stock", damaged: "seller.orders.reject.damaged", pricing_error: "seller.orders.reject.pricing_error", other: "seller.orders.reject.other",
};

const errorKey = (f: ApiFailure): MessageKey => {
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
  readonly api?: SellerApi;
}

/**
 * Accept, reject, pack and ship. Every action first asks for confirmation and is never optimistic: the page changes only after the
 * server answered, then the server-rendered page is refreshed.
 */
export function OrderActions({ locale, marketId, orderId, actions, api: apiProp }: OrderActionsProps) {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const api = useMemo(() => apiProp ?? createSellerApi(marketId.toLowerCase()), [apiProp, marketId]);
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<RejectReason | "">("");
  const [note, setNote] = useState("");
  const [weight, setWeight] = useState("");
  const [invalid, setInvalid] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const known = (["accept", "reject", "pack", "ship"] as const).filter((a) => actions.includes(a));

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
    const grams = /^\d{1,5}$/.test(weight.trim()) ? Number(weight.trim()) : 0;
    if (a === "ship" && (grams < PARCEL_WEIGHT_G.min || grams > PARCEL_WEIGHT_G.max)) {
      setInvalid("seller.orders.ship.weightInvalid");
      return;
    }
    setInvalid(null);
    setBusy(true);
    setError(null);
    const r = a === "accept" ? await api.acceptOrder(orderId) : a === "pack" ? await api.packOrder(orderId) : a === "reject" ? await api.rejectOrder(orderId, reason === "" ? "other" : reason, note.trim()) : await api.shipOrder(orderId, grams);
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
            <button key={a} type="button" className={a === "reject" ? "btn btnSecondary" : "btn btnPrimary"} onClick={() => { open(a); }}>
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
