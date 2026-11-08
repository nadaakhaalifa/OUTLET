"use client";
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import type { Locale } from "@outlet/i18n";
import { Button } from "@outlet/ui-web";
import { ApiProblem, browserApi, type ShopperApi } from "../../lib/client-api";
import { isReturnReason, returnReasonLabel } from "../../lib/orders-labels";
import { PHOTO_REASONS, RETURN_REASONS, SIZE_REASONS, type OrderGroup, type OrderLine, type ReturnReason, type ReturnRequest, type ShopperSellerOrder } from "../../lib/wire";
import { Alert, pickName, Status, useShared } from "./shared";

const ACCEPT = "image/jpeg,image/png,image/webp,image/avif";

function Radio({ name, value, checked, label, hint, onChange }: { readonly name: string; readonly value: string; readonly checked: boolean; readonly label: string; readonly hint?: string; readonly onChange: () => void }) {
  return (
    <label className="shopCheck">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span>{label}{hint === undefined ? null : <span className="hint"> · {hint}</span>}</span>
    </label>
  );
}

export interface ReturnFormProps {
  readonly locale: Locale;
  readonly api?: ShopperApi;
  /** `?line=` */
  readonly lineId: string | null;
  /** `?order=`: the order group that holds the line (the contract posts returns per seller order). */
  readonly orderId: string | null;
}

