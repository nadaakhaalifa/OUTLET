import { hmacSha256, toHex, utf8 } from "@outlet/auth-core";
import type { ConsentHistory, ConsentRecord, Hasher } from "@outlet/privacy";
import type { ConsentRepository } from "../domain/ports";

/** DEVELOPMENT FIXTURE: in-memory append-only consent log, lost on restart. */
export class InMemoryConsentRepository implements ConsentRepository {
  private readonly log: ConsentRecord[] = [];

  async history(userId: string): Promise<ConsentHistory> {
    return this.log.filter((r) => r.userId === userId);
  }
  async append(records: readonly ConsentRecord[]): Promise<void> {
    this.log.push(...records);
  }
}

/** Keyed hash of the client IP (HMAC-SHA-256, hex). The raw IP is never stored. */
export function createIpHasher(key: Uint8Array): Hasher {
  return (input) => toHex(hmacSha256(key, utf8(`ip:v1:${input}`)));
}
