"use client";
import { useId, useMemo, useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "../i18n";
import { validateProduct, type FormError, type ProductDraft, type SkuDraft } from "../view-models/product-form";
import type { Condition, Department } from "../api/schemas";
import { createProductAction } from "../app/actions";

const CONDITIONS: readonly Condition[] = ["new_with_tags", "new_without_tags", "sample", "minor_defect"];
const DEPARTMENTS: readonly Department[] = ["women", "men", "kids", "unisex"];
const emptySku: SkuDraft = { sizeLabel: "", price: "", stock: "0" };

/**
 * Product form with live, field-level validation. Photo upload needs an upload endpoint that the API contract
 * does not have yet, so photo ids are not collectable here and a minor-defect product cannot be submitted.
 */
export function ProductEditor({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const uid = useId();
  const [draft, setDraft] = useState<ProductDraft>({
    titleAr: "", titleEn: "", descriptionAr: "", categoryId: "", condition: "new_with_tags", department: "unisex",
    defectPhotoUploadIds: [], imageUploadIds: [], sizeChartId: "", skus: [emptySku],
  });
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const result = useMemo(() => validateProduct(draft), [draft]);
  const errs = submitted ? result.errors : [];
  const errFor = (f: FormError["field"]): FormError | undefined => errs.find((e) => e.field === f);
  const set = <K extends keyof ProductDraft>(k: K, v: ProductDraft[K]): void => setDraft((d) => ({ ...d, [k]: v }));
  const setSku = (i: number, patch: Partial<SkuDraft>): void =>
    setDraft((d) => ({ ...d, skus: d.skus.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  const field = (id: string, label: string, error: FormError | undefined, input: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => React.ReactNode) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {input({ id, "aria-invalid": error !== undefined, ...(error === undefined ? {} : { "aria-describedby": `${id}-err` }) })}
      {error === undefined ? null : <p id={`${id}-err`} className="err" role="alert">{t(error.messageKey)}</p>}
    </div>
  );

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitted(true);
        setServerError(null);
        if (result.body === null) return;
        setPending(true);
        const r = await createProductAction(draft);
        setPending(false);
        if (r.ok) setSaved(true);
        else setServerError(r.messageKey);
      }}
    >
      {submitted && result.errors.length > 0 ? (
        <div role="alert" className="banner error" tabIndex={-1}>
          <ul>{result.errors.map((e, i) => <li key={`${e.field}-${i}`}>{t(e.messageKey)}</li>)}</ul>
        </div>
      ) : null}
      {field(`${uid}-tar`, t("editor.titleAr"), errFor("titleAr"), (p) => (
        <input {...p} dir="rtl" lang="ar" required value={draft.titleAr} onChange={(e) => set("titleAr", e.target.value)} />
      ))}
      {field(`${uid}-ten`, t("editor.titleEn"), undefined, (p) => (
        <input {...p} dir="ltr" lang="en" value={draft.titleEn} onChange={(e) => set("titleEn", e.target.value)} />
      ))}
      {field(`${uid}-dar`, t("editor.descAr"), errFor("descriptionAr"), (p) => (
        <textarea {...p} dir="rtl" lang="ar" required rows={4} value={draft.descriptionAr} onChange={(e) => set("descriptionAr", e.target.value)} />
      ))}
      {field(`${uid}-cat`, t("editor.category"), errFor("categoryId"), (p) => (
        <input {...p} dir="ltr" required value={draft.categoryId} onChange={(e) => set("categoryId", e.target.value.trim())} />
      ))}
      {field(`${uid}-cond`, t("editor.condition"), undefined, (p) => (
        <select {...p} value={draft.condition} onChange={(e) => set("condition", e.target.value as Condition)}>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>{t(`editor.condition.${c}`)}</option>
          ))}
        </select>
      ))}
      {field(`${uid}-dept`, t("editor.department"), undefined, (p) => (
        <select {...p} value={draft.department ?? "unisex"} onChange={(e) => set("department", e.target.value as Department)}>
          {DEPARTMENTS.map((d) => (
            <option key={d} value={d}>{t(`editor.department.${d}`)}</option>
          ))}
        </select>
      ))}
      {draft.condition === "minor_defect" ? (
        <p id={`${uid}-defect`} className={errFor("defectPhotos") === undefined ? "hint" : "err"} role={errFor("defectPhotos") === undefined ? undefined : "alert"}>
          {t("editor.defectPhotos")}: {t("editor.error.defectPhotosRequired")}
        </p>
      ) : null}
      <fieldset className="card">
        <legend>{t("editor.skus")}</legend>
        {draft.skus.map((s, i) => (
          <div className="row" key={i}>
            {field(`${uid}-s${i}l`, t("editor.skus"), errFor(`sku.${i}.sizeLabel`), (p) => (
              <input {...p} value={s.sizeLabel} onChange={(e) => setSku(i, { sizeLabel: e.target.value })} />
            ))}
            {field(`${uid}-s${i}p`, t("catalog.col.price"), errFor(`sku.${i}.price`), (p) => (
              <input {...p} inputMode="decimal" dir="ltr" value={s.price} onChange={(e) => setSku(i, { price: e.target.value })} />
            ))}
            {field(`${uid}-s${i}s`, t("catalog.col.stock"), errFor(`sku.${i}.stock`), (p) => (
              <input {...p} inputMode="numeric" dir="ltr" value={s.stock} onChange={(e) => setSku(i, { stock: e.target.value })} />
            ))}
          </div>
        ))}
        {errFor("skus") === undefined ? null : <p className="err" role="alert">{t("editor.error.noSkus")}</p>}
        <button type="button" className="btn" onClick={() => setDraft((d) => ({ ...d, skus: [...d.skus, emptySku] }))}>
          {t("chart.addRow")}
        </button>
        <p className="hint">{t("editor.priceNote")}</p>
      </fieldset>
      <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>{t("common.save")}</button>
      {serverError === null ? null : <p role="alert" className="err">{t(serverError)}</p>}
      {saved ? <p role="status">{t("common.save")} ✓</p> : null}
    </form>
  );
}
