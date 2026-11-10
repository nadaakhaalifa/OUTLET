import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { createTranslator, localeSegment, type ResolvedLocale } from "@outlet/i18n";
import { currentProfile } from "../server/admin-get";
import { visibleSections, type SectionId } from "../server/session";
import { ProblemBanner } from "./ProblemBanner";
import { AdminShell } from "./shell/AdminShell";

/** Auth gate + shell for every console page. No profile cookie -> login. A section the live roles do not allow -> 403 banner (the API enforces the same rule). */
export async function ConsoleFrame({ resolved, section, children }: { resolved: ResolvedLocale; section: SectionId | "overview"; children: ReactNode }) {
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const profile = await currentProfile();
  if (profile === null) redirect(`${base}/login`);
  const t = createTranslator(resolved.locale);
  const sections = visibleSections(profile);
  const allowed = section === "overview" || sections.includes(section);
  return (
    <AdminShell t={t} locale={resolved.locale} market={resolved.marketId} base={base} profile={profile} sections={sections} current={section}>
      {allowed ? children : <ProblemBanner t={t} code="forbidden" status={403} />}
    </AdminShell>
  );
}
