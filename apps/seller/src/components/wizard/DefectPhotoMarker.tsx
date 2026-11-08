import { createTranslator, type Locale } from "@outlet/i18n";

/** "Mark defect on photo": click the close-up (or type the position); x/y are stored as percentages of the photo. */
export function DefectPhotoMarker(props: { locale: Locale; src: string | undefined; x: number | null; y: number | null; onChange: (x: number | null, y: number | null) => void }) {
  const t = createTranslator(props.locale);
  const { x, y, onChange } = props;
  const clamp = (v: number): number => Math.min(100, Math.max(0, Math.round(v)));
  const num = (raw: string): number | null => (raw.trim() === "" || Number.isNaN(Number(raw)) ? null : clamp(Number(raw)));
  return (
    <fieldset className="marker">
      <legend>{t("seller.condition.mark")}</legend>
      <p className="hint">{t("seller.condition.markHint")}</p>
      {props.src === undefined ? null : (
        <div className="markerWrap">
          <img src={props.src} alt={t("seller.condition.markPhoto")} className="markerImg" />
          <svg className="markerSvg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {x !== null && y !== null ? <circle cx={x} cy={y} r="4" className="markerDot" /> : null}
          </svg>
          <button
            type="button"
            className="markerHit"
            aria-label={t("seller.condition.markPhoto")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return;
              onChange(clamp(((e.clientX - r.left) / r.width) * 100), clamp(((e.clientY - r.top) / r.height) * 100));
            }}
          />
        </div>
      )}
      <div className="row">
        <label className="fieldInline">
          <span>{t("seller.condition.markX")}</span>
          <input type="number" inputMode="numeric" min={0} max={100} value={x ?? ""} onChange={(e) => { onChange(num(e.target.value), y ?? (e.target.value === "" ? null : 50)); }} />
        </label>
        <label className="fieldInline">
          <span>{t("seller.condition.markY")}</span>
          <input type="number" inputMode="numeric" min={0} max={100} value={y ?? ""} onChange={(e) => { onChange(x ?? (e.target.value === "" ? null : 50), num(e.target.value)); }} />
        </label>
      </div>
      {x !== null && y !== null ? (
        <p role="status" className="hint">
          {t("seller.condition.markSet", { x, y })}
        </p>
      ) : null}
    </fieldset>
  );
}
