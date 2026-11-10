"use client";
import { useRouter } from "next/navigation";
import { createTranslator, type Locale } from "@outlet/i18n";

/** Active store for X-Store-Id. The options come from the sign-in flow (cookie); with one store it is just a label. */
export function StoreSwitcher({ locale, stores, active }: { locale: Locale; stores: readonly string[]; active: string }) {
  const router = useRouter();
  const t = createTranslator(locale);
  if (stores.length === 0) return <p className="storeNone">{t("seller.store.none")}</p>;
  return (
    <div className="storeSwitcher">
      <label htmlFor="store-switcher">{t("seller.store.label")}</label>
      <select
        id="store-switcher"
        value={active}
        onChange={(e) => {
          document.cookie = `seller_store=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
      >
        {stores.map((id, i) => (
          <option key={id} value={id}>
            {t("seller.store.option", { n: i + 1 })}
          </option>
        ))}
      </select>
    </div>
  );
}
