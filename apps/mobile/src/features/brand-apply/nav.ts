import { useRouter, type Href } from "expo-router";
import { useCallback } from "react";
import { stepsFor, nextStep, type Step } from "./model";
import { useBrandApply } from "./context";

export const ROUTE: Readonly<Record<Step | "status" | "gate", string>> = {
  gate: "/brand", type: "/brand/type", country: "/brand/country", account: "/brand/account", factor: "/brand/factor",
  details: "/brand/details", documents: "/brand/documents", website: "/brand/website", review: "/brand/review", status: "/brand/status",
};

/** Forward navigation that skips the website step when nothing asks for it, and never leaves a dead end. */
export function useFlowNav() {
  const router = useRouter();
  const { requirements, app } = useBrandApply();
  const steps = stepsFor(requirements, (app?.values["website_domain"] ?? "") !== "");
  const next = useCallback((from: Step) => router.push(ROUTE[nextStep(from, steps)] as Href), [router, steps]);
  const to = useCallback((s: Step | "status") => router.push(ROUTE[s] as Href), [router]);
  const replace = useCallback((s: Step | "status" | "gate") => router.replace(ROUTE[s] as Href), [router]);
  const back = useCallback(() => (router.canGoBack() ? router.back() : router.replace(ROUTE.type as Href)), [router]);
  return { steps, next, to, replace, back, router };
}
