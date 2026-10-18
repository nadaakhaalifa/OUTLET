import type { ConsentHistory } from "../../workspace";

export type BannerChoice = "allow" | "not_now";

/** The consent surface the banner needs (ConsentController satisfies it). */
export interface BannerConsent {
  history(): ConsentHistory;
  set(purpose: "analytics", granted: boolean, method: "permission_dialog"): Promise<void>;
}

/**
 * Shown while the shopper has never answered for `analytics` on this device. Any record (allowed or declined) means it
 * was answered, so it never nags; the answer is changed later in Privacy settings. Nothing is pre-selected.
 */
export function shouldShowAnalyticsBanner(history: ConsentHistory): boolean {
  return !history.some((r) => r.purpose === "analytics");
}

/** Allow and Not now carry equal weight. Not now records a decline (no SDK ever starts); Allow records consent, which starts it. */
export async function answerAnalyticsBanner(consent: BannerConsent, choice: BannerChoice): Promise<void> {
  await consent.set("analytics", choice === "allow", "permission_dialog");
}
