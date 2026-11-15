// Adversarial browser checks of the terminal view (DEV-23), on the scratch core and backend the other specs use.
// Named zz- so it runs after terminal.spec.ts, which restarts the backend.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { CoreConnection } from "@herdr-web/core-client"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { BACKEND_PORT } from "../playwright.config"
import { PASSPHRASE, startBackend } from "./global-setup"

const root = (): string => process.env.HW_E2E_ROOT!
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })

const screen = (page: Page) =>
  page.evaluate(() => {
    const t = (document.querySelector("[data-testid=terminal-host]") as unknown as { __xterm: { cols: number; rows: number; buffer: { active: { type: string; length: number; viewportY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).__xterm
    const b = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "")
    return { text: lines.join("\n"), cols: t.cols, rows: t.rows, buffer: b.type }
  })
const shows = (page: Page, needle: string | RegExp) => async () => {
  const { text } = await screen(page)
  return typeof needle === "string" ? text.includes(needle) : needle.test(text)
}

const LABEL = ["--label", "herdr.space=s-tattack"]

/** Add a space of ours to the layout document, next to whatever the other specs left there. */
async function writeLayout(): Promise<void> {
  const sock = path.join(scratchEnv(root()).XDG_STATE_HOME!, "herdr-core", "herdr-web-test", "herdr-web-test.sock")
  const conn = await CoreConnection.connect({ path: sock })
  try {
    type Call = { call(m: string, p: unknown): Promise<{ version?: number; value?: { spaces?: { id: string }[] } | null }> }
    const call = (conn as unknown as Call).call.bind(conn)
    const current = await call("doc.get", { name: "herdr-app" }).catch(() => ({}) as Awaited<ReturnType<Call["call"]>>)
    const spaces = (current.value?.spaces ?? []).filter((s) => s.id !== "s-tattack")
    spaces.push({ id: "s-tattack", name: "tattack", folder: "/tmp", tabs: [] } as never)
    await call("doc.set", { name: "herdr-app", value: { spaces }, version: current.version ?? 0 })
  } finally {
    conn.close()
  }
}

async function signInAndOpen(page: Page, name: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "tattack" }).click()
  await page.getByTestId("tab").filter({ hasText: name }).first().click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 15_000 })
}

/** A shell with a plain prompt, shown in the page, focused. */
async function shellIn(page: Page, name: string): Promise<void> {
  hc("run", "--bg", "--name", name, ...LABEL, "--cwd", "/tmp", "--", "bash", "--norc", "--noprofile")
  await signInAndOpen(page, name)
  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.type("PS1='$ '\n")
}

