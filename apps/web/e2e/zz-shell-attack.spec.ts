// Adversarial browser checks of the shell, on the same scratch core and backend the first spec uses.
// Named zz- so it runs after shell.spec.ts: some tests restart the backend or lock its login.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { CoreConnection } from "@herdr-web/core-client"
import { expect, test, type Page } from "@playwright/test"
import { BACKEND_PORT, WEB_PORT } from "../playwright.config"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { PASSPHRASE } from "./global-setup"

const root = (): string => process.env.HW_E2E_ROOT!
const SHOTS = "/tmp/hw-shots/dev-27"
const BACKEND = `http://localhost:${BACKEND_PORT}`
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })

type Call = { call(method: string, params: unknown): Promise<unknown> }

async function core<T>(fn: (conn: Call) => Promise<T>): Promise<T> {
  const sock = path.join(scratchEnv(root()).XDG_STATE_HOME!, "herdr-core", "herdr-web-test", "herdr-web-test.sock")
  const conn = await CoreConnection.connect({ path: sock })
  try {
    return await fn(conn as unknown as Call)
  } finally {
    conn.close()
  }
}

/** Write the desktop app's document, whatever version is there. */
async function setDoc(value: unknown): Promise<void> {
  await core(async (c) => {
    const current = (await c.call("doc.get", { name: "herdr-app" }).catch(() => null)) as { version?: number } | null
    await c.call("doc.set", { name: "herdr-app", value, version: current?.version ?? 0 })
  })
}

const block = (id: string, terminal: string) => ({ id, type: "block", size: { weight: 1 }, content: { terminal } })
const tab = (id: string, name: string, ...terminals: string[]) => ({ id, name, root: { id, type: "row", children: terminals.map((t, i) => block(`${id}-p${i}`, t)) } })
const space = (id: string, name: string, ...tabs: unknown[]) => ({ id, name, folder: `/tmp/${name}`, tabs })

const started: string[] = []

/** Start a terminal; a script that prints the given status first. Returns its address. */
function run(name: string, space: string | null, shell: string): string {
  const args = ["run", "--bg", "--name", name, ...(space ? ["--label", `herdr.space=${space}`] : []), "--", "sh", "-c", shell]
  const address = (JSON.parse(hc(...args)) as { address: string }).address
  started.push(address)
  return address
}

const osc = (state: string, extra = "") => `printf '\\033]7501;state=${state}:app=pi${extra}\\007'`

/** A terminal that reports `first`, then (when `go` exists) `then`, then idles. */
function agentScript(first: string, go: string, then: string): string {
  return `${osc(first)}; while [ ! -e ${go} ]; do sleep 0.1; done; ${osc(then)}; sleep 600`
}

test.beforeEach(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
})

test.afterEach(async () => {
  for (const a of started.splice(0)) {
    try {
      hc("kill", a)
    } catch {
      // already gone
    }
  }
  await setDoc({ spaces: [] }).catch(() => {})
})

async function signIn(page: Page, passphrase = PASSPHRASE): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(passphrase)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/$/)
  // the sidebar may be collapsed from an earlier visit: either of its two doors will do
  await expect(page.locator('[data-testid="sidebar"], [data-testid="open-sidebar"]').first()).toBeVisible()
}

const agentState = (page: Page, address: string) => page.locator(`[data-testid="agent-row"][data-address="${address}"]`)

