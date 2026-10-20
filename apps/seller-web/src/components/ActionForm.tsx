"use client";
import { useActionState, type ReactNode } from "react";
import type { ActionResult } from "../app/actions";
import { createTranslator, type Locale } from "../i18n";

type Action = (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;

/** One-button server-action form with an announced error. `hidden` carries ids/values. */
export function ActionForm({
  action, locale, label, hidden, variant = "default", children,
}: {
  action: Action;
  locale: Locale;
  label: string;
  hidden: Readonly<Record<string, string>>;
  variant?: "default" | "primary" | "danger";
  children?: ReactNode;
}) {
  const [state, run, pending] = useActionState(action, null);
  const t = createTranslator(locale);
  return (
    <form action={run} className="row">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {children}
      <button type="submit" className={`btn ${variant === "default" ? "" : variant}`} disabled={pending} aria-busy={pending}>
        {label}
      </button>
      {state !== null && !state.ok ? (
        <span role="alert" className="err">{t(state.messageKey)}</span>
      ) : null}
    </form>
  );
}
