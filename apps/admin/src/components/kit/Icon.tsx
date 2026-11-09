import type { SVGProps } from "react";

/** Small stroke icons (24 box). Decorative by default: pair with visible text. */
const PATHS = {
  overview: "M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z",
  sellers: "M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9a3 3 0 006 0 3 3 0 006 0 3 3 0 006 0",
  orders: "M6 7h12l1 13H5L6 7zm3 0a3 3 0 016 0",
  money: "M3 7h18v10H3V7zm9 7a2 2 0 100-4 2 2 0 000 4zM6 10v.01M18 14v.01",
  catalog: "M3 12l9-9h8v8l-9 9-8-8zm13-5v.01",
  trust: "M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3zm-3 9l2 2 4-4",
  access: "M12 11a4 4 0 100-8 4 4 0 000 8zm-7 10a7 7 0 0114 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M6 9l6 6 6-6",
  arrow: "M19 12H5m6-6l-6 6 6 6",
  language: "M3 5h8M7 3v2m-3 8c3-1 5-4 5-8m-3 3c0 3 3 6 6 7M13 21l4-10 4 10m-6.5-3h5",
  info: "M12 8v.01M12 11v5m0 6a10 10 0 100-20 10 10 0 000 20z",
  alert: "M12 8v5m0 3v.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  check: "M5 12l5 5 9-10",
  up: "M7 17L17 7M9 7h8v8",
  down: "M7 7l10 10M17 9v8H9",
  flat: "M5 12h14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, ...rest }: { name: IconName } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
