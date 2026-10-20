import { dropPhase, tokenState, serverNow, type DropSnapshot, type QueueStatus, type ServerClock } from "./model";

/**
 * Coarse render key for the drop screen: changes only when something other than the countdown digits changes
 * (phase kind, token validity, remaining whole minutes shown in the admitted text). The 1 s digits live in a leaf.
 */
export function dropRenderKey(args: {
  drop: DropSnapshot | null;
  clock: ServerClock | null;
  queue: QueueStatus;
  admittedOffsetMs: number;
  nowMs: number;
}): string {
  if (args.drop === null || args.clock === null) return "none";
  const phase = dropPhase(args.drop, serverNow(args.clock, args.nowMs)).kind;
  if (args.queue.state !== "admitted") return phase;
  const tok = tokenState(args.queue.token, args.nowMs + args.admittedOffsetMs);
  return tok.kind === "valid" ? `${phase}|valid|${Math.ceil(tok.remainingMs / 60_000)}` : `${phase}|expired`;
}