test.describe.configure({ mode: "serial" })
test.beforeAll(async () => {
  // The spec before this one stops the backend it restarted when it ends: start one if none answers, with a clean login limiter.
  await new Promise((r) => setTimeout(r, 1500)) // the other spec's backend may still be shutting down
  const up = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`).then((r) => r.ok).catch(() => false)
  console.log("zz-terminal-attack: backend up before start:", up)
  if (!up) {
    startBackend(root())
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200))
  }
  await writeLayout()
})

test("Ctrl-D ends a shell and the view says how, with no new socket", async ({ page }) => {
  await shellIn(page, "ctrld")
  let sockets = 0
  page.on("websocket", (ws) => ws.url().includes("/api/terminal/") && sockets++)
  await page.keyboard.press("Control+d")
  await expect(page.getByTestId("terminal-status")).toContainText(/exited with code 0/i, { timeout: 5000 })
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "ended")
  await page.waitForTimeout(1500)
  expect(sockets).toBe(0)
})

test("arrows, Tab completion, Ctrl-C and a 2,000 character paste reach the shell", async ({ page }) => {
  fs.writeFileSync("/tmp/hw-tester-unique-name-xyz.txt", "x")
  await shellIn(page, "keys")
  await page.keyboard.type("echo up-$((3+4))\n")
  await expect.poll(shows(page, /^up-7$/m)).toBe(true)
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("Enter")
  await expect.poll(async () => ((await screen(page)).text.match(/^up-7$/gm) ?? []).length).toBe(2)
  await page.keyboard.type("ls /tmp/hw-tester-unique-na")
  await page.keyboard.press("Tab")
  await expect.poll(shows(page, "hw-tester-unique-name-xyz.txt")).toBe(true)
  await page.keyboard.press("Control+c")
  await page.keyboard.type("sleep 60\n")
  await page.waitForTimeout(300)
  await page.keyboard.press("Control+c")
  await page.keyboard.type("echo int-ok\n")
  await expect.poll(shows(page, /^int-ok$/m), { timeout: 2000 }).toBe(true)
  const long = "abcdefghij".repeat(200)
  await page.evaluate((text) => {
    const ta = document.querySelector(".xterm-helper-textarea")!
    const dt = new DataTransfer()
    dt.setData("text/plain", text)
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
  }, `echo ${long} | wc -c\n`)
  await expect.poll(shows(page, /^\s*2001\s*$/m), { timeout: 4000 }).toBe(true)
})

test("vi opens, edits, saves and quits on the alternate screen, and the screen before it comes back", async ({ page }) => {
  fs.rmSync("/tmp/hw-tester-vi.txt", { force: true })
  await shellIn(page, "vi1")
  await page.keyboard.type("echo before-vi-marker\n")
  await expect.poll(shows(page, /^before-vi-marker$/m)).toBe(true)
  await page.keyboard.type("vi /tmp/hw-tester-vi.txt\n")
  await expect.poll(async () => (await screen(page)).buffer).toBe("alternate")
  await page.keyboard.type("ihello 日本語 😀")
  await page.keyboard.press("Escape")
  await page.keyboard.type(":wq\n")
  await expect.poll(async () => (await screen(page)).buffer).toBe("normal")
  expect((await screen(page)).text).toContain("before-vi-marker")
  expect(fs.readFileSync("/tmp/hw-tester-vi.txt", "utf8")).toBe("hello 日本語 😀\n")
})

test("two windows on one terminal both show output; the one focused last sets the size", async ({ browser }) => {
  const mk = async (width: number, height: number) => {
    const ctx = await browser.newContext({ viewport: { width, height } })
    const page = await ctx.newPage()
    await signInAndOpen(page, "twowin")
    return page
  }
  hc("run", "--bg", "--name", "twowin", ...LABEL, "--cwd", "/tmp", "--", "bash", "--norc", "--noprofile")
  const a = await mk(1280, 800)
  const b = await mk(900, 600)
  await b.locator(".xterm-helper-textarea").focus()
  await b.keyboard.type("PS1='$ '; echo both-$((6*7)); stty size\n")
  await expect.poll(shows(a, /^both-42$/m)).toBe(true)
  await expect.poll(shows(b, /^both-42$/m)).toBe(true)
  const gb = await screen(b)
  await expect.poll(async () => (await screen(a)).text.split("\n").filter((l) => /^\d+ \d+$/.test(l.trim())).pop()).toBe(`${gb.rows} ${gb.cols}`)
  await a.locator(".xterm-helper-textarea").focus()
  const ga = await screen(a)
  await a.keyboard.type("stty size\n")
  await expect.poll(async () => (await screen(b)).text.split("\n").filter((l) => /^\d+ \d+$/.test(l.trim())).pop(), { timeout: 5000 }).toBe(`${ga.rows} ${ga.cols}`)
})

test("a kept terminal comes back by itself after core stops and starts; one killed from hc ends", async ({ page }) => {
  hc("run", "--bg", "--keep", "--name", "kept1", ...LABEL, "--cwd", "/tmp", "--", "bash", "--norc", "--noprofile")
  await signInAndOpen(page, "kept1")
  hc("server", "stop")
  await expect(page.getByTestId("terminal-view")).not.toHaveAttribute("data-state", "live", { timeout: 10_000 })
  hc("server", "start")
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 30_000 })
  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.type("echo kept-back-$((8*8))\n")
  await expect.poll(shows(page, /^kept-back-64$/m)).toBe(true)

  hc("run", "--bg", "--name", "victim", ...LABEL, "--cwd", "/tmp", "--", "bash", "--norc", "--noprofile")
  await page.getByTestId("tab").filter({ hasText: "victim" }).first().click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 15_000 })
  hc("kill", "victim")
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "ended", { timeout: 5000 })
})

test.describe("defects", () => {
  test("the terminal refits when the sidebar collapses and opens, though the click on the button took the focus away", async ({ page }) => {
    await shellIn(page, "refit")
    await page.keyboard.type("seq 1 5\n")
    const fits = async () => {
      const s = await screen(page)
      const px = (await page.locator(".xterm-screen").boundingBox())!.width
      const host = (await page.locator("[data-testid=terminal-host]").boundingBox())!.width
      return { cols: s.cols, screenPx: Math.round(px), hostPx: Math.round(host), fits: px <= host && host - px < 40 }
    }
    await page.getByRole("button", { name: /collapse|hide sidebar|close sidebar/i }).first().click()
    await expect.poll(async () => (await fits()).fits, { timeout: 4000, message: JSON.stringify(await fits()) }).toBe(true)
    await page.getByTestId("open-sidebar").click()
    await expect.poll(async () => (await fits()).fits, { timeout: 4000, message: JSON.stringify(await fits()) }).toBe(true)
  })

  test("a single window narrowed to 768 px while the focus is on the sidebar does not clip the terminal", async ({ page }) => {
    await shellIn(page, "narrow")
    await page.getByTestId("theme-toggle").click() // the focus leaves the terminal
    await page.setViewportSize({ width: 768, height: 900 })
    await expect
      .poll(async () => {
        const px = (await page.locator(".xterm-screen").boundingBox())!.width
        const host = (await page.locator("[data-testid=terminal-host]").boundingBox())!.width
        return px <= host
      }, { timeout: 4000 })
      .toBe(true)
  })
})