test("agent states follow the rules live: needs you, working, done until seen, idle once seen, mark unread, pinned first", async ({ page }) => {
  const go = path.join(root(), "go-c")
  const a = run("a-blocked", "s1", `${osc("blocked", ":kind=permission")}; sleep 600`)
  const b = run("b-working", "s1", `${osc("working")}; sleep 600`)
  const c = run("c-turns", "s1", agentScript("working", go, "idle"))
  const d = run("d-pin", "s1", `${osc("idle")}; sleep 600`)
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "one", a, b, c, d))] })
  await signIn(page)

  await expect(agentState(page, a)).toHaveAttribute("data-state", "needs_you", { timeout: 3000 })
  await expect(agentState(page, b)).toHaveAttribute("data-state", "working")
  await expect(agentState(page, c)).toHaveAttribute("data-state", "working")

  // The turn ends: status goes working -> idle, core counts a turn; nobody has seen it.
  fs.writeFileSync(go, "")
  await expect(agentState(page, c)).toHaveAttribute("data-state", "done", { timeout: 3000 })

  // Another client looks at it: herdr.seen = turn.
  const turn = Number(JSON.parse(hc("get", c, "--json")).turn)
  expect(turn).toBeGreaterThan(0)
  hc("label", c, `herdr.seen=${turn}`)
  await expect(agentState(page, c)).toHaveAttribute("data-state", "idle", { timeout: 3000 })
  // ... and marks it unread again.
  hc("label", c, `herdr.seen=${turn - 1}`)
  await expect(agentState(page, c)).toHaveAttribute("data-state", "done", { timeout: 3000 })

  // Pinned goes first within its space.
  hc("label", d, "herdr.pinned=1")
  await expect(page.getByTestId("agent-row").first()).toHaveAttribute("data-address", d, { timeout: 3000 })
  hc("label", d, "herdr.pinned=")
  await expect(page.getByTestId("agent-row").first()).not.toHaveAttribute("data-address", d, { timeout: 3000 })

  // Killing an agent removes its row.
  hc("kill", b)
  await expect(agentState(page, b)).toHaveCount(0, { timeout: 3000 })
})

test("start, label and kill reach the screen within a second of the hc call", async ({ page }) => {
  const a = run("anchor", "s1", `${osc("working")}; sleep 600`)
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a))] })
  await signIn(page)
  const within = async (what: string, change: () => void, seen: () => Promise<void>) => {
    const t0 = Date.now()
    change()
    await seen()
    const ms = Date.now() - t0
    expect(ms, `${what} took ${ms} ms`).toBeLessThan(1000)
  }
  let b = ""
  await within("start", () => (b = run("newcomer", "s1", `${osc("blocked")}; sleep 600`)), () => expect(page.getByTestId("tab").filter({ hasText: "newcomer" })).toBeVisible({ timeout: 1000 }))
  await within("label", () => hc("label", b, "herdr.pinned=1"), () => expect(page.getByTestId("agent-row").first()).toHaveAttribute("data-address", b, { timeout: 1000 }))
  await within("kill", () => hc("kill", b), () => expect(page.getByTestId("agent-row").filter({ has: page.locator(`[data-address="${b}"]`) })).toHaveCount(0, { timeout: 1000 }))
  await expect(page.locator(`[data-testid="agent-row"][data-address="${b}"]`)).toHaveCount(0)
})

test("a rewritten layout, an extra terminal and a dead pane show up without a reload", async ({ page }) => {
  const a = run("in-pane", "s1", "sleep 600")
  const loose = run("loose-one", "s1", "sleep 600")
  const dead = run("dead-one", "s1", "sleep 600")
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a), tab("tb", "B", dead))] })
  await signIn(page)
  await page.evaluate(() => ((window as unknown as { __kept: number }).__kept = 1))
  await page.getByTestId("space-row").filter({ hasText: "alpha" }).click()

  // tabs: A, B, and `loose-one` (live, labelled for the space, in no pane)
  await expect(page.getByTestId("tab")).toHaveText(["A", "B", "loose-one"], { timeout: 3000 })
  await expect(page.getByTestId("tab").nth(2)).toHaveAttribute("data-extra", "true")

  // The pane's terminal dies: the pane is hidden; its tab stays and says so.
  hc("kill", dead)
  await page.getByTestId("tab").nth(1).click()
  await expect(page.getByTestId("empty")).toContainText("no live panes", { timeout: 3000 })

  // The desktop app rewrites the document: a second space appears, the first loses a tab.
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a)), space("s2", "beta", tab("tc", "C", loose))] })
  await expect(page.getByTestId("space-row").filter({ hasText: "beta" })).toBeVisible({ timeout: 3000 })
  await expect(page.getByTestId("tab")).toHaveText(["A"])
  await page.getByTestId("space-row").filter({ hasText: "beta" }).click()
  await expect(page.getByTestId("tab")).toHaveText(["C"])
  await expect(page.getByTestId("pane-card")).toHaveAttribute("data-address", loose)

  // A layout the page cannot read: the machine falls back to its terminals, with the reason.
  await setDoc({ spaces: [{ id: "s1", name: "alpha", folder: "/x", tabs: [{ id: "t", name: "t", root: { id: "t", type: "wobble", children: [] } }] }] })
  await expect(page.getByTestId("machine-notice")).toContainText("Layout unavailable", { timeout: 3000 })
  await expect(page.getByTestId("space-row").filter({ hasText: "This computer · terminals" })).toBeVisible()
  await page.getByTestId("space-row").filter({ hasText: "This computer · terminals" }).click()
  await expect(page.getByTestId("tab")).toHaveCount(2) // `in-pane` and `loose-one` are live; the dead one is gone

  // And back to a good one.
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a))] })
  await expect(page.getByTestId("machine-notice")).toHaveCount(0, { timeout: 3000 })
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1) // never reloaded
})

