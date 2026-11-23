import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { MODEL_WAIT_MS, corePids, fingerprint, piLive, repo, strayedLiveFiles, strayedSessions } from "../../../packages/agents/live/support"
import { LIVE_BACKEND_PORT } from "../playwright.live.config"
import { PASSPHRASE } from "../e2e/global-setup"
import { addSpace } from "../e2e/scratch"

// ask_user in the chat with a real pi: pi-ask-user (the pinned fork) parks every prompt on pi-live, and the browser answers it. The model is
// claude-relay/claude-haiku-5-5 (the relay of ~/.pi/agent/models.json, which pi reads and this test never writes), told exactly which
// arguments to call ask_user with. `pnpm test:agents` runs it. Screenshots go to /tmp/hw-shots/dev34-live-*.

const SHOTS = "/tmp/hw-shots"
const MODEL = "claude-relay/claude-haiku-5-5"
const piAskUser = path.join(repo, "node_modules/pi-ask-user")
const root = (): string => process.env.HW_LIVE_ROOT!
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })
const backend = `http://localhost:${LIVE_BACKEND_PORT}`

test.describe.configure({ mode: "serial" })

let fingerprintBefore = ""
let coresBefore: number[] = []
const startedAt = Date.now()
const started: string[] = []
const times: string[] = []

test.beforeAll(() => {
  fs.mkdirSync(SHOTS, { recursive: true })
  fingerprintBefore = fingerprint()
  coresBefore = corePids()
})

// A failed test leaves a marker: the teardown then keeps the scratch root and prints where it is.
test.afterEach(({}, info) => {
  if (info.status !== info.expectedStatus) fs.writeFileSync(path.join(root(), "FAILED"), `${info.title}\n`)
})

test.afterAll(() => {
  console.log(["", "times:", ...times.map((l) => `  - ${l}`)].join("\n"))
  for (const a of started) {
    try {
      hc("kill", a)
    } catch {
      // already ended
    }
  }
  // What the live test must not change: pi's own settings and extensions, its session folder, the real core.
  expect(fingerprint()).toBe(fingerprintBefore)
  expect(strayedLiveFiles(root())).toEqual([])
  expect(strayedSessions(root(), startedAt)).toEqual([])
  expect(corePids()).toEqual(coresBefore)
})

/** A pi in a terminal of the scratch core, on the Claude model, with pi-live and what else `extensions` names. */
function startPi(name: string, space: string, extensions: string[]): string {
  const work = path.join(root(), `work-${name}`)
  const sessions = path.join(root(), `pi-sessions-${name}`)
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(sessions, { recursive: true })
  const live = scratchEnv(root()).PI_LIVE_DIR!
  hc("run", "--bg", "--name", name, "--cwd", work, "--label", `herdr.space=${space}`, "--", "env", `PI_LIVE_DIR=${live}`, "pi", "-ne", ...extensions.flatMap((e) => ["-e", e]), "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", MODEL, "--thinking", "off")
  const t = (JSON.parse(hc("ls", "--json")) as { terminals: { address: string; name: string | null }[] }).terminals.find((x) => x.name === name)
  if (!t) throw new Error(`terminal ${name} not found`)
  started.push(t.address)
  return t.address
}

/** What the terminal shows now, for a failure message. */
const screen = (address: string): string => {
  try {
    return hc("read", address).split("\n").slice(-40).join("\n")
  } catch (e) {
    return `(hc read failed: ${String(e)})`
  }
}

async function signIn(page: Page, space: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: space }).click()
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 60_000 }) // pi-live connected
  await page.getByTestId("view-chat").click()
  // the composer, or the panel when a prompt is open (a second tab opened mid-question)
  await expect(page.getByTestId("composer-input").or(page.getByTestId("ask-panel"))).toBeVisible({ timeout: 60_000 })
}

const panel = (page: Page) => page.getByTestId("ask-panel")
/** The line of the ask_user call that asked `question`: calls are told apart by their question, which differs in every case. */
const row = (page: Page, question: string) => page.getByTestId("row-ask").filter({ hasText: question })
const item = (page: Page) => page.locator("[data-slot=questionnaire-item]:not([hidden])")

