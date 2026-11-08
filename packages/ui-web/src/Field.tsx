import { useId, type InputHTMLAttributes } from "react";
import { useI18n } from "./i18n-context.js";
import type { Locale } from "@outlet/i18n";
import s from "./Field.module.css";

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  /** Already-translated visible label. Required: placeholders are not labels. */
  readonly label: string;
  readonly hint?: string;
  /** Already-translated error message; sets aria-invalid. */
  readonly error?: string;
  readonly locale?: Locale;
}

export function Field({ label, hint, error, locale, required, ...rest }: FieldProps) {
  const { t } = useI18n(locale);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={s["field"]}>
      <label htmlFor={id} className={s["label"]}>
        {label}
        {required ? null : <span className={s["optional"]}> ({t("common.optional")})</span>}
      </label>
      <input {...rest} id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={s["input"]} />
      {hint ? <p id={hintId} className={s["hint"]}>{hint}</p> : null}
      {error ? <p id={errorId} role="alert" className={s["error"]}>{error}</p> : null}
    </div>
  );
}
