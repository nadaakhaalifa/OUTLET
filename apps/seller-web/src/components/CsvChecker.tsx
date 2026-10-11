"use client";
import { useId, useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import { checkCatalogCsv, MAX_IMPORT_ROWS, type ImportCheck } from "../view-models/csv-import";

/** Reads the chosen file in the browser and shows the row error report. Nothing is uploaded from here. */
export function CsvChecker({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const id = useId();
  const [result, setResult] = useState<ImportCheck | null>(null);
  return (
    <section>
      <div className="field">
        <label htmlFor={id}>{t("import.file")}</label>
        <input
          id={id} type="file" accept=".csv,text/csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setResult(f === undefined ? null : checkCatalogCsv(await f.text()));
          }}
        />
      </div>
      <div role="status" aria-live="polite">
        {result === null ? null : (
          <>
            <p>{t("import.rowsOk", { count: result.rowsOk })}</p>
            <p className={result.rowsFailed > 0 ? "err" : "hint"}>{t("import.rowsFailed", { count: result.rowsFailed })}</p>
            {result.errors.length === 0 ? null : (
              <div className="tablewrap">
                <table>
                  <caption>{t("import.title")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("import.col.row")}</th>
                      <th scope="col">{t("import.col.column")}</th>
                      <th scope="col">{t("import.col.problem")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.slice(0, 200).map((e, i) => (
                      <tr key={i}>
                        <td>{e.row === 0 ? "-" : e.row}</td>
                        <td dir="ltr">{e.column ?? "-"}</td>
                        <td>{t(e.messageKey, { max: MAX_IMPORT_ROWS })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
