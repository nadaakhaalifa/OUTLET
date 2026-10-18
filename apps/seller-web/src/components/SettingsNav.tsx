import { headers } from "next/headers";
import Link from "next/link";
import { getContext } from "../server-context";

const LINKS = [
  { href: "/settings", key: "ob.nav.overview" },
  { href: "/settings/profile", key: "ob.nav.profile" },
  { href: "/settings/returns", key: "ob.nav.returns" },
  { href: "/settings/delivery", key: "ob.nav.delivery" },
  { href: "/settings/payout", key: "ob.nav.payout" },
  { href: "/settings/shipping", key: "ob.nav.shipping" },
  { href: "/settings/team", key: "ob.nav.team" },
  { href: "/settings/notifications", key: "ob.nav.notifications" },
  { href: "/settings/eta", key: "ob.nav.eta" },
] as const;

export async function SettingsNav() {
  const { t } = await getContext();
  const path = (await headers()).get("x-pathname") ?? "";
  return (
    <nav aria-label={t("ob.nav.label")}>
      <ul className="zm-subnav">
        {LINKS.map((l) => (
          <li key={l.href}><Link href={l.href} aria-current={path === l.href ? "page" : undefined}>{t(l.key)}</Link></li>
        ))}
      </ul>
    </nav>
  );
}
