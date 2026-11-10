# @outlet/ops-attention

Ops attention queue. The money and cancellation workers never fail silently: work they cannot finish (a refund the finance rules refuse, a voucher
settlement that failed, a courier cancel that needs a human) is parked as an `*.attention` outbox event. This package turns those events into
rows ops can see, acknowledge and resolve.

## Events consumed (worker job `ops.attention`, inbox consumer `ops.attention`)

| Event | Emitted by | Payload (whitelisted) | Item `ref_id` |
|---|---|---|---|
| `refund.attention` | `CancellationRefundConsumer`, refund service | `order_group_id?`, `seller_order_id?`, `refund_id?`, `status?`, `error`, `source_event_id?` | `refund_id`, else `group[:seller_order]`, else the event id |
| `promotions.settle_attention` | `PromotionsSettleConsumer`, `OrderCancellation` | `order_group_id?`, `action`, `error`, `source_event_id?` | `group:action`, else the event id |
| `shipment.cancel_attention` | `ShipmentCancelConsumer` | `shipment_id?`, `seller_order_id?`, `reason`, `source_event_id?` | `shipment_id`, else the event id |

`AttentionConsumer.handle` runs one transaction: inbox row, upsert, and `ops.attention_opened {attention_id, kind, ref_type, ref_id, source_event_id}`
(only for a new item). `UNIQUE (kind, ref_id)`: a replay is a `duplicate`; a repeated failure for the same entity refreshes the payload of a
non-resolved item and neither duplicates nor reopens it. A malformed payload or unknown type is parked (inbox row + error log) so it cannot loop.
The payload is PII-free by construction: ids, plus `error` / `reason` / `action` / `status` reduced to a code token (`[A-Za-z0-9_.:-]`, 64 chars,
digit runs of 6 or more masked).

Register with `attentionHandlers(worker, marketId)` in `apps/api/src/worker-consumers.ts`.

## Database (migration 0033, ADR-0011)

`attention_items(id, market_id, kind, ref_type, ref_id, payload, status OPEN|ACKED|RESOLVED, created_at, acked_by, acked_at, resolved_at, resolution_code)`.
- `outlet_worker`, job `ops.attention`: SELECT, INSERT, UPDATE (policy `attention_items__worker_ops_attention`), plus INSERT-only `outbox_events__worker_ops_attention`.
- `outlet_app`, `user` context, own market only: SELECT, and UPDATE limited to `status, acked_by, acked_at, resolved_at, resolution_code`. No INSERT, no DELETE.

## Reader for the admin module (wired: `apps/api/src/modules/admin/attention-admin.ts`)

`PgAttentionReader(appClient, marketId)`: `listOpen({limit, cursor}, actorId?)` (keyset by `created_at DESC, id DESC`, opaque cursor), `ack(id, actorId, onChange?)`,
`resolve(id, actorId, code, onChange?)` with `code` in `FIXED_MANUALLY | REFUNDED_OFFLINE | RETRIED_OK | NOT_AN_ISSUE | DUPLICATE | ESCALATED`, and
`countOpen(actorId?)` (one grouped statement: open, acked, per-kind counts, oldest, for the dashboard tile). Results are `ok {changed}` | `not_found` | `conflict`.
`onChange(tx, item, before)` runs inside the same transaction, only when a row really changed: the admin module appends its audit entry there, so no audit means no change.

Served admin routes (`/v1/{market}/admin/...`, policy `attention.read` / `attention.write`, ops and finance):
- `GET attention?cursor=&limit=` -> `{items, next_cursor}`
- `POST attention/{id}/ack` -> 200 item, 404, 409 `attention-conflict` when already resolved
- `POST attention/{id}/resolve {resolution_code}` -> 200 item, 404, 409 on a different code

Retention: 24 months after creation (`ops_attention_24m` in `data_inventory.yaml`). The nightly `privacy.retention` worker job (ADR-0016) deletes only RESOLVED items past that age (dry run until `WORKER_RETENTION_DRY_RUN=false`); open and acknowledged items are never purged.
