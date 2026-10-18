"use client";
import { useActionState, useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import type { FormOut } from "../app/actions-onboarding";
import { createTranslator, type Locale } from "../i18n";

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "textarea" | "select" | "checkbox" | "checks" | "datetime-local" | "tel" | "email" | "number";
  readonly value?: string;
  readonly checked?: boolean;
  readonly values?: readonly string[];
  readonly hint?: string;
  readonly options?: readonly { readonly value: string; readonly label: string; readonly locked?: boolean }[];
  readonly dir?: "ltr" | "auto";
  readonly inputMode?: "text" | "numeric" | "tel" | "email" | "decimal";
  readonly autoComplete?: string;
  readonly maxLength?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

type Action = (prev: FormOut | null, form: FormData) => Promise<FormOut>;

/**
 * Data-driven form bound to a server action. Field errors come back from the server (which re-validates with the same
 * pure view-model rules), are linked to inputs with aria-describedby and summarised in a role=alert block.
 * A per-form Idempotency-Key makes an accidental double submit a replay; it rotates after a successful save.
 */
export function DynamicForm({
  action, fields, hidden = {}, submitLabel, locale, variant = "primary", nextPath, disabled = false,
}: {
  action: Action;
  fields: readonly FieldSpec[];
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  locale: Locale;
  variant?: "primary" | "danger" | "quiet";
  nextPath?: string;
  disabled?: boolean;
}) {
  const t = createTranslator(locale);
  const uid = useId();
  const [state, run, actionPending] = useActionState(action, null);
  const [transitioning, startTransition] = useTransition();
  const pending = actionPending || transitioning;
  const [idem, setIdem] = useState<string>("");
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIdem(crypto.randomUUID());
  }, []);
  useEffect(() => {
    if (state?.ok === true) setIdem(crypto.randomUUID());
    if (state !== null && !state.ok) summaryRef.current?.focus();
  }, [state]);

  const errors = state !== null && !state.ok ? state.fieldErrors ?? {} : {};
  const errorEntries = Object.entries(errors);
  const idFor = (n: string): string => `${uid}-${n}`;
  // onSubmit (not <form action>) so React does not reset the inputs after a failed save.
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => run(data));
  };

  return (
    <form onSubmit={onSubmit} className="zm-form" noValidate>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input type="hidden" name="idem" value={idem} />
      {state !== null && !state.ok ? (
        <div role="alert" tabIndex={-1} ref={summaryRef} className="zm-alert">
          <p>{t(state.messageKey)}</p>
          {errorEntries.length > 0 ? (
            <ul>
              {errorEntries.map(([n, k]) => <li key={n}><a href={`#${idFor(n)}`}>{fields.find((f) => f.name === n)?.label ?? n}</a>: {t(k)}</li>)}
            </ul>
          ) : null}
          {state.unauthorized === true ? <p><a className="zm-link" href="/login">{t("ob.auth.signIn")}</a></p> : null}
          {state.stepUp === true ? <p><a className="zm-link" href={`/login?stepup=1&next=${encodeURIComponent(nextPath ?? "/start")}`}>{t("ob.stepup.cta")}</a></p> : null}
        </div>
      ) : null}
      {state?.ok === true && state.messageKey !== undefined ? <p role="status" className="zm-ok">{t(state.messageKey)}</p> : null}
      {fields.map((f) => {
        const id = idFor(f.name);
        const err = errors[f.name];
        const described = [f.hint === undefined ? null : `${id}-hint`, err === undefined ? null : `${id}-err`].filter((x): x is string => x !== null).join(" ") || undefined;
        if (f.type === "checkbox") {
          return (
            <div className="zm-check" key={f.name}>
              <input id={id} type="checkbox" name={f.name} defaultChecked={f.checked === true} disabled={f.disabled === true} aria-describedby={described} aria-invalid={err !== undefined} />
              <label htmlFor={id}>{f.label}</label>
              {f.hint === undefined ? null : <p id={`${id}-hint`} className="zm-hint">{f.hint}</p>}
              {err === undefined ? null : <p id={`${id}-err`} className="zm-err">{t(err)}</p>}
            </div>
          );
        }
        if (f.type === "checks") {
          return (
            <fieldset className="zm-fieldset" key={f.name} aria-describedby={described} id={id}>
              <legend>{f.label}</legend>
              {(f.options ?? []).map((o) => {
                const oid = `${id}-${o.value}`;
                const on = o.locked === true || (f.values ?? []).includes(o.value);
                return (
                  <div className="zm-check" key={o.value}>
                    <input id={oid} type="checkbox" name={f.name} value={o.value} defaultChecked={on} disabled={o.locked === true} />
                    <label htmlFor={oid}>{o.label}</label>
                    {o.locked === true ? <input type="hidden" name={f.name} value={o.value} /> : null}
                  </div>
                );
              })}
              {f.hint === undefined ? null : <p id={`${id}-hint`} className="zm-hint">{f.hint}</p>}
              {err === undefined ? null : <p id={`${id}-err`} className="zm-err">{t(err)}</p>}
            </fieldset>
          );
        }
        return (
          <div className="zm-field" key={f.name}>
            <label htmlFor={id}>{f.label}{f.required === true ? <span aria-hidden="true"> *</span> : null}</label>
            {f.type === "textarea" ? (
              <textarea id={id} name={f.name} defaultValue={f.value ?? ""} rows={4} maxLength={f.maxLength} dir={f.dir ?? "auto"} required={f.required} aria-required={f.required} aria-invalid={err !== undefined} aria-describedby={described} disabled={f.disabled === true} />
            ) : f.type === "select" ? (
              <select id={id} name={f.name} defaultValue={f.value ?? ""} required={f.required} aria-required={f.required} aria-invalid={err !== undefined} aria-describedby={described} disabled={f.disabled === true}>
                <option value="">{t("ob.form.choose")}</option>
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                id={id} name={f.name} type={f.type} defaultValue={f.value ?? ""} maxLength={f.maxLength}
                inputMode={f.inputMode} autoComplete={f.autoComplete ?? "off"} dir={f.dir ?? "auto"}
                required={f.required} aria-required={f.required} aria-invalid={err !== undefined} aria-describedby={described} disabled={f.disabled === true}
              />
            )}
            {f.hint === undefined ? null : <p id={`${id}-hint`} className="zm-hint">{f.hint}</p>}
            {err === undefined ? null : <p id={`${id}-err`} className="zm-err">{t(err)}</p>}
          </div>
        );
      })}
      <div className="zm-actions">
        <button type="submit" className={`zm-btn ${variant}`} disabled={pending || disabled} aria-busy={pending}>{pending ? t("ob.form.saving") : submitLabel}</button>
      </div>
    </form>
  );
}
