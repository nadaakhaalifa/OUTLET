import { uuidV7Schema } from "@outlet/ids";
import { z } from "zod";

const jsonValue: z.ZodType = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

/** Event envelope. `payload` is JSON only (no bigint: encode money amounts as decimal strings). Never P3 data. */
export const outboxEventSchema = z.strictObject({
  id: uuidV7Schema,
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "event type must look like aggregate.action"),
  aggregateType: z.string().min(1),
  aggregateId: z.uuid(),
  marketId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  visibility: z.enum(["internal", "public"]).default("internal"),
  traceId: z.string().min(1).optional(),
  payload: z.record(z.string(), jsonValue),
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
export type OutboxEventInput = z.input<typeof outboxEventSchema>;
