/** Route classes for the proxy and the layout. Pure so the rules are unit-tested. */

const startsWithSegment = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`);

/** Reachable with no cookie at all. */
export const isPublicPath = (path: string): boolean => path === "/login";

/** Reachable with an enrol token (OTP verified) or a full session: the brand application flow. */
export const isApplicantPath = (path: string): boolean => startsWithSegment(path, "/apply") || path === "/start";

/** Rendered without the store sidebar (no store exists yet, or the page is the sign-in itself). */
export const isBarePath = (path: string): boolean => isPublicPath(path) || isApplicantPath(path);
