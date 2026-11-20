// The chat components on fixtures (/dev/chat, development only): looks, the scroll rule and smoothness.
// Needs no core; it runs under the same dev server as the other specs.
import fs from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const SHOTS = "/tmp/hw-shots/dev-26"

// A trace takes a snapshot of the page on every action; with 2,000 rows that stalls the page for seconds and would
// be what the smoothness test measures.
test.use({ trace: "off" })

async function open(page: Page, scenario: "every" | "empty" | "paged" | "long" = "every", theme: "light" | "dark" = "light") {
  await page.addInitScript((t) => localStorage.setItem("herdr-web.theme", t), theme)
  await page.goto("/dev/chat")
  await page.getByTestId("dev-chat").waitFor()
  if (scenario !== "every") {
    await page.getByTestId(`scenario-${scenario}`).click()
    // the old thread is on screen until the new one has rendered
    await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", scenario)
  }
  await page.getByTestId(scenario === "empty" ? "empty-thread" : "thread").waitFor()
  const rows = { every: 21, empty: 0, paged: 50, long: 2000 }[scenario]
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-rows", String(rows))
  if (scenario === "long") await expect(page.getByTestId("thread").locator("[data-slot=message-scroller-item]")).toHaveCount(91, { timeout: 30_000 })
}

/**
 * Wait for an element of the 2,000-row page. Not `expect(locator).toBeVisible()`: while the element is missing, that
 * re-queries the whole page on every frame, and on this page that stalls it for seconds, which the test would then
 * be measuring instead of the page.
 */
const appears = (page: Page, testId: string, timeout = 15_000) =>
  page.waitForFunction((id) => document.querySelector(`[data-testid="${id}"]`), testId, { timeout, polling: 250 })

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
      for (const id of ["row-user", "row-assistant", "row-group", "row-compaction", "row-model", "row-notice"]) {
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

  // Every animation frame while the turn plays: the distance to the end as the frame starts, which is what the last
  // paint showed. A page that follows growth a frame late shows a line behind for one frame each time a line is added.
  await page.evaluate(() => {
    const el = document.querySelector("[data-testid=thread-viewport]") as HTMLElement
    const w = window as unknown as { __behind: number[]; __sampling: boolean }
    w.__behind = []
    w.__sampling = true
    const tick = () => {
      w.__behind.push(el.scrollHeight - el.clientHeight - el.scrollTop)
      if (w.__sampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.getByTestId("play-slow").click()
  await appears(page, "live-text")
  await page.waitForTimeout(2500)
  const behind = await page.evaluate(() => {
    const w = window as unknown as { __behind: number[]; __sampling: boolean }
    w.__sampling = false
    return w.__behind
  })
  expect(behind.length).toBeGreaterThan(30)
  // text did arrive during the sampling (the page grew and was followed), and no frame was more than a line behind
  // twice in a row (a line is about 28 px)
  let run = 0
  let longest = 0
  for (const px of behind) {
    run = px > 30 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  expect(Math.max(...behind), "never far behind").toBeLessThan(30)
  expect(longest).toBeLessThan(2)
  await expect.poll(() => fromEnd(page)).toBeLessThan(4) // followed the new text down
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
  const items = () => page.locator("[data-slot=message-scroller-item]").count()
  expect(await items()).toBe(39)
  // Follow one row of the view, frame by frame, from far above the top to after the older page is in. The scroller
  // keeps the row in place: it only ever moves by what the reader's wheel moved it, never by the height of 50 rows.
  await page.evaluate(() => {
    const w = window as unknown as { __ys: number[]; __stop: boolean }
    const vp = document.querySelector<HTMLElement>("[data-testid=thread-viewport]")!
    const row = [...vp.querySelectorAll<HTMLElement>("[data-row-id]")].find((r) => r.getBoundingClientRect().bottom > vp.getBoundingClientRect().top + 4)!
    const id = row.dataset.rowId
    w.__ys = []
    w.__stop = false
    const tick = () => {
      const el = [...vp.querySelectorAll<HTMLElement>("[data-row-id]")].find((r) => r.dataset.rowId === id)
      if (el) w.__ys.push(el.getBoundingClientRect().top - vp.getBoundingClientRect().top)
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // the reader wheels up until the older page has come in
  for (let i = 0; i < 40 && (await items()) < 60; i++) {
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(60)
  }
  await expect.poll(items, { timeout: 15_000 }).toBeGreaterThan(60)
  await page.waitForTimeout(800)
  const ys = await page.evaluate(() => {
    const w = window as unknown as { __ys: number[]; __stop: boolean }
    w.__stop = true
    return w.__ys
  })
  expect(ys.length).toBeGreaterThan(5)
  const jump = Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]!)))
  expect(jump, "no frame moved the row by more than a wheel step").toBeLessThan(500)
})

test("smoothness: a reply streams into a thread of 2,000 rows", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, "long")
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
  const onPage = () => page.evaluate(() => document.querySelectorAll("[data-slot=message-scroller-item]").length)
  expect(await onPage(), "the page has grown as the reader went up").toBeGreaterThan(400)
  await page.getByTestId("jump-to-latest").click()
  await expect.poll(() => fromEnd(page)).toBeLessThan(4)
  // back at the end, the page goes back to the newest rows (not measured with expect(locator): see appears())
  await page.waitForFunction(() => document.querySelectorAll("[data-slot=message-scroller-item]").length <= 130, null, { timeout: 15_000, polling: 250 })
  expect(await fromEnd(page)).toBeLessThan(4)

  await page.getByTestId("measure").click()
  const result = page.getByTestId("bench-result")
  await appears(page, "bench-result", 60_000)
  const text = (await result.textContent()) ?? ""
  const longest = Number(await result.getAttribute("data-longest"))
  console.log(`smoothness: scrolling 2,000 rows: ${JSON.stringify(scroll)}; streaming reply: ${text}`)
  info.annotations.push({ type: "smoothness", description: `scroll ${JSON.stringify(scroll)}; stream ${text}` })
  // a generous ceiling: a frame over 100 ms is a visible stall on any machine
  expect(longest).toBeLessThan(100)
  // the wheel run is 150,000 px a second, and rows are put on the page as it goes, under React's development build
  expect(scroll.longest).toBeLessThan(200)
})
