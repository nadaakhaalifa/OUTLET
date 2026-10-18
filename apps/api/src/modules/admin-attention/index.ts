/** Public surface of the admin-attention module (A2.3). Other code imports only this file. */
export { AdminAttentionModule, type AdminAttentionOptions } from "./admin-attention.module";
export { KyselyAuditChainReader, type AuditReadDb } from "./adapters/kysely-reader";
export type { AttentionSourcePort, AttentionReading, AuditChainReader } from "./domain/ports";
export { ATTENTION_ITEMS, capabilityPredicates } from "./domain/attention";
