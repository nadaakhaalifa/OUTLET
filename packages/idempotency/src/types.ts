import { z } from "zod";

/** Client-generated UUIDv7 (RFC 9562): version nibble 7, variant 10xx. */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const IdempotencyKeySchema = z.string().regex(UUID_V7);
/** Webhook deliveries use the provider's event id, which is not necessarily a UUID. */
export const OpaqueKeySchema = z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export const StoredResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()).default({}),
  body: JsonValueSchema,
});
export type StoredResponse = z.infer<typeof StoredResponseSchema>;

export const ScopeSchema = z.object({
  /** Authenticated actor id; "anonymous:<device>" for pre-login routes, provider id for webhooks. */
  actor: z.string().min(1),
  key: z.string().min(1),
});
export type IdempotencyScope = z.infer<typeof ScopeSchema>;

export type IdempotencyRecord =
  | {
      readonly state: "in_flight";
      readonly scope: IdempotencyScope;
      readonly route: string;
      readonly requestHash: string;
      readonly claimToken: string;
      readonly createdAtMs: number;
      /** After this instant a crashed claim may be taken over. */
      readonly leaseExpiresAtMs: number;
      readonly expiresAtMs: number;
    }
  | {
      readonly state: "completed";
      readonly scope: IdempotencyScope;
      readonly route: string;
      readonly requestHash: string;
      readonly response: StoredResponse;
      readonly createdAtMs: number;
      readonly expiresAtMs: number;
    };

export interface Clock {
  nowMs(): number;
}
