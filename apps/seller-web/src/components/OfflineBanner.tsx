"use client";
import { useEffect, useState } from "react";
import { createTranslator, type Locale } from "../i18n";

/** Shows a persistent notice while the browser reports no connection. Content never pretends to be fresh. */
export function OfflineBanner({ locale }: { locale: Locale }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return (
    <div role="alert" className="banner error">
      {createTranslator(locale)("state.offline")}
    </div>
  );
}
