import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { BACKEND_PORT, WEB_PORT } from "../playwright.config"

export const PASSPHRASE = "e2e passphrase"

export async function waitFor(what: string, ok: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const backendEntry = path.join(repoRoot, "apps/backend/dist/index.js")
const pidFile = (root: string): string => path.join(root, "backend.pid")

/** Starts the backend against the scratch core under `root`; its pid goes to `<root>/backend.pid` so any process can stop it. */
export function startBackend(root: string, ports: { backend: number; web: number } = { backend: BACKEND_PORT, web: WEB_PORT }): void {
  const backend = spawn("node", [backendEntry], {
    // herdr-app's shared.json: a file of its own in the scratch root (there is none), never the real one under ~/.config
    env: { ...scratchEnv(root), HW_HERDR_APP_SHARED: path.join(root, "herdr-app-shared.json"), HERDR_WEB_PASSPHRASE: PASSPHRASE, HERDR_WEB_ORIGINS: `http://localhost:${ports.web}`, PORT: String(ports.backend) },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true, // outlives the worker that restarts it; global teardown stops it
  })
  backend.unref()
  fs.writeFileSync(pidFile(root), String(backend.pid))
}

/** Stops the backend started by `startBackend` (the pid in `<root>/backend.pid`, nothing found by name). */
export function stopBackend(root: string): void {
  let pid: number
  try {
    pid = Number(fs.readFileSync(pidFile(root), "utf8"))
  } catch {
    return
  }
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const repo = repoRoot
  if (!fs.existsSync(backendEntry)) throw new Error("Build the backend first: pnpm build")

  const root = fs.mkdtempSync("/tmp/hw-e2e-") // short on purpose: a unix socket path must stay under ~100 characters
  // Every `hc` call and the backend run under this environment, built by the same guard as scripts/scratch-run.
  const env = scratchEnv(root)
  process.env.HW_E2E_ROOT = root // the test file and its workers read it
  const stopper = path.join(repo, "scripts/scratch-stop")

  execFileSync("hc", ["server", "start"], { env, stdio: "ignore" })

  startBackend(root)
  const stopAll = async (): Promise<void> => {
    stopBackend(root)
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
