/**
 * The chart spike is an internal engineering page (docs/research/chart-spike-results.md). It is served only when NODE_ENV is
 * development or test, or when ADMIN_CHART_SPIKE is exactly "1" (used to verify the production CSP); anything else is 404. It is never linked
 * from the nav, needs no data and renders synthetic arrays only.
 */
export function spikeEnabled(env: { readonly NODE_ENV?: string | undefined; readonly ADMIN_CHART_SPIKE?: string | undefined }): boolean {
  // Fail closed: an unset or unexpected NODE_ENV ("staging", "Production", undefined) does not enable the page.
  return env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.ADMIN_CHART_SPIKE === "1";
}
