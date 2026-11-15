// The chat components on fixtures (/dev/chat, development only): looks, the scroll rule and smoothness.
// Needs no core; it runs under the same dev server as the other specs.
import fs from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const SHOTS = "/tmp/hw-shots/dev-26"

async function open(page: Page, scenario: "every" | "empty" | "paged" | "long" = "every", theme: "light" | "dark" = "light") {
  await page.addInitScript((t) => localStorage.setItem("herdr-web.theme", t), theme)
  await page.goto("/dev/chat")
  await page.getByTestId("dev-chat").waitFor()
  if (scenario !== "every") await page.getByTestId(`scenario-${scenario}`).click()
  await page.getByTestId(scenario === "empty" ? "empty-thread" : "thread").waitFor()
}

/** How far the viewport is from its end, in pixels. */
const fromEnd = (page: Page) =>
  page.getByTestId("thread-viewport").evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

for (const theme of ["light", "dark"] as const) {
  for (const width of [768, 1440]) {
    test(`every row kind, ${theme}, ${width} px wide`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await open(page, "every", theme)
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/)
      for (const id of ["row-user", "row-assistant", "row-thinking", "row-tool", "row-compaction", "row-notice"]) {
        await expect(page.getByTestId(id).first()).toBeAttached()
      }
      // nothing pushes the page wider than the window
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      // the thread opens at its end, so the newest rows are showing
      expect(await fromEnd(page)).toBeLessThan(4)
      await page.screenshot({ path: `${SHOTS}/end-${theme}-${width}.png` })

      // every kind, open: scroll from the top, one shot per screenful, with all traces opened
      const triggers = page.locator('[data-slot="trace-collapsible-trigger"]')
      for (let i = 0; i < (await triggers.count()); i++) await triggers.nth(i).click()
      await page.getByTestId("thread-viewport").evaluate((el) => (el.scrollTop = 0))
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${SHOTS}/top-open-${theme}-${width}.png` })
    })
  }
}

test("one shot while a reply is being written", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, "every", "light")
  await page.getByTestId("play-slow").click()
  await expect(page.getByTestId("live-text")).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(700)
  await expect(page.getByTestId("working")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/mid-reply-light-1440.png` })
  await page.setViewportSize({ width: 768, height: 900 })
  await page.getByTestId("theme-toggle").click()
  await page.screenshot({ path: `${SHOTS}/mid-reply-dark-768.png` })
  await expect(page.getByTestId("working")).toHaveCount(0, { timeout: 40_000 })
  await expect(page.getByTestId("live-text")).toHaveCount(0)
})

test("pinned to the end while text arrives; scrolling up releases it, nothing moves, and Jump to latest brings it back", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await open(page, "long")
  expect(await fromEnd(page)).toBeLessThan(4)

  await page.getByTestId("play-slow").click()
  await expect(page.getByTestId("live-text")).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(800)
  expect(await fromEnd(page)).toBeLessThan(4) // followed the new text down
  await expect(page.getByTestId("jump-to-latest")).toHaveAttribute("data-active", "false")

  // the reader scrolls up
  const viewport = page.getByTestId("thread-viewport")
  await viewport.hover()
  await page.mouse.wheel(0, -1500)
  await page.waitForTimeout(300)
  const top = await viewport.evaluate((el) => el.scrollTop)
  await expect(page.getByTestId("jump-to-latest")).toHaveAttribute("data-active", "true")
  await page.waitForTimeout(1200) // more text arrives
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(top)

  await page.getByTestId("jump-to-latest").click()
  await expect.poll(() => fromEnd(page)).toBeLessThan(4)
})

test("reaching the top loads the older page and keeps the reader's place", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await open(page, "paged")
  const viewport = page.getByTestId("thread-viewport")
  await viewport.hover()
  // the reader scrolls to the top with the wheel (the scroller tells a reader from its own scrolling by the wheel)
  await expect(async () => {
    await page.mouse.wheel(0, -3000)
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0)
  }).toPass({ timeout: 10_000 })
  // the row at the top of the view, and where it is on screen
  const anchor = async () =>
    viewport.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const row = [...el.querySelectorAll("[data-slot=message-scroller-item]")].find((r) => r.getBoundingClientRect().bottom > box.top + 4)!
      return { id: row.querySelector("[data-row-id]")?.getAttribute("data-row-id") ?? null, y: Math.round(row.getBoundingClientRect().top - box.top) }
    })
  const before = await anchor()
  expect(before.id).not.toBeNull()
  await expect.poll(() => page.locator("[data-slot=message-scroller-item]").count(), { timeout: 15_000 }).toBeGreaterThan(60)
  await page.waitForTimeout(500)
  const after = await anchor()
  expect(after.id).toBe(before.id)
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2)
})

test("smoothness: a reply streams into a thread of 2,000 rows", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, "long")
  expect(await page.getByTestId("thread").locator("[data-slot=message-scroller-item]").count()).toBeGreaterThanOrEqual(2000)
  // scrolls: a wheel run from the end to the top of the thread, frames timed on the way
  const viewport = page.getByTestId("thread-viewport")
  await viewport.hover()
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __go: boolean }
    w.__gaps = []
    w.__go = true
    let last = performance.now()
    const tick = (t: number) => {
      w.__gaps.push(t - last)
      last = t
      if (w.__go) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, -2500)
    await page.waitForTimeout(16)
  }
  const scroll = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __go: boolean }
    w.__go = false
    const gaps = w.__gaps.slice(1)
    return { frames: gaps.length, longest: Math.round(Math.max(...gaps)) }
  })
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeLessThan(await viewport.evaluate((el) => el.scrollHeight - 5000))
  await page.getByTestId("jump-to-latest").click()
  await expect.poll(() => fromEnd(page)).toBeLessThan(4)

  await page.getByTestId("measure").click()
  const result = page.getByTestId("bench-result")
  await expect(result).toBeVisible({ timeout: 60_000 })
  const text = (await result.textContent()) ?? ""
  const longest = Number(await result.getAttribute("data-longest"))
  console.log(`smoothness: scrolling 2,000 rows: ${JSON.stringify(scroll)}; streaming reply: ${text}`)
  info.annotations.push({ type: "smoothness", description: `scroll ${JSON.stringify(scroll)}; stream ${text}` })
  // a generous ceiling: a frame over 100 ms is a visible stall on any machine
  expect(longest).toBeLessThan(100)
  expect(scroll.longest).toBeLessThan(100)
})
