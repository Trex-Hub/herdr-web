import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { MODEL_WAIT_MS, corePids, fingerprint, piLive, strayedLiveFiles, strayedSessions } from "../../../packages/agents/live/support"
import { LIVE_BACKEND_PORT } from "../playwright.live.config"
import { PASSPHRASE } from "../e2e/global-setup"
import { addSpace } from "../e2e/scratch"

// A dialog of pi's own in the chat with a real pi: a test extension (written under the scratch root, loaded with -e) registers a tool that calls
// ctx.ui.confirm("Deploy?", …); pi-live reports it as state.waitingForUser, the chat shows "Waiting for you in the terminal: Deploy?", and
// confirming at the keyboard of the scratch terminal clears it. The model is claude-relay/claude-haiku-5-5 (the relay of ~/.pi/agent/models.json,
// which pi reads and this test never writes). `pnpm test:agents` runs it. Screenshots go to /tmp/hw-shots/dev39-live-*.

const SHOTS = "/tmp/hw-shots"
const MODEL = "claude-relay/claude-haiku-5-5"
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
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 60_000 })
}


test("pi on a confirm of an extension: the line names it, Open terminal shows the terminal, and confirming at the keyboard clears it", async ({ page }) => {
  const work = path.join(root(), "work-deploy")
  fs.mkdirSync(work, { recursive: true })
  const extension = path.join(root(), "hw-deploy.ts")
  fs.writeFileSync(
    extension,
    `export default function (pi: any) {
  pi.registerTool({
    name: "deploy",
    label: "Deploy",
    description: "Deploy the app to production. Asks the user to confirm first.",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const ok = await ctx.ui.confirm("Deploy?", "Deploy to production?")
      return { content: [{ type: "text", text: ok ? "Deployed." : "The user declined." }], details: {} }
    },
  })
}
`,
  )
  await addSpace({ id: "sp-wait-live", name: "waitlive", folder: work })
  const address = startPi("deploy-pi", "sp-wait-live", [piLive, extension])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await signIn(page, "waitlive")

  const at = Date.now()
  const composer = page.getByTestId("composer-input")
  await composer.fill("Call the deploy tool with no arguments. Do nothing else.")
  await composer.press("Enter")
  const line = page.getByTestId("waiting-text")
  try {
    await expect(line).toHaveText("Waiting for you in the terminal: Deploy?", { timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`no waiting line\n${String(e)}\n${screen(address)}`)
  }
  times.push(`deploy confirm: line after ${Date.now() - at} ms`)
  await expect(page.getByTestId("working")).toHaveCount(0)
  await expect(page.getByTestId("composer")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/dev39-live-waiting-dark-1440.png` })

  // Open terminal shows the terminal; back in the chat the line is still there.
  await page.getByTestId("open-terminal").click()
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "terminal")
  await page.getByTestId("view-chat").click()
  await expect(line).toBeVisible()

  // Confirm at the keyboard (Yes is the first choice): the line goes and the turn finishes.
  hc("keys", address, "enter")
  await expect(page.getByTestId("waiting")).toHaveCount(0, { timeout: 30_000 })
  try {
    await expect(page.getByTestId("working")).toHaveCount(0, { timeout: MODEL_WAIT_MS })
  } catch (e) {
    throw new Error(`the turn did not settle\n${String(e)}\n${screen(address)}`)
  }
  await expect(page.getByTestId("waiting")).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/dev39-live-confirmed-dark-1440.png` })
})
