import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { checkRoot, scratchEnv } from "../scratch-env.mjs"

const scripts = path.resolve(import.meta.dirname, "..")
const run = path.join(scripts, "scratch-run")
const stop = path.join(scripts, "scratch-stop")

// A root has to be under /tmp, and os.tmpdir() is not that on macOS.
const made: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync("/tmp/hw-sr-")
  made.push(d)
  return d
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const POISON = {
  HC_SOCKET: "/real/core.sock",
  HC_SCOPE: "real",
  HC_TERMINAL_SOCKET: "/real/terminal.sock",
  HC_TERMINAL_ID: "t2m",
  XDG_RUNTIME_DIR: "/run/real",
  HC_SESSION: "default",
  XDG_STATE_HOME: "/real/state",
  XDG_CONFIG_HOME: "/real/config",
  PI_LIVE_DIR: "/real/pi/agent/live",
}

function scratchRun(root: string | undefined, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...POISON, ...extra }
  if (root !== undefined) env.HW_SCRATCH = root
  return spawnSync(run, args, { env, encoding: "utf8" })
}

function envOf(root: string, base: NodeJS.ProcessEnv = {}): Record<string, string> {
  const r = scratchRun(root, ["env"], base)
  expect(r.status).toBe(0)
  return Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
}

describe("scratch-run", () => {
  it("hides the four HC_ names and XDG_RUNTIME_DIR from the command and sets the three scratch values", () => {
    const root = tmp()
    const seen = envOf(root)
    expect(Object.keys(seen).filter((k) => /^(HC_|XDG_)/.test(k)).sort()).toEqual(["HC_SESSION", "XDG_CONFIG_HOME", "XDG_STATE_HOME"])
    expect(seen.HC_SESSION).toBe("herdr-web-test")
    expect(seen.XDG_STATE_HOME).toBe(`${root}/state`)
    expect(seen.XDG_CONFIG_HOME).toBe(`${root}/config`)
  })

  it("points pi-live's folder into the root, whatever the caller had set, and makes it", () => {
    const root = path.join(tmp(), "deeper", "root")
    const seen = envOf(root)
    expect(seen.PI_LIVE_DIR).toBe(`${root}/live`)
    expect(fs.statSync(`${root}/live`).isDirectory()).toBe(true)
  })

  it("creates the state and config folders under the root", () => {
    const root = path.join(tmp(), "deeper", "root")
    expect(scratchRun(root, ["true"]).status).toBe(0)
    expect(fs.statSync(`${root}/state`).isDirectory()).toBe(true)
    expect(fs.statSync(`${root}/config`).isDirectory()).toBe(true)
  })

  it("runs the command with its own arguments and exit status", () => {
    const root = tmp()
    const r = scratchRun(root, ["sh", "-c", 'printf "%s|%s" "$1" "$2"; exit 7', "sh", "a b", "c"])
    expect(r.stdout).toBe("a b|c")
    expect(r.status).toBe(7)
  })

  it("defaults the root to /tmp/hw-scratch", () => {
    const r = scratchRun(undefined, ["sh", "-c", 'printf %s "$XDG_STATE_HOME"'])
    // Only check the value: /tmp/hw-scratch may already be somebody else's, and a folder there is harmless.
    expect(r.stdout).toBe("/tmp/hw-scratch/state")
  })

  it("takes a relative root as relative to the working directory", () => {
    const root = tmp()
    const r = spawnSync(run, ["sh", "-c", 'printf %s "$XDG_STATE_HOME"'], { env: { PATH: process.env.PATH, HW_SCRATCH: "sub/root" }, cwd: root, encoding: "utf8" })
    // The working directory is under /tmp, so the root is accepted. The shell reports the working
    // directory with links resolved, which on macOS is /private/tmp.
    expect(r.stdout).toBe(`${fs.realpathSync(root)}/sub/root/state`)
  })

  describe("refuses a root that is not under /tmp", () => {
    const home = os.homedir()
    const cases: [string, () => string][] = [
      ["a folder in the home directory", () => path.join(home, `hw-refused-${process.pid}`)],
      ["/tmp itself", () => "/tmp"],
      ["a relative path that climbs out of /tmp", () => path.relative(process.cwd(), path.join(home, `hw-refused-${process.pid}`))],
      ["'..' climbing out of /tmp", () => `${tmp()}/a/../../../${home.slice(1)}/hw-refused-${process.pid}`],
      ["a link inside /tmp that leads outside it", () => {
        const link = path.join(tmp(), "link")
        fs.symlinkSync(home, link)
        return path.join(link, `hw-refused-${process.pid}`)
      }],
    ]
    for (const [name, root] of cases) {
      it(name, () => {
        const marker = path.join(tmp(), "ran")
        const r = scratchRun(root(), ["touch", marker])
        expect(r.status).not.toBe(0)
        expect(r.stderr).toMatch(/scratch-run: refusing|cannot be/)
        expect(fs.existsSync(marker)).toBe(false)
        expect(fs.existsSync(path.join(home, `hw-refused-${process.pid}`))).toBe(false)
      })
    }

    it("without a command", () => {
      const r = scratchRun(tmp(), [])
      expect(r.status).not.toBe(0)
    })
  })
})

