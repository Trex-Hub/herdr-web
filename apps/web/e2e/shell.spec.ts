import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { CoreConnection } from "@herdr-web/core-client"
import { expect, test } from "@playwright/test"
import { PASSPHRASE, scratchEnv } from "./global-setup"

const root = (): string => process.env.HW_E2E_ROOT!
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })

/** What the desktop app would have written: one space, `alpha`, with no tabs yet. */
async function writeLayout(): Promise<void> {
  const state = process.env.XDG_STATE_HOME!
  const sock = path.join(state, "herdr-core", "herdr-web-test", "herdr-web-test.sock")
  const conn = await CoreConnection.connect({ path: sock })
  try {
    const value = { spaces: [{ id: "s-alpha", name: "alpha", folder: "/tmp/alpha", tabs: [] }] }
    await (conn as unknown as { call(m: string, p: unknown): Promise<unknown> }).call("doc.set", { name: "herdr-app", value, version: 0 })
  } finally {
    conn.close()
  }
}

test("sign in, a started terminal appears in its space, and stopping core shows the banner", async ({ page }) => {
  await writeLayout()

  // Without a session the app goes to the sign-in page; a wrong passphrase says so.
  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel("Passphrase").fill("not it")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByTestId("login-error")).toContainText("wrong")

  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId("space-row").filter({ hasText: "alpha" })).toBeVisible()
  await expect(page.getByTestId("banner")).toHaveCount(0)

  // A terminal started with `hc run` shows up as a tab of its space, with no reload.
  await page.getByTestId("space-row").filter({ hasText: "alpha" }).click()
  await expect(page.getByTestId("tab")).toHaveCount(0)
  hc("run", "--bg", "--name", "built-by-hc", "--label", "herdr.space=s-alpha", "--", "sleep", "600")
  await expect(page.getByTestId("tab").filter({ hasText: "built-by-hc" })).toBeVisible({ timeout: 3000 })
  await expect(page.getByTestId("pane-card")).toContainText("sleep")

  // Stopping core shows the "backend lost core" banner; starting it again clears the banner.
  hc("server", "stop")
  await expect(page.getByTestId("banner")).toHaveAttribute("data-kind", "core", { timeout: 10_000 })
  hc("server", "start")
  await expect(page.getByTestId("banner")).toHaveCount(0, { timeout: 30_000 })
  fs.accessSync(root())
})
