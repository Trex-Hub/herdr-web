import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { corePids, extension, fingerprint, LLAMA, LOCAL_MODEL, strayedSessions } from "../../../packages/agents/live/support"
import { LIVE_BACKEND_PORT, LIVE_WEB_PORT } from "../playwright.live.config"
import { PASSPHRASE } from "../e2e/global-setup"
import { addSpace } from "../e2e/scratch"

// The chat view with a real pi on the local model, through the real backend and a scratch core. `pnpm test:agents` runs it.
// Prompts are tiny. Screenshots go to /tmp/hw-shots/dev-26-live.

const SHOTS = "/tmp/hw-shots/dev-26-live"
const root = (): string => process.env.HW_LIVE_ROOT!
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.describe.configure({ mode: "serial" })

const turnLines: string[] = []
let fingerprintBefore = ""
let coresBefore: number[] = []
const startedAt = Date.now()
const started: string[] = []

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
  console.log(["", "turn times:", ...turnLines.map((l) => `  - ${l}`)].join("\n"))
  for (const a of started) {
    try {
      hc("kill", a)
    } catch {
      // already ended
    }
  }
  // What the live test must not change: pi's own settings and extensions, its session folder, the real core.
  expect(fingerprint()).toBe(fingerprintBefore)
  expect(strayedSessions(root(), startedAt)).toEqual([])
  expect(corePids()).toEqual(coresBefore)
})

function startPi(name: string, space: string, work: string, sessions: string, withExtension: boolean): string {
  const args = ["run", "--bg", "--name", name, "--cwd", work, "--label", `herdr.space=${space}`, "--", "pi", "-ne", "-e", LLAMA, ...(withExtension ? ["-e", extension] : []), "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", LOCAL_MODEL, "--thinking", "off"]
  hc(...args)
  const ls = JSON.parse(hc("ls", "--json")) as { terminals: { address: string; name: string | null }[] }
  const t = ls.terminals.find((x) => x.name === name)
  if (!t) throw new Error(`terminal ${name} not found`)
  started.push(t.address)
  return t.address
}

/** The session files pi wrote under `dir`, newest first. */
function sessionFiles(dir: string): string[] {
  const out: { file: string; at: number }[] = []
  const walk = (d: string): void => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".jsonl")) out.push({ file: p, at: fs.statSync(p).mtimeMs })
    }
  }
  walk(dir)
  return out.sort((a, b) => b.at - a.at).map((x) => x.file)
}

/** What pi and its terminal show right now: the end of its newest session file, the end of the screen, and what core says it is doing. */
function whatPiShows(address: string, sessions: string): string {
  const files = sessionFiles(sessions)
  const tail = files[0] ? fs.readFileSync(files[0], "utf8").slice(-3000) : "(no session file yet)"
  let screen = ""
  let status = ""
  try {
    screen = hc("read", address).split("\n").slice(-40).join("\n")
    status = JSON.stringify((JSON.parse(hc("get", address, "--json")) as { status: unknown }).status)
  } catch (e) {
    screen = `(hc read failed: ${String(e)})`
  }
  return [`pi's newest session file (${files[0] ?? "none"}), its last 3000 characters:`, tail, "", `hc get status: ${status}`, "hc read (last 40 lines):", screen].join("\n")
}

/** Runs a wait; when it runs out, the failure says what pi and its terminal show at that moment. */
async function waitingFor<T>(what: string, address: string, sessions: string, wait: () => Promise<T>): Promise<T> {
  try {
    return await wait()
  } catch (e) {
    throw new Error(`${what}\n${e instanceof Error ? e.message : String(e)}\n\n${whatPiShows(address, sessions)}`)
  }
}

const theme = async (page: Page, scheme: "light" | "dark") => {
  await page.emulateMedia({ colorScheme: scheme })
  await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/, { timeout: 5000 })
}