describe("scratch-env.mjs agrees with scratch-run", () => {
  it("builds the same environment", () => {
    const root = tmp()
    const fromScript = envOf(root)
    const fromNode = scratchEnv(root, { ...POISON, PATH: process.env.PATH, HOME: process.env.HOME })
    for (const k of ["HC_SESSION", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "PI_LIVE_DIR"]) expect(fromNode[k]).toBe(fromScript[k])
    expect(fromNode.PI_LIVE_DIR).toBe(`${root}/live`)
    for (const k of ["HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "XDG_RUNTIME_DIR"]) expect(fromNode[k]).toBeUndefined()
    expect(fromNode.PATH).toBe(process.env.PATH)
  })

  it("accepts and refuses the same roots, and a refused root creates nothing", () => {
    const home = os.homedir()
    const link = path.join(tmp(), "link")
    fs.symlinkSync(home, link)
    const ok = [tmp(), path.join(tmp(), "x", "y"), "/private/tmp/hw-sr-parity"]
    const bad = [path.join(home, `hw-refused-${process.pid}`), "/tmp", "/", path.join(link, `hw-refused-${process.pid}`), `${tmp()}/a/../../../${home.slice(1)}`]
    for (const r of ok) {
      expect(() => checkRoot(r), r).not.toThrow()
      expect(spawnSync(run, ["true"], { env: { PATH: process.env.PATH, HW_SCRATCH: r.replace("/private/tmp/hw-sr-parity", tmp()) } }).status).toBe(0)
    }
    for (const r of bad) {
      expect(() => scratchEnv(r, {}), r).toThrow(/refusing|cannot be/)
      expect(scratchRun(r, ["true"]).status, r).not.toBe(0)
    }
    expect(fs.existsSync(path.join(home, `hw-refused-${process.pid}`))).toBe(false)
  })
})

describe("scratch-stop", () => {
  /** A fake `hc` that leaves a note, to prove nothing calls it (any real `hc` starts a core). */
  function fakeHc(): { dir: string; note: string } {
    const dir = tmp()
    const note = path.join(dir, "hc-was-called")
    fs.writeFileSync(path.join(dir, "hc"), `#!/bin/sh\ntouch '${note}'\nexit 1\n`, { mode: 0o755 })
    return { dir, note }
  }
  function scratchStop(root: string, args: string[] = [], pathPrefix?: string) {
    const PATH = pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH
    return spawnSync(stop, args, { env: { PATH, HOME: process.env.HOME, ...POISON, HW_SCRATCH: root }, encoding: "utf8" })
  }

  it("with no core running exits 0 and does not call hc", () => {
    const root = tmp()
    const fake = fakeHc()
    const r = scratchStop(root, [], fake.dir)
    expect(r.status).toBe(0)
    expect(fs.existsSync(fake.note)).toBe(false)
    expect(fs.existsSync(root)).toBe(true)
  })

  it("--delete removes the root once nothing holds it", () => {
    const root = tmp()
    scratchRun(root, ["true"])
    const r = scratchStop(root, ["--delete"])
    expect(r.status).toBe(0)
    expect(fs.existsSync(root)).toBe(false)
  })

  it("refuses a root outside /tmp without creating or removing anything", () => {
    const root = path.join(os.homedir(), `hw-refused-${process.pid}`)
    const r = scratchStop(root, ["--delete"])
    expect(r.status).not.toBe(0)
    expect(fs.existsSync(root)).toBe(false)
  })

  it("rejects an unknown argument", () => {
    expect(scratchStop(tmp(), ["--now"]).status).toBe(2)
  })

  it("names the process that still holds a file under the root, exits 1 and keeps the root, even with --delete", async () => {
    const root = tmp()
    scratchRun(root, ["true"])
    const file = `${root}/state/held`
    fs.writeFileSync(file, "")
    // `tail -f` keeps the file open without being a core, so the stop has nothing to call `hc` for.
    const holder = spawn("tail", ["-f", file], { stdio: "ignore" })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const fake = fakeHc()
      const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const p = spawn(stop, ["--delete"], { env: { PATH: `${fake.dir}:${process.env.PATH}`, HW_SCRATCH: root }, stdio: ["ignore", "ignore", "pipe"] })
        let stderr = ""
        p.stderr.on("data", (d) => (stderr += d))
        p.on("close", (status) => resolve({ status, stderr }))
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`${holder.pid} tail`)
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.existsSync(fake.note)).toBe(false)
      expect(holder.killed).toBe(false) // it was only named
    } finally {
      holder.kill()
    }
  }, 30_000)
})
