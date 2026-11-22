import { defineConfig } from "@playwright/test"

/**
 * The live browser test: the web app in a browser, the real backend, a scratch core and a real pi with pi-live loaded,
 * on the local model. Run by `pnpm test:agents` from the repo root; needs `hc`, `pi` and the local model. Ports of its own, so it
 * can run beside the others.
 */
export const LIVE_WEB_PORT = 14041
export const LIVE_BACKEND_PORT = 18441

export default defineConfig({
  testDir: "./e2e-live",
  timeout: 1_500_000,
  workers: 1,
  reporter: "list",
  globalSetup: "./e2e-live/global-setup.ts",
  use: { baseURL: `http://localhost:${LIVE_WEB_PORT}`, trace: "off" },
  webServer: {
    command: `next dev --port ${LIVE_WEB_PORT}`,
    url: `http://localhost:${LIVE_WEB_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_BACKEND_URL: `http://localhost:${LIVE_BACKEND_PORT}`, NEXT_DIST_DIR: ".next-live" },
  },
})
