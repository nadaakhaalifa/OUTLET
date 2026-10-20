/**
 * Single seam to the pure drops domain (packages/domain/src/drops). Aliases only, no behaviour.
 *
 * NOTE for the integrator: once `export * as drops from "./drops";` is added to
 * packages/domain/src/index.ts, replace the relative import below with
 * `import { drops } from "@outlet/domain";` and re-export the same names (ADR-0018).
 */
import { drops } from "@outlet/domain";
export import ADMISSION_TTL_MS = drops.ADMISSION_TTL_MS;
export import DEFAULT_BOT_CONFIG = drops.DEFAULT_BOT_CONFIG;
export import FifoWaitingQueue = drops.FifoWaitingQueue;
export import HEARTBEAT_TTL_MS = drops.HEARTBEAT_TTL_MS;
export import checkAdmissionClaims = drops.checkAdmissionClaims;
export import decideBot = drops.decideBot;
export import fifoDeviation = drops.fifoDeviation;
export import joinVerdict = drops.joinVerdict;
export import mayAdmit = drops.mayAdmit;
export type AdmissionClaims = drops.AdmissionClaims;
export type AdmissionVerdict = drops.AdmissionVerdict;
export type BotConfig = drops.BotConfig;
export type ClaimsVerdict = drops.ClaimsVerdict;
export type DropType = drops.DropType;
export type JoinResult = drops.JoinResult;
export type Ticket = drops.Ticket;
export type TicketState = drops.TicketState;
export type { DropState } from "@outlet/domain";
