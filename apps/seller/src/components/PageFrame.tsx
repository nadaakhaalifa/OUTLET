import type { ReactNode } from "react";
import { createTranslator, localeSegment, type ResolvedLocale } from "@outlet/i18n";
import { Sidebar } from "./Sidebar";

/** Sidebar + main landmark shared by every Seller Center page. */
export function PageFrame({ resolved, current, children }: { resolved: ResolvedLocale; current: string; children: ReactNode }) {
  const t = createTranslator(resolved.locale);
  return (
    <>
      <Sidebar t={t} base={`/${localeSegment(resolved.marketId, resolved.locale)}`} current={current} />
      <main id="content" className="content" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
