/** Help skeleton: contact channels and FAQ entries. Contact details are PLACEHOLDERS until the company sets them (legal drafts use the same). */
export const FAQ_IDS = ["track", "return", "payment", "credit", "plus", "privacy"] as const;
export type FaqId = (typeof FAQ_IDS)[number];

/** Which FAQ answer opens next; tapping the open one closes it. */
export function toggleFaq(open: FaqId | null, id: FaqId): FaqId | null {
  return open === id ? null : id;
}
