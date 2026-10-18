import { getApiRuntime, getSharedClient } from "../../services/runtime";

/** Real revoke through the generated client, or null when no API runtime is configured (fake mode). */
export function remoteRevoker(): (() => Promise<void>) | null {
  const rt = getApiRuntime();
  if (rt === null) return null;
  return async () => {
    await getSharedClient(rt).logout();
  };
}
