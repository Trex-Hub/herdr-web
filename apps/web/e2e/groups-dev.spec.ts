// DEV-31: opening a group is quick and does not move the reader. Needs no core: the page is /dev/chat on fixtures.
import { expect, test, type Page } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 } })

async function open(page: Page) {
  await page.goto("/dev/chat")
  await page.getByTestId("thread").waitFor()
  await page.waitForTimeout(2500)
}

const viewport = (page: Page) => page.getByTestId("thread-viewport")
const top = (page: Page) => viewport(page).evaluate((el) => el.scrollTop)
const lineY = (page: Page) => page.getByTestId("group-trigger").first().evaluate((el) => Math.round(el.getBoundingClientRect().top))

test("the steps of a group are on the page within 200 ms of the click", async ({ page }) => {
  await open(page)
  const ms = await page.evaluate(async () => {
    const trigger = document.querySelector<HTMLElement>("[data-testid=group-trigger]")!
    const start = performance.now()
    trigger.click()
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r))
      const steps = document.querySelector<HTMLElement>("[data-testid=group-steps]")
      const last = steps?.lastElementChild
      if (steps && last && last.getBoundingClientRect().height > 0 && steps.getBoundingClientRect().height >= steps.scrollHeight - 1) return performance.now() - start
      if (performance.now() - start > 5000) return Infinity
    }
  })
  expect(ms, "ms until every step is laid out").toBeLessThan(200)
})

test("a step inside a group opens within 200 ms too", async ({ page }) => {
  await open(page)
  await page.getByTestId("group-trigger").first().click()
  const ms = await page.evaluate(async () => {
    const trigger = document.querySelector<HTMLElement>("[data-testid=group-steps] [data-testid=row-thinking] [data-slot=trace-collapsible-trigger]")!
    const root = trigger.closest("[data-slot=trace-collapsible]")!
    const start = performance.now()
    trigger.click()
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r))
      const panel = root.querySelector<HTMLElement>("[data-slot=trace-collapsible-content]")
      if (panel && panel.getBoundingClientRect().height >= panel.scrollHeight - 1 && panel.scrollHeight > 0) return performance.now() - start
      if (performance.now() - start > 5000) return Infinity
    }
  })
  expect(ms).toBeLessThan(200)
})

// The reader leaves the end by any scroll that moves away from it, not only by the wheel; then opening and closing a
// group leaves the page where it is.
const ways: Array<[string, (page: Page) => Promise<void>]> = [
  ["scrollTop = 0 from a script", (page) => viewport(page).evaluate((el) => void (el.scrollTop = 0))],
  ["the Home key", async (page) => { await viewport(page).focus(); await page.keyboard.press("Home") }],
  ["PageUp", async (page) => { await viewport(page).focus(); for (let i = 0; i < 3; i++) await page.keyboard.press("PageUp") }],
  ["the wheel", async (page) => { await viewport(page).hover(); await page.mouse.wheel(0, -3000) }],
]
for (const [name, leave] of ways) {
  test(`after leaving the end by ${name}, opening and closing a group keeps the page where it is`, async ({ page }) => {
    await open(page)
    expect(await top(page)).toBeGreaterThan(100) // it opens at the end, and this thread scrolls
    await leave(page)
    await page.waitForTimeout(800)
    const before = { top: await top(page), y: await lineY(page) }
    expect(before.top).toBeLessThan(60)
    for (const state of ["true", "false"]) {
      await page.getByTestId("group-trigger").first().click()
      await expect(page.getByTestId("group-trigger").first()).toHaveAttribute("aria-expanded", state)
      await page.waitForTimeout(1000)
      expect({ top: await top(page), y: await lineY(page) }, `group ${state === "true" ? "open" : "closed"}`).toEqual(before)
    }
  })
}

test("at the end, opening a group still follows the end", async ({ page }) => {
  await open(page)
  // clicked from the page, not by a pointer: a pointer would scroll the line into view first, and that is the reader moving
  await page.getByTestId("group-trigger").first().evaluate((el) => (el as HTMLElement).click())
  await page.waitForTimeout(800)
  expect(await viewport(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(4)
})
