import Link from "next/link";
import { PageHeader } from "../../components/ui";
import { getConsole } from "../../server/console";
import { countLabel } from "../../view-models/brand-review";
import { navAllowsPath, navFor } from "../../view-models/nav";

export default async function Home() {
  const c = await getConsole();
  const showBrand = navAllowsPath(c.roles, "/brand-applications");
  // Three capped reads (limit 50): a count of "50+" is honest, an exact total would need an API count we do not have.
  const [inReview, mine, late] = showBrand
    ? await Promise.all([
      c.api.brandQueue({ status: "IN_REVIEW", assignee: "unassigned", limit: 50 }),
      c.api.brandQueue({ assignee: "me", limit: 50 }),
      c.api.brandQueue({ sla_breached: true, limit: 50 }),
    ])
    : [null, null, null];
  const tile = (r: typeof inReview, label: string, href: string) => (
    <li key={href}>
      <Link className="tile" href={href}>
        <span className="tile-n">{r === null || !r.ok ? "—" : countLabel(r.value.data.items.length, r.value.data.page.has_more)}</span>
        <span>{label}</span>
      </Link>
    </li>
  );
  return (
    <>
      <PageHeader title={c.t("home.title")} intro={c.t("home.intro")} />
      {showBrand ? (
        <section aria-labelledby="home-brand">
          <h2 id="home-brand">{c.t("brand.tile.title")}</h2>
          <ul className="tiles">
            {tile(inReview, c.t("brand.tile.unassigned"), "/brand-applications?status=IN_REVIEW&assignee=unassigned")}
            {tile(mine, c.t("brand.tile.mine"), "/brand-applications/mine")}
            {tile(late, c.t("brand.tile.late"), "/brand-applications?sla_breached=true")}
          </ul>
          {[inReview, mine, late].some((r) => r !== null && !r.ok) ? <p className="muted">{c.t("brand.tile.unavailable")}</p> : null}
        </section>
      ) : null}
      <ul>
        {navFor(c.roles).filter((i) => i.id !== "home").map((i) => (
          <li key={i.id}><Link href={i.href}>{c.t(i.labelKey)}</Link></li>
        ))}
      </ul>
    </>
  );
}
