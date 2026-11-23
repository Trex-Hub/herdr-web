// The ask_user views on fixtures (/dev/chat, no core): every thread line, every panel mode, in dark and light at 1440 and dark at 390.
import fs from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const SHOTS = "/tmp/hw-shots"
test.use({ trace: "off" })
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

async function open(page: Page, mode: string, theme: "light" | "dark", width: number, height = 900) {
  await page.addInitScript((t) => localStorage.setItem("herdr-web.theme", t), theme)
  await page.setViewportSize({ width, height })
  await page.goto("/dev/chat")
  await page.getByTestId("dev-chat").waitFor()
  await page.getByTestId(`scenario-ask-${mode}`).click()
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", `ask-${mode}`)
  await page.getByTestId("thread").waitFor()
}

const shots: Array<[string, number, "light" | "dark"]> = [
  ["dark-1440", 1440, "dark"],
  ["light-1440", 1440, "light"],
  ["dark-390", 390, "dark"],
]

for (const [name, width, theme] of shots) {
  test(`every line a finished or running ask_user call has, ${name}`, async ({ page }) => {
    await open(page, "lines", theme, width, 1100)
    const states = ["answered", "answered", "answered", "answered", "not-answered", "stopped", "error", "no-details", "open"]
    const rows = page.locator("[data-testid=row-ask], [data-testid=row-tool][data-name=ask_user]")
    await expect(rows).toHaveCount(9)
    await expect(page.locator("[data-testid=row-ask][data-ask-state=answered]")).toHaveCount(4)
    expect(states.length).toBe(9)
    // never folded into a step group
    await expect(page.getByTestId("row-group")).toHaveCount(0)
    const lines = await page.locator("[data-testid=row-ask] [data-testid=ask-line]").allTextContents()
    expect(lines.map((l) => l.replace(/\s+/g, " ").trim())).toEqual([
      "Asked: Which color should the report header be? · Answered: Green",
      "Asked: Which color should the report header be? · Answered: Teal",
      "Asked: Which color should the report header be? · Answered: Blue + comment",
      "Asked: Project setup · Answered: 2 of 3 answered",
      "Asked: Which color should the report header be? · Not answered",
      "Asked: Which color should the report header be? · Stopped",
      "Asked: Which color should the report header be? · Blue",
      "Awaiting input…", // c-9 until the grace is over
    ])
    // the call pi-live never reported becomes a read-only card after a second
    await expect(page.locator("[data-testid=row-ask][data-ask-state=no-item]")).toHaveCount(1, { timeout: 5000 })
    await expect(page.getByTestId("ask-card").last()).toContainText("Answer in the terminal.")
    await expect(page.getByTestId("ask-panel")).toHaveCount(0)
    await expect(page.getByTestId("composer")).toBeVisible()
    // open every answered line: the read-only card has every question and the pick marked
    const answered = page.locator("[data-testid=row-ask][data-ask-state=answered] [data-slot=trace-collapsible-trigger]")
    for (let i = 0; i < (await answered.count()); i++) await answered.nth(i).click()
    await expect(page.getByTestId("ask-card")).toHaveCount(5)
    await page.waitForTimeout(500) // the cards finish opening
    await page.getByTestId("thread-viewport").evaluate((el) => (el.scrollTop = 0))
    await page.screenshot({ path: `${SHOTS}/dev34-lines-top-${name}.png` })
    await page.getByTestId("thread-viewport").evaluate((el) => (el.scrollTop = el.scrollHeight))
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/dev34-lines-${name}.png` })
  })

  for (const mode of ["single", "multiple", "comment", "freeform", "batch", "context", "two"]) {
    test(`panel: ${mode}, ${name}`, async ({ page }) => {
      await open(page, mode, theme, width)
      const panel = page.getByTestId("ask-panel")
      await expect(panel).toBeVisible()
      await expect(page.getByTestId("composer")).toHaveCount(0)
      await expect(page.getByTestId("ask-line")).toHaveText("Awaiting input…")
      await expect(page.getByTestId("stop")).toBeVisible()
      // nothing wider than the window, the panel inside it
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (mode === "single" || mode === "comment" || mode === "context" || mode === "two") {
        const list = panel.locator("[data-slot=questionnaire-choices]")
        await expect(list.locator("input[type=radio]").first()).toBeAttached()
        // one list: the rows are not boxes of their own, and the text row is the last one, numbered after the options
        expect(await list.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px")
        expect(await list.locator("[data-slot=questionnaire-choice]").first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px")
        // the radio dot is not drawn
        expect(await list.locator("[data-slot=questionnaire-choice-indicator]").first().evaluate((el) => getComputedStyle(el).display)).toBe("none")
      }
      if (mode === "multiple") await expect(panel.locator("input[type=checkbox]").first()).toBeAttached()
      if (mode === "batch") {
        // the progress is flush with the panel's right content edge (the choices' right edge)
        const progress = await panel.getByTestId("ask-progress").first().boundingBox()
        const list = await panel.locator("[data-slot=questionnaire-choices]").first().boundingBox()
        expect(progress && list && Math.abs(progress.x + progress.width - (list.x + list.width)) <= 1).toBe(true)
      }
      if (mode === "context") {
        // a heading in the context is no bigger than the question
        const heading = await panel.locator("[data-testid=ask-context] h1").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
        const title = await panel.locator("[data-slot=questionnaire-title]").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
        expect(heading).toBeLessThanOrEqual(title)
        await expect(page.getByTestId("ask-context")).toHaveAttribute("data-collapsed", "true")
      }
      if (mode === "two") await expect(page.getByTestId("ask-waiting")).toHaveText("1 more question waiting")
      await page.screenshot({ path: `${SHOTS}/dev34-panel-${mode}-${name}.png` })
    })
  }
}

test("the panel's answer goes through the page's actions: the panel and the open line go, the composer is back", async ({ page }) => {
  await open(page, "single", "dark", 1440)
  await page.getByRole("radio", { name: /Blue/ }).check({ force: true })
  await expect(page.getByTestId("ask-panel")).toHaveCount(0, { timeout: 5000 })
  await expect(page.getByTestId("composer")).toBeVisible()
})

test("batch: a single-choice pick moves to the next question; a multiple-choice one waits for Next", async ({ page }) => {
  await open(page, "batch", "dark", 1440)
  const progress = () => page.locator("[data-slot=questionnaire-item]:not([hidden]) [data-testid=ask-progress]")
  await expect(progress()).toHaveText("1/3")
  await page.getByRole("radio", { name: /LinkedIn/ }).check({ force: true })
  await expect(progress()).toHaveText("2/3")
  await page.getByRole("checkbox", { name: "lint" }).check({ force: true })
  await page.waitForTimeout(150)
  await expect(progress()).toHaveText("2/3") // multiple choice uses Next
  await page.getByRole("button", { name: "Next" }).click()
  await expect(progress()).toHaveText("3/3")
  await page.locator("[data-slot=questionnaire-item]:not([hidden])").getByLabel("Type something else").fill("nothing else")
  await expect(page.getByRole("button", { name: "Submit" })).toBeVisible()
})
