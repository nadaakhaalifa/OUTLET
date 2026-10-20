import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { readApiBaseUrl } from "../../api/config";
import { getConsole } from "../../server/console";
import { NavSections } from "../../components/nav-sections";
import { PhoneMenu } from "../../components/phone-menu";
import { ShellControls } from "../../components/shell-controls";
import { Wordmark } from "../../components/identity-mark";
import type { MessageKey } from "../../i18n";
import { safeBackPath } from "../../lib/back-path";
import { parseTheme, THEME_COOKIE } from "../../lib/theme";
import type { Role } from "../../view-models/common";
import { breadcrumbFor, isSyntheticEnvironment, navSectionsFor, roleChip } from "../../view-models/nav";

const ROLE_KEYS: Readonly<Record<Role, MessageKey>> = {
  ops: "role.ops", finance: "role.finance", trust_safety: "role.trust_safety", support: "role.support",
  marketing: "role.marketing", dpo: "role.dpo", security: "role.security", super_admin: "role.super_admin",
};

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const c = await getConsole();
  const sections = navSectionsFor(c.roles);
  const h = await headers();
  const path = h.get("x-pathname") ?? "";
  const back = safeBackPath(`${path}${h.get("x-search") ?? ""}`);
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const crumb = breadcrumbFor(sections, path);
  const labels = (c.roles ?? []).map((r) => c.t(ROLE_KEYS[r]));
  const chip = roleChip(labels);
  const roleText = chip === null ? c.t("common.roleNone") : labels.join(" · ");
  const synthetic = isSyntheticEnvironment(readApiBaseUrl(process.env));
  const brand = (
    <p className="brandline">
      <Wordmark height={20} />
      <span className="sr-only">{c.t("app.name")}</span>
      <span className="eyebrow" aria-hidden="true">{c.t("app.product")}</span>
    </p>
  );
  return (
    <>
      <a className="skip" href="#main">{c.t("common.skipToContent")}</a>
      <div className="shell">
        <nav className="side" aria-label={c.t("common.mainNav")}>
          <div className="side-inner">
            {brand}
            <NavSections sections={sections} path={path} t={c.t} idPrefix="nav-side" />
          </div>
        </nav>
        <main id="main">
          <div className="topbar">
            <PhoneMenu label={c.t("nav.menu")}>
              <nav className="menu-panel" aria-label={c.t("common.mainNav")}>
                <NavSections sections={sections} path={path} t={c.t} idPrefix="nav-menu" />
                <div className="menu-foot">
                  <p className="who"><span className="muted">{c.t("common.signedInAs")}</span> <span>{roleText}</span></p>
                  <ShellControls t={c.t} locale={c.locale} theme={theme} back={back} />
                </div>
              </nav>
            </PhoneMenu>
            {crumb === null ? null : (
              <nav className="crumbs" aria-label={c.t("shell.breadcrumb")}>
                <ol>
                  <li>{c.t(crumb.groupKey)}</li>
                  <li aria-current="page">{c.t(crumb.itemKey)}</li>
                </ol>
              </nav>
            )}
            {synthetic ? <span className="badge warn env">{c.t("shell.envSynthetic")}</span> : null}
            <div className="who">
              <span className="muted">{c.t("common.signedInAs")}</span>
              {chip === null ? <span>{roleText}</span> : (
                <details className="rolechip">
                  <summary className="badge" aria-label={c.t("shell.roleChipLabel", { list: labels.join(", ") })}>
                    {chip.more === 0 ? chip.first : c.t("shell.roleChip", { first: chip.first, n: chip.more })}
                  </summary>
                  {chip.more === 0 ? null : (
                    <ul className="rolechip-list" aria-label={c.t("shell.rolesPanel")}>
                      {chip.all.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  )}
                </details>
              )}
            </div>
            <div className="row"><ShellControls t={c.t} locale={c.locale} theme={theme} back={back} /></div>
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
