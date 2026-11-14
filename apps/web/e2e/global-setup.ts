import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { BACKEND_PORT, WEB_PORT } from "../playwright.config"

export const PASSPHRASE = "e2e passphrase"

/** The environment every `hc` call and the backend run under: a scratch core, never the real one. */
export function scratchEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ["HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID"]) delete env[k]
  return { ...env, HC_SESSION: "herdr-web-test", XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: path.join(root, "config") }
}

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
  fs.mkdirSync(path.join(root, "state"))
  fs.mkdirSync(path.join(root, "config"))
  const env = scratchEnv(root)
  // The test file and its workers inherit these.
  Object.assign(process.env, { HW_E2E_ROOT: root, HC_SESSION: env.HC_SESSION, XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME })
  for (const k of ["HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID"]) delete process.env[k]

  execFileSync("hc", ["server", "start"], { env, stdio: "ignore" })

  const backend: ChildProcess = spawn("node", [backendEntry], {
    env: { ...env, HERDR_WEB_PASSPHRASE: PASSPHRASE, HERDR_WEB_ORIGINS: `http://localhost:${WEB_PORT}`, PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  })
  await waitFor("the backend", async () => (await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`)).ok)

  return async () => {
    backend.kill()
    try {
      execFileSync("hc", ["server", "stop"], { env, stdio: "ignore" })
    } catch {
      // already stopped by the test
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}
