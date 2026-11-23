import fs from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { PASSPHRASE } from "./global-setup"
import { addSpace, hc, liveDir, root } from "./scratch"
import { StandIn } from "./stand-in"

// pi's own dialogs in the chat, in a browser, against the real backend and a scratch core, with a stand-in for pi-live that sends
// `state.waitingForUser`: the line shows, Open terminal switches the view, and the line goes when the state clears. No pi and no model.
// (Named so that it runs after shell.spec.ts, which expects the core's herdr-app doc at version 0: this spec adds a space.)

const osc = (state: string) => `printf '\\033]7501;state=${state}:app=pi\\007'`
const SHOTS = "/tmp/hw-shots"

test.describe.configure({ mode: "serial" })

const started: string[] = []
let agent: StandIn | null = null
test.afterAll(() => {
  agent?.close()
  for (const address of started) {
    try {
      hc("kill", address)
    } catch {
      // already ended
    }
  }
})

test("a dialog of pi's own shows as a line, Open terminal shows the terminal, and the line goes with the dialog", async ({ page }) => {
  const folder = fs.mkdtempSync(path.join(root(), "waiting-"))
  await addSpace({ id: "sp-wait", name: "waitspace", folder })
  await fs.promises.mkdir(SHOTS, { recursive: true })
  const address = (JSON.parse(hc("run", "--bg", "--name", "wait-agent", "--keep", "--no-parent", "--label", "herdr.space=sp-wait", "--label", "herdr.seen=0", "--", "sh", "-c", `${osc("idle")}; sleep 600`)) as { address: string }).address
  started.push(address)
  agent = await StandIn.connect({ liveDir: liveDir(), terminalId: address, dir: path.join(folder, "sessions"), stepMs: 100 })
  const stand = agent

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "waitspace" }).click()
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 10_000 })
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("waiting")).toHaveCount(0)

  // pi opens a confirm: the line, with its title, after the grace; the composer stays.
  stand.setWaiting({ kind: "confirm", title: "Deploy to production?" })
  await expect(page.getByTestId("waiting-title")).toHaveText("Deploy to production?", { timeout: 10_000 })
  await expect(page.getByTestId("waiting-prefix")).toHaveText("Waiting for you in the terminal")
  await expect(page.getByTestId("composer")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/dev39-stand-in-waiting-dark-1440.png` })

  // Open terminal: the pane shows its terminal.
  await page.getByTestId("open-terminal").click()
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "terminal")
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat")
  await expect(page.getByTestId("waiting")).toBeVisible()

  // The dialog ends in the terminal: the line goes.
  stand.setWaiting(null)
  await expect(page.getByTestId("waiting")).toHaveCount(0, { timeout: 10_000 })

  // A second dialog, with no title; then it is replaced by another kind (pi coalesces nested ones into one span).
  stand.setWaiting({ kind: "custom", title: null })
  await expect(page.getByTestId("waiting")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("waiting-title")).toHaveCount(0)
  stand.setWaiting({ kind: "select", title: "Pick a region" })
  await expect(page.getByTestId("waiting-title")).toHaveText("Pick a region")
  stand.setWaiting(null)
  await expect(page.getByTestId("waiting")).toHaveCount(0, { timeout: 10_000 })

  // An ask_user prompt sets the same state in a real pi (it opens through ctx.ui.custom): only the panel shows, never the line.
  const ask = stand.park("ask_user.question", { question: "Which color?", options: [{ title: "Green" }, { title: "Blue" }], allowMultiple: false, allowFreeform: true, allowComment: false })
  stand.setWaiting({ kind: "custom", title: "Which color?" })
  await expect(page.getByTestId("ask-panel")).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(2000)
  await expect(page.getByTestId("waiting")).toHaveCount(0)
  await page.getByRole("radio", { name: /Blue/ }).check({ force: true })
  await expect.poll(() => stand.answers.length, { timeout: 5000 }).toBe(1)
  expect(stand.answers[0]).toMatchObject({ id: ask })
  stand.setWaiting(null)
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("waiting")).toHaveCount(0)
})
