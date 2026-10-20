import type { HomeBanner } from "../domain/banner";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
export const H = 3_600_000;

export const banner = (n: number, o: Partial<HomeBanner> = {}): HomeBanner => ({
  id: U(n),
  status: "scheduled",
  titleAr: `عرض ${n}`,
  titleEn: `Offer ${n}`,
  subtitleAr: null,
  subtitleEn: null,
  imageKey: null,
  artVariant: "warm",
  priority: 100,
  startsAtMs: NOW - H,
  endsAtMs: NOW + H,
  sponsored: false,
  sponsorRef: null,
  cta: { kind: "store", targetId: U(500 + n) },
  createdBy: U(900),
  updatedBy: U(900),
  version: 1,
  createdAtMs: NOW - 2 * H + n,
  updatedAtMs: NOW - 2 * H + n,
  ...o,
});

export const sponsored = (n: number, o: Partial<HomeBanner> = {}): HomeBanner => banner(n, { sponsored: true, sponsorRef: `ads:campaign-${n}`, ...o });
