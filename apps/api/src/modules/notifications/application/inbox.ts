import type { Clock, InboxRepository, PushToken, PushTokenRepository } from "../domain/ports";
import type { InboxMessage } from "../domain/types";

export type ListInboxResult =
  | { readonly kind: "page"; readonly items: readonly InboxMessage[]; readonly nextCursor: string | null }
  | { readonly kind: "invalid_cursor" };

const encodeCursor = (m: InboxMessage): string => Buffer.from(`${m.createdAtMs}:${m.id}`, "utf8").toString("base64url");

function decodeCursor(c: string): { createdAtMs: number; id: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(c, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const m = /^(\d{1,15}):([0-9a-f-]{36})$/.exec(raw);
  if (m === null) return null;
  return { createdAtMs: Number(m[1]), id: m[2] as string };
}

export class ListInbox {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string, page: { cursor: string | undefined; limit: number }): Promise<ListInboxResult> {
    const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
    if (page.cursor !== undefined && after === null) return { kind: "invalid_cursor" };
    const rows = await this.inbox.list(userId, after, page.limit + 1, this.clock.nowMs());
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    const more = rows.length > page.limit && last !== undefined;
    return { kind: "page", items, nextCursor: more ? encodeCursor(last) : null };
  }
}

export class MarkInboxRead {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly clock: Clock,
  ) {}

  /** All or nothing: a foreign or missing id is "not found" for the whole call. */
  async execute(userId: string, ids: readonly string[]): Promise<{ readonly kind: "ok" } | { readonly kind: "not_found" }> {
    const unique = [...new Set(ids)];
    return (await this.inbox.markRead(userId, unique, this.clock.nowMs())) ? { kind: "ok" } : { kind: "not_found" };
  }
}

export class RegisterPushToken {
  constructor(
    private readonly tokens: PushTokenRepository,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string, token: PushToken): Promise<void> {
    await this.tokens.upsert(userId, token, this.clock.nowMs());
  }
}
