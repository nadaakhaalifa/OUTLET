import Link from "next/link";
import { PageHeader } from "../../components/ui";
import { getConsole } from "../../server/console";
import { navFor } from "../../view-models/nav";

export default async function Home() {
  const c = await getConsole();
  return (
    <>
      <PageHeader title={c.t("home.title")} intro={c.t("home.intro")} />
      <ul>
        {navFor(c.roles).filter((i) => i.id !== "home").map((i) => (
          <li key={i.id}><Link href={i.href}>{c.t(i.labelKey)}</Link></li>
        ))}
      </ul>
    </>
  );
}
