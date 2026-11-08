import { createTranslator, type Locale } from "@outlet/i18n";

/**
 * Placeholder tiles. Purely structural: no names, prices or images. Sized by CSS classes, not style attributes,
 * because the CSP forbids inline style attributes (ui-web's Skeleton sets inline-size/block-size inline).
 */
export function SkeletonGrid({ locale, count }: { locale: Locale; count: number }) {
  const t = createTranslator(locale);
  return (
    <div className="grid" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" role="status">
          <span className="srOnly">{t("state.loading")}</span>
        </div>
      ))}
    </div>
  );
}
