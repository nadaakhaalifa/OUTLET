import type { ReactNode } from "react";
import s from "./base.module.css";

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={s.srOnly}>{children}</span>;
}