/** The turn is over: pi is not working and the composer is back. */
async function settled(page: Page, address: string): Promise<void> {
  try {
    await expect(page.getByTestId("working")).toHaveCount(0, { timeout: MODEL_WAIT_MS })
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 })
  } catch (e) {
    throw new Error(`the turn did not settle\n${String(e)}\n${screen(address)}`)
  }
}

/** Tells the model to call ask_user with exactly these arguments, and waits for the panel of that call. Returns the prompt's id. */
async function ask(page: Page, address: string, args: Record<string, unknown>): Promise<string> {
  const at = Date.now()
  const composer = page.getByTestId("composer-input")
  await composer.fill(`Call the ask_user tool with exactly these arguments: ${JSON.stringify(args)}. Do nothing else.`)
  await composer.press("Enter")
  try {
    await expect(panel(page)).toBeVisible({ timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`no panel after the prompt for ${JSON.stringify(args).slice(0, 80)}\n${String(e)}\n${screen(address)}`)
  }
  times.push(`${String(args["question"] ?? "a batch")}: panel after ${Date.now() - at} ms`)
  return (await panel(page).getAttribute("data-ask-id"))!
}

/** The `answer` operation, from the page, as the web app calls it: what the backend says it did. */
const answerFrom = (page: Page, terminal: string, id: string, answer: unknown) =>
  page.evaluate(
    async ([url, terminal, id, answer]) => {
      const res = await fetch(`${url}/api/chat/answer`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminal, id, answer }) })
      return (await res.json()) as { status: string; reason?: string }
    },
    [backend, terminal, id, answer] as const,
  )

