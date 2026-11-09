import { createTranslator, type Locale } from "@outlet/i18n";
import { governorateKey, type IdentityForm } from "../../lib/onboarding-model";

/** What the shopper sees on every listing (CPL 181/2018: supplier identity). Only what the seller typed; nothing is invented. */
export function LegalIdentityPreview({ locale, identity }: { locale: Locale; identity: IdentityForm | null }) {
  const t = createTranslator(locale);
  const pending = <span className="hint">{t("seller.kyc.preview.pending")}</span>;
  const val = (v: string): React.ReactNode => (v.trim() === "" ? pending : v.trim());
  return (
    <aside className="preview identityCard" aria-labelledby="identity-preview-title">
      <h2 id="identity-preview-title" className="panelTitle">
        {t("seller.kyc.preview.title")}
      </h2>
      <p className="hint">{t("seller.kyc.preview.note")}</p>
      {identity === null ? (
        <p className="hint">{t("seller.kyc.preview.unavailable")}</p>
      ) : (
        <dl className="facts">
          <div className="factRow">
            <dt>{t("seller.kyc.preview.name")}</dt>
            <dd>{val(identity.nameAr)}</dd>
          </div>
          <div className="factRow">
            <dt>{t("seller.kyc.preview.register")}</dt>
            <dd>{val(identity.register)}</dd>
          </div>
          <div className="factRow">
            <dt>{t("seller.kyc.preview.tax")}</dt>
            <dd>{val(identity.tax)}</dd>
          </div>
          <div className="factRow">
            <dt>{t("seller.kyc.preview.governorate")}</dt>
            <dd>{identity.governorate === "" ? pending : t(governorateKey(identity.governorate))}</dd>
          </div>
        </dl>
      )}
    </aside>
  );
}
