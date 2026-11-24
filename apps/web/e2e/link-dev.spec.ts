// pi-link in the chat on fixtures (/dev/chat, no core): received messages as bubbles from the left, what this agent sent on the
// right, the link tools' own rows, compaction lines, and a batch that cannot be split. Dark and light at 1440 and dark at 390;
// screenshots in /tmp/hw-shots/dev40-*.
import fs from "node:fs"
import { expect, test, type Page } from "@playwright/test"

const SHOTS = "/tmp/hw-shots"
test.use({ trace: "off" })
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

async function open(page: Page, theme: "light" | "dark", width: number, height = 900) {
  await page.addInitScript((t) => localStorage.setItem("herdr-web.theme", t), theme)
  await page.setViewportSize({ width, height })
  await page.goto("/dev/chat")
  await page.getByTestId("dev-chat").waitFor()
  await page.getByTestId("scenario-link").click()
  await expect(page.getByTestId("dev-chat")).toHaveAttribute("data-scenario", "link")
  await page.getByTestId("thread").waitFor()
}

const shots: Array<[string, number, "light" | "dark"]> = [
  ["dark-1440", 1440, "dark"],
  ["light-1440", 1440, "light"],
  ["dark-390", 390, "dark"],
]

for (const [name, width, theme] of shots) {
  test(`pi-link messages and tools, ${name}`, async ({ page }) => {
    await open(page, theme, width)
    const thread = page.getByTestId("thread-viewport")

    // received: a bubble per message, grouped by sender, from the left
    const from = page.getByTestId("link-from")
    await expect(from).toHaveCount(4) // engineer; engineer (2 bubbles) + designer; the unsplit one
    await expect(page.locator('[data-testid=row-link][data-split=true]')).toHaveCount(3)
    const batch = page.getByTestId("row-link").nth(1)
    await expect(batch.getByTestId("link-from")).toHaveCount(2)
    await expect(batch.getByTestId("link-from").first().getByTestId("link-bubble")).toHaveCount(2)
    await expect(batch.getByTestId("link-from").first().getByTestId("link-name")).toHaveText("herdr-web-engineer")
    await expect(batch.getByTestId("link-from").first().getByTestId("link-avatar")).toHaveText("WE")
    await expect(batch.getByText("Ship it.")).toBeVisible()

    // a long message folds, Show more opens it
    const long = batch.getByTestId("link-body").first()
    await expect(long).toHaveAttribute("data-folded", "true")
    await batch.getByTestId("link-more").click()
    await expect(long).toHaveAttribute("data-folded", "false")
    await expect(batch.getByText("Waiting for you.")).toBeVisible()
    await expect(batch.getByTestId("link-more")).toHaveText("Show less")

    // compaction outcomes: one small line each
    await expect(page.getByTestId("link-compact-outcome")).toHaveText(["herdr-web-tester compacted", "Compaction of ui-ux-engineer: not done: busy"])
    await expect(page.getByTestId("link-compact-asked")).toContainText("Asked herdr-web-engineer to compact")

    // a batch whose split does not match its count: shown whole, nothing lost
    const unsplit = page.locator('[data-testid=row-link][data-split=false]')
    await expect(unsplit.getByTestId("link-unsplit")).toBeVisible()
    await expect(unsplit.getByTestId("link-name")).toHaveText("herdr-web-tester")
    await expect(unsplit).toContainText("I'll start the final round now.")

    // sent: on the right, sent / not delivered / sending; never folded into a group of steps
    const sends = page.getByTestId("row-link-send")
    await expect(sends).toHaveCount(3)
    await expect(sends.nth(0)).toHaveAttribute("data-state", "sent")
    await expect(sends.nth(0).getByTestId("link-send-status")).toContainText("Sent")
    await expect(sends.nth(1)).toHaveAttribute("data-state", "failed")
    await expect(sends.nth(1).getByTestId("link-send-status")).toContainText('Not delivered: Terminal "herdr-web-tester" not found')
    await expect(sends.nth(2)).toHaveAttribute("data-state", "sending")
    const sentBubble = (await sends.nth(0).getByTestId("link-bubble").boundingBox())!
    const receivedBubble = (await from.first().getByTestId("link-bubble").boundingBox())!
    // the sent bubble ends where the user's own messages end; the received one starts at the reply column's left
    const userRow = (await page.getByTestId("row-user").first().boundingBox())!
    const reply = (await page.getByTestId("row-assistant").first().boundingBox())!
    expect(Math.abs(sentBubble.x + sentBubble.width - (userRow.x + userRow.width))).toBeLessThan(2)
    expect(receivedBubble.x).toBeLessThan(reply.x + 48)
    await expect(page.getByText(/used link_send/)).toHaveCount(0)

    // link_list: one line, opening to each terminal
    const list = page.getByTestId("row-link-list")
    await expect(list).toContainText("Listed 3 terminals")
    await expect(list.getByTestId("link-terminal")).toHaveCount(0)
    await list.getByText("Listed 3 terminals").click()
    await expect(list.getByTestId("link-terminal")).toHaveCount(3)
    await expect(list.getByTestId("link-terminal").first()).toContainText("(this agent)")
    await expect(list.getByTestId("link-terminal").nth(1)).toContainText("working")

    // a custom message of another type: the notice line, as before
    await expect(page.getByTestId("row-notice").filter({ hasText: "An extension's own message of a type the chat does not know" })).toBeVisible()

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await thread.evaluate((el) => el.scrollTo(0, 0))
    await page.screenshot({ path: `${SHOTS}/dev40-top-${name}.png` })
    await page.getByTestId("row-link").nth(1).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/dev40-batch-${name}.png` })
    await thread.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await page.screenshot({ path: `${SHOTS}/dev40-end-${name}.png` })
  })
}
