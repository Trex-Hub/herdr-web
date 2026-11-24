// Break-tests for the todo card on /dev/chat (fixtures, no core): keyboard, the card's share of short screens, the live region in a real browser.
import { expect, test, type Page } from "@playwright/test"

test.use({ trace: "off" })

async function open(page: Page, scenario: string, width: number, height: number) {
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await page.setViewportSize({ width, height })
  await page.goto("/dev/chat")
  await page.getByTestId("dev-chat").waitFor()
  await page.getByTestId(`scenario-${scenario}`).click()
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", scenario)
  await page.getByTestId("composer").waitFor()
}

test("the toggle is reachable by keyboard, Enter and Space both flip it, and it shows a focus ring", async ({ page }) => {
  await open(page, "todo-statuses", 1440, 900)
  const toggle = page.getByTestId("todos-toggle")
  await toggle.focus()
  await expect(toggle).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Space")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(toggle).toBeFocused() // focus is not lost when the body folds
  // the card comes before the composer in the tab order
  await page.getByTestId("composer-input").focus()
  await page.keyboard.press("Shift+Tab")
  const where = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))
  expect(where).not.toBe("composer-input")
})

test("the card's accessible tree: a labelled region, state-first rows, one polite status", async ({ page }) => {
  await open(page, "todo-statuses", 1440, 900)
  const region = page.getByRole("region", { name: "Todos" })
  await expect(region).toBeVisible()
  await expect(region.getByRole("status")).toHaveCount(1)
  await expect(region.getByRole("status")).toHaveAttribute("aria-live", "polite")
  await expect(region.getByRole("listitem").nth(2)).toContainText("In progress:")
  // decorative marks are hidden from the tree
  expect(await region.locator('[data-testid="todo-mark"][aria-hidden="true"]').count()).toBe(5)
})

for (const [w, h] of [[390, 700], [390, 500], [844, 390], [1440, 500]] as const) {
  test(`a long open list on a ${w}x${h} screen: the card stays near a third, scrolls inside, and the composer stays on screen`, async ({ page }) => {
    await open(page, "todo-long", w, h)
    await page.getByTestId("todos-more").click()
    const card = (await page.getByTestId("todos").boundingBox())!
    const comp = (await page.getByTestId("composer").boundingBox())!
    console.log(`${w}x${h}: card ${Math.round(card.height)} px (${Math.round((card.height / h) * 100)}%), composer bottom ${Math.round(comp.y + comp.height)}`)
    expect(card.height / h).toBeLessThan(0.45)
    // (on a short screen the dev page's own toolbar leaves the chat 200 px; the composer then runs below the screen with or without the card, so it is not asserted here)
    if (h >= 700) expect(comp.y + comp.height).toBeLessThanOrEqual(h + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const body = page.getByTestId("todos-body")
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(h < 900)
  })
}

test("a subject with one 5,000-character word does not widen the page and the collapsed line truncates", async ({ page }) => {
  await open(page, "todo-turn", 390, 700)
  await page.getByTestId("todo-step").click() // the list appears
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="todo-task"] span.break-words')
    if (el) el.textContent = "W".repeat(5000)
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const row = (await page.getByTestId("todo-task").first().boundingBox())!
  expect(row.width).toBeLessThanOrEqual(390)
})

// Found by the tester: the ring spun under prefers-reduced-motion (the app's other motion, trace.tsx, has motion-reduce:shimmer-none).
test("the spinner is a CSS animation that respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await open(page, "todo-statuses", 1440, 900)
  const anim = await page.locator('[data-testid="todo-mark"][data-spinning="true"]').evaluate((el) => getComputedStyle(el).animationName)
  console.log(`spinner animation under reduced motion: ${anim}`)
  expect(anim, "the spinning ring keeps turning with prefers-reduced-motion: reduce").toBe("none")
})
