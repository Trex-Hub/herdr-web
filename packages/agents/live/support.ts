// What the live tests share: a scratch core, the checks that pi's own files and the real core
// were left alone, and a few waiting helpers. Nothing here touches the real core: every `hc` call
// takes the environment of scripts/scratch-env.mjs.
import { execFileSync, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"

export const repo = path.resolve(import.meta.dirname, "../../..")
export const extension = path.join(repo, "packages/pi-extension")
export const LLAMA = "~/.pi/agent/npm/node_modules/@danielmeneses/pi-llama-swap".replace("~", os.homedir())
export const LOCAL_MODEL = "llama-swap/zorro-davidau-3.8-flash-next"

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until<T>(what: string, f: () => T | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** A scratch root of its own under /tmp, and `hc` bound to it. */
export function scratch(prefix: string) {
  const root = fs.mkdtempSync(`/tmp/${prefix}`)
  const env = scratchEnv(root)
  const work = path.join(root, "work")
  const sessions = path.join(root, "pi-sessions")
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(sessions, { recursive: true })
  const hc = (...args: string[]): string => execFileSync("hc", args, { env, encoding: "utf8" })
  /** Every terminal kept off and killed, then the core stopped, as scripts/scratch-stop does. */
  const stopCore = (): void => {
    try {
      const ls = JSON.parse(hc("ls", "--json")) as { terminals: { address: string; state: string }[] }
      for (const t of ls.terminals) {
        if (t.state === "live") {
          hc("keep", t.address, "--off")
          hc("kill", t.address)
        }
      }
      hc("server", "stop")
    } catch (e) {
      console.error("could not stop the scratch core cleanly:", e)
    }
  }
  return { root, env, work, sessions, hc, stopCore }
}

// ---- what the tests must not change ----------------------------------------------------------

const agentDir = path.join(os.homedir(), ".pi/agent")

/** settings.json and the extensions folder of a person's own pi, as a string to compare before and after. */
export function fingerprint(): string {
  const parts: string[] = []
  const sum = (p: string) => crypto.createHash("sha256").update(fs.existsSync(p) ? fs.readFileSync(p) : "absent").digest("hex")
  parts.push(`settings.json ${sum(path.join(agentDir, "settings.json"))}`)
  const ext = path.join(agentDir, "extensions")
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name)
      return e.isDirectory() ? walk(p) : [`${path.relative(ext, p)} ${fs.statSync(p).size} ${fs.statSync(p).mtimeMs}`]
    })
  parts.push(fs.existsSync(ext) ? `extensions\n${walk(ext).sort().join("\n")}` : "extensions absent")
  return parts.join("\n")
}

/**
 * Other pis (a person's own) write to ~/.pi/agent/sessions all the time, so the folder cannot be
 * compared as a whole. What matters is that none of the test's sessions went there: no session file
 * written since the test began names the scratch root as its folder.
 */
export function strayedSessions(root: string, since: number): string[] {
  const base = path.join(agentDir, "sessions")
  if (!fs.existsSync(base)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since) {
        const head = fs.readFileSync(p, "utf8").slice(0, 2000)
        if (head.includes(root) || head.includes(fs.realpathSync(root))) out.push(p)
      }
    }
  }
  walk(base)
  return out
}

/** The pids of every `herdr-core serve` on this machine (read-only: pgrep). */
export function corePids(): number[] {
  const out = spawnSync("pgrep", ["-f", "herdr-core serve"], { encoding: "utf8" }).stdout
  return out.split("\n").filter(Boolean).map(Number)
}
