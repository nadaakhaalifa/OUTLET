import Link from "next/link";
import type { ReactNode } from "react";
import { createTranslator, type Locale } from "../i18n";
import { navFor } from "../view-models/nav";

/** Role is not exposed by the API yet (no seller "me"), so all links are listed; the API enforces access. */
export function Shell({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = createTranslator(locale);
  const items = navFor(null);
  return (
    <div className="shell">
      <aside className="side">
        <h1>{t("app.name")}</h1>
        <nav aria-label={t("common.mainNav")}>
          <ul>
            {items.map((i) => (
              <li key={i.href}>
                <Link href={i.href}>{t(i.labelKey)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
