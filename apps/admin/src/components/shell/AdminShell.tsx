import Link from "next/link";
import type { ReactNode } from "react";
import type { Locale, Translator } from "@outlet/i18n";
import type { Profile, SectionId } from "../../server/session";
import { LogoutButton } from "../LogoutButton";
import { BreakGlassBanner, RoleBadge } from "../Shell";
import { IdleHint } from "./IdleHint";
import { LanguageSwitch } from "./LanguageSwitch";
import { MobileTabBar } from "./MobileTabBar";
import { NavList } from "./NavList";
import { visibleGroups, type NavId } from "./navigation";

/**
 * The console chrome: collapsible-group sidebar, top bar (staff, role badge, AR/EN switch, sign out),
 * break-glass banner, main region and the phone tab bar. Navigation is filtered by the session's
 * sections (display only; the API enforces). The skip link lives in the segment layout, before this.
 */
export function AdminShell({ t, locale, market, base, profile, sections, current, staffName, children }: {
  t: Translator;
  locale: Locale;
  market: string;
  base: string;
  profile: Profile;
  sections: readonly SectionId[];
  current: NavId;
  /** Display name when the session exposes one; otherwise the generic "passkey-protected session" label. */
  staffName?: string;
  children: ReactNode;
}) {
  const groups = visibleGroups(sections);
  return (
    <div className="adminShell">
      <aside className="adminSide">
        <Link className="brand" href={base}>{t("admin.brand")}</Link>
        <nav aria-label={t("admin.nav.label")}>
          <NavList t={t} base={base} groups={groups} current={current} />
        </nav>
      </aside>
      <div className="adminCol">
        <header className="topbar">
          <Link className="brand brandPhone" href={base}>{t("admin.brand")}</Link>
          <p className="staffName" data-testid="staff-name">{staffName ?? t("admin.topbar.signedIn")}</p>
          <IdleHint expiresAt={profile.expiresAt} locale={locale} />
          <RoleBadge t={t} profile={profile} />
          <LanguageSwitch locale={locale} market={market} label={t("admin.topbar.language")} targetName={t(locale === "ar-EG" ? "admin.lang.en" : "admin.lang.ar")} />
          <LogoutButton locale={locale} market={market} />
        </header>
        {profile.breakGlass ? <BreakGlassBanner t={t} /> : null}
        <main id="content" className="content" tabIndex={-1}>{children}</main>
      </div>
      <MobileTabBar drawerInfo={<><p className="staffName" data-testid="staff-name-drawer">{staffName ?? t("admin.topbar.signedIn")}</p><RoleBadge t={t} profile={profile} /></>} t={t} locale={locale} base={base} groups={groups} current={current} />
    </div>
  );
}
