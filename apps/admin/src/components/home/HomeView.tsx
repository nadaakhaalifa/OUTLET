import type { Locale, Translator } from "@outlet/i18n";
import { buildNeeds } from "../../lib/attention";
import { flattenTiles, type DashboardResponse, type Range } from "../../lib/dashboard";
import { AllChecks } from "./AllChecks";
import { NeedsYou } from "./NeedsYou";
import { SalesAndOrders } from "./SalesAndOrders";
import { TodayCards } from "./TodayCards";
import { anyVisible } from "./tileModel";

/** Cairo-time greeting key. */
export function greetingKey(now: Date): "admin.home.greeting.morning" | "admin.home.greeting.afternoon" | "admin.home.greeting.evening" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Africa/Cairo" }).format(now));
  return hour < 12 ? "admin.home.greeting.morning" : hour < 18 ? "admin.home.greeting.afternoon" : "admin.home.greeting.evening";
}

/** The whole Home body from one parsed dashboard response. Pure render: no data beyond the response. */
export function HomeView({ resp, range, now, t, locale, base }: { resp: DashboardResponse; range: Range; now: Date; t: Translator; locale: Locale; base: string }) {
  const rtl = locale === "ar-EG";
  const tiles = flattenTiles(resp);
  return (
    <div className="stack" data-home>
      <header className="pageHeader">
        <h1 className="pageTitle">{t(greetingKey(now))}</h1>
        <p className="lead">{t("admin.home.glance")}</p>
      </header>
      {anyVisible(resp, now) ? (
        <>
          <TodayCards tiles={tiles} now={now} t={t} locale={locale} base={base} rtl={rtl} />
          <NeedsYou needs={buildNeeds(resp, now)} t={t} locale={locale} base={base} />
          <SalesAndOrders resp={resp} range={range} now={now} t={t} locale={locale} base={base} rtl={rtl} />
          <AllChecks resp={resp} now={now} t={t} locale={locale} base={base} rtl={rtl} />
        </>
      ) : <p className="lead" data-testid="home-none">{t("admin.overview.none")}</p>}
    </div>
  );
}
