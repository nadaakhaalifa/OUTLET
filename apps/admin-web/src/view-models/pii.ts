import { z } from "zod";
import type { MessageKey } from "../i18n";
import { isReasonCode } from "./common";

export const PII_FIELDS = ["display_name", "phone", "email", "default_address"] as const;
export type PiiField = (typeof PII_FIELDS)[number];

export const PII_FIELD_KEYS: Readonly<Record<PiiField, MessageKey>> = {
  display_name: "pii.field.display_name",
  phone: "pii.field.phone",
  email: "pii.field.email",
  default_address: "pii.field.default_address",
};

/** Revealed values are dropped from the page after this long, so a forgotten tab does not keep personal data. */
export const PII_REVEAL_TTL_MS = 60_000;

export interface PiiRequestInput {
  readonly subjectUserId: string;
  readonly fields: readonly string[];
  readonly reasonCode: string;
}

export type PiiRequestResult =
  | { readonly ok: true; readonly request: { subject_user_id: string; fields: PiiField[]; reason_code: ReturnType<typeof asReason> } }
  | { readonly ok: false; readonly errors: readonly { field: "subject" | "fields" | "reason"; key: MessageKey }[] };

const asReason = (v: string) => {
  if (!isReasonCode(v)) throw new Error("reason");
  return v;
};

/** A PII view is only ever sent with a subject, at least one known field and an enumerated reason code. */
export function validatePiiRequest(i: PiiRequestInput): PiiRequestResult {
  const errors: { field: "subject" | "fields" | "reason"; key: MessageKey }[] = [];
  if (!z.uuid().safeParse(i.subjectUserId).success) errors.push({ field: "subject", key: "pii.error.subject" });
  const fields = [...new Set(i.fields)].filter((f): f is PiiField => (PII_FIELDS as readonly string[]).includes(f));
  if (fields.length === 0 || fields.length !== new Set(i.fields).size) errors.push({ field: "fields", key: "pii.error.fields" });
  if (!isReasonCode(i.reasonCode)) errors.push({ field: "reason", key: "pii.error.reason" });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, request: { subject_user_id: i.subjectUserId, fields, reason_code: asReason(i.reasonCode) } };
}

export function revealExpired(revealedAtMs: number, nowMs: number): boolean {
  return nowMs - revealedAtMs >= PII_REVEAL_TTL_MS;
}
