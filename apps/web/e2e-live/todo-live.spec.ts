import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { MODEL_WAIT_MS, corePids, fingerprint, piLive, repo, strayedLiveFiles, strayedSessions } from "../../../packages/agents/live/support"
import { PASSPHRASE } from "../e2e/global-setup"
import { addSpace } from "../e2e/scratch"

// The agent's todo list (DEV-41) with a real pi: @juicesharp/rpiv-todo (loaded with -e from where it is installed, read only) is the tool the
// model calls, pi-live feeds the chat, and the card above the composer follows. The model is claude-relay/claude-haiku-5-5 (the relay of
// ~/.pi/agent/models.json, which pi reads and this test never writes), told exactly which todo calls to make. Written by the tester.
// Screenshots go to /tmp/hw-shots/dev41-live-*.

const SHOTS = "/tmp/hw-shots"
const MODEL = "claude-relay/claude-haiku-5-5"
const rpivTodo = path.join(os.homedir(), ".pi/agent/npm/node_modules/@juicesharp/rpiv-todo")
const piAskUser = path.join(repo, "node_modules/pi-ask-user")
const root = (): string => process.env.HW_LIVE_ROOT!
const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })

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
  expect(fingerprint()).toBe(fingerprintBefore)
  expect(strayedLiveFiles(root())).toEqual([])
  expect(strayedSessions(root(), startedAt)).toEqual([])
  expect(corePids()).toEqual(coresBefore)
})

function startPi(name: string, space: string, extensions: string[]): { address: string; sessions: string } {
  const work = path.join(root(), `work-${name}`)
  const sessions = path.join(root(), `pi-sessions-${name}`)
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(sessions, { recursive: true })
  const live = scratchEnv(root()).PI_LIVE_DIR!
  hc("run", "--bg", "--name", name, "--cwd", work, "--label", `herdr.space=${space}`, "--", "env", `PI_LIVE_DIR=${live}`, "pi", "-ne", ...extensions.flatMap((e) => ["-e", e]), "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--session-dir", sessions, "--model", MODEL, "--thinking", "off")
  const t = (JSON.parse(hc("ls", "--json")) as { terminals: { address: string; name: string | null }[] }).terminals.find((x) => x.name === name)
  if (!t) throw new Error(`terminal ${name} not found`)
  started.push(t.address)
  return { address: t.address, sessions }
}

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
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("composer-input").or(page.getByTestId("ask-panel"))).toBeVisible({ timeout: 60_000 })
}

async function settled(page: Page, address: string): Promise<void> {
  try {
    await expect(page.getByTestId("working")).toHaveCount(0, { timeout: MODEL_WAIT_MS })
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 })
  } catch (e) {
    throw new Error(`the turn did not settle\n${String(e)}\n${screen(address)}`)
  }
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("composer-input")
  await composer.fill(text)
  await composer.press("Enter")
}

