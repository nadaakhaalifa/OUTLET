import { CsvChecker } from "../../../components/CsvChecker";
import { pageCtx } from "../../../page-context";

export default async function ImportPage() {
  const { t, locale } = await pageCtx();
  return (
    <section aria-labelledby="imp-h">
      <h2 id="imp-h">{t("import.title")}</h2>
      <p className="hint">{t("import.body")}</p>
      <CsvChecker locale={locale} />
    </section>
  );
}
