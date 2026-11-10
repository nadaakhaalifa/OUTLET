import type { ReactNode } from "react";
import Link from "next/link";
import type { Locale, MessageKey, Translator } from "@outlet/i18n";
import { Icon } from "../kit/Icon";
import { MobileNav } from "./MobileNav";
import { tabItems, type NavGroup, type NavId } from "./navigation";

/** Below 48rem: up to four main destinations plus Menu (five targets, each at least 44px), at the thumb. */
export function MobileTabBar({ t, locale, base, groups, current, drawerInfo }: { drawerInfo?: ReactNode; t: Translator; locale: Locale; base: string; groups: readonly NavGroup[]; current: NavId }) {
  return (
    <div className="tabBar" data-tab-bar>
      <nav aria-label={t("admin.nav.tabs")} className="tabs">
        {tabItems(groups).map((i) => (
          <Link key={i.id} href={`${base}${i.path}`} className="tab" {...(current === i.id ? { "aria-current": "page" as const } : {})}>
            <Icon name={i.icon} />
            <span className="tabLabel">{t(`admin.nav.tab.${i.id}` as MessageKey)}</span>
          </Link>
        ))}
        <MobileNav drawerInfo={drawerInfo} locale={locale} base={base} groups={groups} current={current} />
      </nav>
    </div>
  );
}
