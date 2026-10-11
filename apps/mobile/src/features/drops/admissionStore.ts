import type { AdmissionToken } from "./model";

/**
 * In-memory handoff of the admission token from the drop screen to checkout. Never persisted,
 * never put in a URL or log. Single use per drop: `take` clears it.
 */
let held: { dropId: string; token: AdmissionToken } | null = null;

export function holdAdmission(dropId: string, token: AdmissionToken): void {
  held = { dropId, token };
}

export function takeAdmission(dropId: string): AdmissionToken | null {
  if (held === null || held.dropId !== dropId) return null;
  const t = held.token;
  held = null;
  return t;
}

export function clearAdmission(): void {
  held = null;
}