export function ReturnForm({ locale, api = browserApi(), lineId, orderId }: ReturnFormProps) {
  const { t, date, base } = useShared(locale);
  const uid = useId();
  const [order, setOrder] = useState<OrderGroup | null>(null);
  const [state, setState] = useState<"loading" | "out" | "error" | "ready">(lineId !== null && orderId !== null ? "loading" : "ready");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [media, setMedia] = useState<readonly string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState(false);
  const [method, setMethod] = useState<"pickup" | "dropoff">("pickup");
  const [resolution, setResolution] = useState<"refund" | "exchange">("refund");
  const [refundTo, setRefundTo] = useState<"original" | "store_credit">("original");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ReturnRequest | null>(null);

  useEffect(() => {
    if (lineId === null || orderId === null) return;
    let live = true;
    api.getOrderGroup(orderId).then((o) => { if (live) { setOrder(o); setState("ready"); } }, (e: unknown) => { if (live) setState(e instanceof ApiProblem && e.status === 401 ? "out" : "error"); });
    return () => { live = false; };
  }, [api, lineId, orderId]);

  if (lineId === null || orderId === null) return <p className="empty">{t("returns.new.missing")}</p>;
  if (state === "loading") return <p role="status">{t("returns.list.loading")}</p>;
  if (state === "out") return (
    <div className="empty" role="status">
      <p>{t("auth.required")}</p>
      <a className="shopLink" href={`${base}/login?next=${encodeURIComponent(`${base}/returns/new?line=${lineId}&order=${orderId}`)}`}>{t("auth.goLogin")}</a>
    </div>
  );
  if (state === "error" || order === null) return <Alert>{t("returns.new.loadError")}</Alert>;
  const found = order.seller_orders.flatMap((so) => so.lines.map((l): [ShopperSellerOrder, OrderLine] => [so, l])).find(([, l]) => l.id === lineId);
  if (found === undefined) return <Alert>{t("returns.new.loadError")}</Alert>;
  const [so, line] = found;
  if (created !== null) return (
    <div className="shopStack">
      <Status>{t("returns.new.ok")}</Status>
      <a className="shopButton" href={`${base}/returns/${created.id}`}>{t("returns.new.view")}</a>
    </div>
  );
  if (!so.returnable) return <Alert>{t("returns.new.notReturnable")}</Alert>;

  const photosNeeded = reason !== "" && PHOTO_REASONS.includes(reason);
  const sizeReason = reason !== "" && SIZE_REASONS.includes(reason);
  const bnpl = order.payment_method === "bnpl";
  const effectiveResolution = sizeReason ? resolution : "refund";

  function pickReason(v: string): void {
    const next = isReturnReason(v) ? v : "";
    setReason(next);
    // Exchange first for size reasons; everything else is a refund.
    setResolution(next !== "" && SIZE_REASONS.includes(next) ? "exchange" : "refund");
  }
  async function addPhotos(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return;
    setUploading(true); setPhotoError(false);
    try {
      const ids: string[] = [];
      for (const f of Array.from(files)) ids.push(await api.uploadEvidence(f, "return_evidence"));
      setMedia((m) => [...m, ...ids]);
    } catch { setPhotoError(true); } finally { setUploading(false); }
  }
  async function submit(e: SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (reason === "" || (photosNeeded && media.length === 0)) { setError(t("returns.new.error")); return; }
    setBusy(true); setError(null);
    try {
      setCreated(await api.createReturn(so.id, {
        lines: [{ orderLineId: line.id, qty }], reasonCode: reason, method, resolution: effectiveResolution,
        ...(effectiveResolution === "refund" && !bnpl ? { refundPreference: refundTo } : {}), evidenceMediaIds: media,
      }));
    } catch (err) {
      setError(err instanceof ApiProblem && err.type === "return-window-closed" ? t("returns.new.windowClosed") : t("returns.new.error"));
    } finally { setBusy(false); }
  }

  return (
    <form noValidate className="shopForm shopCard" onSubmit={(e) => { void submit(e); }} aria-label={t("returns.new.title")}>
      <p><strong>{t("returns.new.item")}:</strong> {pickName(locale, line.title_ar_snapshot, line.title_en_snapshot)}</p>
      {so.return_window_ends_at === null ? null : <p className="hint">{t("returns.new.window", { date: date(so.return_window_ends_at) })}</p>}
      {line.qty > 1 ? (
        <div className="shopField">
          <label htmlFor={`${uid}-q`}>{t("returns.new.qty")}</label>
          <select id={`${uid}-q`} className="shopSelect" value={qty} onChange={(e) => { setQty(Number(e.target.value)); }}>
            {Array.from({ length: line.qty }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      ) : null}
      <div className="shopField">
        <label htmlFor={`${uid}-r`}>{t("returns.new.reason")}</label>
        <select id={`${uid}-r`} className="shopSelect" value={reason} required onChange={(e) => { pickReason(e.target.value); }}>
          <option value="">{t("returns.new.choose")}</option>
          {RETURN_REASONS.map((r) => <option key={r} value={r}>{returnReasonLabel(t, r)}</option>)}
        </select>
      </div>
      {reason === "" ? null : (
        <fieldset className="shopFieldset">
          <legend>{t("returns.photos.title")}</legend>
          <p className="hint">{photosNeeded ? t("returns.photos.required") : t("returns.photos.optional")}</p>
          <div className="shopField">
            <label htmlFor={`${uid}-p`}>{t("returns.photos.add")}</label>
            <input id={`${uid}-p`} className="shopInput" type="file" accept={ACCEPT} multiple disabled={uploading} aria-required={photosNeeded} onChange={(e) => { void addPhotos(e.target.files); e.target.value = ""; }} />
          </div>
          {uploading ? <Status>{t("returns.photos.uploading")}</Status> : null}
          {media.length > 0 ? <Status>{t("returns.photos.added", { count: media.length })}</Status> : null}
          {photoError ? <Alert>{t("returns.photos.error")}</Alert> : null}
        </fieldset>
      )}
      {sizeReason ? (
        <fieldset className="shopFieldset">
          <legend>{t("returns.resolution.title")}</legend>
          <Radio name={`${uid}-res`} value="exchange" checked={resolution === "exchange"} label={t("returns.resolution.exchange")} hint={t("returns.resolution.exchangeHint")} onChange={() => { setResolution("exchange"); }} />
          <Radio name={`${uid}-res`} value="refund" checked={resolution === "refund"} label={t("returns.resolution.refund")} onChange={() => { setResolution("refund"); }} />
        </fieldset>
      ) : null}
      {reason !== "" && effectiveResolution === "refund" ? (
        <fieldset className="shopFieldset">
          <legend>{t("returns.refund.title")}</legend>
          {bnpl ? <p className="hint">{t("returns.refund.providerOnly")}</p> : (
            <>
              <Radio name={`${uid}-ref`} value="original" checked={refundTo === "original"} label={t("returns.refund.original")} onChange={() => { setRefundTo("original"); }} />
              <Radio name={`${uid}-ref`} value="store_credit" checked={refundTo === "store_credit"} label={t("returns.refund.storeCredit")} onChange={() => { setRefundTo("store_credit"); }} />
            </>
          )}
        </fieldset>
      ) : null}
      <fieldset className="shopFieldset">
        <legend>{t("returns.method.title")}</legend>
        <Radio name={`${uid}-m`} value="pickup" checked={method === "pickup"} label={t("returns.method.pickup")} onChange={() => { setMethod("pickup"); }} />
        <Radio name={`${uid}-m`} value="dropoff" checked={method === "dropoff"} label={t("returns.method.dropoff")} onChange={() => { setMethod("dropoff"); }} />
      </fieldset>
      {error === null ? null : <Alert>{error}</Alert>}
      <Button type="submit" loading={busy} disabled={uploading || reason === ""}>{t("returns.submit")}</Button>
    </form>
  );
}
