import { InvalidInboxMessageError } from './errors.js';
import { isUuid } from './record.js';
import type { Clock, InboxStore, UnitOfWork } from './ports.js';

export type ConsumeOutcome = 'processed' | 'duplicate';

/**
 * Idempotent consumer. The inbox row and the handler's writes share one unit
 * of work: both commit or both roll back. A redelivered message finds the row
 * and the handler does not run again.
 *
 * Scope of the guarantee: effects written through `tx` happen once per
 * message_id. Effects outside the transaction (HTTP calls, emails) are NOT
 * covered; they must carry their own idempotency key. Combined with
 * at-least-once delivery this is "effectively once" for database effects, not
 * exactly-once delivery.
 */
export class InboxConsumer<Tx> {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork<Tx>;
      readonly inbox: InboxStore<Tx>;
      readonly clock: Clock;
    },
  ) {}

  async consume(args: {
    readonly consumer: string;
    readonly messageId: string;
    readonly handler: (tx: Tx) => Promise<void>;
  }): Promise<ConsumeOutcome> {
    if (args.consumer.length === 0) throw new InvalidInboxMessageError('consumer name is empty');
    if (!isUuid(args.messageId)) throw new InvalidInboxMessageError('messageId must be a lowercase uuid');
    const { uow, inbox, clock } = this.deps;
    return uow.run(async (tx) => {
      const fresh = await inbox.tryRecord(tx, args.consumer, args.messageId, clock.now());
      if (!fresh) return 'duplicate';
      await args.handler(tx);
      return 'processed';
    });
  }
}
