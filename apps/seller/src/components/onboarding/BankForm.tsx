import { createTranslator, type Locale } from "@outlet/i18n";

export interface BankFormProps {
  readonly locale: Locale;
  readonly iban: string;
  readonly name: string;
  readonly hasAccount: boolean;
  readonly last4: string | null;
  readonly problem: "iban" | "name" | null;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onChange: (patch: { iban?: string; name?: string }) => void;
  readonly onSave: () => void;
}

/** Step 3: payout IBAN. The server encrypts it and only ever returns the last four characters. */
export function BankForm({ locale, iban, name, hasAccount, last4, problem, busy, disabled, onChange, onSave }: BankFormProps) {
  const t = createTranslator(locale);
  return (
    <form
      className="stepBody"
      noValidate
      aria-labelledby="bank-title"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2 id="bank-title" className="panelTitle">
        {t("seller.kyc.bank.title")}
      </h2>
      <p className="hint">{t("seller.kyc.bank.hint")}</p>
      {hasAccount ? <p className="success" role="status">{last4 === null ? t("seller.kyc.bank.onFile") : t("seller.kyc.bank.onFileLast4", { tail: last4 })}</p> : null}
      <div className="field">
        <label htmlFor="kyc-iban">{t("seller.kyc.bank.iban")}</label>
        <input id="kyc-iban" dir="ltr" autoComplete="off" spellCheck={false} maxLength={42} disabled={disabled} value={iban} onChange={(e) => { onChange({ iban: e.target.value }); }} {...(problem === "iban" ? { "aria-invalid": true, "aria-describedby": "err-iban" } : {})} />
        {problem === "iban" ? <p id="err-iban" className="error">{t("seller.kyc.bank.err.iban")}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="kyc-account-name">{t("seller.kyc.bank.name")}</label>
        <input id="kyc-account-name" autoComplete="off" maxLength={200} disabled={disabled} value={name} onChange={(e) => { onChange({ name: e.target.value }); }} {...(problem === "name" ? { "aria-invalid": true, "aria-describedby": "err-account-name" } : {})} />
        <p className="hint">{t("seller.kyc.bank.name.hint")}</p>
        {problem === "name" ? <p id="err-account-name" className="error">{t("seller.kyc.bank.err.name")}</p> : null}
      </div>
      <div className="footer">
        <button type="submit" className="btn btnSecondary" disabled={disabled || busy}>
          {busy ? t("seller.kyc.bank.saving") : t("seller.kyc.bank.save")}
        </button>
      </div>
    </form>
  );
}
