import { getContext } from "../server-context";

export default async function NotFound() {
  const { t } = await getContext();
  return <p role="alert" className="banner">{t("state.notFound")}</p>;
}
