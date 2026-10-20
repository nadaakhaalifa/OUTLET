import { redirect } from "next/navigation";

/**
 * The unscoped /v1/seller/team routes were never served and are deleted (ADR-0050). The working,
 * store-scoped team screen is /settings/team (invites and member changes under /v1/seller/stores/{id}/team).
 */
export default function TeamPage(): never {
  redirect("/settings/team");
}
