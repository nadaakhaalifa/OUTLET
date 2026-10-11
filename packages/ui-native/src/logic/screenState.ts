export type ScreenStatus = "loading" | "error" | "offline" | "empty" | "ready";

export interface ScreenStateInput {
  readonly isLoading: boolean;
  readonly isOnline: boolean;
  readonly hasError: boolean;
  readonly itemCount: number;
  /** True when cached data is on screen, so offline/error need not blank it. */
  readonly hasCachedData?: boolean;
}

/**
 * Single decision table for list screens. Order matters:
 * cached data stays visible; otherwise offline beats error beats empty.
 */
export function resolveScreenStatus(i: ScreenStateInput): ScreenStatus {
  if (i.itemCount > 0 || i.hasCachedData === true) return "ready";
  if (i.isLoading) return "loading";
  if (!i.isOnline) return "offline";
  if (i.hasError) return "error";
  return "empty";
}
