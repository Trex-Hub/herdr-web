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
  /**
   * Every terminal kept off and killed and the core stopped (`scripts/scratch-stop`). The root is removed only after a pass
   * (`--delete`, once nothing holds it); after a failure it stays, and its path is printed, so the files can be looked at.
   */
  const stopCore = (passed = true): void => {
    try {
      execFileSync(path.join(repo, "scripts/scratch-stop"), passed ? ["--delete"] : [], { env: { ...process.env, HW_SCRATCH: root }, stdio: "inherit" })
      if (!passed) console.error(`a live test failed: its scratch root is kept at ${root} (core stopped; pi's sessions are in ${sessions})`)
    } catch (e) {
      console.error(`the scratch root ${root} was left behind:`, e)
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

/**
 * How many assistant messages the session files under `dir` hold (files touched since `since`, ms). What a test that has no
 * socket to look at asks instead of reading the model's words: pi answered, whatever it said.
 */
export function assistantMessages(dir: string, since: number): number {
  let n = 0
  const walk = (d: string): void => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since) {
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          try {
            const entry = JSON.parse(line) as { type?: string; message?: { role?: string } }
            if (entry.type === "message" && entry.message?.role === "assistant") n++
          } catch {
            // a half-written last line
          }
        }
      }
    }
  }
  walk(dir)
  return n
}

// ---- how long a turn takes ---------------------------------------------------------------------

/** What a thread says about the agent, as far as a turn's clock needs it. */
export interface LiveLike {
  working: boolean
  reply?: unknown
  tools?: unknown[]
}

/**
 * Times each turn from the message being sent to the first sign of life (working, live text or a tool) and to the agent being
 * settled, and prints one line per turn when asked. A slow model shows here before it shows as a timeout.
 */
export class TurnClock {
  private readonly turns: { label: string; sentAt: number; first?: number; settled?: number }[] = []

  /** Call just before the message is sent. */
  start(label: string): void {
    this.turns.push({ label, sentAt: Date.now() })
  }

  /** Feed it every time the live state of the thread is known. */
  observe(live: LiveLike): void {
    const now = Date.now()
    for (const t of this.turns) {
      if (t.settled !== undefined) continue
      const alive = live.working || Boolean(live.reply) || (live.tools?.length ?? 0) > 0
      if (t.first === undefined) {
        if (alive) t.first = now
      } else if (!live.working) {
        t.settled = now
      }
    }
  }

  lines(): string[] {
    const sec = (a: number, b?: number) => (b === undefined ? "never" : `${((b - a) / 1000).toFixed(1)} s`)
    return this.turns.map((t) => `turn "${t.label}": first event ${sec(t.sentAt, t.first)} after send, settled ${sec(t.sentAt, t.settled)} after send`)
  }

  /** The slowest turn's first event, in seconds (null when none came). */
  slowestFirst(): number | null {
    const firsts = this.turns.map((t) => (t.first === undefined ? null : (t.first - t.sentAt) / 1000))
    return firsts.includes(null) ? null : firsts.length ? Math.max(...(firsts as number[])) : 0
  }

  print(): void {
    console.log(["", "turn times:", ...this.lines().map((l) => `  - ${l}`)].join("\n"))
  }
}
