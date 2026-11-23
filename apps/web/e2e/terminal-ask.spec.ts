import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { PASSPHRASE } from "./global-setup"
import { addSpace, hc, liveDir, root } from "./scratch"
import { StandIn } from "./stand-in"

// ask_user in the chat, in a browser, against the real backend and a scratch core, with a stand-in for pi-live (e2e/stand-in.ts) that
// parks prompts the way pi-ask-user does: the panel answers them, and the thread's line says what was answered. No pi and no model.

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

const panel = (page: Page) => page.getByTestId("ask-panel")
const line = (page: Page) => page.getByTestId("row-ask").last().getByTestId("ask-line")
const item = (page: Page) => page.locator("[data-slot=questionnaire-item]:not([hidden])")
const progress = (page: Page) => item(page).getByTestId("ask-progress")

const colors = { question: "Which color?", options: [{ title: "Green", description: "the calm one" }, { title: "Blue" }], allowMultiple: false, allowFreeform: true, allowComment: false }

test("ask_user in the chat: single, several with a comment, typed, a batch with a skip, a refused answer, and one that came late", async ({ page, browser }) => {
  const folder = fs.mkdtempSync(path.join(root(), "ask-"))
  await addSpace({ id: "sp-ask", name: "askspace", folder })
  await fs.promises.mkdir(SHOTS, { recursive: true })
  const address = (JSON.parse(hc("run", "--bg", "--name", "ask-agent", "--keep", "--no-parent", "--label", "herdr.space=sp-ask", "--label", "herdr.seen=0", "--", "sh", "-c", `${osc("idle")}; sleep 600`)) as { address: string }).address
  started.push(address)
  agent = await StandIn.connect({ liveDir: liveDir(), terminalId: address, dir: path.join(folder, "sessions"), stepMs: 100 })
  const stand = agent

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "askspace" }).click()
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 10_000 })
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 10_000 })

  // One question, one choice: the panel is where the composer was, the thread says it waits, and a pick answers.
  const first = stand.park("ask_user.question", colors)
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("composer")).toHaveCount(0)
  await expect(line(page)).toHaveText("Awaiting input…")
  await expect(panel(page).getByTestId("stop")).toBeVisible()
  await expect(page.getByTestId("row-group")).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev34-stand-in-open-dark-1440.png` })
  await page.getByRole("radio", { name: /Blue/ }).check({ force: true })
  await expect.poll(() => stand.answers.length, { timeout: 5000 }).toBe(1)
  expect(stand.answers[0]).toMatchObject({ id: first, answer: { kind: "selection", selections: ["Blue"] } })
  await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId("composer")).toBeVisible()
  await expect(line(page)).toHaveText("Asked: Which color? · Answered: Blue", { timeout: 10_000 })
  await page.screenshot({ path: `${SHOTS}/dev34-stand-in-answered-dark-1440.png` })
  // the line opens to a read-only card with the pick marked
  await page.getByTestId("row-ask").last().locator("[data-slot=trace-collapsible-trigger]").click()
  await expect(page.getByTestId("ask-card").locator("[data-picked=true]")).toHaveText(/Blue/)

  // Several choices and a comment: nothing is sent until Submit, and the comment goes with the picks.
  const second = stand.park("ask_user.question", { question: "Which checks?", options: [{ title: "lint" }, { title: "test" }, { title: "types" }], allowMultiple: true, allowFreeform: false, allowComment: true })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  await page.getByRole("checkbox", { name: "types" }).check({ force: true })
  await page.getByRole("checkbox", { name: "lint" }).check({ force: true })
  await page.getByTestId("ask-comment").fill("fast ones first")
  expect(stand.answers).toHaveLength(1)
  await page.getByRole("button", { name: "Submit" }).click()
  await expect.poll(() => stand.answers.length, { timeout: 5000 }).toBe(2)
  expect(stand.answers[1]).toMatchObject({ id: second, answer: { kind: "selection", selections: ["lint", "types"], comment: "fast ones first" } })
  await expect(line(page)).toHaveText("Asked: Which checks? · Answered: lint, types + comment", { timeout: 10_000 })

  // Typed: the last row of the list is the input, and Enter sends it.
  const third = stand.park("ask_user.question", { ...colors, question: "What is the file called?", options: [] })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  await page.getByLabel("Type something else").fill("out.csv")
  await page.getByLabel("Type something else").press("Enter")
  await expect.poll(() => stand.answers.length, { timeout: 5000 }).toBe(3)
  expect(stand.answers[2]).toMatchObject({ id: third, answer: { kind: "freeform", text: "out.csv" } })
  await expect(line(page)).toHaveText("Asked: What is the file called? · Answered: out.csv", { timeout: 10_000 })

  // A batch: a single choice moves on by itself, the second is skipped, the third typed; one answer at the end.
  const batch = stand.park("ask_user.batch", {
    heading: "Setup",
    allowComment: false,
    questions: [
      { question: "Which language?", options: [{ title: "TypeScript" }, { title: "Python" }], allowMultiple: false, allowFreeform: false },
      { question: "Which checks?", options: [{ title: "lint" }, { title: "test" }], allowMultiple: true, allowFreeform: false },
      { question: "Anything else?", options: [], allowMultiple: false, allowFreeform: true },
    ],
  })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  await expect(progress(page)).toHaveText("1/3")
  await page.getByRole("radio", { name: /Python/ }).check({ force: true })
  await expect(progress(page)).toHaveText("2/3")
  await page.getByRole("button", { name: "Skip" }).click()
  await expect(progress(page)).toHaveText("3/3")
  await page.screenshot({ path: `${SHOTS}/dev34-stand-in-batch-dark-1440.png` })
  await item(page).getByLabel("Type something else").fill("nothing")
  expect(stand.answers).toHaveLength(3)
  await page.getByRole("button", { name: "Submit" }).click()
  await expect.poll(() => stand.answers.length, { timeout: 5000 }).toBe(4)
  expect(stand.answers[3]).toMatchObject({
    id: batch,
    answer: { answers: [{ status: "answered", response: { kind: "selection", selections: ["Python"] } }, { status: "skipped" }, { status: "answered", response: { kind: "freeform", text: "nothing" } }] },
  })
  await expect(line(page)).toHaveText("Asked: Setup · 2 of 3 answered", { timeout: 10_000 })

  // A refused answer: pi-ask-user's reason is shown under the choices, the panel stays, and the next try goes through.
  const fourth = stand.park("ask_user.question", { ...colors, question: "Pick again?" })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  stand.rejectNext("option \"Green\" is no longer offered")
  await page.getByRole("radio", { name: /Green/ }).check({ force: true })
  await expect(page.getByTestId("ask-rejected")).toHaveText("option \"Green\" is no longer offered", { timeout: 5000 })
  await expect(panel(page)).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/dev34-stand-in-invalid-dark-1440.png` })
  await page.getByRole("radio", { name: /Blue/ }).check({ force: true })
  await expect.poll(() => stand.answers.length, { timeout: 5000 }).toBe(6)
  expect(stand.answers[5]).toMatchObject({ id: fourth, answer: { kind: "selection", selections: ["Blue"] } })
  await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })

  // Late: the keyboard got there first and the page has not heard yet. The answer is `closed`; the page says so, and the panel
  // goes as soon as pi says the prompt is closed.
  const fifth = stand.park("ask_user.question", { ...colors, question: "Too late?" })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  stand.dropAsk(fifth)
  await page.getByRole("radio", { name: /Green/ }).check({ force: true })
  await expect(page.getByTestId("ask-closed")).toHaveText("This question was already answered or closed.", { timeout: 5000 })
  stand.announceClosed(fifth)
  await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })

  // A second tab shows the open prompt too, and the answer from the first closes it there.
  const tab = await (await browser.newContext({ baseURL: "http://localhost:14000" })).newPage()
  await tab.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await tab.goto("/login")
  await tab.getByLabel("Passphrase").fill(PASSPHRASE)
  await tab.getByRole("button", { name: "Sign in" }).click()
  await tab.getByTestId("space-row").filter({ hasText: "askspace" }).click()
  const sixth = stand.park("ask_user.question", { ...colors, question: "Two tabs?" })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  await expect(tab.getByTestId("view-toggle")).toBeVisible({ timeout: 10_000 })
  await tab.getByTestId("view-chat").click()
  await expect(panel(tab)).toBeVisible({ timeout: 10_000 })
  await page.getByRole("radio", { name: /Green/ }).check({ force: true })
  await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(panel(tab)).toHaveCount(0, { timeout: 10_000 })
  await expect(line(tab)).toHaveText("Asked: Two tabs? · Answered: Green", { timeout: 10_000 })
  expect(stand.answers.at(-1)).toMatchObject({ id: sixth })
  await tab.context().close()

  // Answered at the keyboard, or cancelled there: the thread says so with no help from this page.
  stand.park("ask_user.question", { ...colors, question: "At the keyboard?" })
  await expect(panel(page)).toBeVisible({ timeout: 10_000 })
  stand.cancelAsk(stand.openAsks()[0]!, "keyboard")
  await expect(panel(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(line(page)).toHaveText("Asked: At the keyboard? · Not answered", { timeout: 10_000 })
})
