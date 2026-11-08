import { money } from "@outlet/money";
import type { Locale } from "@outlet/i18n";
import { Button, DefectCard, Field, FreeDeliveryProgress, LocaleProvider, LocaleSwitch, PriceBlock, ProductCard } from "../src/index.js";

const NAME = "NOVA";
const evidence = { claimAllowed: true, reference: money(200_000n, "EGP"), evidenceIds: ["ev-1"], lowestIn30Days: true } as const;

/** Tiny gallery of every component, used by the axe tests and as a manual visual check. */
export function Gallery({ locale, onLocale }: { locale: Locale; onLocale: (l: Locale) => void }) {
  return (
    <LocaleProvider locale={locale}>
      <main>
        <LocaleSwitch onChange={onLocale} />
        <PriceBlock price={money(80_000n, "EGP")} verified={evidence} />
        <PriceBlock price={money(80_000n, "EGP")} priceKind="launch" />
        <FreeDeliveryProgress subtotal={money(195_000n, "EGP")} threshold={money(200_000n, "EGP")} storeName={NAME} />
        <ProductCard
          name={NAME} storeName={NAME} href="/p/1" image={{ src: "/a.avif", alt: `${NAME} storefront` }}
          pricing={{ price: money(80_000n, "EGP"), verified: evidence }} condition="openBox" onQuickAdd={() => undefined}
        />
        <DefectCard grade="B" photos={[{ src: "/d.avif", alt: NAME }]} description={NAME} passportUrl="/passport/1" />
        <Field label={NAME} hint={NAME} />
        <Button>{NAME}</Button>
      </main>
    </LocaleProvider>
  );
}