test("what the person selected, the sidebar and the theme survive a reload; sign out ends the session", async ({ page }) => {
  const a = run("one", "s1", "sleep 600")
  const b = run("two", "s2", "sleep 600")
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a)), space("s2", "beta", tab("tb", "B", b))] })
  await signIn(page)
  await page.getByTestId("space-row").filter({ hasText: "beta" }).click()
  await page.getByLabel("Collapse sidebar").click()
  await expect(page.getByTestId("sidebar")).toHaveCount(0)
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"))
  await page.getByLabel("Open sidebar").click()
  await page.getByTestId("theme-toggle").click()
  await page.getByLabel("Collapse sidebar").click()
  await page.reload()
  await expect(page.getByTestId("sidebar")).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(!wasDark)
  await expect(page.getByTestId("pane-card")).toHaveAttribute("data-address", b)
  await page.getByLabel("Open sidebar").click()
  await expect(page.getByTestId("space-row").filter({ hasText: "beta" })).toHaveAttribute("data-selected", "true")

  await page.getByTestId("sign-out").click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  // The session cookie is gone for the backend too.
  const res = await page.request.get(`${BACKEND}/api/session`)
  expect(await res.json()).toEqual({ signedIn: false })
  await page.getByTestId("theme-toggle").count() // login page has no toggle; nothing to assert
  await page.evaluate(() => localStorage.removeItem("herdr-web.theme"))
})

test("usable at 768 and 1440, light and dark, sidebar open and collapsed (screenshots in /tmp/hw-shots/dev-27)", async ({ page }) => {
  const names = ["a-long-agent-name-that-goes-on", "short"]
  const a = run(names[0]!, "s1", `${osc("working")}; sleep 600`)
  const b = run(names[1]!, "s1", "sleep 600")
  await setDoc({ spaces: [space("s1", "a-space-with-a-name-that-is-much-too-long-to-fit-in-the-sidebar-at-any-width", tab("ta", "t".repeat(120), a), tab("tb", "", b))] })
  for (const [width, height] of [[768, 900], [1440, 900]] as const) {
    await page.setViewportSize({ width, height })
    await signIn(page)
    for (const dark of [false, true]) {
      await page.evaluate((d) => {
        localStorage.setItem("herdr-web.theme", d ? "dark" : "light")
        document.documentElement.classList.toggle("dark", d)
      }, dark)
      for (const open of [true, false]) {
        const isOpen = (await page.getByTestId("sidebar").count()) > 0
        if (isOpen !== open) await (open ? page.getByLabel("Open sidebar") : page.getByLabel("Collapse sidebar")).click()
        await expect(page.getByTestId("sidebar")).toHaveCount(open ? 1 : 0)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, `${width}px ${dark ? "dark" : "light"} ${open ? "open" : "collapsed"}: page scrolls sideways`).toBeLessThanOrEqual(0)
        // the sign-out button and the first tab stay reachable
        if (open) await expect(page.getByTestId("sign-out")).toBeInViewport()
        await expect(page.getByTestId("tab").first()).toBeInViewport()
        await page.screenshot({ path: path.join(SHOTS, `${width}-${dark ? "dark" : "light"}-${open ? "open" : "collapsed"}.png`) })
      }
    }
    await page.context().clearCookies()
  }
})

test("stopping the backend marks what is shown as stale and says so; starting it again recovers without a reload", async ({ page }) => {
  const a = run("one", "s1", "sleep 600")
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a))] })
  await signIn(page)
  await page.evaluate(() => ((window as unknown as { __kept: number }).__kept = 1))
  await expect(page.getByTestId("banner")).toHaveCount(0)

  stopBackend()
  await expect(page.getByTestId("banner")).toHaveAttribute("data-kind", "backend", { timeout: 5000 })
  await expect(page.getByTestId("banner")).toContainText("out of date")
  await expect(page.locator('[data-testid="sidebar"] [data-stale="true"]')).toHaveCount(1)
  // what was there is still there, not blanked
  await expect(page.getByTestId("space-row").filter({ hasText: "alpha" })).toBeVisible()

  // While the backend is away, core changes; the page must catch up after reconnecting.
  const b = run("born-while-away", "s1", "sleep 600")
  await startBackend()
  await expect(page.getByTestId("banner")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId("tab")).toHaveText(["A", "born-while-away"], { timeout: 3000 })
  await expect(page.locator('[data-stale="true"]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1)
  expect(b).toBeTruthy()
})

