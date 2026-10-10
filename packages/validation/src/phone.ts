import { z } from "zod";

/** E.164: "+", a non-zero first digit, 7 to 15 digits in total. */
export const E164Schema = z.string().regex(/^\+[1-9][0-9]{6,14}$/, "must be an E.164 phone number");

/** Egypt-only allow-list used at launch for OTP (SMS pumping control, spec 1). */
export const EgyptE164Schema = z.string().regex(/^\+20[0-9]{10}$/, "must be an Egyptian E.164 phone number");

/** Last three digits only, for display (OpenAPI Me.phone_masked). Throws on malformed input. */
export function maskPhone(e164: string): string {
  const r = E164Schema.parse(e164);
  return `${"*".repeat(r.length - 3)}${r.slice(-3)}`;
}
