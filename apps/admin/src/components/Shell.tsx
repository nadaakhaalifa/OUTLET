import Link from "next/link";
import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import type { Profile, SectionId } from "../server/session";
import { LogoutButton } from "./LogoutButton";

const ITEMS: readonly { readonly id: SectionId; readonly key: MessageKey; readonly href: string }[] = [
  { id: "kyc", key: "admin.nav.kyc", href: "/kyc" },
  { id: "price", key: "admin.nav.price", href: "/price-integrity" },
  { id: "recon", key: "admin.nav.recon", href: "/reconciliation" },
  { id: "dpo", key: "admin.nav.dpo", href: "/privacy" },
  { id: "audit", key: "admin.nav.audit", href: "/audit" },
  { id: "access", key: "admin.nav.access", href: "/access" },
];

/** Sidebar: only the sections the live roles allow (display filter; the API enforces authorization). */
export function Sidebar({ t, base, sections, current }: { t: Translator; base: string; sections: readonly SectionId[]; current: string }) {
  return (
    <nav className="sidebar" aria-label={t("admin.nav.label")}>
      <ul>
        <li><Link className="navItem" href={base} {...(current === "overview" ? { "aria-current": "page" as const } : {})}>{t("admin.nav.overview")}</Link></li>
        {ITEMS.filter((i) => sections.includes(i.id)).map((i) => (
          <li key={i.id}><Link className="navItem" href={`${base}${i.href}`} {...(current === i.id ? { "aria-current": "page" as const } : {})}>{t(i.key)}</Link></li>
        ))}
      </ul>
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
