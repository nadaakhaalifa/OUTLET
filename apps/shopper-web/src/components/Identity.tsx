import { MONOGRAM_EYELET, MONOGRAM_Z, wordmarkGeometry } from "../lib/brand-geometry";

const WM = wordmarkGeometry();

/** Didone Z-OUTLET wordmark, the same geometry as the mobile app. Ink follows `currentColor`; the hyphen takes the brand accent. */
export function Wordmark({ height = 20, label }: { height?: number; label?: string }) {
  const width = Math.round((WM.width / WM.height) * height);
  return (
    <svg
      className="wm"
      width={width}
      height={height}
      viewBox={`-1 -1 ${WM.width + 2} ${WM.height + 2}`}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
    >
      {WM.parts.map((p, i) => {
        const cls = p.accent === true ? "wm-accent" : undefined;
        return p.w === 0 ? (
          <path key={i} d={p.d} className={cls} fill="currentColor" fillRule={p.evenodd === true ? "evenodd" : "nonzero"} />
        ) : (
          <path key={i} d={p.d} className={cls} fill="none" stroke="currentColor" strokeWidth={p.w} />
        );
      })}
    </svg>
  );
}

/** Playfair Z monogram with a sand full stop. */
export function Monogram({ size = 40, label }: { size?: number; label?: string }) {
  return (
    <svg
      className="wm"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
    >
      <path d={MONOGRAM_Z} fill="currentColor" />
      <circle className="wm-eyelet" cx={MONOGRAM_EYELET.cx} cy={MONOGRAM_EYELET.cy} r={MONOGRAM_EYELET.r} />
    </svg>
  );
}
