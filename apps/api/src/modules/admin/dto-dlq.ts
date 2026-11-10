import { DISCARD_REASON_CODES } from "@outlet/outbox";
import { z } from "zod";
import { CursorQuery, pageOf } from "../../platform/pagination.js";

const Iso = z.iso.datetime({ offset: true });

// ---- dead-letter queue (outbox relay DLQ, ADR-0016): list, replay, discard. Never a payload: ids, event type, attempts and an error code only.
export const DlqQuery = CursorQuery;
export type DlqQuery = z.infer<typeof DlqQuery>;
export const DlqEntryDto = z.strictObject({
  /** dlq_messages.id: the id replay and discard take. */
  id: z.uuid(),
  /** The outbox event id. */
  event_id: z.uuid(),
  event_type: z.string().max(200),
  attempts: z.number().int().min(0),
  /** Error name and code only (never a message). */
  last_error: z.string().max(200).nullable(),
  dead_lettered_at: Iso,
});
export type DlqEntryDto = z.infer<typeof DlqEntryDto>;
export const DlqPage = pageOf(DlqEntryDto);
export type DlqPage = z.infer<typeof DlqPage>;

export const DLQ_MAX_IDS = 50;
const Ids = z.array(z.uuid()).min(1).max(DLQ_MAX_IDS);
export const DlqReplayInput = z.strictObject({ ids: Ids });
export type DlqReplayInput = z.infer<typeof DlqReplayInput>;
export const DlqDiscardInput = z.strictObject({ ids: Ids, reason_code: z.enum(DISCARD_REASON_CODES) });
export type DlqDiscardInput = z.infer<typeof DlqDiscardInput>;
export const DlqActionResult = z.strictObject({
  results: z.array(z.strictObject({ id: z.uuid(), outcome: z.enum(["replayed", "discarded", "not_in_dlq"]) })).max(DLQ_MAX_IDS),
  /** Rows actually changed (replayed or discarded). */
  changed: z.number().int().min(0),
});
export type DlqActionResult = z.infer<typeof DlqActionResult>;
