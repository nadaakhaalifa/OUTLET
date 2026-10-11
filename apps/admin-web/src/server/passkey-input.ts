import { z } from "zod";

const credential = z
  .object({
    id: z.string().min(1).max(1024),
    raw_id: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z
      .object({
        client_data_json: z.string().min(1).max(8192),
        authenticator_data: z.string().min(1).max(8192),
        signature: z.string().min(1).max(8192),
        user_handle: z.string().max(1024).nullable(),
      })
      .strict(),
  })
  .strict();

/** Validates what the browser sends to the sign-in action. Anything else is dropped before it reaches the API. */
export function serializeAssertionInput(
  challengeId: string,
  credentialJson: string,
): { challengeId: string; credential: z.infer<typeof credential> } | null {
  if (!z.uuid().safeParse(challengeId).success || credentialJson.length > 20_000) return null;
  try {
    const c = credential.safeParse(JSON.parse(credentialJson));
    return c.success ? { challengeId, credential: c.data } : null;
  } catch {
    return null;
  }
}
