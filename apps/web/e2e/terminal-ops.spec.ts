import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { PASSPHRASE } from "./global-setup"
import { addSpace, hc, root } from "./scratch"

const osc = (state: string) => `printf '\\033]7501;state=${state}:app=pi\\007'`
const labels = (address: string): Record<string, string> => (JSON.parse(hc("get", address, "--json")) as { labels: Record<string, string> }).labels
const record = (address: string) => JSON.parse(hc("get", address, "--json")) as Record<string, unknown>

/** The page can be made to look hidden and unfocused, as a background browser tab is. */
async function controllableAttention(page: Page): Promise<(hidden: boolean) => Promise<void>> {
  await page.addInitScript(() => {
    ;(window as unknown as { __hidden: boolean }).__hidden = false
    Object.defineProperty(document, "visibilityState", { get: () => ((window as unknown as { __hidden: boolean }).__hidden ? "hidden" : "visible") })
    document.hasFocus = () => !(window as unknown as { __hidden: boolean }).__hidden
  })
  return (hidden) =>
    page.evaluate((h) => {
      ;(window as unknown as { __hidden: boolean }).__hidden = h
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event(h ? "blur" : "focus"))
    }, hidden)
}

test.describe.configure({ mode: "serial" })

// Later specs count the terminals of the scratch core: what this file started goes away with it.
const started: string[] = []
test.afterAll(() => {
  for (const address of started) {
    try {
      hc("kill", address)
    } catch {
      // already ended
    }
  }
})

test("start a shell from the +, kill it from the tab menu, pin and unpin, and seen follows what is on screen", async ({ page }) => {
  const folder = fs.mkdtempSync(path.join(root(), "folder-")) // inside the scratch root: removed with it
  await addSpace({ id: "sp-ops", name: "opsspace", folder })
  const setHidden = await controllableAttention(page)

  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "opsspace" }).click()
  await expect(page.getByTestId("tab")).toHaveCount(0)

  // Start: the "+" menu offers Shell and pi; the new terminal arrives as a tab and is selected.
  await page.getByTestId("new-terminal").click()
  await expect(page.getByTestId("starter").filter({ hasText: "Shell" })).toBeVisible()
  await expect(page.getByTestId("starter").filter({ hasText: "pi" })).toBeVisible()
  await page.getByTestId("starter").filter({ hasText: "Shell" }).click()
  await expect(page.getByTestId("tab")).toHaveCount(1, { timeout: 5000 })
  await expect(page.getByTestId("tab").first()).toHaveAttribute("data-selected", "true")
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 10_000 })
  const first = (await page.getByTestId("terminal-view").getAttribute("data-address"))!
  started.push(first)
  const made = record(first)
  expect(made).toMatchObject({ keep: true, parent: null })
  expect([folder, fs.realpathSync(folder)]).toContain(made["cwd"])
  expect(made["labels"]).toEqual({ "herdr.space": "sp-ops", "herdr.tab": expect.stringMatching(/^tb[0-9a-f]{32}$/), "herdr.seen": "0" })

  // Kill: confirmation names the terminal; afterwards the tab is gone and the selection moved to a neighbour.
  await page.getByTestId("new-terminal").click()
  await page.getByTestId("starter").filter({ hasText: "Shell" }).click()
  await expect(page.getByTestId("tab")).toHaveCount(2, { timeout: 5000 })
  const second = (await page.getByTestId("terminal-view").getAttribute("data-address"))!
  expect(second).not.toBe(first)
  await page.getByTestId("tab-menu").nth(1).click()
  await page.getByTestId("tab-kill").click()
  await expect(page.getByTestId("kill-dialog")).toContainText(second)
  await page.getByTestId("kill-confirm").click()
  await expect(page.getByTestId("tab")).toHaveCount(1, { timeout: 5000 })
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-address", first)
  expect(record(second)).toMatchObject({ state: "finished", reason: "killed" })

  // An agent that reports a turn when told to.
  const go = path.join(folder, "go")
  hc("run", "--bg", "--name", "agent-ops", "--keep", "--no-parent", "--label", "herdr.space=sp-ops", "--label", "herdr.seen=0", "--", "sh", "-c", `${osc("working")}; while [ ! -e ${go} ]; do sleep 0.1; done; ${osc("idle")}; sleep 600`)
  const row = page.getByTestId("agent-row")
  await expect(row).toHaveAttribute("data-state", "working", { timeout: 5000 })
  const agent = (await row.getAttribute("data-address"))!
  started.push(agent)

  // Pin and unpin from the row's menu, and the same label written with hc shows within a second.
  await page.getByTestId("agent-menu").click()
  await page.getByTestId("agent-pin").click()
  await expect.poll(() => labels(agent)["herdr.pinned"]).toBe("1")
  await expect(page.getByLabel("Pinned")).toBeVisible()
  await page.getByTestId("agent-menu").click()
  await page.getByTestId("agent-pin").click()
  await expect.poll(() => labels(agent)["herdr.pinned"]).toBeUndefined()
  hc("label", agent, "herdr.pinned=1")
  await expect(page.getByLabel("Pinned")).toBeVisible({ timeout: 1000 })
  hc("label", agent, "herdr.pinned=")
  await expect(page.getByLabel("Pinned")).toHaveCount(0, { timeout: 1000 })

  // Its pane is shown but the page is hidden: the turn ends and the agent stays done.
  await row.click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-address", agent)
  await setHidden(true)
  fs.writeFileSync(go, "")
  await expect(row).toHaveAttribute("data-state", "done", { timeout: 3000 })
  await page.waitForTimeout(1000)
  await expect(row).toHaveAttribute("data-state", "done")
  expect(labels(agent)["herdr.seen"]).toBe("0")
  // Visible and focused again: seen is written, once, and the agent is idle.
  await setHidden(false)
  await expect(row).toHaveAttribute("data-state", "idle", { timeout: 3000 })
  expect(labels(agent)["herdr.seen"]).toBe("1")

  // Mark unread while it is on screen: it stays unread (done) until the next turn.
  await page.getByTestId("agent-menu").click()
  await page.getByTestId("agent-unread").click()
  await expect(row).toHaveAttribute("data-state", "done", { timeout: 3000 })
  await page.waitForTimeout(1000)
  await expect(row).toHaveAttribute("data-state", "done")
  expect(labels(agent)["herdr.seen"]).toBe("0")
})

test("controls are off while core is away, and an operation's error shows next to its control", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "opsspace" }).click()
  await expect(page.getByTestId("new-terminal")).toBeEnabled()
  // A space whose folder is gone: core refuses and its own words appear by the "+".
  await addSpace({ id: "sp-gone", name: "gonespace", folder: path.join(root(), "no-such-folder") })
  await page.getByTestId("space-row").filter({ hasText: "gonespace" }).click()
  await page.getByTestId("new-terminal").click()
  await page.getByTestId("starter").filter({ hasText: "Shell" }).click()
  await expect(page.getByTestId("op-error")).toBeVisible({ timeout: 5000 })

  hc("server", "stop")
  await expect(page.getByTestId("banner")).toHaveAttribute("data-kind", "core", { timeout: 10_000 })
  await expect(page.getByTestId("new-terminal")).toBeDisabled()
  hc("server", "start")
  await expect(page.getByTestId("banner")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId("new-terminal")).toBeEnabled()
  fs.accessSync(root())
})
