import axe from "axe-core";
import { expect } from "vitest";

/** Runs axe on a container. color-contrast and region need a real layout engine: contrast is covered by ui-tokens tests. */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}
