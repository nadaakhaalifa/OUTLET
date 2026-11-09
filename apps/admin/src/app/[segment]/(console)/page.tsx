import { createTranslator, localeSegment } from "@outlet/i18n";
import { ConsoleFrame } from "../../../components/ConsoleFrame";
import { HomeView } from "../../../components/home/HomeView";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { allUnreadable, DashboardResponse, parseRange } from "../../../lib/dashboard";
import { load } from "../../../lib/load";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";

export default async function HomePage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ range?: string }> }) {
  const resolved = await requireLocale(params);
  const range = parseRange((await searchParams).range);
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const now = new Date();
  const res = await load(DashboardResponse, resolved.marketId, "dashboard", { range });
  // A response that does not match the contract renders every tile "Could not load" (never partial guessing); other failures show the problem.
  const resp = res.ok ? res.data : res.code === "bad-response" ? allUnreadable(range, now.toISOString().slice(0, 10), now) : null;
  return (
    <ConsoleFrame resolved={resolved} section="overview">
      {resp !== null ? <HomeView resp={resp} range={range} now={now} t={t} locale={resolved.locale} base={base} /> : <ProblemBanner t={t} code={res.ok ? "unknown" : res.code} status={res.ok ? 500 : res.status} />}
    </ConsoleFrame>
  );
}
