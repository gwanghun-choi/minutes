import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke against the real production bundle.
 *
 * `vite preview` serves exactly what `npm run build` produced, with the same
 * SPA history fallback FastAPI gives it in production. The API is stubbed in
 * the browser, so this run needs no database, no models, and no credentials —
 * what it proves is that the shipped bundle renders and its interactions work
 * in a real engine.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
