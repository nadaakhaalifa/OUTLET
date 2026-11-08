import { createTranslator, type Locale } from "@outlet/i18n";
import { money } from "@outlet/money";
import { ProductCard } from "@outlet/ui-web";
import { conditionOf, parsePriceMinor, type WizardState } from "../../lib/wizard-model";

/** A neutral grey tile (data: URL, allowed by img-src) until the seller adds the main photo. */
const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='3'%3E%3Crect width='4' height='3' fill='%23e6e0d4'/%3E%3C/svg%3E";

/**
 * Exactly what the shopper's ProductCard shows. The seller preview never carries a reference price or a % off:
 * those only exist with Price Watch evidence, which a draft never has.
 */
export function BuyerPreview({ locale, state }: { locale: Locale; state: WizardState }) {
  const t = createTranslator(locale);
  const minor = parsePriceMinor(state.price);
  const photo = state.photos.main?.previewUrl;
  return (
    <aside className="preview" aria-labelledby="preview-title">
      <h2 id="preview-title" className="panelTitle">
        {t("seller.preview.title")}
      </h2>
      {minor === null ? (
        <p className="hint">{t("seller.preview.pricePending")}</p>
      ) : (
        <ProductCard
          locale={locale}
          name={state.name.trim() === "" ? t("seller.preview.name") : state.name.trim()}
          storeName={t("seller.preview.store")}
          href="#preview-title"
          image={{ src: photo ?? PLACEHOLDER, alt: t("seller.preview.photoAlt") }}
          pricing={{ price: money(minor, "EGP"), priceKind: "plain" }}
          condition={conditionOf(state.condition).id}
        />
      )}
    </aside>
  );
}
