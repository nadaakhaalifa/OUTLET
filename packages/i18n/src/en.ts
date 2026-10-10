export const en = {
  app: { name: "Outlet NK" },
  tabs: { home: "Home", explore: "Explore", stylist: "Stylist", bag: "Bag", me: "Me" },
  home: {
    title: "Real deals, verified",
    devFixtureNotice: "Development build: placeholder content, not real products or prices.",
  },
  common: { languageToggle: "العربية" },
} as const;

type Widen<T> = T extends string ? string : { -readonly [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof en>;
