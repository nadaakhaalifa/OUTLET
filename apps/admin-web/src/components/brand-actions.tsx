"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  claimBrandAction, cosignBrandAction, decideBrandAction, releaseBrandAction, resolveBrandConflictAction, trademarkLookupAction,
} from "../server/brand-actions";
import { BRAND_REASON_CODES, CONFLICT_OUTCOMES } from "../api/brand-schemas";
import { validateDecision, validateNote, type DecisionField } from "../view-models/brand-review";
import type { BrandLabels } from "../view-models/brand-labels";
import { BRAND_SHORTCUT_EVENT } from "./brand-shortcuts";

export interface GateView {
  readonly allowed: boolean;
  readonly reason: string | null;
}
export interface ActionsProps {
  readonly applicationId: string;
  /** One fresh Idempotency-Key per action, minted at render: a double submit replays instead of acting twice. */
  readonly idem: Readonly<Record<"claim" | "release" | "decision" | "cosign" | "conflict" | "lookup", string>>;
  readonly gates: Readonly<Record<"claim" | "release" | "approve" | "reject" | "needsInfo" | "cosign" | "lookup" | "resolve", GateView>>;
  readonly labels: BrandLabels;
  readonly candidates: readonly { readonly code: string; readonly kind: string; readonly label: string }[];
  readonly reasonLabels: Readonly<Record<string, string>>;
  readonly approveNeedsCosign: boolean;
  readonly cosignRequestedBy: string | null;
}
type Panel = "claim" | "release" | "approve" | "reject" | "needs_info" | "cosign" | "resolve" | "lookup";

function Submit({ label, danger }: { readonly label: string; readonly danger?: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={danger === true ? "btn danger" : "btn primary"} disabled={pending} aria-busy={pending}>{label}</button>;
}

function Field({ id, label, error, children }: { readonly id: string; readonly label: string; readonly error: string | undefined; readonly children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error === undefined ? null : <p id={`${id}-err`} className="field-error" role="alert">{error}</p>}
    </div>
  );
}