test("stopping core marks everything stale; after it starts again the page shows exactly what `hc ls` shows", async ({ page }) => {
  const a = run("one", "s1", "sleep 600")
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a))] })
  await signIn(page)
  hc("server", "stop")
  await expect(page.getByTestId("banner")).toHaveAttribute("data-kind", "core", { timeout: 10_000 })
  await expect(page.locator('[data-testid="sidebar"] [data-stale="true"]')).toHaveCount(1)
  await expect(page.getByTestId("space-row").filter({ hasText: "alpha" })).toBeVisible()
  hc("server", "start")
  await expect(page.getByTestId("banner")).toHaveCount(0, { timeout: 30_000 })
  const live = (JSON.parse(hc("ls", "--json")) as { terminals: { address: string }[] }).terminals.map((t) => t.address)
  await page.getByTestId("space-row").filter({ hasText: "alpha" }).click()
  // the pane is shown only if its terminal is live; its tab stays either way
  await expect(page.getByTestId("tab")).toHaveText(["A"])
  await expect(page.getByTestId("pane-card")).toHaveCount(live.includes(a) ? 1 : 0)
  await expect(page.getByTestId("agent-row")).toHaveCount(0)
})

test("the backend restarted with another passphrase signs the open page out", async ({ page }) => {
  const a = run("one", "s1", "sleep 600")
  await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a))] })
  await signIn(page)
  stopBackend()
  await startBackend("a different passphrase")
  await expect(page).toHaveURL(/\/login$/, { timeout: 30_000 })
  // the old passphrase no longer works, the new one does
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByTestId("login-error")).toContainText("wrong")
  await page.getByLabel("Passphrase").fill("a different passphrase")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/$/)
  stopBackend()
  await startBackend()
})

test("sign-in: a wrong passphrase says so and keeps the field empty; five misses slow the next tries down and the page counts the wait", async ({ page }) => {
  await page.goto("/login")
  for (let i = 0; i < 5; i++) {
    await page.getByLabel("Passphrase").fill(`wrong ${i}`)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.getByTestId("login-error")).toContainText("wrong")
    await expect(page.getByLabel("Passphrase")).toHaveValue("")
  }
  await page.getByLabel("Passphrase").fill("wrong again")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByTestId("login-error")).toContainText("Slow down")
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled()
  // even the right passphrase is refused while the wait lasts
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled()
})

test.describe("defects", () => {
  test("a stored selection of `null` should not blank the page", async ({ page }) => {
    const a = run("one", "s1", "sleep 600")
    await setDoc({ spaces: [space("s1", "alpha", tab("ta", "A", a))] })
    // The backend is locked by the test above; restart it to get a clean limiter.
    stopBackend()
    await startBackend()
    await signIn(page)
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.evaluate(() => localStorage.setItem("herdr-web.selection", "null"))
    await page.reload()
    await page.waitForTimeout(1500) // useStored reads storage after mount
    expect(errors).toEqual([])
    await expect(page.getByTestId("space-row").first()).toBeVisible()
  })
})

// --- the backend the first spec started: stopped and started again by pid of whatever listens on its port ---

let ours: ChildProcess | null = null

function stopBackend(): void {
  const pids = execFileSync("lsof", ["-ti", `tcp:${BACKEND_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)
  for (const p of pids) process.kill(Number(p), "SIGTERM")
  ours = null
}

async function startBackend(passphrase = PASSPHRASE): Promise<void> {
  const repo = path.resolve(import.meta.dirname, "../../..")
  ours = spawn("node", [path.join(repo, "apps/backend/dist/index.js")], {
    env: { ...scratchEnv(root()), HERDR_WEB_PASSPHRASE: passphrase, HERDR_WEB_ORIGINS: `http://localhost:${WEB_PORT}`, PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  })
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    if (await fetch(`${BACKEND}/health`).then((r) => r.ok).catch(() => false)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("the backend did not come back")
}

test.afterAll(() => {
  ours?.kill()
})
