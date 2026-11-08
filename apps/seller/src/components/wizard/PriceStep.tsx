import { createTranslator, type Locale } from "@outlet/i18n";
import type { WizardState } from "../../lib/wizard-model";

export function PriceStep({ locale, state, onChange }: { locale: Locale; state: WizardState; onChange: (patch: Partial<WizardState>) => void }) {
  const t = createTranslator(locale);
  return (
    <div className="stepBody">
      <h2 className="panelTitle">{t("seller.price.title")}</h2>
      <div className="row">
        <div className="field">
          <label htmlFor="price">{t("seller.price.selling")}</label>
          <input id="price" type="text" inputMode="decimal" maxLength={12} value={state.price} onChange={(e) => { onChange({ price: e.target.value }); }} aria-describedby="price-note" />
        </div>
        <div className="field">
          <label htmlFor="quantity">
            {t("seller.price.quantity")} ({t("common.optional")})
          </label>
          <input id="quantity" type="text" inputMode="numeric" maxLength={6} value={state.quantity} onChange={(e) => { onChange({ quantity: e.target.value }); }} aria-describedby="qty-note" />
        </div>
      </div>
      <p id="price-note" className="hint">
        {t("seller.price.plain")}
      </p>
      <p id="qty-note" className="hint">
        {t("seller.price.quantityNote")}
      </p>
      <fieldset className="offers">
        <legend className="panelTitle">{t("seller.offers.title")}</legend>
        <label className="check">
          <input type="checkbox" role="switch" checked={state.offersEnabled} onChange={(e) => { onChange({ offersEnabled: e.target.checked }); }} />
          <span>{t("seller.offers.allow")}</span>
        </label>
        <div className="field">
          <label htmlFor="offer-min">{t("seller.offers.minimum")}</label>
          <input id="offer-min" type="text" inputMode="decimal" maxLength={12} disabled={!state.offersEnabled} value={state.offerMinimum} onChange={(e) => { onChange({ offerMinimum: e.target.value }); }} aria-describedby="offer-note" />
        </div>
        <p id="offer-note" className="hint">
          {t("seller.offers.private")} {t("seller.offers.soon")}
        </p>
      </fieldset>
    </div>
  );
}
