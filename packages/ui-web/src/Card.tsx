import type { ReactNode } from "react";

/** Raised surface. With a `title` it is a labelled region; heading level is the caller's choice (default h2). */
export function Card({ title, level = 2, children, className }: { title?: string; level?: 2 | 3 | 4; children: ReactNode; className?: string }) {
  const H = `h${level}` as "h2" | "h3" | "h4";
  return (
    <section className={className === undefined ? "uw-card" : `uw-card ${className}`}>
      {title === undefined ? null : <H>{title}</H>}
      {children}
    </section>
  );
}
