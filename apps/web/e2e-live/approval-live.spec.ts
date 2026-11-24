import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { MODEL_WAIT_MS, corePids, fingerprint, piLive, repo, strayedLiveFiles, strayedSessions } from "../../../packages/agents/live/support"
import { PASSPHRASE } from "../e2e/global-setup"
import { addSpace } from "../e2e/scratch"

// Guardrails approvals (DEV-42) with a real pi: pi-guardrails (the Trex-Hub fork pinned in the root package.json, loaded with -e) gates
// `rm -rf` by default and parks its prompt on pi-live; the chat shows the card and answers it. No guardrails config is written: the
// defaults gate the command, and -ne keeps the user's own extensions (and any delegate) out. The commands only touch folders this test
// made in the scratch root. Screenshots go to /tmp/hw-shots/dev42-live-*.

const SHOTS = "/tmp/hw-shots"
const MODEL = "claude-relay/claude-haiku-5-5"
const guardrails = path.join(repo, "node_modules/@aliou/pi-guardrails")
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


/** Wait for the card, with the pi's screen when it never comes. */
async function card(page: Page, address: string) {
  try {
    await expect(page.getByTestId("approval-panel")).toBeVisible({ timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`no approval card\n${String(e)}\n${screen(address)}`)
  }
  await expect(page.getByTestId("approval-card")).toHaveAttribute("data-guarding", "false")
}

const ask = (name: string) => `Run exactly this bash command once, with nothing added: rm -rf ./${name}. Then reply with the single word OK and stop. If it is blocked, reply BLOCKED and stop; do not retry.`

test("a real pi with pi-guardrails: a dangerous command is allowed, denied and stopped from the chat", async ({ page }) => {
  // startPi runs the pi in work-<name>; the space points at it too
  const work = path.join(root(), "work-guard-pi")
  fs.mkdirSync(work, { recursive: true })
  for (const d of ["junk-a", "junk-b", "junk-c"]) fs.mkdirSync(path.join(work, d), { recursive: true })
  await addSpace({ id: "sp-guard-live", name: "guardlive", folder: work })
  const { address } = startPi("guard-pi", "sp-guard-live", [piLive, guardrails])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "guardlive")

  // Allow once: the command runs
  let at = Date.now()
  await say(page, ask("junk-a"))
  await card(page, address)
  times.push(`approval card after ${Date.now() - at} ms`)
  await expect(page.getByTestId("approval-question")).toHaveText("Run this command?")
  await expect(page.getByTestId("approval-command")).toContainText("rm -rf ./junk-a")
  await expect(page.getByTestId("approval-reason")).toContainText("recursive force delete")
  await expect(page.getByTestId("composer")).toHaveCount(0)
  await expect(page.getByTestId("waiting")).toHaveCount(0)
  await expect(page.getByTestId("approval-line").first()).toContainText("Awaiting approval")
  await page.screenshot({ path: `${SHOTS}/dev42-live-card-dark-1440.png` })

  // a reload: the open prompt comes back
  await page.reload()
  await card(page, address)

  at = Date.now()
  await page.getByTestId("approval-allow").click()
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 30_000 })
  times.push(`allowed: card gone after ${Date.now() - at} ms`)
  await settled(page, address)
  expect(fs.existsSync(path.join(work, "junk-a"))).toBe(false)

  // Deny: the command does not run, the turn goes on
  await say(page, ask("junk-b"))
  await card(page, address)
  await page.getByTestId("approval-deny").click()
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 30_000 })
  await settled(page, address)
  expect(fs.existsSync(path.join(work, "junk-b"))).toBe(true)

  // Deny and stop the turn: the command does not run and the agent stops
  await say(page, ask("junk-c"))
  await card(page, address)
  await page.getByTestId("approval-stop").click()
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 30_000 })
  await settled(page, address)
  expect(fs.existsSync(path.join(work, "junk-c"))).toBe(true)
  await page.screenshot({ path: `${SHOTS}/dev42-live-after-dark-1440.png`, fullPage: true })
})

test("Escape denies, Enter does not approve, at 390 px", async ({ page }) => {
  const work = path.join(root(), "work-guard-pi")
  fs.mkdirSync(path.join(work, "junk-d"), { recursive: true })
  const address = started[0]!
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "guardlive")
  await say(page, ask("junk-d"))
  await card(page, address)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `${SHOTS}/dev42-live-card-dark-390.png` })
  await page.getByTestId("approval-allow").focus()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(1500)
  await expect(page.getByTestId("approval-panel")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 30_000 })
  await settled(page, address)
  expect(fs.existsSync(path.join(work, "junk-d"))).toBe(true)
})
