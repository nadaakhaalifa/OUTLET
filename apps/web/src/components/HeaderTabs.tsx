"use client";
import { usePathname } from "next/navigation";
import type { Locale } from "@outlet/i18n";
import { TabsExploreDeals } from "./ui";

/** Marks the active tab from the URL (the layout cannot know it). */
export function HeaderTabs({ base, locale }: { base: string; locale: Locale }) {
  const path = usePathname();
  const active = path.startsWith(`${base}/deals`) ? "deals" : path === base || path.startsWith(`${base}/stores`) ? "explore" : "none";
  return <TabsExploreDeals active={active} exploreHref={base} dealsHref={`${base}/deals`} locale={locale} />;
}
