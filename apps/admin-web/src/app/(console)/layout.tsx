import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { setLocaleAction, signOutAction } from "../../server/actions";
import { getConsole } from "../../server/console";
import { Wordmark } from "../../components/identity-mark";
import { navFor } from "../../view-models/nav";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const c = await getConsole();
  const items = navFor(c.roles);
  const path = (await headers()).get("x-pathname") ?? "";
  const here = (href: string): boolean => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  const other = c.locale === "ar" ? "en" : "ar";
  return (
    <>
      <a className="skip" href="#main">{c.t("common.skipToContent")}</a>
      <div className="shell">
        <nav className="side" aria-label={c.t("common.mainNav")}>
          <p className="brandline">
            <Wordmark height={20} />
            <span className="sr-only">{c.t("app.name")}</span>
            <span className="eyebrow" aria-hidden="true">{c.t("app.product")}</span>
          </p>
          <ul>
            {items.map((i) => (
              <li key={i.id}><Link href={i.href} aria-current={here(i.href) ? "page" : undefined}>{c.t(i.labelKey)}</Link></li>
            ))}
          </ul>
        </nav>
        <main id="main">
          <div className="topbar">
            <form action={setLocaleAction}>
              <input type="hidden" name="locale" value={other} />
              <input type="hidden" name="back" value="/" />
              <button className="btn ghost" type="submit">{c.t("common.language")}</button>
            </form>
            <form action={signOutAction}><button className="btn ghost" type="submit">{c.t("common.signOut")}</button></form>
          </div>
          {!c.configured ? <p role="alert" className="notice error">{c.t("state.notConfigured")}</p> : null}
          {c.roles === null ? <p className="notice">{c.t("nav.rolesUnknown")}</p> : null}
          {c.posture.bannerKey === null ? null : <p role="status" className="notice error">{c.t(c.posture.bannerKey)}</p>}
          {children}
        </main>
      </div>
    </>
  );
}
