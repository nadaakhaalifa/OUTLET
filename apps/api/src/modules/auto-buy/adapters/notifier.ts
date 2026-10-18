import type { ModuleRef } from "@nestjs/core";
import { SEND_NOTIFICATION, type SendNotification } from "../../notifications";
import type { Notice, NoticeKind, NoticePort } from "../domain/ports";

/** Template keys seeded by notifications (auto-buy-templates.ts). */
export const NOTICE_TEMPLATE: Readonly<Record<NoticeKind, string>> = {
  target_reached: "auto_buy_target_reached",
  pre_charge: "auto_buy_pre_charge",
  charged: "auto_buy_charged",
  not_charged: "auto_buy_not_charged",
  sca_required: "auto_buy_sca_required",
};

export interface SendFn {
  execute(input: {
    readonly userId: string;
    readonly templateKey: string;
    readonly ref: string;
    readonly payload: Readonly<Record<string, string | number>>;
    readonly deepLink?: string | null;
    readonly expiresAtMs?: number;
  }): ReturnType<SendNotification["execute"]>;
}

/**
 * Sends through the notifications module (channel choice, suppression, delivery log live there).
 * "accepted" means the request was durably accepted (or already was): the charge path treats
 * anything else as "no notice, no charge". `ref` is `{attempt}:{kind}`, so a retry is a duplicate.
 */
export class NotificationsNoticePort implements NoticePort {
  constructor(private readonly sender: () => SendFn) {}

  static lazy(ref: ModuleRef): NotificationsNoticePort {
    return new NotificationsNoticePort(() => ref.get<SendNotification>(SEND_NOTIFICATION, { strict: false }));
  }

  async send(n: Notice): Promise<"accepted" | "failed"> {
    const r = await this.sender().execute({
      userId: n.userId,
      templateKey: NOTICE_TEMPLATE[n.kind],
      ref: `${n.attemptId}:${n.kind}`,
      payload: {},
      deepLink: `/auto-buy/attempts/${n.attemptId}`,
      // A notice that cannot go out inside its own window is useless; others live a day.
      ...(n.cancelDeadlineMs !== null ? { expiresAtMs: n.cancelDeadlineMs } : {}),
    });
    switch (r.kind) {
      case "rejected":
        return "failed";
      case "duplicate":
        return r.status === "FAILED" || r.status === "CANCELLED" ? "failed" : "accepted";
      case "accepted":
        // SUPPRESSED still counts as a notice only if the in-app inbox mirror was written.
        if (r.status === "FAILED" || r.status === "CANCELLED") return "failed";
        return r.inbox || r.status !== "SUPPRESSED" ? "accepted" : "failed";
    }
  }
}
