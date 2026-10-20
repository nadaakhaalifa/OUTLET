import { Redirect } from "expo-router";

/** The phone number now lives on the single account screen. */
export default function PhoneRedirect() {
  return <Redirect href="/onboarding/account" />;
}
