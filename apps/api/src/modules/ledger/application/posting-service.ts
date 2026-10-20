import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  DomainError,
  GENESIS_HASH,
  GiftCardSalesDisabledError,
  InvalidEntryError,
  PostingConflictError,
  buildEntry,
  buildReversal,
  createJournalEntry,
  nextHash,
  reversalKey,
  reversesOf,
  samePayload,
  type JournalEntry,
  type PostingCommand,
  type Sha256Hex,
} from "../domain/bridge";
import { IdempotencyKeyTaken, type LedgerStore, type LedgerTxn, type PostOutcome, type PostingFlags, type StoredEntry } from "../domain/ports";

export class LedgerEntryNotFoundError extends DomainError {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIFT_CARD_KINDS: ReadonlySet<string> = new Set(["gift_card_sold", "gift_card_redeemed"]);

export interface PostingServiceDeps<T extends LedgerTxn> {
  readonly store: LedgerStore<T>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sha256: Sha256Hex;
  readonly flags: PostingFlags;
}

/**
 * The only way money gets into the ledger. Every method takes the CALLER's transaction handle, so
 * the posting, the caller's state change and its outbox events commit or roll back together
 * (ADR-0021 point 5). It has no HTTP surface.
 *
 * Idempotency: `findByKey` first (no lock). A new key takes the chain lock, re-checks, then
 * appends. With the lock held a second writer cannot reach the unique constraint, because it
 * waits, then finds the winner in the re-check.
 */
export class PostingService<T extends LedgerTxn> {
  constructor(private readonly deps: PostingServiceDeps<T>) {}

  postCommand(tx: T, command: PostingCommand): Promise<PostOutcome> {
    const entry = buildEntry(command, { id: this.deps.ids.uuidV7(), occurredAt: new Date(this.deps.clock.nowMs()) });
    return this.post(tx, entry);
  }

  async post(tx: T, entry: JournalEntry): Promise<PostOutcome> {
    const valid = createJournalEntry(entry);
    if (!UUID.test(valid.id)) throw new InvalidEntryError("entry id must be a lowercase uuid");
    if (GIFT_CARD_KINDS.has(valid.kind) && !(await this.deps.flags.giftCardSalesEnabled())) {
      throw new GiftCardSalesDisabledError("gift card entries are disabled by the gift_card_sales kill switch");
    }
    return this.deps.store.privileged(tx, () => this.write(tx, valid, "ledger.entry_posted"));
  }

  /** Exact mirror of an entry. Repeating it returns the same reversal. */
  async reversal(tx: T, entryId: string): Promise<PostOutcome> {
    return this.deps.store.privileged(tx, async () => {
      const original = await this.deps.store.findById(tx, entryId);
      if (original === null) throw new LedgerEntryNotFoundError(`entry ${entryId} does not exist`);
      const entry = buildReversal(original.entry, {
        id: this.deps.ids.uuidV7(),
        occurredAt: new Date(this.deps.clock.nowMs()),
      });
      return this.write(tx, entry, "ledger.entry_reversed");
    });
  }

  private async write(tx: T, entry: JournalEntry, eventType: "ledger.entry_posted" | "ledger.entry_reversed"): Promise<PostOutcome> {
    const { store } = this.deps;
    const replay = await this.replayOf(tx, entry);
    if (replay !== null) return { kind: "replayed", stored: replay };

    await store.lockChain(tx);
    const raced = await this.replayOf(tx, entry);
    if (raced !== null) return { kind: "replayed", stored: raced };

    const prevHash = (await store.chainHead(tx)) || GENESIS_HASH;
    const entryHash = nextHash(prevHash, entry, this.deps.sha256);
    let stored: StoredEntry;
    try {
      stored = await store.append(tx, entry, { prevHash, entryHash });
    } catch (e) {
      // Only reachable when a caller breaks the READ COMMITTED requirement on LedgerStore: another
      // writer committed the same key and our re-check could not see it. Re-read; same payload
      // replays, a different payload is a conflict.
      if (!(e instanceof IdempotencyKeyTaken)) throw e;
      // On Postgres the failed INSERT has aborted the surrounding transaction, so the re-read can
      // itself throw: surface the typed error so the caller retries in a fresh transaction.
      const winner = await this.replayOf(tx, entry).catch(() => null);
      if (winner === null) throw e;
      return { kind: "replayed", stored: winner };
    }
    await tx.emit({
      aggregateType: "journal_entry",
      aggregateId: entry.id,
      eventType,
      orderingKey: `journal_entry:${entry.ref.type}:${entry.ref.id}`,
      payload: {
        kind: entry.kind,
        ref_type: entry.ref.type,
        ref_id: entry.ref.id,
        idempotency_key: entry.idempotencyKey,
        posting_count: entry.postings.length,
        chain_seq: stored.link.seq.toString(),
        reverses_entry_id: reversesOf(entry),
      },
    });
    return { kind: "posted", stored };
  }

  private async replayOf(tx: T, entry: JournalEntry): Promise<StoredEntry | null> {
    const existing = await this.deps.store.findByKey(tx, entry.idempotencyKey);
    if (existing === null) return null;
    if (!samePayload(existing.entry, entry)) {
      throw new PostingConflictError(entry.idempotencyKey, existing.entry.id);
    }
    return existing;
  }
}

export { reversalKey };
