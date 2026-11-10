"use client";

import { useId } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

/**
 * Incident form stub. It deliberately never submits: the incident API is not connected yet, and the copy says so.
 * The submit button is aria-disabled (not removed) so the reason stays reachable by keyboard and screen reader.
 */
export function BreachStubForm({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const id = useId();
  return (
    <form className="stepForm stub" onSubmit={(e) => { e.preventDefault(); }} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="panelTitle">{t("admin.dpo.breach.form.title")}</h3>
      <p className="banner" role="note">{t("admin.dpo.breach.form.stub")}</p>
      <label className="field"><span>{t("admin.dpo.breach.form.summary")}</span><textarea rows={3} /></label>
      <label className="field">
        <span>{t("admin.dpo.breach.form.severity")}</span>
        <select defaultValue="medium">{SEVERITIES.map((s) => (<option key={s} value={s}>{t(`admin.dpo.breach.severity.${s}` as MessageKey)}</option>))}</select>
      </label>
      <label className="field"><span>{t("admin.dpo.breach.form.categories")}</span><input /></label>
      <label className="field"><span>{t("admin.dpo.breach.form.estimate")}</span><input type="number" min={0} inputMode="numeric" /></label>
      <button type="submit" className="btn btnPrimary" aria-disabled="true" aria-describedby={`${id}-n`}>{t("admin.dpo.breach.form.submit")}</button>
      <span id={`${id}-n`} className="srOnly">{t("admin.dpo.breach.form.stub")}</span>
    </form>
  );
}
