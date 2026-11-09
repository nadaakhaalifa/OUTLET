import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { DOC_TYPES, MAX_DOCUMENT_MB, docKey, documentPresent, type DocType } from "../../lib/onboarding-model";

export interface DocumentsPanelProps {
  readonly locale: Locale;
  readonly gaps: readonly string[];
  readonly required: readonly DocType[];
  readonly disabled: boolean;
  readonly progress: Partial<Record<DocType, number>>;
  readonly errors: Partial<Record<DocType, MessageKey>>;
  readonly onFile: (type: DocType, file: File) => void;
}

/** Step 2: one PDF per document type. "On file" comes from the server's gap list, never from local guesses. */
export function DocumentsPanel({ locale, gaps, required, disabled, progress, errors, onFile }: DocumentsPanelProps) {
  const t = createTranslator(locale);
  return (
    <section className="stepBody" aria-labelledby="docs-title">
      <h2 id="docs-title" className="panelTitle">
        {t("seller.kyc.docs.title")}
      </h2>
      <p className="hint">{t("seller.kyc.docs.hint", { mb: MAX_DOCUMENT_MB })}</p>
      <ul className="slots">
        {DOC_TYPES.map((d) => {
          const isRequired = required.includes(d);
          const present = isRequired && documentPresent(gaps, d);
          const busy = progress[d] !== undefined;
          const err = errors[d];
          return (
            <li key={d} className="slot" data-filled={present}>
              <h3>{t(docKey(d))}</h3>
              <p className="hint">{isRequired ? t("seller.kyc.docs.required") : t("seller.kyc.docs.optional")}</p>
              <p className="chip" data-tone={isRequired && !present ? "action" : undefined}>
                {isRequired ? (present ? t("seller.kyc.docs.onFile") : t("seller.kyc.docs.missing")) : t("seller.kyc.docs.notRequired")}
              </p>
              {busy ? <progress aria-label={t("seller.kyc.docs.uploading")} max={1} value={progress[d] ?? 0} /> : null}
              {err === undefined ? null : <p className="error" role="alert">{t(err)}</p>}
              <label className="btn btnSecondary" aria-disabled={disabled || busy}>
                <input
                  className="fileInput"
                  type="file"
                  accept="application/pdf"
                  disabled={disabled || busy}
                  aria-label={t("seller.kyc.docs.chooseFor", { doc: t(docKey(d)) })}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f !== undefined) onFile(d, f);
                    e.target.value = "";
                  }}
                />
                <span aria-hidden="true">{present ? t("seller.kyc.docs.replace") : t("seller.kyc.docs.upload")}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
