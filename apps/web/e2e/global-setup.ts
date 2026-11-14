import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { BACKEND_PORT, WEB_PORT } from "../playwright.config"

export const PASSPHRASE = "e2e passphrase"

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const repo = path.resolve(import.meta.dirname, "../../..")
  const backendEntry = path.join(repo, "apps/backend/dist/index.js")
  if (!fs.existsSync(backendEntry)) throw new Error("Build the backend first: pnpm build")

  const root = fs.mkdtempSync("/tmp/hw-e2e-") // short on purpose: a unix socket path must stay under ~100 characters
  // Every `hc` call and the backend run under this environment, built by the same guard as scripts/scratch-run.
  const env = scratchEnv(root)
  process.env.HW_E2E_ROOT = root // the test file and its workers read it
  const stopper = path.join(repo, "scripts/scratch-stop")

  execFileSync("hc", ["server", "start"], { env, stdio: "ignore" })

  const backend: ChildProcess = spawn("node", [backendEntry], {
    env: { ...env, HERDR_WEB_PASSPHRASE: PASSPHRASE, HERDR_WEB_ORIGINS: `http://localhost:${WEB_PORT}`, PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  })
  const stopAll = async (): Promise<void> => {
    const exited = new Promise<void>((resolve) => (backend.exitCode !== null ? resolve() : backend.once("exit", () => resolve())))
    backend.kill()
    await exited
    // Stops the core (kept terminals included), checks nothing still holds the root, then removes it.
    execFileSync(stopper, ["--delete"], { env: { ...process.env, HW_SCRATCH: root }, stdio: "inherit" })
  }
  try {
    await waitFor("the backend", async () => (await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`)).ok)
  } catch (e) {
    await stopAll()
    throw e
  }

  return stopAll
}
