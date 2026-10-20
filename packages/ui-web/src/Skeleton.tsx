export type SkeletonWidth = 25 | 50 | 75 | 100;
export type SkeletonHeight = "line" | "heading" | "block";

/** Placeholder block. Decorative; the loading announcement is `label` (screen-reader only), or none when nested. */
export function Skeleton({ width = 100, height = "line", label }: { width?: SkeletonWidth; height?: SkeletonHeight; label?: string }) {
  const h = height === "heading" ? " uw-sk-h1" : height === "block" ? " uw-sk-h2" : "";
  return (
    <span className={`uw-skeleton uw-sk-w${width}${h}`} {...(label === undefined ? { "aria-hidden": true } : { role: "status" })}>
      {label === undefined ? null : <span className="uw-sr">{label}</span>}
    </span>
  );
}
