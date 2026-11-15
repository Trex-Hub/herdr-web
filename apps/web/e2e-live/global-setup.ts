import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { startBackend, stopBackend, waitFor } from "../e2e/global-setup"
import { LIVE_BACKEND_PORT, LIVE_WEB_PORT } from "../playwright.live.config"

/** A scratch core of its own and the built backend on it; the spec reads the root from HW_LIVE_ROOT. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const repo = path.resolve(import.meta.dirname, "../../..")
  if (!fs.existsSync(path.join(repo, "apps/backend/dist/index.js"))) throw new Error("Build the backend first: pnpm build")
  const root = fs.mkdtempSync("/tmp/hwl-") // short on purpose: a unix socket path must stay under ~100 characters
  process.env.HW_LIVE_ROOT = root
  process.env.HW_E2E_ROOT = root // the helpers of e2e/scratch.ts read this one
  execFileSync("hc", ["server", "start"], { env: scratchEnv(root), stdio: "ignore" })
  startBackend(root, { backend: LIVE_BACKEND_PORT, web: LIVE_WEB_PORT })
  const stopAll = async (): Promise<void> => {
    stopBackend(root)
    execFileSync(path.join(repo, "scripts/scratch-stop"), ["--delete"], { env: { ...process.env, HW_SCRATCH: root }, stdio: "inherit" })
  }
  try {
    await waitFor("the backend", async () => (await fetch(`http://127.0.0.1:${LIVE_BACKEND_PORT}/health`)).ok)
  } catch (e) {
    await stopAll()
    throw e
  }
  return stopAll
}
