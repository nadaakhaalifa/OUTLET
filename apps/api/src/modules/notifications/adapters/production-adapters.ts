import { sql, type Kysely } from "kysely";
import { latestConsent } from "@outlet/privacy";
import type { ConsentRepository } from "../../privacy";
import type {
  AnalyticsPort,
  ChannelProvider,
  ConsentPort,
  InboxProcessedPort,
  NotificationEvent,
  NotificationEventPublisher,
  ProviderMessage,
  ProviderRegistry,
  ProviderResult,
} from "../domain/ports";
import type { ExternalChannel, MarketingPurpose } from "../domain/types";

/**
 * Consent through the privacy module's append-only history (public index). Nothing is pre-granted;
 * a withdrawal appends a record, it never edits one. Marketing sends re-read this at send time.
 */
export class PrivacyConsentPort implements ConsentPort {
  constructor(private readonly consents: Pick<ConsentRepository, "history" | "append">) {}

  async isGranted(userId: string, purpose: MarketingPurpose): Promise<boolean> {
    const r = latestConsent(await this.consents.history(userId), userId, purpose);
    return r !== undefined && r.granted;
  }

  async withdraw(userId: string, purpose: MarketingPurpose): Promise<void> {
    const history = await this.consents.history(userId);
    const last = latestConsent(history, userId, purpose);
    if (last === undefined || !last.granted) return; // already not granted: nothing to withdraw
    await this.consents.append(
      [
        {
          userId,
          purpose,
          version: last.version,
          granted: false,
          method: "support_agent_on_request",
          at: new Date().toISOString(),
          // Provider-driven opt-out (STOP, hard bounce): there is no client IP.
          ipHash: "0".repeat(32),
        },
      ],
      [],
    );
  }
}

/**
 * A provider with no credentials/contract. It FAILS AT CALL TIME with the error built by `fail`
 * (the composition passes ProviderNotConfiguredError, 503 provider_not_configured). The
 * dispatcher records that as a FAILED delivery attempt and retries per policy; it is never SENT.
 */
export class UnconfiguredChannelProvider<C extends ExternalChannel> implements ChannelProvider<C> {
  constructor(
    readonly code: string,
    readonly channel: C,
    private readonly fail: (operation: string) => Error,
  ) {}
  async send(_message: ProviderMessage & { readonly channel: C }): Promise<ProviderResult> {
    throw this.fail("send");
  }
}

export function unconfiguredProviderRegistry(fail: Readonly<Record<ExternalChannel, (operation: string) => Error>>): ProviderRegistry {
  const byChannel: Readonly<Record<ExternalChannel, readonly ChannelProvider[]>> = {
    push: [new UnconfiguredChannelProvider("expo_push", "push", fail.push)],
    whatsapp: [new UnconfiguredChannelProvider("wa_bsp", "whatsapp", fail.whatsapp)],
    sms: [new UnconfiguredChannelProvider("sms_primary", "sms", fail.sms)],
    email: [new UnconfiguredChannelProvider("email_primary", "email", fail.email)],
  };
  return { providersFor: (channel) => byChannel[channel] };
}

/** Structured-log publisher: ids and codes only, never recipients or text. The outbox publisher replaces it (gap). */
export class LogNotificationEvents implements NotificationEventPublisher {
  async publish(event: NotificationEvent): Promise<void> {
    process.stdout.write(`${JSON.stringify({ level: "info", event: event.type, request_id: event.requestId })}\n`);
  }
}

/** Analytics are consent gated and the warehouse is Unconfigured: drop, never queue personal data. */
export class DroppingAnalytics implements AnalyticsPort {
  async track(): Promise<void> {}
}

/**
 * Postgres `inbox_processed` consumer dedupe. The mark is taken first; when the effect throws the
 * mark is removed so the redelivery retries (at-least-once, effects are idempotent).
 */
export class KyselyInboxProcessed implements InboxProcessedPort {
  constructor(private readonly db: Kysely<Record<string, never>>) {}

  async runOnce<T>(consumer: string, messageId: string, fn: () => Promise<T>) {
    const fresh = await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql<{ message_id: string }>`
        insert into inbox_processed (consumer, message_id) values (${consumer}, ${messageId}::uuid)
        on conflict do nothing returning message_id::text as message_id`.execute(trx);
      return r.rows[0] !== undefined;
    });
    if (!fresh) return { kind: "duplicate" as const };
    try {
      return { kind: "done" as const, value: await fn() };
    } catch (e) {
      await this.db.transaction().execute(async (trx) => {
        await sql`select set_config('app.role', 'system', true)`.execute(trx);
        await sql`delete from inbox_processed where consumer = ${consumer} and message_id = ${messageId}::uuid`.execute(trx);
      });
      throw e;
    }
  }
}
