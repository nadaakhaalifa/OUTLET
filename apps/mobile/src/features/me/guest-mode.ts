/** Pure guest-mode decision. A guest is a signed-out device on a real backend; the offline fixture build keeps its dev data. */
export type GuestMode = "unknown" | "guest" | "member";

export function resolveGuestMode(input: { readonly backendConfigured: boolean; readonly hasTokens: boolean | null }): GuestMode {
  if (!input.backendConfigured) return "member";
  if (input.hasTokens === null) return "unknown";
  return input.hasTokens ? "member" : "guest";
}
