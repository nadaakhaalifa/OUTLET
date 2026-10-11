import { evaluateDeletionEligibility, DEFAULT_COOLING_DAYS, type DeletionBlocker, type DeletionSnapshot } from "../workspace";

export type DeletionView =
  | { readonly state: "blocked"; readonly blockers: readonly DeletionBlocker[] }
  | {
      readonly state: "eligible";
      readonly coolingDays: number;
      /** Store credit that will be forfeited. Present only when greater than zero. */
      readonly forfeitureMinor: bigint | null;
    };

export function deletionView(snapshot: DeletionSnapshot, coolingDays: number = DEFAULT_COOLING_DAYS): DeletionView {
  const e = evaluateDeletionEligibility(snapshot);
  if (!e.eligible) return { state: "blocked", blockers: e.blockers };
  return { state: "eligible", coolingDays, forfeitureMinor: e.forfeitureWarning?.balanceMinor ?? null };
}

/** The confirm button is enabled only for an eligible account, and, when credit is forfeited, after acknowledgement. */
export function canConfirmDeletion(view: DeletionView, acknowledged: boolean): boolean {
  if (view.state === "blocked") return false;
  return view.forfeitureMinor === null || acknowledged;
}
