import Link from "next/link";
import { createTranslator } from "../../i18n";

/** Static (ISR-safe): no request headers are read, so both languages are shown. Arabic first. */
export default function NotFound() {
  const ar = createTranslator("ar");
  const en = createTranslator("en");
  return (
    <>
      <h1 lang="ar" dir="rtl">{ar("state.notFound")}</h1>
      <p lang="en" dir="ltr">{en("state.notFound")}</p>
      <p>
        <Link className="btn ghost" href="/ar" lang="ar">{ar("state.notFoundHome")}</Link>{" "}
        <Link className="btn ghost" href="/en" lang="en">{en("state.notFoundHome")}</Link>
      </p>
    </>
  );
}
