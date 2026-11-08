import Link from "next/link";
import { createTranslator, type Locale } from "@outlet/i18n";
import { reasonKey, stepForReason, type StepId } from "../../lib/wizard-model";

export interface ReviewStepProps {
  readonly locale: Locale;
  readonly hasDraft: boolean;
  readonly reasons: readonly string[] | null;
  readonly published: boolean;
  readonly listHref: string;
  readonly onFix: (step: StepId) => void;
}

export function ReviewStep({ locale, hasDraft, reasons, published, listHref, onFix }: ReviewStepProps) {
  const t = createTranslator(locale);
  return (
    <div className="stepBody">
      <h2 className="panelTitle">{t("seller.review.title")}</h2>
      {published ? (
        <p role="status" className="success">
          {t("seller.review.published")} <Link href={listHref}>{t("seller.review.viewList")}</Link>
        </p>
      ) : !hasDraft || reasons === null ? (
        <p className="hint">{t("seller.review.needDraft")}</p>
      ) : reasons.length === 0 ? (
        <p role="status" className="success">
          {t("seller.review.ok")}
        </p>
      ) : (
        <div role="alert" className="blocked">
          <p>{t("seller.review.blocked")}</p>
          <ul>
            {reasons.map((code) => (
              <li key={code} data-reason={code}>
                {t(reasonKey(code))}{" "}
                <button type="button" className="btn btnGhost" onClick={() => { onFix(stepForReason(code)); }}>
                  {t("seller.review.fix")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
