"use client";
import { useActionState, useId } from "react";
import { acceptOrderAction, createShipmentAction, packOrderAction, rejectOrderAction, type ActionResult } from "../app/actions";
import { createTranslator, type Locale } from "../i18n";
import type { OrderAction } from "../view-models/orders";
import { ActionForm } from "./ActionForm";

const REASONS = ["out_of_stock", "pricing_error", "cannot_fulfil", "other"] as const;

function RejectForm({ id, locale }: { id: string; locale: Locale }) {
  const t = createTranslator(locale);
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(rejectOrderAction, null);
  const sel = useId();
  return (
    <form action={run} className="row">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={sel} className="vh">{t("orders.rejectReason")}</label>
      <select id={sel} name="reason" defaultValue="out_of_stock" className="btn">
        {REASONS.map((r) => (
          <option key={r} value={r}>{t(`orders.reason.${r}`)}</option>
        ))}
      </select>
      <button type="submit" className="btn danger" disabled={pending}>{t("orders.reject")}</button>
      {state !== null && !state.ok ? <span role="alert" className="err">{t(state.messageKey)}</span> : null}
    </form>
  );
}

function ShipmentForm({ id, locale }: { id: string; locale: Locale }) {
  const t = createTranslator(locale);
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(createShipmentAction, null);
  return (
    <form action={run} className="row">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn primary" disabled={pending}>{t("orders.createShipment")}</button>
      {state !== null && !state.ok ? <span role="alert" className="err">{t(state.messageKey)}</span> : null}
      {state?.ok === true && state.shipmentId !== undefined ? (
        <a className="btn" href={`/orders/label/${encodeURIComponent(state.shipmentId)}`}>{t("orders.label")}</a>
      ) : null}
    </form>
  );
}

export function OrderActions({ id, actions, locale }: { id: string; actions: readonly OrderAction[]; locale: Locale }) {
  const t = createTranslator(locale);
  return (
    <div className="row">
      {actions.includes("accept") ? <ActionForm action={acceptOrderAction} locale={locale} label={t("orders.accept")} hidden={{ id }} variant="primary" /> : null}
      {actions.includes("reject") ? <RejectForm id={id} locale={locale} /> : null}
      {actions.includes("pack") ? <ActionForm action={packOrderAction} locale={locale} label={t("orders.pack")} hidden={{ id }} variant="primary" /> : null}
      {actions.includes("create_shipment") ? <ShipmentForm id={id} locale={locale} /> : null}
    </div>
  );
}
