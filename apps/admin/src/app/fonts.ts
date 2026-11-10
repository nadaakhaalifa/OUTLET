import localFont from "next/font/local";

// Self-hosted IBM Plex (OFL-1.1) subsets copied from @fontsource 5.3.0; no runtime request to any font CDN.
export const plexArabic = localFont({
  src: [
    { path: "../fonts/plex-arabic-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/plex-arabic-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-arabic",
  display: "swap",
});

export const plexLatin = localFont({
  src: [
    { path: "../fonts/plex-latin-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/plex-latin-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-latin",
  display: "swap",
});
