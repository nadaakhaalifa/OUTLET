import { headerValue, type ApiRequest, type Principal } from "./http-types";
import type { Authenticator, Clock } from "./ports";
import { Problems } from "./problem";

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{16,2048})$/;

/**
 * Authenticates at most once per request and caches the result on the request. Returns null when
 * no credentials were sent. A malformed or unknown token is a 401, never "anonymous".
 */
export async function resolvePrincipal(
  req: ApiRequest,
  authenticator: Authenticator,
  clock: Clock,
): Promise<Principal | null> {
  if (req.principal !== undefined) return req.principal;
  const header = headerValue(req, "authorization");
  if (header === undefined) {
    req.principal = null;
    return null;
  }
  const m = BEARER.exec(header);
  if (!m || m[1] === undefined) throw Problems.unauthenticated("invalid_credentials");
  let result;
  try {
    result = await authenticator.authenticate(m[1], clock.nowMs());
  } catch {
    throw Problems.unavailable("authentication_unavailable");
  }
  if (result === null) throw Problems.unauthenticated("invalid_credentials");
  req.principal = result;
  return result;
}
