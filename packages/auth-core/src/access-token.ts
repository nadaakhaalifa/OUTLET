import { z } from "zod";
import { InvalidTokenShapeError } from "./errors";
import { MS } from "./ports";

export const ACCESS_TOKEN_TTL_MS = 10 * MS.minute;

export const audienceSchema = z.enum(["buyer_api", "seller_api", "admin_api"]);
export type Audience = z.infer<typeof audienceSchema>;

/** Authentication methods references (RFC 8176 style where one exists). */
export const amrSchema = z.enum(["otp_sms", "otp_whatsapp", "apple", "google", "passkey", "email_link", "attestation", "webauthn", "totp"]);
export type Amr = z.infer<typeof amrSchema>;

/** A seller enrolment token (phone OTP only) may live 30 minutes, cannot be refreshed, and is scope limited. */
export const SELLER_ENROL_SCOPE = "seller:enrol";
export const SELLER_ENROL_TTL_MS = 30 * MS.minute;

export const accessClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  aud: audienceSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
  /** Session id, so revocation can be checked on sensitive routes. */
  sid: z.string().min(1),
  amr: z.array(amrSchema).min(1),
  /** Present only on seller enrolment tokens. Absent on every full session token. */
  scope: z.literal(SELLER_ENROL_SCOPE).optional(),
}).refine(
  (c) => c.exp > c.iat && c.exp - c.iat <= (c.scope === SELLER_ENROL_SCOPE ? SELLER_ENROL_TTL_MS : ACCESS_TOKEN_TTL_MS) / 1000,
  { message: "lifetime exceeds the limit for this token type" },
).refine((c) => c.scope !== SELLER_ENROL_SCOPE || (c.aud === "seller_api" && !c.amr.some((a) => a === "webauthn" || a === "totp" || a === "passkey")), {
  message: "enrol tokens are seller tokens without a strong factor",
});
export type AccessClaims = z.infer<typeof accessClaimsSchema>;

/** Claims only: signing (JWT) is an adapter concern. Times are epoch seconds. */
export function buildAccessClaims(input: {
  issuer: string;
  userId: string;
  audience: Audience;
  sessionId: string;
  jti: string;
  amr: readonly Amr[];
  nowMs: number;
  /** Seller enrolment token: 30 minute lifetime, scope `seller:enrol`. */
  enrol?: boolean;
}): AccessClaims {
  const iat = Math.floor(input.nowMs / 1000);
  const parsed = accessClaimsSchema.safeParse({
    iss: input.issuer,
    sub: input.userId,
    aud: input.audience,
    iat,
    exp: iat + (input.enrol === true ? SELLER_ENROL_TTL_MS : ACCESS_TOKEN_TTL_MS) / 1000,
    jti: input.jti,
    sid: input.sessionId,
    amr: [...new Set(input.amr)],
    ...(input.enrol === true ? { scope: SELLER_ENROL_SCOPE } : {}),
  });
  if (!parsed.success) throw new InvalidTokenShapeError(parsed.error.message);
  return parsed.data;
}

export type ClaimsCheck = { ok: true; claims: AccessClaims } | { ok: false; reason: "malformed" | "expired" | "wrong_audience" | "not_yet_valid" };

export function checkAccessClaims(raw: unknown, expectedAudience: Audience, nowMs: number): ClaimsCheck {
  const parsed = accessClaimsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const c = parsed.data;
  if (c.aud !== expectedAudience) return { ok: false, reason: "wrong_audience" };
  const nowS = Math.floor(nowMs / 1000);
  if (c.iat > nowS + 30) return { ok: false, reason: "not_yet_valid" };
  if (nowS >= c.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims: c };
}
