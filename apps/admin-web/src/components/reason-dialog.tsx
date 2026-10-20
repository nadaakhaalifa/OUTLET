"use client";
import { useId, useRef, type ReactNode } from "react";

export interface ReasonOption {
  readonly code: string;
  readonly label: string;
}

export interface ReasonDialogProps {
  readonly triggerLabel: string;
  readonly title: string;
  readonly description?: string;
  readonly reasonLabel: string;
  readonly choosePlaceholder: string;
  readonly submitLabel: string;
  readonly cancelLabel: string;
  readonly reasons: readonly ReasonOption[];
  readonly action: (form: FormData) => void | Promise<void>;
  readonly hidden: Readonly<Record<string, string>>;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}

/**
 * Mandatory reason-code dialog. The reason is a required <select> of the enumerated codes: there is no free text
 * path, so it cannot be skipped or forged. The server action re-validates with the same enum.
 */
export function ReasonDialog(p: ReasonDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const selectId = useId();
  return (
    <>
      <button type="button" className={p.danger === true ? "btn danger" : "btn"} disabled={p.disabled === true} onClick={() => ref.current?.showModal()}>
        {p.triggerLabel}
      </button>
      <dialog ref={ref} aria-labelledby={titleId} className="dialog">
        <form action={p.action}>
          <h2 id={titleId}>{p.title}</h2>
          {p.description === undefined ? null : <p className="muted">{p.description}</p>}
          {Object.entries(p.hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {p.children}
          <label htmlFor={selectId}>{p.reasonLabel}</label>
          <select id={selectId} name="reason_code" required defaultValue="">
            <option value="" disabled>{p.choosePlaceholder}</option>
            {p.reasons.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>{p.cancelLabel}</button>
            <button type="submit" className={p.danger === true ? "btn danger" : "btn primary"}>{p.submitLabel}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
