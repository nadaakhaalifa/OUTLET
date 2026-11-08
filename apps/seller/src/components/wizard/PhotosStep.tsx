import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import type { AttributeSetWire, CategoryWire } from "../../client/seller-api";
import { ACCEPTED_TYPES, CONDITION_OPTIONS, MAX_NOTES, MAX_UPLOAD_MB, conditionOf, needsDefectCard, type Slot, type WizardState } from "../../lib/wizard-model";
import { DefectPhotoMarker } from "./DefectPhotoMarker";

const SLOT_KEY: Readonly<Record<Slot, MessageKey>> = {
  main: "seller.photos.slot.main",
  defect: "seller.photos.slot.defect",
  packaging: "seller.photos.slot.packaging",
};

export interface PhotosStepProps {
  readonly locale: Locale;
  readonly state: WizardState;
  readonly categories: readonly CategoryWire[];
  readonly attributeSet: AttributeSetWire | null;
  readonly progress: Readonly<Partial<Record<Slot, number>>>;
  readonly photoError: Readonly<Partial<Record<Slot, MessageKey>>>;
  readonly onChange: (patch: Partial<WizardState>) => void;
  readonly onFile: (slot: Slot, file: File) => void;
  readonly onRemove: (slot: Slot) => void;
}

export function PhotosStep(p: PhotosStepProps) {
  const t = createTranslator(p.locale);
  const { state } = p;
  const grade = conditionOf(state.condition).grade;
  const slots: Slot[] = needsDefectCard(grade) ? ["main", "defect", "packaging"] : ["main", "packaging"];
  return (
    <div className="stepBody">
      <section aria-labelledby="photos-title">
        <h2 id="photos-title" className="panelTitle">
          {t("seller.photos.title")}
        </h2>
        <p className="hint">{t("seller.photos.hint")}</p>
        <p className="hint">{t("seller.photos.formats", { formats: "JPG, PNG, HEIC", mb: MAX_UPLOAD_MB })}</p>
        <div className="field">
          <label htmlFor="category">{t("seller.details.category")}</label>
          <select id="category" value={state.categoryId} onChange={(e) => { p.onChange({ categoryId: e.target.value, attributes: {} }); }}>
            <option value="">{t("seller.details.categoryPlaceholder")}</option>
            {p.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {`${"— ".repeat(c.depth)}${c.name}`}
              </option>
            ))}
          </select>
        </div>
        <ul className="slots">
          {slots.map((slot) => {
            const photo = state.photos[slot];
            const progress = p.progress[slot];
            const err = p.photoError[slot];
            const inputId = `file-${slot}`;
            return (
              <li key={slot} className="slot" data-filled={photo !== undefined}>
                <h3>{t(SLOT_KEY[slot])}</h3>
                {photo?.previewUrl !== undefined ? <img className="slotImg" src={photo.previewUrl} alt={t("seller.photos.preview", { slot: t(SLOT_KEY[slot]) })} /> : null}
                {photo !== undefined && photo.previewUrl === undefined ? <p className="hint">{t("seller.photos.saved")}</p> : null}
                {progress === undefined ? null : (
                  <p>
                    <progress value={Math.round(progress * 100)} max={100} aria-label={t("seller.photos.uploading", { slot: t(SLOT_KEY[slot]) })} />
                  </p>
                )}
                {err === undefined ? null : (
                  <p role="alert" className="error">
                    {t(err)}
                  </p>
                )}
                <input
                  id={inputId}
                  className="fileInput"
                  type="file"
                  accept={ACCEPTED_TYPES.join(",")}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f !== undefined) p.onFile(slot, f);
                  }}
                />
                <label htmlFor={inputId} className="btn btnSecondary">
                  {photo === undefined ? t("seller.photos.choose") : t("seller.photos.replace")}
                </label>
                {photo === undefined ? null : (
                  <button type="button" className="btn btnGhost" onClick={() => { p.onRemove(slot); }}>
                    {t("seller.photos.remove")}
                  </button>
                )}
              </li>
            );
          })}
          <li className="slot">
            <h3>{t("seller.photos.video")}</h3>
            <button type="button" className="btn btnSecondary" disabled aria-describedby="video-soon">
              {t("seller.photos.video")}
            </button>
            <p id="video-soon" className="hint">
              {t("seller.details.soon")}
            </p>
          </li>
        </ul>
      </section>

      <fieldset className="conditions">
        <legend className="panelTitle">{t("seller.condition.title")}</legend>
        <p className="hint">{t("seller.condition.group")}</p>
        <div className="radios" role="radiogroup">
          {CONDITION_OPTIONS.map((o) => (
            <label key={o.id} className="radio">
              <input type="radio" name="condition" value={o.id} checked={state.condition === o.id} onChange={() => { p.onChange({ condition: o.id }); }} />
              <span>{t(o.labelKey)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {needsDefectCard(grade) ? (
        <section aria-labelledby="defects-title" className="defects">
          <h2 id="defects-title" className="panelTitle">
            {t("seller.condition.defectsTitle")}
          </h2>
          <div className="field">
            <label htmlFor="defect-type">{t("seller.condition.type")}</label>
            <select id="defect-type" value={state.defect.typeCode} onChange={(e) => { p.onChange({ defect: { ...state.defect, typeCode: e.target.value } }); }}>
              <option value="">{t("seller.condition.typePlaceholder")}</option>
              {(p.attributeSet?.defect_types ?? []).map((d) => (
                <option key={d.code} value={d.code}>
                  {p.locale === "en-EG" && d.label_en !== null ? d.label_en : d.label_ar}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="defect-location">{t("seller.condition.location")}</label>
            <input id="defect-location" type="text" maxLength={120} value={state.defect.location} onChange={(e) => { p.onChange({ defect: { ...state.defect, location: e.target.value } }); }} />
          </div>
          <div className="field">
            <label htmlFor="defect-severity">{t("seller.condition.severity")}</label>
            <select id="defect-severity" value={state.defect.severity} onChange={(e) => { p.onChange({ defect: { ...state.defect, severity: e.target.value === "major" ? "major" : "minor" } }); }}>
              <option value="minor">{t("seller.condition.severity.minor")}</option>
              <option value="major">{t("seller.condition.severity.major")}</option>
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={!state.defect.affectsFunction} onChange={(e) => { p.onChange({ defect: { ...state.defect, affectsFunction: !e.target.checked } }); }} />
            <span>{t("seller.condition.affectsNo")}</span>
          </label>
          <div className="field">
            <label htmlFor="notes">{t("seller.condition.notes")}</label>
            <textarea id="notes" rows={4} maxLength={MAX_NOTES} value={state.notes} onChange={(e) => { p.onChange({ notes: e.target.value }); }} aria-describedby="notes-count" />
            <p id="notes-count" className="hint">
              {t("seller.condition.notesCount", { count: state.notes.length, max: MAX_NOTES })}
            </p>
          </div>
          <DefectPhotoMarker
            locale={p.locale}
            src={state.photos.defect?.previewUrl}
            x={state.defect.xPct}
            y={state.defect.yPct}
            onChange={(x, y) => { p.onChange({ defect: { ...state.defect, xPct: x, yPct: y } }); }}
          />
        </section>
      ) : (
        <p className="hint">{t("seller.condition.none")}</p>
      )}
    </div>
  );
}
