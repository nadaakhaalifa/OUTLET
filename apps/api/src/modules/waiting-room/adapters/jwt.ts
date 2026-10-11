import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdmissionClaims } from "../domain/bridge";
import type { AdmissionCodec } from "../domain/ports";

const b64 = (b: Buffer): string => b.toString("base64url");
const MAX_TOKEN_LEN = 2048;

const Header = z.object({ alg: z.literal("HS256"), typ: z.literal("JWT"), kid: z.string().min(1).max(64) }).strict();
const Payload = z
  .object({
    jti: z.string().min(1).max(64),
    sub: z.string().min(1).max(64),
    drop: z.string().min(1).max(64),
    dev: z.string().length(64),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    aud: z.literal("drop-admission"),
  })
  .strict();

/** HS256 admission token. Seconds on the wire; claims are in ms inside the app. */
export function signAdmission(c: AdmissionClaims, kid: string, key: Uint8Array): string {
  const head = b64(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid })));
  const body = b64(
    Buffer.from(
      JSON.stringify({
        jti: c.jti,
        sub: c.userId,
        drop: c.dropId,
        dev: c.deviceHash,
        iat: Math.floor(c.iatMs / 1000),
        exp: Math.floor(c.expMs / 1000),
        aud: "drop-admission",
      }),
    ),
  );
  const sig = b64(createHmac("sha256", key).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export type ParsedToken =
  | { readonly ok: true; readonly claims: AdmissionClaims; readonly kid: string; readonly signingInput: string; readonly sig: Buffer }
  | { readonly ok: false; readonly code: "malformed" };

export function parseAdmission(token: string): ParsedToken {
  if (token.length > MAX_TOKEN_LEN) return { ok: false, code: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, code: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  try {
    const head = Header.safeParse(JSON.parse(Buffer.from(h, "base64url").toString("utf8")));
    const pay = Payload.safeParse(JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
    if (!head.success || !pay.success) return { ok: false, code: "malformed" };
    return {
      ok: true,
      kid: head.data.kid,
      signingInput: `${h}.${p}`,
      sig: Buffer.from(s, "base64url"),
      claims: {
        jti: pay.data.jti,
        userId: pay.data.sub,
        dropId: pay.data.drop,
        deviceHash: pay.data.dev,
        iatMs: pay.data.iat * 1000,
        expMs: pay.data.exp * 1000,
      },
    };
  } catch {
    return { ok: false, code: "malformed" };
  }
}

export function signatureValid(p: { signingInput: string; sig: Uint8Array }, key: Uint8Array): boolean {
  const want = createHmac("sha256", key).update(p.signingInput).digest();
  return want.length === p.sig.length && timingSafeEqual(want, p.sig);
}

/** The adapter instance the module injects into the application layer. */
export const jwtAdmissionCodec: AdmissionCodec = { sign: signAdmission, parse: parseAdmission, signatureValid };
