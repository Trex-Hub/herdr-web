import { execFileSync } from "node:child_process"
import { CoreConnection } from "@herdr-web/core-client"
import { expect, test, type Page } from "@playwright/test"
import path from "node:path"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { PASSPHRASE, startBackend, stopBackend } from "./global-setup"

const root = (): string => process.env.HW_E2E_ROOT!
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })

async function writeLayout(): Promise<void> {
  const sock = path.join(scratchEnv(root()).XDG_STATE_HOME!, "herdr-core", "herdr-web-test", "herdr-web-test.sock")
  const conn = await CoreConnection.connect({ path: sock })
  try {
    // Another spec may have written the document already: add a space next to whatever is there.
    const call = (conn as unknown as { call(m: string, p: unknown): Promise<{ version?: number; value?: { spaces?: unknown[] } | null }> }).call.bind(conn)
    const current = await call("doc.get", { name: "herdr-app" }).catch(() => ({}) as { version?: number; value?: { spaces?: unknown[] } | null })
    const spaces = [...(current.value?.spaces ?? []), { id: "s-term", name: "termspace", folder: "/tmp", tabs: [] }]
    await call("doc.set", { name: "herdr-app", value: { spaces }, version: current.version ?? 0 })
  } finally {
    conn.close()
  }
}

/** What the emulator in the page shows now, row by row, with its size. */
const screen = (page: Page) =>
  page.evaluate(() => {
    const t = (document.querySelector("[data-testid=terminal-host]") as unknown as { __xterm: { cols: number; rows: number; buffer: { active: { viewportY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).__xterm
    const b = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "")
    return { text: lines.join("\n"), cols: t.cols, rows: t.rows }
  })
const shows = (page: Page, needle: string | RegExp) => async () => {
  const { text } = await screen(page)
  return typeof needle === "string" ? text.includes(needle) : needle.test(text)
}

test.describe.configure({ mode: "serial" })

test("a shell in the browser: typing, resizing, a flood that Ctrl-C stops, a backend restart, and how it ends", async ({ page }) => {
  await writeLayout()
  hc("run", "--bg", "--name", "shell-under-test", "--label", "herdr.space=s-term", "--", "bash", "--norc", "--noprofile")

  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "termspace" }).click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 15_000 })
  await page.locator(".xterm-helper-textarea").focus()

  // Typing reaches the shell and its answer comes back.
  await page.keyboard.type("echo hello-$((6*7))\n")
  await expect.poll(shows(page, /^hello-42$/m), { timeout: 5000 }).toBe(true)

  // Resizing the window: the shell's idea of its size follows the emulator's.
  for (const size of [{ width: 1100, height: 700 }, { width: 900, height: 600 }]) {
    await page.setViewportSize(size)
    await expect
      .poll(async () => {
        const before = await screen(page)
        await page.keyboard.type("stty size\n")
        await expect.poll(shows(page, /^\d+ \d+$/m)).toBe(true)
        const after = await screen(page)
        const reported = after.text.split("\n").filter((l) => /^\d+ \d+$/.test(l)).pop()
        return reported === `${before.rows} ${before.cols}`
      }, { timeout: 8000 })
      .toBe(true)
  }

  // A flood of output, then Ctrl-C: the shell answers again within 2 s.
  await page.keyboard.type("yes | head -c 50000000\n")
  await page.waitForTimeout(1000)
  const interrupted = Date.now()
  await page.keyboard.press("Control+c")
  await page.keyboard.type("echo back-$((20+22))\n")
  await expect.poll(shows(page, /^back-42$/m), { timeout: 2000 }).toBe(true)
  expect(Date.now() - interrupted).toBeLessThan(2000)

  // Restarting the backend: the view notices, reattaches by itself and paints the screen again; typing works afterwards.
  stopBackend(root())
  await expect(page.getByTestId("terminal-view")).not.toHaveAttribute("data-state", "live", { timeout: 15_000 })
  startBackend(root())
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 30_000 })
  await expect.poll(shows(page, /^back-42$/m), { timeout: 5000 }).toBe(true)
  await page.locator(".xterm-helper-textarea").focus()
  await page.keyboard.type("echo again-$((50+8))\n")
  await expect.poll(shows(page, /^again-58$/m), { timeout: 5000 }).toBe(true)

  // The shell exits: the view says how it ended and opens no new socket.
  await page.keyboard.type("exit 3\n")
  await expect(page.getByTestId("terminal-status")).toContainText(/exit(ed)?.*3/i, { timeout: 5000 })
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "ended")
})
