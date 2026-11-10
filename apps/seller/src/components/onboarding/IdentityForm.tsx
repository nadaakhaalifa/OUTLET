import { createTranslator, type Locale } from "@outlet/i18n";
import { GOVERNORATES, SIGNATORY_MIN_AGE, governorateKey, type GovernorateCode, type IdentityForm as Form, type IdentityProblem } from "../../lib/onboarding-model";

const PROBLEM_KEYS = {
  nameAr: "seller.kyc.err.nameAr",
  register: "seller.kyc.err.register",
  tax: "seller.kyc.err.tax",
  governorate: "seller.kyc.err.governorate",
  signatory: "seller.kyc.err.signatory",
} as const;

export interface IdentityFormProps {
  readonly locale: Locale;
  readonly value: Form;
  readonly problems: readonly IdentityProblem[];
  readonly busy: boolean;
  readonly onChange: (patch: Partial<Form>) => void;
  readonly onSubmit: () => void;
}

/** Step 1: create the application (legal identity). Legal identity cannot be edited after this on the served API. */
export function IdentityForm({ locale, value, problems, busy, onChange, onSubmit }: IdentityFormProps) {
  const t = createTranslator(locale);
  const bad = (p: IdentityProblem): { "aria-invalid"?: true; "aria-describedby"?: string } => (problems.includes(p) ? { "aria-invalid": true, "aria-describedby": `err-${p}` } : {});
  const err = (p: IdentityProblem) => (problems.includes(p) ? <p id={`err-${p}`} className="error">{t(PROBLEM_KEYS[p])}</p> : null);
  return (
    <form
      className="stepBody"
      noValidate
      aria-labelledby="identity-title"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 id="identity-title" className="panelTitle">
        {t("seller.kyc.identity.title")}
      </h2>
      <p className="hint">{t("seller.kyc.identity.lock")}</p>
      <fieldset className="conditions">
        <legend>{t("seller.kyc.legalType")}</legend>
        <div className="radios">
          {(["company", "sole_trader"] as const).map((k) => (
            <label key={k} className="radio">
              <input type="radio" name="legal-type" checked={value.legalType === k} onChange={() => { onChange({ legalType: k }); }} />
              {t(k === "company" ? "seller.kyc.legalType.company" : "seller.kyc.legalType.sole_trader")}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="kyc-name-ar">{t("seller.kyc.nameAr")}</label>
        <input id="kyc-name-ar" dir="rtl" lang="ar" autoComplete="organization" maxLength={200} value={value.nameAr} onChange={(e) => { onChange({ nameAr: e.target.value }); }} {...bad("nameAr")} />
        {err("nameAr")}
      </div>
      <div className="field">
        <label htmlFor="kyc-name-en">{t("seller.kyc.nameEn")}</label>
        <input id="kyc-name-en" dir="ltr" lang="en" maxLength={200} value={value.nameEn} onChange={(e) => { onChange({ nameEn: e.target.value }); }} />
        <p className="hint">{t("seller.kyc.optional")}</p>
      </div>
      <div className="field">
        <label htmlFor="kyc-register">{t("seller.kyc.register")}</label>
        <input id="kyc-register" dir="ltr" inputMode="numeric" maxLength={200} value={value.register} onChange={(e) => { onChange({ register: e.target.value }); }} {...bad("register")} />
        {err("register")}
      </div>
      <div className="field">
        <label htmlFor="kyc-tax">{t("seller.kyc.tax")}</label>
        <input id="kyc-tax" dir="ltr" inputMode="numeric" maxLength={200} value={value.tax} onChange={(e) => { onChange({ tax: e.target.value }); }} {...bad("tax")} />
        {err("tax")}
      </div>
      <div className="field">
        <label htmlFor="kyc-gov">{t("seller.kyc.governorate")}</label>
        <select id="kyc-gov" value={value.governorate} onChange={(e) => { onChange({ governorate: e.target.value as "" | GovernorateCode }); }} {...bad("governorate")}>
          <option value="">{t("seller.kyc.governorate.placeholder")}</option>
          {GOVERNORATES.map((g) => (
            <option key={g} value={g}>
              {t(governorateKey(g))}
            </option>
          ))}
        </select>
        {err("governorate")}
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={value.signatoryOk} onChange={(e) => { onChange({ signatoryOk: e.target.checked }); }} {...bad("signatory")} />
          {t("seller.kyc.signatory", { age: SIGNATORY_MIN_AGE })}
        </label>
        <p className="hint">{t("seller.kyc.signatory.note", { age: SIGNATORY_MIN_AGE })}</p>
        {err("signatory")}
      </div>
      <div className="footer">
        <button type="submit" className="btn btnPrimary" disabled={busy}>
          {busy ? t("seller.kyc.creating") : t("seller.kyc.create")}
        </button>
      </div>
    </form>
  );
}
