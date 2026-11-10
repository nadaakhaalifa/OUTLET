import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import type { AttributeSetWire } from "../../client/seller-api";
import type { SizeRow, WizardState } from "../../lib/wizard-model";

const ATTR_KEYS: Readonly<Record<string, MessageKey>> = {
  colour: "seller.attr.colour",
  material: "seller.attr.material",
  fit: "seller.attr.fit",
  sleeve_length: "seller.attr.sleeve_length",
  season: "seller.attr.season",
  coverage: "seller.attr.coverage",
  age_group: "seller.attr.age_group",
  drawstring_free: "seller.attr.drawstring_free",
  care_notes_ar: "seller.attr.care_notes_ar",
  size_run: "seller.attr.size_run",
};

export interface DetailsStepProps {
  readonly locale: Locale;
  readonly state: WizardState;
  readonly attributeSet: AttributeSetWire | null;
  readonly onChange: (patch: Partial<WizardState>) => void;
}

export function DetailsStep({ locale, state, attributeSet, onChange }: DetailsStepProps) {
  const t = createTranslator(locale);
  const setSize = (i: number, patch: Partial<SizeRow>): void => { onChange({ sizes: state.sizes.map((r, j) => (j === i ? { ...r, ...patch } : r)) }); };
  return (
    <div className="stepBody">
      <h2 className="panelTitle">{t("seller.details.title")}</h2>
      <div className="field">
        <label htmlFor="name">{t("seller.details.name")}</label>
        <div className="withActions">
          <input id="name" type="text" maxLength={200} value={state.name} onChange={(e) => { onChange({ name: e.target.value }); }} aria-describedby="name-hint" />
          <button type="button" className="btn btnSecondary" disabled aria-describedby="scan-soon">
            {t("seller.details.scan")}
          </button>
          <button type="button" className="btn btnSecondary" disabled aria-describedby="scan-soon">
            {t("seller.details.voice")}
          </button>
        </div>
        <p id="name-hint" className="hint">
          {t("seller.details.nameHint")}
        </p>
        <p id="scan-soon" className="hint">
          {t("seller.details.soon")}
        </p>
      </div>
      <div className="field">
        <label htmlFor="description">{t("seller.details.description")}</label>
        <textarea id="description" rows={4} maxLength={5000} value={state.description} onChange={(e) => { onChange({ description: e.target.value }); }} />
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="warranty">
            {t("seller.details.warranty")} ({t("common.optional")})
          </label>
          <input id="warranty" type="text" inputMode="numeric" maxLength={3} value={state.warrantyMonths} onChange={(e) => { onChange({ warrantyMonths: e.target.value }); }} />
        </div>
        <div className="field">
          <label htmlFor="warranty-kind">{t("seller.details.warrantyKind")}</label>
          <select id="warranty-kind" value={state.warrantyKind} onChange={(e) => { onChange({ warrantyKind: e.target.value === "brand" ? "brand" : e.target.value === "none" ? "none" : "seller" }); }}>
            <option value="seller">{t("seller.details.warrantyKind.seller")}</option>
            <option value="brand">{t("seller.details.warrantyKind.brand")}</option>
            <option value="none">{t("seller.details.warrantyKind.none")}</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="accessories">
          {t("seller.details.accessories")} ({t("common.optional")})
        </label>
        <input id="accessories" type="text" maxLength={500} value={state.accessories} onChange={(e) => { onChange({ accessories: e.target.value }); }} />
      </div>
      <p className="hint">{t("seller.details.separate")}</p>

      <section aria-labelledby="attrs-title">
        <h3 id="attrs-title" className="panelTitle">
          {t("seller.details.attributes")}
        </h3>
        {attributeSet === null ? <p className="hint">{t("seller.details.attributesLoading")}</p> : null}
        {(attributeSet?.attributes ?? []).map((a) => {
          const label = `${t(ATTR_KEYS[a.code] ?? "seller.details.attributes")}${a.required ? "" : ` (${t("common.optional")})`}`;
          const id = `attr-${a.code}`;
          if (a.data_type === "size_run") {
            return (
              <fieldset key={a.code} className="sizes">
                <legend>{label}</legend>
                {state.sizes.map((r, i) => (
                  <div className="row" key={i}>
                    <label className="fieldInline">
                      <span>{t("seller.size.label")}</span>
                      <input type="text" maxLength={8} value={r.label} onChange={(e) => { setSize(i, { label: e.target.value }); }} />
                    </label>
                    <label className="fieldInline">
                      <span>{t("seller.size.cm")}</span>
                      <input type="text" inputMode="decimal" maxLength={5} value={r.cm} onChange={(e) => { setSize(i, { cm: e.target.value }); }} />
                    </label>
                    {state.sizes.length > 1 ? (
                      <button type="button" className="btn btnGhost" onClick={() => { onChange({ sizes: state.sizes.filter((_, j) => j !== i) }); }}>
                        {t("seller.size.remove")}
                      </button>
                    ) : null}
                  </div>
                ))}
                <button type="button" className="btn btnSecondary" onClick={() => { onChange({ sizes: [...state.sizes, { label: "", cm: "" }] }); }}>
                  {t("seller.size.add")}
                </button>
              </fieldset>
            );
          }
          if (a.data_type === "enum") {
            return (
              <div className="field" key={a.code}>
                <label htmlFor={id}>{label}</label>
                <select id={id} value={state.attributes[a.code] ?? ""} onChange={(e) => { onChange({ attributes: { ...state.attributes, [a.code]: e.target.value } }); }} required={a.required}>
                  <option value="">{t("seller.details.choose")}</option>
                  {a.options.map((o) => (
                    <option key={o.code} value={o.code}>
                      {locale === "en-EG" && o.label_en !== null ? o.label_en : o.label_ar}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          if (a.data_type === "boolean") {
            return (
              <div className="field" key={a.code}>
                <label htmlFor={id}>{label}</label>
                <select id={id} value={state.attributes[a.code] ?? ""} onChange={(e) => { onChange({ attributes: { ...state.attributes, [a.code]: e.target.value } }); }} required={a.required}>
                  <option value="">{t("seller.details.choose")}</option>
                  <option value="true">{t("seller.boolean.yes")}</option>
                  <option value="false">{t("seller.boolean.no")}</option>
                </select>
              </div>
            );
          }
          return (
            <div className="field" key={a.code}>
              <label htmlFor={id}>{label}</label>
              <input id={id} type="text" value={state.attributes[a.code] ?? ""} onChange={(e) => { onChange({ attributes: { ...state.attributes, [a.code]: e.target.value } }); }} required={a.required} />
            </div>
          );
        })}
      </section>
    </div>
  );
}
