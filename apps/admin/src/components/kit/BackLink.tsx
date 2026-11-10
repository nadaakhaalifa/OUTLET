"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** Back to the admin page the person came from (browser history); falls back to `href` when opened directly or from another site. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <Link href={href} className="btn btnGhost" onClick={(event) => {
      const external = ((): boolean => {
        try {
          return document.referrer !== "" && new URL(document.referrer).origin !== window.location.origin;
        } catch {
          return false;
        }
      })();
      if (!external && window.history.length > 1) {
        event.preventDefault();
        router.back();
      }
    }}>
      <Icon name="arrow" className="flipRtl" />
      <span>{children}</span>
    </Link>
  );
}
