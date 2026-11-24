// The agent's todo list on fixtures (/dev/chat, no core): the card pinned above the composer with every status, a long list that
// folds, no card for an empty list, a list that changes across a turn, and the `todo` tool row as one line. Dark and light at 1440
// and dark at 390; screenshots in /tmp/hw-shots/dev41-*.
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
  await page.getByTestId(`scenario-${scenario}`).click()
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", scenario)
  await page.getByTestId("composer").waitFor()
}

const shots: Array<[string, number, "light" | "dark"]> = [
  ["dark-1440", 1440, "dark"],
  ["light-1440", 1440, "light"],
  ["dark-390", 390, "dark"],
]

for (const [name, width, theme] of shots) {
  test(`todo card with every status, ${name}`, async ({ page }) => {
    await open(page, "todo-statuses", theme, width)
    const card = page.getByTestId("todos")
    await expect(card.getByTestId("todos-count")).toHaveText("2/5")
    const tasks = card.getByTestId("todo-task")
    await expect(tasks).toHaveCount(5)
    await expect(tasks.nth(0)).toHaveAttribute("data-status", "completed")
    await expect(tasks.nth(2)).toHaveAttribute("data-status", "in_progress")
    await expect(tasks.nth(2).getByTestId("todo-active")).toHaveText("Making parseRow tolerate a bad date")
    await expect(tasks.nth(2).getByTestId("todo-mark")).toHaveAttribute("data-spinning", "true")
    await expect(tasks.nth(3).getByTestId("todo-blocked")).toHaveText("after #3")
    await expect(tasks.nth(3)).toHaveAttribute("data-status", "pending")
    await expect(tasks.nth(0)).toContainText("Done: Read the importer")
    await expect(tasks.nth(0).locator("span.line-through")).toBeVisible()
    await expect(card.getByTestId("todos-done-fold")).toHaveCount(0) // five or fewer never fold
    await expect(card.getByTestId("todos-more")).toHaveCount(0)

    // the card sits on top of the composer, in its column
    const c = (await card.boundingBox())!
    const comp = (await page.getByTestId("composer").boundingBox())!
    expect(c.y + c.height).toBeLessThanOrEqual(comp.y + 1)
    expect(comp.y - (c.y + c.height)).toBeLessThan(8)
    expect(Math.abs(c.x - comp.x)).toBeLessThan(2)
    expect(Math.abs(c.width - comp.width)).toBeLessThan(2)
    expect(c.height).toBeLessThan(900 / 3 + 40)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `${SHOTS}/dev41-statuses-${name}.png` })

    // collapsed: the current task and a meter; open again
    await card.getByTestId("todos-toggle").click()
    await expect(card.getByTestId("todo-task")).toHaveCount(0)
    await expect(card.getByTestId("todos-current")).toHaveText("· Making parseRow tolerate a bad date")
    await expect(card.getByTestId("todos-meter")).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/dev41-collapsed-${name}.png` })
    await card.getByTestId("todos-toggle").click()
    await expect(card.getByTestId("todo-task")).toHaveCount(5)

    // the todo calls are in the thread as short lines, inside the step group, never JSON
    await expect(page.getByText('"action"')).toHaveCount(0)
  })

  test(`a long list folds and opens, ${name}`, async ({ page }) => {
    await open(page, "todo-long", theme, width)
    const card = page.getByTestId("todos")
    await expect(card.getByTestId("todos-count")).toHaveText("3/9")
    await expect(card.getByTestId("todos-done-fold")).toHaveText("✓3 done")
    const tasks = card.getByTestId("todo-task")
    await expect(tasks).toHaveCount(3)
    await expect(tasks.first()).toHaveAttribute("data-status", "in_progress")
    await expect(card.getByTestId("todos-more")).toHaveText("+3 more")
    await page.screenshot({ path: `${SHOTS}/dev41-long-${name}.png` })
    await card.getByTestId("todos-more").click()
    await expect(tasks).toHaveCount(9)
    await expect(card.getByTestId("todos-less")).toHaveText("Show less")
    const c = (await card.boundingBox())!
    expect(c.height).toBeLessThan(900 / 3 + 40)
    await page.screenshot({ path: `${SHOTS}/dev41-long-open-${name}.png` })
    await card.getByTestId("todos-less").click()
    await expect(tasks).toHaveCount(3)
  })
}

test("no list, no card; the todo row says what a call did", async ({ page }) => {
  await open(page, "todo-empty", "dark", 1440)
  await expect(page.getByTestId("todos")).toHaveCount(0)
  await page.getByTestId("scenario-todo-statuses").click()
  await expect(page.getByTestId("todos")).toBeVisible()
})

test("a list across a turn: written, worked, finished, dropped when the user speaks again", async ({ page }) => {
  await open(page, "todo-turn", "dark", 1440)
  const card = page.getByTestId("todos")
  await expect(card).toHaveCount(0)
  const step = page.getByTestId("todo-step")
  await step.click()
  await expect(card.getByTestId("todos-count")).toHaveText("0/3")
  await expect(card.getByTestId("todo-task")).toHaveCount(3)
  await step.click()
  await expect(card.getByTestId("todo-task").first()).toHaveAttribute("data-status", "in_progress")
  await expect(card.getByTestId("todo-task").first().getByTestId("todo-mark")).toHaveAttribute("data-spinning", "true")
  await step.click()
  await expect(card.getByTestId("todos-count")).toHaveText("1/3")
  await step.click()
  await step.click()
  await expect(card.getByTestId("todos-count")).toHaveText("2/3")
  await step.click() // the last task done and the turn over: stays as 3/3, no spinner
  await expect(card.getByTestId("todos-count")).toHaveText("3/3")
  await expect(card).toContainText("Todos")
  await expect(card.getByTestId("todos-toggle")).not.toContainText("Done")
  await expect(card.locator('[data-spinning="true"]')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev41-turn-done-dark-1440.png` })
  await step.click() // the next user message: the finished list goes
  await expect(card).toHaveCount(0)
})
