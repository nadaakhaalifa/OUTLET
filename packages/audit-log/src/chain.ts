import { createHash } from "node:crypto";
import { redact } from "@outlet/logger";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import { uuidv7 } from "@outlet/ids";

export const GENESIS_HASH = "0".repeat(64);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const AuditEntryInputSchema = z.object({
  marketId: z.string().min(1),
  actorType: z.enum(["user", "staff", "store_member", "system"]),
  actorId: z.string().min(1).nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  diff: z.object({ before: z.unknown().optional(), after: z.unknown().optional() }).nullable(),
  /** Keyed hash (HMAC) of the IP computed by the caller. The raw IP is never accepted. */
  ipHash: hex64.nullable(),
  deviceId: z.string().min(1).nullable(),
  requestId: z.string().min(1).nullable(),
});
export type AuditEntryInput = z.infer<typeof AuditEntryInputSchema>;

export interface AuditEntry extends AuditEntryInput {
  readonly id: string;
  readonly occurredAt: string;
  readonly prevHash: string;
  readonly hash: string;
}

/** Persistence port. Implemented over Postgres later; in-memory in tests. */
export interface AuditStore {
  last(): Promise<AuditEntry | undefined>;
  insert(entry: AuditEntry): Promise<void>;
}

export function computeHash(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonicalJson(entry) + entry.prevHash).digest("hex");
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly brokenIndex: number };

/** Verifies hashes and linkage. Returns the first broken index. */
export function verifyChain(entries: readonly AuditEntry[], startPrevHash: string = GENESIS_HASH): VerifyResult {
  let prev = startPrevHash;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === undefined) return { ok: false, brokenIndex: i };
    const { hash, ...rest } = e;
    let expected: string;
    try {
      expected = computeHash(rest);
    } catch {
      return { ok: false, brokenIndex: i };
    }
    if (e.prevHash !== prev || hash !== expected) return { ok: false, brokenIndex: i };
    prev = hash;
  }
  return { ok: true };
}

export interface AuditChainOptions {
  readonly now?: () => Date;
  readonly newId?: (nowMs: number) => string;
}

export class AuditChain {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly newId: (nowMs: number) => string;

  constructor(private readonly store: AuditStore, options: AuditChainOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? uuidv7;
  }

  /** Appends serially (in-process); the DB must also enforce a single writer per chain. */
  append(input: AuditEntryInput): Promise<AuditEntry> {
    const run = this.tail.then(() => this.doAppend(input));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async doAppend(raw: AuditEntryInput): Promise<AuditEntry> {
    const input = AuditEntryInputSchema.parse(raw);
    const last = await this.store.last();
    const at = this.now();
    const unsigned: Omit<AuditEntry, "hash"> = {
      ...input,
      diff: input.diff === null ? null : (redact(input.diff) as AuditEntryInput["diff"]),
      id: this.newId(at.getTime()),
      occurredAt: at.toISOString(),
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const entry: AuditEntry = { ...unsigned, hash: computeHash(unsigned) };
    await this.store.insert(entry);
    return entry;
  }
}

export class InMemoryAuditStore implements AuditStore {
  readonly entries: AuditEntry[] = [];
  last(): Promise<AuditEntry | undefined> {
    return Promise.resolve(this.entries[this.entries.length - 1]);
  }
  insert(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
