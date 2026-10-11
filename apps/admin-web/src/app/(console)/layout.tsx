import Link from "next/link";
import type { ReactNode } from "react";
import { setLocaleAction, signOutAction } from "../../server/actions";
import { getConsole } from "../../server/console";
import { navFor } from "../../view-models/nav";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const c = await getConsole();
  const items = navFor(c.roles);
  const other = c.locale === "ar" ? "en" : "ar";
  return (
    <>
      <a className="skip" href="#main">{c.t("common.skipToContent")}</a>
      <div className="shell">
        <nav className="side" aria-label={c.t("common.mainNav")}>
          <h2>{c.t("app.name")}</h2>
          <ul>
            {items.map((i) => (
              <li key={i.id}><Link href={i.href}>{c.t(i.labelKey)}</Link></li>
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
