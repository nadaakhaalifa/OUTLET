import { createTranslator, type Locale } from "@outlet/i18n";
import { checklistFrom } from "../../lib/wizard-model";

/** "Ready to continue": every row comes from the server's activation reasons, never from client guesses. */
export function ReadinessChecklist({ locale, reasons }: { locale: Locale; reasons: readonly string[] | null }) {
  const t = createTranslator(locale);
  return (
    <section className="checklist" aria-labelledby="ready-title">
      <h2 id="ready-title" className="panelTitle">
        {t("seller.ready.title")}
      </h2>
      <ul>
        {checklistFrom(reasons).map((row) => (
          <li key={row.id} data-done={row.done}>
            <span aria-hidden="true">{row.done ? "✓" : "○"}</span> {t(row.labelKey)}
            <span className="srOnly"> — {row.done ? t("seller.ready.done") : t("seller.ready.todo")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
