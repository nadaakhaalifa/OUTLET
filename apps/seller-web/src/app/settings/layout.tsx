import type { ReactNode } from "react";
import { SettingsNav } from "../../components/SettingsNav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="zm-set">
      <SettingsNav />
      {children}
    </div>
  );
}
