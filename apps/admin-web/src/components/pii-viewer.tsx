"use client";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { viewPiiAction, type PiiActionState } from "../server/actions";
import { PII_REVEAL_TTL_MS } from "../view-models/pii";

export interface PiiViewerProps {
  readonly labels: {
    readonly open: string; readonly title: string; readonly subject: string; readonly fields: string; readonly reason: string;
    readonly choose: string; readonly submit: string; readonly cancel: string; readonly hideNow: string; readonly autoHides: string;
    readonly error: string | null;
  };
  readonly fieldOptions: readonly { readonly value: string; readonly label: string }[];
  readonly reasons: readonly { readonly code: string; readonly label: string }[];
  readonly errorMessages: Readonly<Record<string, string>>;
}

const initial: PiiActionState = { status: "idle", fields: {}, errorKey: null, revealedAtMs: null };

/** Reason-coded PII view. Revealed values vanish after PII_REVEAL_TTL_MS or on demand. */
export function PiiViewer(p: PiiViewerProps) {
  const [state, formAction] = useActionState(viewPiiAction, initial);
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const subjectId = useId();
  const reasonId = useId();
  const revealedAt = state.revealedAtMs;

  useEffect(() => {
    if (revealedAt === null) return undefined;
    const timer = setTimeout(() => setHiddenAt(revealedAt), PII_REVEAL_TTL_MS);
    return () => clearTimeout(timer);
  }, [revealedAt]);

  useEffect(() => {
    if (state.status !== "idle") ref.current?.close();
  }, [state]);

  const visible = state.status === "ok" && revealedAt !== null && hiddenAt !== revealedAt;
  return (
    <section>
      <button type="button" className="btn primary" onClick={() => ref.current?.showModal()}>{p.labels.open}</button>
      <dialog ref={ref} className="dialog" aria-label={p.labels.title}>
        <form action={formAction}>
          <h2>{p.labels.title}</h2>
          <label htmlFor={subjectId}>{p.labels.subject}</label>
          <input id={subjectId} name="subject_user_id" required inputMode="text" autoComplete="off" pattern="[0-9a-fA-F-]{36}" dir="ltr" />
          <fieldset>
            <legend>{p.labels.fields}</legend>
            {p.fieldOptions.map((f) => (
              <label key={f.value} className="check">
                <input type="checkbox" name="fields" value={f.value} /> {f.label}
              </label>
            ))}
          </fieldset>
          <label htmlFor={reasonId}>{p.labels.reason}</label>
          <select id={reasonId} name="reason_code" required defaultValue="">
            <option value="" disabled>{p.labels.choose}</option>
            {p.reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>{p.labels.cancel}</button>
            <button type="submit" className="btn primary">{p.labels.submit}</button>
          </div>
        </form>
      </dialog>
      {state.status === "error" && state.errorKey !== null ? (
        <p role="alert" className="notice error">{p.errorMessages[state.errorKey] ?? p.labels.error ?? ""}</p>
      ) : null}
      {visible ? (
        <div className="card" aria-live="polite">
          <dl>
            {Object.entries(state.fields).map(([k, v]) => (
              <div key={k} className="kv"><dt>{p.fieldOptions.find((f) => f.value === k)?.label ?? k}</dt><dd dir="auto">{v}</dd></div>
            ))}
          </dl>
          <p className="muted">{p.labels.autoHides}</p>
          <button type="button" className="btn" onClick={() => setHiddenAt(revealedAt)}>{p.labels.hideNow}</button>
        </div>
      ) : null}
    </section>
  );
}
