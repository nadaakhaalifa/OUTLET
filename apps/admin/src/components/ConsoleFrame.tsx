import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { createTranslator, localeSegment, type ResolvedLocale } from "@outlet/i18n";
import { currentProfile } from "../server/admin-get";
import { visibleSections, type SectionId } from "../server/session";
import { ProblemBanner } from "./ProblemBanner";
import { BreakGlassBanner, Sidebar, TopBarActions } from "./Shell";

/** Auth gate + shell for every console page. No profile cookie -> login. A section the live roles do not allow -> 403 banner (the API enforces the same rule). */
export async function ConsoleFrame({ resolved, section, children }: { resolved: ResolvedLocale; section: SectionId | "overview"; children: ReactNode }) {
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const profile = await currentProfile();
  if (profile === null) redirect(`${base}/login`);
  const t = createTranslator(resolved.locale);
  const sections = visibleSections(profile);
  const allowed = section === "overview" || sections.includes(section);
  return (
    <>
      <header className="topbar">
        <a className="brand" href={base}>{t("admin.title")}</a>
        <TopBarActions t={t} locale={resolved.locale} market={resolved.marketId} profile={profile} />
      </header>
      {profile.breakGlass ? <BreakGlassBanner t={t} /> : null}
      <div className="shellBody">
        <Sidebar t={t} base={base} sections={sections} current={section} />
        <main id="content" className="content" tabIndex={-1}>
          {allowed ? children : <ProblemBanner t={t} code="forbidden" status={403} />}
        </main>
      </div>
    </>
  );
}
