import type { Messages } from "./en";

/** Arabic is authoritative (spec §A2.15). Type parity with `en` is checked by the compiler. */
export const ar: Messages = {
  app: { name: "أوتلت NK" },
  tabs: { home: "الرئيسية", explore: "استكشف", stylist: "المنسّق", bag: "الحقيبة", me: "حسابي" },
  home: {
    title: "عروض حقيقية، موثّقة",
    devFixtureNotice: "نسخة تطوير: محتوى تجريبي وليس منتجات أو أسعارًا حقيقية.",
  },
  common: { languageToggle: "English" },
};
