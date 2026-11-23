// "Waiting for you in the terminal" on fixtures (/dev/chat, no core): the line, Open terminal, and when it stays hidden because an
// ask_user call already shows the wait. Dark and light at 1440 and dark at 390; screenshots in /tmp/hw-shots/dev39-*.
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
  await page.getByTestId(`scenario-waiting-${mode}`).click()
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", `waiting-${mode}`)
  await page.getByTestId("thread").waitFor()
}

const shots: Array<[string, number, "light" | "dark"]> = [
  ["dark-1440", 1440, "dark"],
  ["light-1440", 1440, "light"],
  ["dark-390", 390, "dark"],
]

for (const [name, width, theme] of shots) {
  test(`pi on a confirm: the line with its title replaces Working…, ${name}`, async ({ page }) => {
    await open(page, "confirm", theme, width)
    await expect(page.getByTestId("working")).toBeVisible() // inside the grace
    await expect(page.getByTestId("waiting")).toBeVisible({ timeout: 5000 })
    if (width >= 640) {
      await expect(page.getByTestId("waiting-prefix")).toHaveText("Waiting for you in the terminal")
      await expect(page.getByTestId("waiting-title")).toHaveText("Deploy to production?")
    } else {
      // narrow: the short words, the title still there (cut only when it must), and the link whole
      await expect(page.getByTestId("waiting-prefix-short")).toBeVisible()
      await expect(page.getByTestId("waiting-prefix")).toBeHidden()
      await expect(page.getByTestId("waiting-title")).toBeVisible()
      const title = (await page.getByTestId("waiting-title").boundingBox())!
      expect(title.width).toBeGreaterThan(20)
      const link = (await page.getByTestId("open-terminal").boundingBox())!
      expect(link.width).toBeGreaterThan(80)
    }
    await expect(page.getByTestId("working")).toHaveCount(0)
    await expect(page.getByTestId("open-terminal")).toBeVisible()
    await expect(page.getByTestId("composer")).toBeVisible()
    // the line stays inside the thread's column, the link on it
    const line = (await page.getByTestId("waiting").boundingBox())!
    const column = (await page.getByTestId("thread-viewport").boundingBox())!
    expect(line.x).toBeGreaterThanOrEqual(column.x)
    expect(line.x + line.width).toBeLessThanOrEqual(column.x + column.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `${SHOTS}/dev39-confirm-${name}.png` })
  })
}

test("a short title shows whole at 390 px, after the short words, with the link whole", async ({ page }) => {
  await open(page, "short", "dark", 390)
  await expect(page.getByTestId("waiting-prefix-short")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("waiting-prefix")).toBeHidden()
  await expect(page.getByTestId("waiting-title")).toHaveText("Deploy?")
  await expect(page.getByTestId("waiting-title")).toBeVisible()
  expect(await page.getByTestId("waiting-title").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true) // not cut
  await expect(page.getByTestId("open-terminal")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/dev39-short-title-dark-390.png` })
})

test("a dialog with no title is the words alone", async ({ page }) => {
  await open(page, "untitled", "dark", 1440)
  await expect(page.getByTestId("waiting-prefix")).toHaveText("Waiting for you in the terminal", { timeout: 5000 })
  await expect(page.getByTestId("waiting-title")).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev39-untitled-dark-1440.png` })
})

test("Open terminal switches the pane's view", async ({ page }) => {
  await open(page, "confirm", "dark", 1440)
  await page.getByTestId("open-terminal").click({ timeout: 5000 })
  await expect(page.getByTestId("terminal-stand-in")).toBeVisible()
})

test("behind an open ask_user prompt the line stays hidden: the panel is the wait", async ({ page }) => {
  await open(page, "ask", "dark", 1440)
  await expect(page.getByTestId("ask-panel")).toBeVisible()
  await page.waitForTimeout(2500)
  await expect(page.getByTestId("waiting")).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev39-with-ask-dark-1440.png` })
})

test("behind an ask_user call pi-live never reported the line stays hidden: the card is the wait", async ({ page }) => {
  await open(page, "card", "dark", 1440)
  await expect(page.locator("[data-testid=row-ask][data-ask-state=no-item]")).toHaveCount(1, { timeout: 5000 })
  await expect(page.getByTestId("ask-card")).toContainText("Answer in the terminal.")
  await page.waitForTimeout(1500)
  await expect(page.getByTestId("waiting")).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev39-with-card-dark-1440.png` })
})