export function BrandActions(p: ActionsProps) {
  const L = p.labels;
  const ref = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [errors, setErrors] = useState<Readonly<Partial<Record<DecisionField | "note", string>>>>({});
  const [reason, setReason] = useState("");
  const [msgAr, setMsgAr] = useState("");
  const [msgEn, setMsgEn] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);

  const gateFor: Readonly<Record<Panel, GateView>> = {
    claim: p.gates.claim, release: p.gates.release, approve: p.gates.approve, reject: p.gates.reject,
    needs_info: p.gates.needsInfo, cosign: p.gates.cosign, resolve: p.gates.resolve, lookup: p.gates.lookup,
  };

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (panel !== null && !d.open) d.showModal();
    if (panel === null && d.open) d.close();
  }, [panel]);

  const openPanel = (next: Panel): void => {
    if (!gateFor[next].allowed) return;
    setErrors({}); setReason(""); setMsgAr(""); setMsgEn(""); setPicked([]);
    setPanel(next);
  };

  useEffect(() => {
    const on = (e: Event): void => {
      const id = e instanceof CustomEvent && typeof e.detail === "string" ? e.detail : "";
      const map: Readonly<Record<string, Panel>> = { claim: "claim", release: "release", approve: "approve", reject: "reject", needs_info: "needs_info" };
      const target = map[id];
      if (target !== undefined) openPanel(target);
    };
    window.addEventListener(BRAND_SHORTCUT_EVENT, on);
    return () => window.removeEventListener(BRAND_SHORTCUT_EVENT, on);
    // openPanel closes over gates which are stable per render of this page.
  }, [p.gates]);

  const msg = (k: string): string => L[k as keyof BrandLabels] ?? k;

  const onDecision = (decision: "approve" | "reject" | "needs_info") => (e: React.FormEvent<HTMLFormElement>): void => {
    const fd = new FormData(e.currentTarget);
    const v = validateDecision({
      decision,
      reasonCode: decision === "approve" ? "ok" : String(fd.get("reason_code") ?? ""),
      messageAr: String(fd.get("message_ar") ?? ""),
      messageEn: String(fd.get("message_en") ?? ""),
      items: fd.getAll("item").map((x) => { const [code = "", kind = ""] = String(x).split("|"); return { code, kind }; }),
      internalNote: String(fd.get("internal_note") ?? ""),
      reapplyAfterDays: String(fd.get("reapply_after_days") ?? ""),
      slug: String(fd.get("slug") ?? ""),
    });
    if (!v.ok) {
      e.preventDefault();
      setErrors(Object.fromEntries(Object.entries(v.errors).map(([k, key]) => [k, msg(key)])));
    }
  };
  const onNote = (e: React.FormEvent<HTMLFormElement>): void => {
    const v = validateNote(String(new FormData(e.currentTarget).get("internal_note") ?? ""));
    if (!v.ok) { e.preventDefault(); setErrors({ note: msg(v.error) }); }
  };
  const errCount = Object.keys(errors).length;
  const summary = errCount === 0 ? null : <p role="alert" className="notice error">{L["brand.errors.summary"].replace("{{n}}", String(errCount))}</p>;
  const hidden = (idem: string) => (
    <>
      <input type="hidden" name="id" value={p.applicationId} />
      <input type="hidden" name="idem" value={idem} />
    </>
  );
  const footer = (label: string, danger?: boolean) => (
    <div className="row end">
      <button type="button" className="btn ghost" onClick={() => setPanel(null)}>{L["common.cancel"]}</button>
      <Submit label={label} {...(danger === undefined ? {} : { danger })} />
    </div>
  );
  const noteField = (required: boolean) => (
    <Field id={`${uid}-note`} label={required ? L["brand.note.label"] : L["brand.note.optional"]} error={errors.note ?? errors.internalNote}>
      <textarea id={`${uid}-note`} name="internal_note" rows={3} maxLength={4000} className="wide" required={required}
        aria-invalid={errors.note !== undefined || errors.internalNote !== undefined} aria-describedby={`${uid}-note-err`} />
    </Field>
  );
  const messages = (
    <>
      <p className="muted">{L["brand.msg.hint"]}</p>
      <Field id={`${uid}-ar`} label={L["brand.msg.ar"]} error={errors.messageAr}>
        <textarea id={`${uid}-ar`} name="message_ar" dir="rtl" lang="ar" rows={3} maxLength={1000} className="wide" required value={msgAr}
          onChange={(e) => setMsgAr(e.target.value)} aria-invalid={errors.messageAr !== undefined} aria-describedby={`${uid}-ar-err`} />
      </Field>
      <Field id={`${uid}-en`} label={L["brand.msg.en"]} error={errors.messageEn}>
        <textarea id={`${uid}-en`} name="message_en" dir="ltr" lang="en" rows={3} maxLength={1000} className="wide" required value={msgEn}
          onChange={(e) => setMsgEn(e.target.value)} aria-invalid={errors.messageEn !== undefined} aria-describedby={`${uid}-en-err`} />
      </Field>
    </>
  );
  const reasonSelect = (
    <Field id={`${uid}-reason`} label={L["brand.reason.label"]} error={errors.reasonCode}>
      <select id={`${uid}-reason`} name="reason_code" required value={reason} onChange={(e) => setReason(e.target.value)}
        aria-invalid={errors.reasonCode !== undefined} aria-describedby={`${uid}-reason-err`}>
        <option value="" disabled>{L["common.choose"]}</option>
        {BRAND_REASON_CODES.filter((c) => c !== "ok").map((c) => <option key={c} value={c}>{p.reasonLabels[c] ?? c}</option>)}
      </select>
    </Field>
  );

  const gateNote = (g: GateView): React.ReactNode => (g.allowed || g.reason === null ? null : <span className="muted gate-note">{g.reason}</span>);
  const btn = (k: Panel, label: string, g: GateView, cls = "btn", key?: string) => (
    <div className="action" key={k}>
      <button type="button" className={cls} disabled={!g.allowed} aria-disabled={!g.allowed} onClick={() => openPanel(k)}>
        {label}{key === undefined ? null : <kbd dir="ltr" aria-hidden="true">{key}</kbd>}
      </button>
      {gateNote(g)}
    </div>
  );

  return (
    <div className="actions" role="group" aria-label={L["brand.act.confirm"]}>
      {btn("claim", L["brand.act.claim"], p.gates.claim, "btn", "c")}
      {btn("release", L["brand.act.release"], p.gates.release, "btn", "l")}
      {btn("lookup", L["brand.act.lookup"], p.gates.lookup)}
      <hr />
      {btn("approve", L["brand.act.approve"], p.gates.approve, "btn primary", "a")}
      {btn("reject", L["brand.act.reject"], p.gates.reject, "btn danger", "x")}
      {btn("needs_info", L["brand.act.needsInfo"], p.gates.needsInfo, "btn", "i")}
      <hr />
      {btn("cosign", L["brand.act.cosign"], p.gates.cosign, "btn primary")}
      {btn("resolve", L["brand.act.resolve"], p.gates.resolve)}

      <dialog ref={ref} className="dialog wide-dialog" aria-labelledby={`${uid}-title`} onClose={() => setPanel(null)}>
        {panel === "claim" ? (
          <form action={claimBrandAction}>
            <h2 id={`${uid}-title`}>{L["brand.act.claim"]}</h2><p>{L["brand.claim.body"]}</p>{hidden(p.idem.claim)}{footer(L["brand.act.claim"])}
          </form>
        ) : null}
        {panel === "release" ? (
          <form action={releaseBrandAction}>
            <h2 id={`${uid}-title`}>{L["brand.act.release"]}</h2><p>{L["brand.release.body"]}</p>{hidden(p.idem.release)}{footer(L["brand.act.release"])}
          </form>
        ) : null}
        {panel === "lookup" ? (
          <form action={trademarkLookupAction}>
            <h2 id={`${uid}-title`}>{L["brand.act.lookup"]}</h2><p>{L["brand.lookup.body"]}</p>{hidden(p.idem.lookup)}{footer(L["brand.act.lookup"])}
          </form>
        ) : null}
        {panel === "approve" ? (
          <form action={decideBrandAction} onSubmit={onDecision("approve")} noValidate>
            <h2 id={`${uid}-title`}>{L["brand.approve.title"]}</h2>
            {summary}
            <ul className="consequences">
              {(p.approveNeedsCosign ? (["brand.approve.cosignFirst", "brand.approve.thenCreates"] as const) : (["brand.approve.createsStore", "brand.approve.createsOwner", "brand.approve.notifies"] as const))
                .map((k) => <li key={k}>{L[k]}</li>)}
            </ul>
            {hidden(p.idem.decision)}
            <input type="hidden" name="decision" value="approve" />
            <input type="hidden" name="reason_code" value="ok" />
            <Field id={`${uid}-slug`} label={L["brand.approve.slug"]} error={errors.slug}>
              <input id={`${uid}-slug`} name="slug" dir="ltr" maxLength={60} aria-invalid={errors.slug !== undefined} aria-describedby={`${uid}-slug-err`} />
            </Field>
            <p className="muted">{L["brand.approve.slugHint"]}</p>
            {noteField(false)}
            {footer(L["brand.act.approve"])}
          </form>
        ) : null}
        {panel === "reject" ? (
          <form action={decideBrandAction} onSubmit={onDecision("reject")} noValidate>
            <h2 id={`${uid}-title`}>{L["brand.reject.title"]}</h2>
            {summary}{hidden(p.idem.decision)}
            <input type="hidden" name="decision" value="reject" />
            {reasonSelect}{messages}
            <Field id={`${uid}-reapply`} label={L["brand.reject.reapply"]} error={errors.reapplyAfterDays}>
              <input id={`${uid}-reapply`} name="reapply_after_days" inputMode="numeric" dir="ltr" maxLength={3} aria-invalid={errors.reapplyAfterDays !== undefined} aria-describedby={`${uid}-reapply-err`} />
            </Field>
            {noteField(false)}
            {footer(L["brand.act.reject"], true)}
          </form>
        ) : null}
        {panel === "needs_info" ? (
          <form action={decideBrandAction} onSubmit={onDecision("needs_info")} noValidate>
            <h2 id={`${uid}-title`}>{L["brand.needsInfo.title"]}</h2>
            {summary}{hidden(p.idem.decision)}
            <input type="hidden" name="decision" value="needs_info" />
            {reasonSelect}
            <fieldset aria-describedby={`${uid}-items-err`}>
              <legend>{L["brand.needsInfo.items"]}</legend>
              <p className="muted">{L["brand.needsInfo.itemsHint"]}</p>
              {p.candidates.map((c) => {
                const v = `${c.code}|${c.kind}`;
                return (
                  <label key={v} className="check">
                    <input type="checkbox" name="item" value={v} checked={picked.includes(v)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, v] : picked.filter((x) => x !== v))} />
                    <span>{c.label}</span>
                  </label>
                );
              })}
              {errors.items === undefined ? null : <p id={`${uid}-items-err`} className="field-error" role="alert">{errors.items}</p>}
            </fieldset>
            {messages}{noteField(false)}
            {footer(L["brand.act.needsInfo"])}
          </form>
        ) : null}
        {panel === "cosign" ? (
          <form action={cosignBrandAction} onSubmit={onNote} noValidate>
            <h2 id={`${uid}-title`}>{L["brand.cosign.title"]}</h2>
            {summary}
            <p>{L["brand.cosign.body"]}</p>
            {p.cosignRequestedBy === null ? null : <p className="muted">{L["brand.cosign.requestedBy"].replace("{{id}}", p.cosignRequestedBy)}</p>}
            <ul className="consequences">{(["brand.approve.createsStore", "brand.approve.createsOwner", "brand.approve.notifies"] as const).map((k) => <li key={k}>{L[k]}</li>)}</ul>
            {hidden(p.idem.cosign)}{noteField(true)}{footer(L["brand.act.cosign"])}
          </form>
        ) : null}
        {panel === "resolve" ? (
          <form action={resolveBrandConflictAction} onSubmit={onNote} noValidate>
            <h2 id={`${uid}-title`}>{L["brand.conflict.title"]}</h2>
            {summary}
            <p>{L["brand.conflict.body"]}</p>
            {hidden(p.idem.conflict)}
            <Field id={`${uid}-outcome`} label={L["brand.conflict.outcome"]} error={undefined}>
              <select id={`${uid}-outcome`} name="outcome" required defaultValue="">
                <option value="" disabled>{L["common.choose"]}</option>
                {CONFLICT_OUTCOMES.map((o) => <option key={o} value={o}>{L[`brand.outcome.${o}`]}</option>)}
              </select>
            </Field>
            {noteField(true)}{footer(L["brand.act.resolve"])}
          </form>
        ) : null}
      </dialog>
    </div>
  );
}
