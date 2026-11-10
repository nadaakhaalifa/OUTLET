/** Whole hours and minutes between `now` and `deadline`; `late` when the deadline has passed. Pure, so server and client agree. */
export interface SlaRemaining {
  readonly late: boolean;
  readonly hours: number;
  readonly minutes: number;
}

export const slaRemaining = (deadline: Date, now: Date): SlaRemaining => {
  const diff = deadline.getTime() - now.getTime();
  const abs = Math.abs(diff);
  return { late: diff < 0, hours: Math.floor(abs / 3_600_000), minutes: Math.floor((abs % 3_600_000) / 60_000) };
};

/** Which deadline applies in which state: accept while the order waits for the seller, dispatch once accepted. */
export const slaKindOf = (status: string): "accept" | "dispatch" | null => {
  if (status === "PAID" || status === "CONFIRMED_COD") return "accept";
  if (status === "ACCEPTED" || status === "PACKED") return "dispatch";
  return null;
};

/** A label link is only followed when it is https or a same-origin path. */
export const safeHref = (url: string | null): string | null => {
  if (url === null) return null;
  return url.startsWith("https://") || /^\/[^/]/.test(url) ? url : null;
};
