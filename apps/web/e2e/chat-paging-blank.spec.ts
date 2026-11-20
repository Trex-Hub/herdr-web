// DEV-30 item 5: the reader never sees an empty thread viewport while scrolling to the top of a paged thread.
// Needs no core. A frame is "blank" when the painted thread area has (almost) no pixel that differs from its background.
import { expect, test, type Page } from "@playwright/test"

test.use({ trace: "off" })

async function isBlank(page: Page, png: Buffer): Promise<boolean> {
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement("canvas")
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext("2d")!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const [r, g, b] = [d[0]!, d[1]!, d[2]!]
    let diff = 0
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - r) + Math.abs(d[i + 1]! - g) + Math.abs(d[i + 2]! - b) > 24) diff++
    return diff / (c.width * c.height) < 0.002
  }, png.toString("base64"))
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/dev/chat")
  await page.getByTestId("scenario-paged").click()
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", "paged")
  await expect(page.locator("[data-slot=message-scroller-item]")).toHaveCount(39)
  await page.waitForTimeout(800)
  await page.getByTestId("thread-viewport").hover()
  await page.mouse.click(720, 300)
}

async function blankFramesWhile(page: Page, act: () => Promise<void>, shots = 12): Promise<number> {
  const clip = { x: 0, y: 45, width: 1440, height: 750 } // the thread, above the composer
  await act()
  let blank = 0
  for (let i = 0; i < shots; i++) if (await isBlank(page, await page.screenshot({ clip }))) blank++
  return blank
}

test("Home to the top of a paged thread never shows an empty viewport", async ({ page }) => {
  await open(page)
  expect(await blankFramesWhile(page, () => page.keyboard.press("Home"))).toBe(0)
})

test("holding PageUp up to the older page never shows an empty viewport", async ({ page }) => {
  await open(page)
  expect(await blankFramesWhile(page, async () => { for (let i = 0; i < 30; i++) await page.keyboard.press("PageUp") }, 20)).toBe(0)
})

test("scrollTop = 0 never shows an empty viewport", async ({ page }) => {
  await open(page)
  expect(await blankFramesWhile(page, () => page.getByTestId("thread-viewport").evaluate((el) => void (el.scrollTop = 0)))).toBe(0)
})