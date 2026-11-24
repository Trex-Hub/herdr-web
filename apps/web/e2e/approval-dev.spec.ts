// Guardrails approvals on fixtures (/dev/chat, no core): the card in the composer's place for a dangerous command and a path
// outside the workspace, the tap guard, the grants menu, keys, a long command that folds, two open at once, the "Awaiting approval"
// line under the call (the parent's for a nested call, the thread's end when no call is named), and the lines past prompts leave.
// Dark and light at 1440 and dark at 390; screenshots in /tmp/hw-shots/dev42-*.
import fs from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const SHOTS = "/tmp/hw-shots"
test.use({ trace: "off" })
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

async function open(page: Page, scenario: string, theme: "light" | "dark", width: number, height = 900) {
  await page.addInitScript((t) => localStorage.setItem("herdr-web.theme", t), theme)
  await page.setViewportSize({ width, height })
  await page.goto("/dev/chat")
  await page.getByTestId("dev-chat").waitFor()
  await page.getByTestId("scenario-approval").selectOption(scenario)
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", scenario)
}

const shots: Array<[string, number, "light" | "dark"]> = [
  ["dark-1440", 1440, "dark"],
  ["light-1440", 1440, "light"],
  ["dark-390", 390, "dark"],
]

for (const [name, width, theme] of shots) {
  test(`command approval card, ${name}`, async ({ page }) => {
    await open(page, "approval-command", theme, width)
    const panel = page.getByTestId("approval-panel")
    await expect(page.getByTestId("composer")).toHaveCount(0)
    await expect(panel.getByTestId("approval-question")).toHaveText("Run this command?")
    await expect(panel.getByTestId("approval-reason")).toContainText("recursive delete")
    await expect(panel.getByTestId("approval-command")).toHaveText(/rm -rf \.\/build \.\/dist/)
    await expect(panel.getByTestId("approval-stop")).toBeVisible()
    await expect(page.getByTestId("approval-line")).toHaveText("Awaiting approval")
    await expect(page.getByTestId("waiting")).toHaveCount(0)
    await expect(panel.getByTestId("approval-allow")).toBeEnabled()
    if (width < 640) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: `${SHOTS}/dev42-command-${name}.png` })
  })

  test(`path approval card with its grants open, ${name}`, async ({ page }) => {
    await open(page, "approval-untrusted", theme, width)
    const panel = page.getByTestId("approval-panel")
    await expect(panel.getByTestId("approval-question")).toHaveText("Use a file outside the workspace?")
    await expect(panel.getByTestId("approval-path")).toHaveText("/Users/dev/.ssh/config")
    await expect(panel.getByTestId("approval-stop")).toHaveCount(0)
    await panel.getByTestId("approval-more").click()
    const grants = page.getByTestId("approval-grant")
    await expect(grants).toHaveCount(5)
    await expect(grants.nth(3)).toHaveAttribute("data-result", "allow-file-always")
    await expect(grants.nth(3)).toHaveAttribute("data-disabled", "")
    await expect(grants.nth(3)).toContainText("Not available: project not trusted")
    await page.waitForTimeout(300) // the menu fades in
    await page.screenshot({ path: `${SHOTS}/dev42-path-${name}.png` })
  })
}

test("Allow is off for a moment, Enter does not approve, and a click does", async ({ page }) => {
  await open(page, "approval-command", "dark", 1440)
  const panel = page.getByTestId("approval-panel")
  await expect(panel.getByTestId("approval-card")).toHaveAttribute("data-guarding", "true")
  await expect(panel.getByTestId("approval-allow")).toBeDisabled()
  await expect(panel.getByTestId("approval-card")).toHaveAttribute("data-guarding", "false")
  await panel.getByTestId("approval-allow").focus()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(400)
  await expect(page.getByTestId("approval-panel")).toBeVisible()
  await panel.getByTestId("approval-allow").click()
  await expect(page.getByTestId("approval-panel")).toHaveCount(0)
  await expect(page.getByTestId("composer")).toBeVisible()
  await expect(page.getByTestId("approval-line")).toHaveText("Allowed once")
})

