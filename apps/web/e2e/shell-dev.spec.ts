// DEV-33: the sidebar's layout, measured in a real browser on /dev/shell (fixtures, no backend needed).
import { expect, test, type Locator, type Page } from "@playwright/test"

const box = async (l: Locator) => (await l.boundingBox())!

async function open(page: Page, size = { width: 1440, height: 900 }, checks: Record<string, boolean> = {}) {
  await page.setViewportSize(size)
  await page.goto("/dev/shell")
  await page.getByTestId("sidebar").waitFor()
  for (const [label, on] of Object.entries(checks)) await page.getByLabel(label, { exact: true }).setChecked(on)
}

const sidebar = (p: Page) => p.getByTestId("sidebar")
const spaces = (p: Page) => p.getByTestId("spaces-block")
const agents = (p: Page) => p.getByTestId("agents-block")

test("the Agents block is the bottom of the sidebar, above the footer, and the Spaces block takes what is above it", async ({ page }) => {
  await open(page)
  const s = await box(sidebar(page))
  const a = await box(agents(page))
  const sp = await box(spaces(page))
  const footer = await box(page.getByTestId("sign-out"))
  expect(a.y + a.height, "the agents block ends where the footer starts").toBeGreaterThan(footer.y - 20)
  expect(a.y + a.height).toBeLessThanOrEqual(footer.y)
  expect(Math.abs(sp.y + sp.height - a.y), "no gap between the two blocks").toBeLessThanOrEqual(1)
  expect(a.height, "no more than half of what the two blocks share").toBeLessThanOrEqual((sp.height + a.height) / 2 + 1)
  expect(s.height).toBe(900)
})

test("the Agents block is as tall as its content up to half the sidebar, then scrolls inside", async ({ page }) => {
  // Tall window: the agents fit in under half, so the block is exactly its content.
  await open(page, { width: 1440, height: 1600 })
  const fits = await agents(page).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(fits.client).toBe(fits.scroll)
  const sTall = await box(sidebar(page))
  expect((await box(agents(page))).height).toBeLessThan(sTall.height / 2)
  // A short window: the content is more than half.
  await open(page, { width: 1440, height: 600 })
  const short = await agents(page).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(short.scroll).toBeGreaterThan(short.client)
  const both = (await box(agents(page))).height + (await box(spaces(page))).height
  expect((await box(agents(page))).height).toBeLessThanOrEqual(both / 2 + 1)
  await agents(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
  expect(await agents(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  // The last agent can be reached.
  await expect(page.getByTestId("agent-row").last()).toBeInViewport()
})

test("many spaces scroll in the Spaces block while the Agents block stays where it is", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, { "Many spaces": true })
  const before = await box(agents(page))
  const sp = await spaces(page).evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(sp.scroll).toBeGreaterThan(sp.client)
  await spaces(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
  expect(await spaces(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const after = await box(agents(page))
  expect(after.y).toBe(before.y)
  expect(after.height).toBe(before.height)
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop), "the page itself does not scroll").toBe(0)
})

test("in a short window both blocks scroll", async ({ page }) => {
  await open(page, { width: 1440, height: 600 }, { "Many spaces": true, "Many agents": true })
  for (const block of [spaces(page), agents(page)]) {
    const m = await block.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
    expect(m.scroll).toBeGreaterThan(m.client)
  }
  expect((await box(spaces(page))).height).toBeGreaterThan(100)
})

test("with no agents the block is one muted line and Spaces gets the room", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, { Agents: false })
  await expect(agents(page)).toHaveText("No agents running")
  expect((await box(agents(page))).height).toBeLessThan(60)
  expect((await box(spaces(page))).height).toBeGreaterThan(700)
})

test("an unreachable machine is one line, and the long reason is in its tooltip, not on the page", async ({ page }) => {
  await open(page)
  const machine = page.locator('[data-testid="machine"][data-machine="cachyos"]')
  const header = machine.locator("> div").first()
  await expect(header).toHaveAttribute("title", /Connection timed out after 30 seconds.*tailscale reports/)
  await expect(page.getByTestId("machine-down")).toHaveText("Unreachable")
  expect((await box(header)).height).toBe(28)
  await expect(page.getByText("Connection timed out")).toHaveCount(0)
  const name = await box(header.locator("span").nth(1))
  const status = await box(page.getByTestId("machine-down"))
  expect(status.x, "the status is to the right of the name").toBeGreaterThan(name.x + name.width)
  expect(Math.abs(status.y - name.y), "on the same line").toBeLessThan(6)
})