const LONG = "Z".repeat(180) // one word, no break opportunity
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/** The newest session file of a pi, parsed: what rpiv-todo wrote. */
function sessionEntries(sessions: string): any[] {
  const files = fs.readdirSync(sessions).filter((f) => f.endsWith(".jsonl"))
  const newest = files.map((f) => path.join(sessions, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  return newest ? fs.readFileSync(newest, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
}

test("a real pi with rpiv-todo: the card follows the calls, survives a reload, stops its spinner, stays at N/N and goes when the user speaks", async ({ page }) => {
  const work = path.join(root(), "work-todo")
  fs.mkdirSync(work, { recursive: true })
  await addSpace({ id: "sp-todo-live", name: "todolive", folder: work })
  const { address, sessions } = startPi("todo-pi", "sp-todo-live", [piLive, rpivTodo])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "todolive")

  const tasks = [
    { subject: "Read the importer", activeForm: "Reading the importer" },
    { subject: LONG, activeForm: "Chasing the long one" },
    { subject: "Third 😀 task" },
    { subject: "constructor" },
    { subject: "__proto__" },
    { subject: "Sixth" },
    { subject: "Seventh" },
  ]
  const at = Date.now()
  await say(
    page,
    `Use the todo tool, one call at a time, in this order, with exactly these arguments and nothing else: (1) ${JSON.stringify({ action: "create", tasks })} (2) ${JSON.stringify({ action: "update", id: 1, status: "in_progress" })} (3) ${JSON.stringify({ action: "update", id: 1, status: "completed" })} (4) ${JSON.stringify({ action: "update", id: 2, status: "in_progress" })}. After the fourth call reply with the single word FINISHED and stop. Do not complete any other task.`,
  )
  const card = page.getByTestId("todos")
  try {
    await expect(card.getByTestId("todos-count")).toHaveText("1/7", { timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`the card never reached 1/7\n${String(e)}\n${screen(address)}`)
  }
  times.push(`todo list: 1/7 after ${Date.now() - at} ms`)
  await settled(page, address)

  // What pi wrote, for the record: a state entry per changing call
  const written = sessionEntries(sessions)
  const states = written.filter((e) => e.type === "custom" && e.customType === "rpiv-todo-state")
  expect(states.length).toBeGreaterThanOrEqual(4)

  // the turn is over: no spinner; the long list folds: 1 done, the live task and the next two, 3 more
  await expect(card.locator('[data-spinning="true"]')).toHaveCount(0)
  await expect(card.getByTestId("todos-done-fold")).toContainText("1 done")
  await expect(card.getByTestId("todo-task").first()).toHaveAttribute("data-status", "in_progress")
  await expect(card.getByTestId("todos-more")).toHaveText("+3 more")
  expect(await noSideScroll(page)).toBe(true)
  await page.screenshot({ path: `${SHOTS}/dev41-live-folded-dark-1440.png` })
  await card.getByTestId("todos-more").click()
  await expect(card.getByTestId("todo-task")).toHaveCount(7)
  const names = await card.getByTestId("todo-task").allTextContents()
  expect(names.some((n) => n.includes("constructor"))).toBe(true)
  expect(names.some((n) => n.includes("__proto__"))).toBe(true)
  expect(names.some((n) => n.includes("😀"))).toBe(true)
  expect(await card.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(900 / 3 + 50)
  await page.screenshot({ path: `${SHOTS}/dev41-live-open-dark-1440.png` })

  // the todo calls are one-line rows inside their step group, not JSON (the user's own message does hold JSON, so look inside the groups)
  const group = page.getByTestId("row-group").first()
  await group.getByTestId("group-trigger").click()
  const lines = await group.getByTestId("row-todo").allTextContents()
  expect(lines[0]).toBe("Added 7 tasks")
  expect(lines).toContain("Started: Read the importer")
  expect(lines).toContain("Completed: Read the importer")
  await expect(group.getByText('"action"')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev41-live-rows-dark-1440.png` })

  // a reload: the snapshot carries the list
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("todos").getByTestId("todos-count")).toHaveText("1/7")

  // a phone: nothing sticks out, the card stays a third of the screen at most
  await page.setViewportSize({ width: 390, height: 700 })
  await page.screenshot({ path: `${SHOTS}/dev41-live-dark-390-sidebar-open.png` }) // the shell has no phone layout: the sidebar takes 270 px
  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(page.getByTestId("todos")).toBeVisible()
  expect(await noSideScroll(page)).toBe(true)
  const box = (await page.getByTestId("todos").boundingBox())!
  expect(box.height).toBeLessThan(700 / 3 + 50)
  await page.screenshot({ path: `${SHOTS}/dev41-live-dark-390.png` })
  await page.getByTestId("todos").getByTestId("todos-toggle").click()
  await expect(page.getByTestId("todos-current")).toContainText("Chasing the long one")
  expect(await noSideScroll(page)).toBe(true)
  await page.screenshot({ path: `${SHOTS}/dev41-live-collapsed-dark-390.png` })
  await page.setViewportSize({ width: 1440, height: 900 })

  // finish them all: the card stays as 7/7 (not "Done") with no spinner
  await say(
    page,
    `Use the todo tool: first call update id 2 status completed, then for each of the ids 3, 4, 5, 6, 7 one call {"action":"update","id":N,"status":"completed"}. One call at a time, nothing else. Then reply DONE.`,
  )
  try {
    await expect(page.getByTestId("todos-count")).toHaveText("7/7", { timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`the card never reached 7/7\n${String(e)}\n${screen(address)}`)
  }
  await settled(page, address)
  await expect(page.getByTestId("todos")).toBeVisible()
  await expect(page.getByTestId("todos").locator('[data-spinning="true"]')).toHaveCount(0)
  await expect(page.getByTestId("todos-toggle")).not.toContainText("Done")
  await page.screenshot({ path: `${SHOTS}/dev41-live-alldone-dark-1440.png` })

  // the user speaks again: the finished list goes
  await say(page, "Reply with the word hello and nothing else. Do not use any tool.")
  await expect(page.getByTestId("todos")).toHaveCount(0, { timeout: MODEL_WAIT_MS })
  await settled(page, address)
  await expect(page.getByTestId("todos")).toHaveCount(0)
})

test("the card, the ask panel and the composer together at 390 px", async ({ page }) => {
  const work = path.join(root(), "work-todoask")
  fs.mkdirSync(work, { recursive: true })
  await addSpace({ id: "sp-todoask-live", name: "todoask", folder: work })
  const { address } = startPi("todoask-pi", "sp-todoask-live", [piLive, rpivTodo, piAskUser])
  await page.setViewportSize({ width: 390, height: 700 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "todoask")
  await page.getByRole("button", { name: "Collapse sidebar" }).click()
  const tasks = Array.from({ length: 9 }, (_, i) => ({ subject: `Step ${i + 1}: ${"keep this one long ".repeat(3)}`, activeForm: `Doing step ${i + 1}` }))
  await say(
    page,
    `Do exactly two things, in order. First call the todo tool once with ${JSON.stringify({ action: "create", tasks })}. Then call the ask_user tool with exactly ${JSON.stringify({ question: "Pick a color", options: [{ title: "Red" }, { title: "Blue" }] })}. Do nothing else.`,
  )
  try {
    await expect(page.getByTestId("ask-panel")).toBeVisible({ timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`no ask panel\n${String(e)}\n${screen(address)}`)
  }
  const card = page.getByTestId("todos")
  await expect(card.getByTestId("todos-count")).toHaveText("0/9")
  // an open question folds the card to its header (toggle disabled), so the question has the room
  await expect(card.getByTestId("todos-toggle")).toBeDisabled()
  await expect(card.getByTestId("todo-task")).toHaveCount(0)
  const cardBox = (await card.boundingBox())!
  const askBox = (await page.getByTestId("ask-panel").boundingBox())!
  const threadBox = (await page.getByTestId("thread").boundingBox().catch(() => null)) ?? null
  await page.screenshot({ path: `${SHOTS}/dev41-live-ask-dark-390.png` })
  expect(await noSideScroll(page)).toBe(true)
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(askBox.y + 1) // the card sits on the ask panel
  expect(cardBox.height).toBeLessThan(60)
  expect(askBox.y + askBox.height).toBeLessThanOrEqual(700 + 1) // the panel is on screen
  expect(threadBox === null || threadBox.height > 0).toBe(true)
  console.log(`390x700: card ${Math.round(cardBox.height)} px, ask ${Math.round(askBox.height)} px, thread ${threadBox ? Math.round(threadBox.height) : "?"} px`)
  // the panel can be answered with the card there
  await page.getByRole("radio", { name: /Blue/ }).check({ force: true })
  await expect(page.getByTestId("ask-panel")).toHaveCount(0, { timeout: 30_000 })
  await settled(page, address)
  await expect(card.getByTestId("todos-count")).toHaveText("0/9")
  await expect(card.getByTestId("todos-toggle")).toBeEnabled() // answered: the card opens again
  await expect(card.getByTestId("todo-task").first()).toBeVisible()
})
