import { defineConfig } from "@playwright/test";

const app = process.env.E2E_APP ?? "seller";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 90_000,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: `/tmp/e2e-${app}-results.json` }]],
  use: { baseURL: process.env.E2E_BASE ?? "http://localhost:3001", trace: "off" },
  // Visual regression is opt-in (E2E_VISUAL=1) and never part of the default gate: see docs/engineering/visual-regression.md.
  snapshotPathTemplate: "{testDir}/../visual-baselines/{projectName}/{testFilePath}/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2, animations: "disabled" } },
  projects: process.env.E2E_VISUAL === "1"
    ? [{ name: "visual", testMatch: /visual\.spec\.ts/, use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } }]
    : [
        { name: "desktop", testIgnore: /visual\.spec/, use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
        { name: "mobile", testIgnore: /visual\.spec/, use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
      ],
});
