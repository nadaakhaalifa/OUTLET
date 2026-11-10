import { AuthError } from "./errors.js";

export type AgeBand = "under_18_blocked" | "18_20" | "21_plus";

export interface AgeAssessment {
  readonly age: number;
  readonly ageBand: AgeBand;
  readonly limitedCapacity: boolean;
}

const DOB = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole years on `now` (UTC dates). Master prompt B6: 18 to shop, 21 for contracts; 18-20 are limited_capacity. */
export const assessAge = (dob: string, now: Date): AgeAssessment => {
  const m = DOB.exec(dob);
  if (!m) throw new AuthError("INVALID_DOB", "dob must be YYYY-MM-DD");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || probe.getTime() > now.getTime()) {
    throw new AuthError("INVALID_DOB", "dob is not a valid past date");
  }
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  if (age < 18) return { age, ageBand: "under_18_blocked", limitedCapacity: false };
  if (age < 21) return { age, ageBand: "18_20", limitedCapacity: true };
  return { age, ageBand: "21_plus", limitedCapacity: false };
};
