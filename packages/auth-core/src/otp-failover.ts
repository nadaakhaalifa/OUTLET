import type { OtpSender, OtpSendRequest } from "./ports";

export type FailoverAttempt = { senderId: string; channel: string; ok: boolean; reason: string | null };

export type FailoverResult =
  | { ok: true; senderId: string; providerMessageId: string; attempts: FailoverAttempt[] }
  | { ok: false; attempts: FailoverAttempt[] };

/**
 * Tries each sender in order (spec: SMS provider, second SMS provider, then WhatsApp).
 * Any failure moves to the next sender; thrown errors count as retryable failures.
 */
export async function sendWithFailover(chain: readonly OtpSender[], request: OtpSendRequest): Promise<FailoverResult> {
  const attempts: FailoverAttempt[] = [];
  for (const sender of chain) {
    try {
      const r = await sender.send(request);
      if (r.ok) {
        attempts.push({ senderId: sender.id, channel: sender.channel, ok: true, reason: null });
        return { ok: true, senderId: sender.id, providerMessageId: r.providerMessageId, attempts };
      }
      attempts.push({ senderId: sender.id, channel: sender.channel, ok: false, reason: r.reason });
    } catch {
      attempts.push({ senderId: sender.id, channel: sender.channel, ok: false, reason: "sender_threw" });
    }
  }
  return { ok: false, attempts };
}