test("Escape denies and ⌘/Ctrl+Enter allows once", async ({ page }) => {
  await open(page, "approval-command", "dark", 1440)
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-guarding", "false")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("approval-line")).toHaveText("Denied")
  await expect(page.getByTestId("approval-line")).toHaveAttribute("data-tone", "denied")

  await open(page, "approval-command", "dark", 1440)
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-guarding", "false")
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(page.getByTestId("approval-line")).toHaveText("Allowed once")
})

test("a grant from the menu, and Deny and stop", async ({ page }) => {
  await open(page, "approval-path", "dark", 1440)
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-guarding", "false")
  await page.getByTestId("approval-more").click()
  await page.locator('[data-testid="approval-grant"][data-result="allow-dir-session"]').click()
  await expect(page.getByTestId("approval-line")).toHaveText("Allowed this folder for this session")

  await open(page, "approval-command", "dark", 1440)
  await page.getByTestId("approval-stop").click()
  await expect(page.getByTestId("approval-line")).toHaveText("Denied and stopped")
})

test("a long command folds, every line numbered", async ({ page }) => {
  await open(page, "approval-long", "dark", 1440)
  const command = page.getByTestId("approval-command")
  await expect(command).toHaveAttribute("data-folded", "true")
  await page.getByTestId("approval-command-more").click()
  await expect(command).toHaveAttribute("data-folded", "false")
  await expect(command).toContainText("rm -rf ./build ./dist ./node_modules/.cache")
  await expect(page.getByTestId("approval-command-more")).toHaveText("Show less")
  await page.screenshot({ path: `${SHOTS}/dev42-long-dark-1440.png` })
})

test("two open: the oldest shows, then the next", async ({ page }) => {
  await open(page, "approval-two", "dark", 1440)
  await expect(page.getByTestId("approval-count")).toHaveText("1 of 2")
  await expect(page.getByTestId("approval-waiting")).toHaveText("1 more waiting")
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-guarding", "false")
  await page.getByTestId("approval-deny").click()
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-kind", "guardrails.path")
  await expect(page.getByTestId("approval-count")).toHaveCount(0)
  // the next card has its own guard
  await expect(page.getByTestId("approval-allow")).toBeDisabled()
})

test("a nested call's line goes under its parent; an unnamed one at the end", async ({ page }) => {
  await open(page, "approval-nested", "dark", 1440)
  const row = page.locator('[data-testid="with-approval"]')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId("approval-line")).toHaveText("Awaiting approval")

  await open(page, "approval-unpinned", "dark", 1440)
  await expect(page.locator('[data-testid="with-approval"]')).toHaveCount(0)
  await expect(page.getByTestId("live-tail").getByTestId("approval-line")).toContainText("Awaiting approval")
  await expect(page.getByTestId("live-tail").getByTestId("approval-line")).toContainText("rm -rf ./build ./dist")
})

test("the lines past prompts leave under their calls", async ({ page }) => {
  await open(page, "approval-lines", "dark", 1440)
  await expect(page.getByTestId("composer")).toBeVisible()
  // past calls fold into a step group like any others; opened, each has its line
  await page.getByTestId("group-trigger").click()
  await expect(page.getByTestId("approval-line")).toHaveText([
    "Allowed once",
    "Allowed for this session",
    "Denied",
    "Denied and stopped",
    "Answered in the terminal",
    "Denied: the agent was stopped",
    "Not answered: pi closed the prompt",
  ])
  await page.screenshot({ path: `${SHOTS}/dev42-lines-dark-1440.png`, fullPage: true })
})

test("disconnected: nothing can be answered", async ({ page }) => {
  await open(page, "approval-command", "dark", 1440)
  await page.getByTestId("disable").check()
  await expect(page.getByTestId("approval-panel")).toHaveAttribute("data-disabled", "true")
  await expect(page.getByTestId("approval-allow")).toBeDisabled()
  await expect(page.getByTestId("approval-deny")).toBeDisabled()
})