test("a real pi in the browser: a turn, Stop, an effort change, /new, a message typed at the terminal, and the hint for a pi with no extension", async ({ page }) => {
  const work = path.join(root(), "work")
  const sessions = path.join(root(), "pi-sessions")
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(sessions, { recursive: true })
  await addSpace({ id: "sp-live", name: "livespace", folder: work })
  const address = startPi("live-pi", "sp-live", work, sessions, true)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "livespace" }).click()
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 60_000 }) // the extension connected
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 })
  console.log("pi's status as core reports it:", JSON.stringify((JSON.parse(hc("get", address, "--json")) as { status: unknown }).status))

  // The thread's capabilities, read over a socket of the page's own (the selectors show names only).
  const capabilities = () =>
    page.evaluate(
      ([url, terminal]) =>
        new Promise<{ models: { list: { id: string; name: string; reasoning: boolean }[]; current: string | null } | null; efforts: { current: string | null } | null }>((resolve, reject) => {
          const ws = new WebSocket(url!)
          const timer = setTimeout(() => reject(new Error("no chat snapshot")), 10_000)
          ws.onopen = () => ws.send(JSON.stringify({ type: "chat.subscribe", terminal }))
          ws.onmessage = (e) => {
            const m = JSON.parse(String(e.data))
            if (m.type === "chat.snapshot") {
              clearTimeout(timer)
              ws.close()
              resolve(m.snapshot.capabilities)
            }
          }
        }),
      [`ws://localhost:${LIVE_BACKEND_PORT}/api/ws`, address],
    )
  // Every message goes through here: nothing is written to pi unless it is on the local model.
  const composer = page.getByTestId("composer-input")
  const say = async (text: string) => {
    expect((await capabilities()).models!.current, "pi is on the local model before a message is sent").toBe(LOCAL_MODEL)
    await composer.fill(text)
    await composer.press("Enter")
  }

  // One full turn, seen in the browser, and in pi's own transcript.
  const life = page.getByTestId("working").or(page.getByTestId("live-text")).or(page.getByTestId("live-tool")).or(page.getByTestId("row-tool")).or(page.getByTestId("row-assistant")).first()
  let turnAt = Date.now()
  await say("Use the bash tool to run: echo hello-from-chat. Then say done.")
  await expect(page.getByTestId("row-user").last()).toContainText("hello-from-chat", { timeout: 15_000 })
  await waitingFor("no sign of life after the tool prompt", address, sessions, () => life.waitFor({ timeout: 240_000 }))
  const firstAt = Date.now()
  await waitingFor("no finished reply after the tool prompt", address, sessions, () => expect(page.getByTestId("row-assistant").last()).toBeVisible({ timeout: 240_000 }))
  await waitingFor("the agent did not settle after the tool prompt", address, sessions, () => expect(page.getByTestId("working")).toHaveCount(0, { timeout: 240_000 }))
  turnLines.push(`turn "tool prompt": first event ${((firstAt - turnAt) / 1000).toFixed(1)} s after send, settled ${((Date.now() - turnAt) / 1000).toFixed(1)} s after send`)
  console.log("tool rows in the first turn:", await page.getByTestId("row-tool").count())
  expect(hc("read", address)).toContain("hello-from-chat")

  // A model change and an effort change. The local model has one level (off), so the selector is hidden; a model that reasons brings it
  // back. pi's list holds paid providers, so nothing is sent while another model is selected: this selects it, changes the effort, and
  // selects the local model again (over HTTP, in a `finally`) before the next message, which is guarded by `say`.
  const model = page.getByTestId("model-select")
  const effort = page.getByTestId("effort-select")
  await expect(effort).toHaveCount(0)
  const caps = await capabilities()
  expect(caps.models!.current).toBe(LOCAL_MODEL)
  const local = caps.models!.list.find((m) => m.id === LOCAL_MODEL)!.name
  const reasoning = caps.models!.list.find((m) => m.reasoning && m.id !== LOCAL_MODEL)
  expect(reasoning, "a model in pi's list that reasons").toBeDefined()
  const exact = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
  try {
    await model.click()
    await page.getByTestId("model-select-option").filter({ hasText: exact(reasoning!.name) }).first().click()
    await expect.poll(async () => (await capabilities()).models!.current, { timeout: 10_000 }).toBe(reasoning!.id)
    await expect(effort).toBeVisible({ timeout: 10_000 })
    const was = ((await effort.textContent()) ?? "").replace("▼", "").trim()
    await effort.click()
    await expect(page.getByTestId("effort-select-option").first()).toBeVisible()
    const levels = (await page.getByTestId("effort-select-option").allTextContents()).map((t) => t.trim())
    const other = levels.find((l) => l !== was && l !== "off") ?? levels.find((l) => l !== was)!
    await page.getByTestId("effort-select-option").filter({ hasText: exact(other) }).click()
    await expect(effort).toContainText(other, { timeout: 10_000 })
    await expect.poll(async () => (await capabilities()).efforts?.current, { timeout: 10_000 }).toBe(other)
    await expect(page.getByTestId("composer-error")).toHaveCount(0)
    console.log(`model ${LOCAL_MODEL} -> ${reasoning!.id} (no message sent); effort ${was} -> ${other}`)
  } finally {
    await page.request.post(`http://localhost:${LIVE_BACKEND_PORT}/api/chat/model`, { data: { terminal: address, model: LOCAL_MODEL }, headers: { Origin: `http://localhost:${LIVE_WEB_PORT}` } })
    await expect.poll(async () => (await capabilities()).models!.current, { timeout: 15_000 }).toBe(LOCAL_MODEL)
  }
  await expect(model).toContainText(local, { timeout: 10_000 })
  await expect(effort).toHaveCount(0, { timeout: 10_000 })

  // Stop on a reply: text is arriving (or a tool is running: a model may reach for one however the prompt is worded), Stop is
  // clicked, the thread goes quiet. Either way the agent settles and the thread says it was stopped.
  turnAt = Date.now()
  await say("Write a very long story, at least 3000 words, about a lighthouse. Do not use any tool.")
  const busy = page.getByTestId("live-text").or(page.getByTestId("live-tool")).or(page.locator("[data-testid=row-tool][data-status=running]")).first()
  await waitingFor("no live text or tool after the lighthouse prompt", address, sessions, () => expect(busy).toBeVisible({ timeout: 120_000 }))
  turnLines.push(`turn "lighthouse, stopped": first event ${((Date.now() - turnAt) / 1000).toFixed(1)} s after send`)
  await page.screenshot({ path: path.join(SHOTS, "mid-reply-light-1440.png") })
  await page.getByTestId("stop").click()
  await expect(page.getByTestId("working")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId("stop")).toHaveCount(0)
  await expect(page.getByTestId("live-text")).toHaveCount(0)
  await expect(page.getByTestId("live-tool")).toHaveCount(0)
  await expect(page.locator("[data-testid=row-tool][data-status=running]")).toHaveCount(0)
  await expect(page.getByTestId("row-notice").last()).toContainText(/stopped/i)

  // Screenshots of this thread: light and dark, 768 and 1440 wide, and the Terminal side of the same pane.
  for (const scheme of ["light", "dark"] as const) {
    await theme(page, scheme)
    for (const width of [1440, 768]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: path.join(SHOTS, `thread-${scheme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId("view-terminal").click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 10_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOTS, "terminal-side-dark-1440.png") })
  await theme(page, "light")
  await page.screenshot({ path: path.join(SHOTS, "terminal-side-light-1440.png") })
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("thread")).toBeVisible()

  // /new typed through the / rule: pi runs it (a few seconds later) and the thread is the new, empty one.
  const sentAt = Date.now()
  await say("/new")
  await expect(page.getByTestId("typed-note")).toContainText("Typed into the terminal", { timeout: 15_000 })
  const typedAt = Date.now()
  console.log(`/new: the composer's note came ${typedAt - sentAt} ms after Enter`) // it is there from the start; the POST itself answers when pi has run the command
  await expect(page.getByTestId("empty-thread")).toBeVisible({ timeout: 30_000 })
  console.log(`/new: empty thread ${Date.now() - sentAt} ms after Enter`)
  await expect(page.getByTestId("row-user")).toHaveCount(0)

  // A message typed at the terminal shows in the thread within a second of pi writing it.
  const text = "Say hello in one short sentence."
  turnAt = Date.now()
  expect((await capabilities()).models!.current, "pi is on the local model before a message is typed").toBe(LOCAL_MODEL)
  hc("send", address, text)
  let wroteAt = 0
  const end = Date.now() + 30_000
  while (!wroteAt && Date.now() < end) {
    if (sessionFiles(sessions).some((f) => fs.readFileSync(f, "utf8").includes(text))) wroteAt = Date.now()
    else await sleep(20)
  }
  expect(wroteAt, "pi wrote the message to its session file").toBeGreaterThan(0)
  await page.getByTestId("row-user").filter({ hasText: text }).waitFor({ timeout: 5000 })
  const shownAfter = Date.now() - wroteAt
  console.log(`typed at the terminal: shown ${shownAfter} ms after pi wrote it (the poll adds up to 20 ms)`)
  expect(shownAfter).toBeLessThan(1000)
  await waitingFor("the agent did not settle after the typed message", address, sessions, () => expect(page.getByTestId("working")).toHaveCount(0, { timeout: 240_000 }))
  turnLines.push(`turn "typed at the terminal": settled ${((Date.now() - turnAt) / 1000).toFixed(1)} s after it was typed`)

  // A pi started without the extension: its terminal, no toggle, and the hint (when core reports it as a pi).
  const bare = startPi("bare-pi", "sp-live", work, sessions, false)
  await page.getByTestId("tab").filter({ hasText: "bare-pi" }).click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-address", bare, { timeout: 10_000 })
  await expect(page.getByTestId("view-toggle")).toHaveCount(0)
  // Core reports it as a pi a moment after it starts (it looks at the program), and then the hint is there.
  await expect
    .poll(() => (JSON.parse(hc("get", bare, "--json")) as { status: { app?: string } | null }).status?.app, { timeout: 60_000 })
    .toBe("pi")
  await expect(page.getByTestId("extension-hint")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("view-toggle")).toHaveCount(0)
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOTS, "hint-light-1440.png") })
})
