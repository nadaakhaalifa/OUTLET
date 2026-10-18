"use client";
import { useState } from "react";
import { decideMediaAction } from "../app/actions-media";
import { createTranslator, type Locale } from "../i18n";
import type { MediaRowVM } from "../view-models/product-media";
import { ActionForm } from "./ActionForm";

/**
 * Before/after for one photo. Images come through the same-origin relay (/media/file), never from the storage host,
 * so the strict CSP stays as is and the signed links never reach the browser. The original is always one click away.
 */
export function MediaCompare({ row, storeId, locale }: { row: MediaRowVM; storeId: string; locale: Locale }) {
  const t = createTranslator(locale);
  const [view, setView] = useState<"original" | "cutout">(row.hasCutout ? "cutout" : "original");
  const src = (kind: "original" | "png") => `/media/file?job=${row.id}&kind=${kind}`;
  const hidden = (op: string) => ({ storeId, id: row.id, op });
  const showCutout = row.hasCutout && view === "cutout";
  return (
    <article className="media-card" aria-label={t("media.card")}>
      {row.hasCutout ? (
        <div role="group" aria-label={t("media.toggle")} className="row">
          <button type="button" className="btn" aria-pressed={view === "original"} onClick={() => setView("original")}>{t("media.original")}</button>
          <button type="button" className="btn" aria-pressed={view === "cutout"} onClick={() => setView("cutout")}>{t("media.cutout")}</button>
        </div>
      ) : null}
      <div className={showCutout ? "media-frame checker" : "media-frame"}>
        {row.status === "PENDING" || row.status === "PROCESSING" ? (
          <p role="status" className="hint">{t("media.working")}</p>
        ) : row.status === "FAILED" ? (
          <p className="hint">{t("media.failed")}</p>
        ) : (
          <img src={src(showCutout ? "png" : "original")} alt={t(showCutout ? "media.cutoutAlt" : "media.originalAlt")} width={240} height={300} />
        )}
      </div>
      <p><span className="pill">{t(row.statusKey)}</span> <span className="hint">{t(row.decisionKey)}</span>{row.attached ? <> <span className="pill" data-state="attached">{t("media.attached")}</span></> : null}</p>
      {row.score !== null ? (
        <>
          <p className="hint">{t(row.scoreGood ? "media.scoreGood" : "media.scoreCheck", { score: row.score })}</p>
          <ul>{row.reasonKeys.map((k) => <li key={k} className="hint">{t(k)}</li>)}</ul>
          <p className="hint">{t("media.notPerfect")}</p>
        </>
      ) : null}
      {row.status === "NEEDS_REVIEW" ? <p className="banner" role="note">{t("media.review")}</p> : null}
      {row.status === "FAILED" ? <p className="banner" role="note">{t("media.manual")}</p> : null}
      <div className="row">
        {row.canDecide ? <ActionForm action={decideMediaAction} locale={locale} label={t("media.use")} hidden={hidden("accept")} variant="primary" /> : null}
        {row.canDecide ? <ActionForm action={decideMediaAction} locale={locale} label={t("media.useOriginal")} hidden={hidden("use_original")} /> : null}
        {row.canRerun && row.otherModels.length > 0 ? (
          <ActionForm action={decideMediaAction} locale={locale} label={t("media.tryAnother")} hidden={hidden("rerun")}>
            <label className="vh" htmlFor={`m-${row.id}`}>{t("media.model")}</label>
            <select id={`m-${row.id}`} name="model">
              {row.otherModels.map((m) => <option key={m} value={m}>{t(`media.model.${m}` as const)}</option>)}
            </select>
          </ActionForm>
        ) : null}
      </div>
    </article>
  );
}