test("a real pi asking: single, several with a comment, typed, a batch with a skip, at the keyboard, a refused answer, a late one, and Stop", async ({ page, browser }) => {
  const work = path.join(root(), "work")
  fs.mkdirSync(work, { recursive: true })
  await addSpace({ id: "sp-ask-live", name: "asklive", folder: work })
  const address = startPi("ask-pi", "sp-ask-live", [piLive, piAskUser])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "asklive")

  // One question, one choice: the panel is where the composer was, the thread says it waits, a pick answers, and the line is exact.
  const q1 = "Pick a fruit"
  const id1 = await ask(page, address, { question: q1, options: [{ title: "Apple", description: "red or green" }, { title: "Pear" }] })
  expect(id1).toMatch(/\S/)
  await expect(page.getByTestId("composer")).toHaveCount(0)
  // While it is open the call is the live tail's tool (its row is written when pi has the answer), which does not name the question.
  await expect(page.locator("[data-testid=live-tool][data-ask-state=open], [data-testid=row-ask][data-ask-state=open]")).toHaveText("Awaiting input…")
  await expect(panel(page).getByTestId("stop")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/dev34-live-open-dark-1440.png` })
  await page.getByRole("radio", { name: /Pear/ }).check({ force: true })
  await expect(panel(page)).toHaveCount(0, { timeout: 30_000 })
  await expect(row(page, q1).getByTestId("ask-line")).toHaveText(`Asked: ${q1} · Answered: Pear`, { timeout: 30_000 })
  await settled(page, address)
  await expect(row(page, q1)).toHaveCount(1)
  await page.screenshot({ path: `${SHOTS}/dev34-live-answered-dark-1440.png` })

  // Several choices and a comment: nothing is sent until Submit; the line says + comment.
  const q2 = "Which toppings"
  await ask(page, address, { question: q2, options: [{ title: "Cheese" }, { title: "Olives" }, { title: "Basil" }], allowMultiple: true, allowFreeform: false, allowComment: true })
  await page.getByRole("checkbox", { name: "Basil" }).check({ force: true })
  await page.getByRole("checkbox", { name: "Cheese" }).check({ force: true })
  await page.getByTestId("ask-comment").fill("extra please")
  await page.getByRole("button", { name: "Submit" }).click()
  await expect(row(page, q2).getByTestId("ask-line")).toHaveText(`Asked: ${q2} · Answered: Cheese, Basil + comment`, { timeout: 30_000 })
  await settled(page, address)
  await row(page, q2).locator("[data-slot=trace-collapsible-trigger]").click()
  await expect(row(page, q2).getByTestId("ask-card-comment")).toHaveText("Comment: extra please")

  // Typed: no options, so the text row is the answer.
  const q3 = "What is the project called"
  await ask(page, address, { question: q3, allowFreeform: true })
  await page.getByLabel("Type something else").fill("Nimbus")
  await page.getByLabel("Type something else").press("Enter")
  await expect(row(page, q3).getByTestId("ask-line")).toHaveText(`Asked: ${q3} · Answered: Nimbus`, { timeout: 30_000 })
  await settled(page, address)

  // A batch: a single choice moves on, the second question is skipped, the last pick leaves Submit to press; one answer at the end.
  // (a top-level `question` beside `questions` is the batch's heading)
  const heading = "Trip plan"
  await ask(page, address, {
    question: heading,
    questions: [
      { question: "Where to?", options: [{ title: "Oslo" }, { title: "Rome" }], allowFreeform: false },
      { question: "Which month?", options: [{ title: "May" }, { title: "June" }], allowFreeform: false },
      { question: "Travelling with?", options: [{ title: "Alone" }, { title: "Friends" }], allowFreeform: false },
    ],
  })
  const progress = () => item(page).getByTestId("ask-progress")
  await expect(progress()).toHaveText("1/3")
  await expect(panel(page)).toContainText(heading)
  await page.getByRole("radio", { name: /Rome/ }).check({ force: true })
  await expect(progress()).toHaveText("2/3")
  await page.getByRole("button", { name: "Skip" }).click()
  await expect(progress()).toHaveText("3/3")
  await page.screenshot({ path: `${SHOTS}/dev34-live-batch-dark-1440.png` })
  await page.getByRole("radio", { name: /Friends/ }).check({ force: true })
  await expect(page.getByRole("button", { name: "Submit" })).toBeFocused()
  await page.getByRole("button", { name: "Submit" }).click()
  const batchRow = page.getByTestId("row-ask").filter({ hasText: heading })
  await expect(batchRow.getByTestId("ask-line")).toHaveText(`Asked: ${heading} · 2 of 3 answered`, { timeout: 30_000 })
  await settled(page, address)
  await batchRow.locator("[data-slot=trace-collapsible-trigger]").click()
  await expect(batchRow.getByText("Skipped")).toBeVisible()

  // At the keyboard of pi's own terminal: the panel goes, and the line has the answer pi recorded.
  const q5 = "Pick a color"
  await ask(page, address, { question: q5, options: [{ title: "Red" }, { title: "Blue" }] })
  hc("keys", address, "enter")
  await expect(panel(page)).toHaveCount(0, { timeout: 30_000 })
  await expect(row(page, q5).getByTestId("ask-line")).toHaveText(`Asked: ${q5} · Answered: Red`, { timeout: 30_000 })
  await settled(page, address)

  // A refused answer: pi-ask-user's reason comes back, the panel stays, and a valid answer then goes through. Once answered, the same
  // prompt is `closed`; an id pi never had is `not_found`.
  const q6 = "Pick a size"
  const id6 = await ask(page, address, { question: q6, options: [{ title: "Small" }, { title: "Large" }] })
  const refused = await answerFrom(page, address, id6, { kind: "selection", selections: ["Huge"] })
  expect(refused.status).toBe("invalid")
  expect(refused.reason).toMatch(/\S/)
  console.log("pi-ask-user's reason for a refused answer:", refused.reason)
  await expect(panel(page)).toBeVisible()
  await page.getByRole("radio", { name: /Large/ }).check({ force: true })
  await expect(row(page, q6).getByTestId("ask-line")).toHaveText(`Asked: ${q6} · Answered: Large`, { timeout: 30_000 })
  await settled(page, address)
  expect((await answerFrom(page, address, id6, { kind: "selection", selections: ["Small"] })).status).toBe("closed")
  expect((await answerFrom(page, address, "no-such-call", { kind: "freeform", text: "x" })).status).toBe("not_found")

  // A second tab shows the same prompt; the first tab answers; the second one's late answer is `closed`, and its panel goes.
  const q7 = "Pick a number"
  const id7 = await ask(page, address, { question: q7, options: [{ title: "One" }, { title: "Two" }] })
  const context = await browser.newContext({ baseURL: page.url().replace(/\/[^/]*$/, "") })
  const tab = await context.newPage()
  await signIn(tab, "asklive")
  await expect(panel(tab)).toBeVisible({ timeout: 30_000 })
  await expect(panel(tab)).toHaveAttribute("data-ask-id", id7)
  await page.getByRole("radio", { name: /Two/ }).check({ force: true })
  await expect(panel(page)).toHaveCount(0, { timeout: 30_000 })
  await expect(panel(tab)).toHaveCount(0, { timeout: 30_000 })
  await expect(row(tab, q7).getByTestId("ask-line")).toHaveText(`Asked: ${q7} · Answered: Two`, { timeout: 30_000 })
  expect((await answerFrom(tab, address, id7, { kind: "selection", selections: ["One"] })).status).toBe("closed")
  await context.close()
  await settled(page, address)

  // Stop while asking: the panel goes, the turn ends, and the line says it was not answered.
  const q8 = "Pick a mode"
  await ask(page, address, { question: q8, options: [{ title: "Fast" }, { title: "Careful" }] })
  await panel(page).getByTestId("stop").click()
  await expect(panel(page)).toHaveCount(0, { timeout: 30_000 })
  await expect(row(page, q8).getByTestId("ask-line")).toHaveText(`Asked: ${q8} · Not answered`, { timeout: 30_000 })
  await settled(page, address)
  await page.screenshot({ path: `${SHOTS}/dev34-live-stopped-dark-1440.png` })

  // A reload: every line is the same from what pi recorded, with nothing open.
  await page.reload()
  await page.getByTestId("view-chat").click().catch(() => {})
  await expect(row(page, q1).getByTestId("ask-line")).toHaveText(`Asked: ${q1} · Answered: Pear`, { timeout: 60_000 })
  await expect(row(page, q2).getByTestId("ask-line")).toHaveText(`Asked: ${q2} · Answered: Cheese, Basil + comment`)
  await expect(row(page, q8).getByTestId("ask-line")).toHaveText(`Asked: ${q8} · Not answered`)
  await expect(panel(page)).toHaveCount(0)
})

// pi without the fork: a tool called ask_user that pi-live knows nothing about (no prompt is parked), so there is nothing to answer in the
// browser. The thread shows the question read-only with a pointer to the terminal, and then the result.
test("a pi whose ask_user is not parked on pi-live: a read-only card, 'Answer in the terminal'", async ({ page }) => {
  const work = path.join(root(), "work-plain")
  fs.mkdirSync(work, { recursive: true })
  const extension = path.join(root(), "hw-plain-ask.ts")
  fs.writeFileSync(
    extension,
    `export default function (pi: any) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask the user a question.",
    parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } }, required: ["question"] },
    async execute(_id: string, _params: unknown, signal: AbortSignal | undefined) {
      await new Promise((resolve) => { const t = setTimeout(resolve, 15000); signal?.addEventListener("abort", () => { clearTimeout(t); resolve(undefined) }) })
      return { content: [{ type: "text", text: "User answered: Pear" }], details: {} }
    },
  })
}
`,
  )
  await addSpace({ id: "sp-ask-plain", name: "askplain", folder: work })
  const address = startPi("plain-pi", "sp-ask-plain", [piLive, extension])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "askplain")
  const q = "Pick a plain fruit"
  const composer = page.getByTestId("composer-input")
  await composer.fill(`Call the ask_user tool with exactly these arguments: ${JSON.stringify({ question: q, options: [{ title: "Apple" }, { title: "Pear" }] })}. Do nothing else.`)
  await composer.press("Enter")
  try {
    await expect(page.getByTestId("ask-card").filter({ hasText: q })).toBeVisible({ timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`no read-only card\n${String(e)}\n${screen(address)}`)
  }
  await expect(page.getByTestId("ask-card").filter({ hasText: q })).toContainText("Answer in the terminal.")
  await expect(page.getByTestId("ask-card").filter({ hasText: q })).toContainText("Pear")
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByTestId("composer")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/dev34-live-no-item-dark-1440.png` })
  // the call ends on its own: the line is the question and pi's own words
  await expect(row(page, q).getByTestId("ask-line")).toHaveText(`Asked: ${q} · Pear`, { timeout: 60_000 })
  await settled(page, address)
})
