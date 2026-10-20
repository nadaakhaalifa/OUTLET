import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { createTranslator, type Locale } from "../i18n";
import { Wordmark } from "./Identity";
import { resolveAccess } from "../page-context";
import { getContext } from "../server-context";
import { navForAccess } from "../view-models/nav";

/** Links come from server permissions (store-scoped me) behind the role_nav flag; blocked means all links. The API enforces access. */
export async function Shell({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = createTranslator(locale);
  const access = await resolveAccess((await getContext()).api);
  const items = navForAccess(access);
  const path = (await headers()).get("x-pathname") ?? "";
  const current = (href: string): boolean => path === href || path.startsWith(`${href}/`);
  return (
    <div className="shell">
      <aside className="side">
        <h1 className="brandline">
          <Wordmark height={20} />
          <span className="vh">{t("app.name")}</span>
          <span className="eyebrow" aria-hidden="true">{t("app.product")}</span>
        </h1>
        <nav aria-label={t("common.mainNav")}>
          <ul>
            {items.map((i) => (
              <li key={i.href}>
                <Link href={i.href} aria-current={current(i.href) ? "page" : undefined}>{t(i.labelKey)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {access.kind === "no_access" ? (
          <section role="alert">
            <h2>{t("access.noAccess.title")}</h2>
            <p>{t("access.noAccess.body")}</p>
          </section>
        ) : (
          <>
            {access.kind === "unavailable" ? <p role="status">{t("access.unavailable")}</p> : null}
            {access.kind === "granted" && access.storeStatus === "suspended" ? <p role="status">{t("access.suspended")}</p> : null}
            {children}
          </>
        )}
      </main>
    </div>
  );
}