test("space rows are all 40px, with or without a path; paths use ~", async ({ page }) => {
  await open(page)
  const heights = await page.getByTestId("space-row").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  expect(new Set(heights)).toEqual(new Set([40]))
  expect(await page.getByTestId("space-path").allTextContents()).toEqual(["~", "~/…/devendras-work/herdr-web", "~/…/api/service", "~/ayra/app", "~"])
  const nopath = page.getByTestId("space-row").filter({ hasText: "scratchpad" })
  const row = await box(nopath)
  const name = await box(nopath.locator("span.truncate"))
  expect(Math.abs(name.y + name.height / 2 - (row.y + row.height / 2)), "the name is centred when there is no path").toBeLessThan(2)
})

test("herdr-app's groups and names show, and with no file the grouping is by space", async ({ page }) => {
  await open(page)
  const titles = () => page.getByTestId("agent-group").evaluateAll((els) => els.map((e) => e.firstElementChild!.textContent))
  expect(await titles()).toEqual(["ayra", "herdr-web", "freebrawl"])
  await expect(page.getByTestId("agent-name").filter({ hasText: "ui-lead" })).toHaveCount(1)
  await page.getByLabel("herdr-app file").setChecked(false)
  expect(await titles()).toEqual(["Home", "herdr-web", "server-box", "ayra", "Not in a space (This computer)"])
  await expect(page.getByTestId("agent-name").filter({ hasText: "ui-lead" })).toHaveCount(0)
})

test("the row menu shows on hover and on the selected row only; ages line up; a long name is cut with an ellipsis", async ({ page }) => {
  await open(page, { width: 1440, height: 1200 })
  const rows = page.getByTestId("agent-row")
  const menuOpacity = (i: number) => page.getByTestId("agent-menu").nth(i).evaluate((el) => getComputedStyle(el).opacity)
  const selected = await rows.evaluateAll((els) => els.findIndex((e) => e.getAttribute("data-selected") === "true"))
  const other = selected === 0 ? 1 : 0
  await expect.poll(() => menuOpacity(other)).toBe("0")
  await expect.poll(() => menuOpacity(selected)).toBe("1")
  // Ages share a right edge while no menu shows (every row but the selected one).
  const rights = await page.getByTestId("agent-row").evaluateAll((els, sel) => els.filter((_, i) => i !== sel).map((e) => Math.round(e.querySelector(".tabular-nums")!.getBoundingClientRect().right)), selected)
  expect(new Set(rights).size).toBe(1)
  await rows.nth(other).hover()
  await expect.poll(() => menuOpacity(other)).toBe("1") // the button fades in
  await page.mouse.move(700, 500)
  await expect.poll(() => menuOpacity(other)).toBe("0")
  // The long name is cut at the end and the row stays inside the sidebar.
  const long = page.getByTestId("agent-name").filter({ hasText: "sidebar-modification" })
  const cut = await long.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }))
  expect(cut).toEqual({ cut: true, overflow: "ellipsis" })
  const s = await box(sidebar(page))
  const r = await box(long.locator("xpath=ancestor::button"))
  expect(r.x + r.width).toBeLessThanOrEqual(s.x + s.width)
})

test("the space after an agent's name is dropped, never squeezed, when the name needs the room", async ({ page }) => {
  await open(page, { width: 1440, height: 1200 })
  const shown = async (name: string) => {
    const row = page.getByTestId("agent-row").filter({ has: page.getByTestId("agent-name").filter({ hasText: name }) })
    const tag = row.getByTestId("agent-space")
    if ((await tag.count()) === 0) return "none"
    const t = await box(tag)
    const holder = await box(tag.locator(".."))
    return t.y >= holder.y && t.y + t.height <= holder.y + holder.height + 1 ? "visible" : "dropped"
  }
  expect(await shown("AYR-59")).toBe("visible") // fits beside a short name
  expect(await shown("sidebar-modification")).toBe("dropped") // the long name keeps the room
})
