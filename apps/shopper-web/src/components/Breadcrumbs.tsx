import Link from "next/link";
import { createTranslator, type Locale } from "../i18n";

export function Breadcrumbs({ locale, items }: { locale: Locale; items: readonly { label: string; href?: string }[] }) {
  const t = createTranslator(locale);
  return (
    <nav className="crumbs" aria-label={t("common.breadcrumb")}>
      <ol>
        {items.map((it, i) => (
          <li key={i}>{it.href === undefined ? <span aria-current="page">{it.label}</span> : <Link href={it.href}>{it.label}</Link>}</li>
        ))}
      </ol>
    </nav>
  );
}
