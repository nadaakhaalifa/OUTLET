"use client";
import { useId, useMemo, useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import { checkChart, requiredFor, type ChartRowDraft } from "../view-models/size-chart";

const TYPES = ["tops", "dresses", "bottoms", "outerwear", "shoes", "kids_tops"] as const;

export function SizeChartEditor({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const uid = useId();
  const [productType, setProductType] = useState<string>("tops");
  const [unit, setUnit] = useState<"cm" | "in">("cm");
  const [rows, setRows] = useState<readonly ChartRowDraft[]>([{ sizeLabel: "S", values: {} }, { sizeLabel: "M", values: {} }]);
  const measures = requiredFor(productType);
  const check = useMemo(() => checkChart({ productType, unit, rows }), [productType, unit, rows]);
  const update = (i: number, patch: Partial<ChartRowDraft>): void => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <section aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>{t("chart.title")}</h3>
      <div className="row">
        <div className="field">
          <label htmlFor={`${uid}-pt`}>{t("chart.productType")}</label>
          <select id={`${uid}-pt`} value={productType} onChange={(e) => setProductType(e.target.value)}>
            {TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-u`}>{t("chart.unit")}</label>
          <select id={`${uid}-u`} value={unit} onChange={(e) => setUnit(e.target.value === "in" ? "in" : "cm")}>
            <option value="cm">cm</option>
            <option value="in">in</option>
          </select>
        </div>
      </div>
      <div className="tablewrap">
        <table>
          <caption className="vh">{t("chart.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("editor.skus")}</th>
              {measures.map((m) => <th key={m} scope="col">{m.replace("_cm", "")} ({unit})</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <label className="vh" htmlFor={`${uid}-r${i}`}>{t("editor.skus")}</label>
                  <input id={`${uid}-r${i}`} value={r.sizeLabel} onChange={(e) => update(i, { sizeLabel: e.target.value })} />
                </td>
                {measures.map((m) => (
                  <td key={m}>
                    <label className="vh" htmlFor={`${uid}-r${i}-${m}`}>{r.sizeLabel} {m}</label>
                    <input
                      id={`${uid}-r${i}-${m}`} inputMode="decimal" dir="ltr" value={r.values[m] ?? ""}
                      aria-invalid={check.issues.some((x) => x.sizeLabel === r.sizeLabel.trim())}
                      onChange={(e) => update(i, { values: { ...r.values, [m]: e.target.value } })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, { sizeLabel: "", values: {} }])}>{t("chart.addRow")}</button>
      <div role="status" aria-live="polite">
        {check.valid ? <p className="hint">{t("chart.valid")}</p> : (
          <ul className="err">
            {check.issues.map((x, i) => <li key={`${x.sizeLabel}-${x.code}-${i}`}>{x.sizeLabel === "" ? "" : `${x.sizeLabel}: `}{t(x.messageKey)}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
