import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import type { Profile, SectionId } from "../server/session";
import { LogoutButton } from "./LogoutButton";
import { NavList } from "./shell/NavList";
import { visibleGroups, type NavId } from "./shell/navigation";

/** Navigation only for the sections the live roles allow (display filter; the API enforces authorization). */
export function Sidebar({ t, base, sections, current }: { t: Translator; base: string; sections: readonly SectionId[]; current: NavId }) {
  return (
    <nav className="sidebar" aria-label={t("admin.nav.label")}>
      <NavList t={t} base={base} groups={visibleGroups(sections)} current={current} />
    </nav>
  );
}

export function RoleBadge({ t, profile }: { t: Translator; profile: Profile }) {
  return (
    <p className="roleBadge">
      <span className="hint">{t("admin.topbar.role")}:</span>{" "}
      {profile.roles.length === 0 ? <span className="badge">{t("admin.topbar.noRole")}</span> : profile.roles.map((r) => (
        <span key={r} className="badge" data-role={r}>{t(`admin.role.${r}` as MessageKey)}</span>
      ))}
    </p>
  );
}

/** Shown for the whole session while super_admin is live (break-glass only, dual approval per action). */
export function BreakGlassBanner({ t }: { t: Translator }) {
  return (
    <div className="banner breakGlass" role="alert" data-testid="break-glass">
      <p><strong>{t("admin.breakGlass.title")}</strong></p>
      <p>{t("admin.breakGlass.body")}</p>
    </div>
  );
}

export function TopBarActions({ t, locale, market, profile }: { t: Translator; locale: Locale; market: string; profile: Profile }) {
  return (
    <>
      <RoleBadge t={t} profile={profile} />
      <LogoutButton locale={locale} market={market} />
    </>
  );
}
