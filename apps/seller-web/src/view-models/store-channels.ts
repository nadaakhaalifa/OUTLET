import type { StoreChannel, StoreChannelKind } from "../api/schemas-phase3";
import type { Locale, MessageKey } from "../i18n";
import { formatDateTime } from "../lib/format";

/** Kinds connected with a secret reference. Shopify/WooCommerce use the OAuth section; crawling uses crawl targets. */
export const REF_CHANNEL_KINDS = ["odoo", "google_sheets"] as const satisfies readonly StoreChannelKind[];
export type RefChannelKind = (typeof REF_CHANNEL_KINDS)[number];

export interface StoreChannelRowVM {
  readonly id: string; readonly kindKey: MessageKey; readonly status: string; readonly createdAt: string;
}
export function storeChannelRows(items: readonly StoreChannel[], locale: Locale): readonly StoreChannelRowVM[] {
  return items.map((c) => ({ id: c.id, kindKey: `channels.kind.${c.kind}` as MessageKey, status: c.status, createdAt: formatDateTime(c.created_at, locale) }));
}

export type RefError = "kind" | "token_ref" | "kms_key_ref";
export type RefResult =
  | { readonly ok: true; readonly value: { kind: RefChannelKind; token_ref: string; kms_key_ref: string } }
  | { readonly ok: false; readonly errors: readonly RefError[] };

/** A reference is an opaque handle, 8 to 256 printable characters without spaces. A pasted secret cannot be told apart, so the form says so. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{7,255}$/;

export function validateChannelRefs(f: { kind: string; tokenRef: string; kmsKeyRef: string }): RefResult {
  const errors: RefError[] = [];
  const kind = REF_CHANNEL_KINDS.find((k) => k === f.kind);
  if (kind === undefined) errors.push("kind");
  if (!REF.test(f.tokenRef.trim())) errors.push("token_ref");
  if (!REF.test(f.kmsKeyRef.trim())) errors.push("kms_key_ref");
  if (errors.length > 0 || kind === undefined) return { ok: false, errors };
  return { ok: true, value: { kind, token_ref: f.tokenRef.trim(), kms_key_ref: f.kmsKeyRef.trim() } };
}
