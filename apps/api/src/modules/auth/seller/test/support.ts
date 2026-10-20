import { randomBytes } from "node:crypto";
import { issueFamily as coreIssueFamily, type Csprng } from "@outlet/auth-core";

export const nodeFriendlyRng = (): Csprng => ({ randomBytes: (n) => new Uint8Array(randomBytes(n)) });

export function issueFamily(userId: string, deviceId: string) {
  return coreIssueFamily({ familyId: crypto.randomUUID(), userId, deviceId, recordId: crypto.randomUUID(), rng: nodeFriendlyRng(), nowMs: 1000 });
}
