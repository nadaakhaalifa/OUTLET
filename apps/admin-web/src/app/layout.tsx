import { headers } from "next/headers";
import type { ReactNode } from "react";
import { isRtl } from "../i18n";
import { readLocale } from "../server/console";
import { STYLES } from "./styles";

export const metadata = { title: "Z-OUTLET Admin Console", robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await readLocale();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang={locale === "ar" ? "ar-EG" : "en"} dir={isRtl(locale) ? "rtl" : "ltr"}>
      <head>
        <meta name="color-scheme" content="light dark" />
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
