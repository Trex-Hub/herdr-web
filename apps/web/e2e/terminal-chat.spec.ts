import fs from "node:fs"
import path from "node:path"
import { agentsSocketPath } from "@herdr-web/agents/wire"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { PASSPHRASE } from "./global-setup"
import { addSpace, hc, root } from "./scratch"
import { StandIn } from "./stand-in"

// The chat view in a browser, against the real backend and a scratch core, with a stand-in for the pi extension (e2e/stand-in.ts):
// no pi and no model. The terminal it is for is a plain `sh` that reports the status of a pi, so the backend treats it as an agent.

const osc = (state: string) => `printf '\\033]7501;state=${state}:app=pi\\007'`
const labels = (address: string): Record<string, string> => (JSON.parse(hc("get", address, "--json")) as { labels: Record<string, string> }).labels

/** What the emulator in the page shows now. */
const terminalText = (page: Page) =>
  page.evaluate(() => {
    const t = (document.querySelector("[data-testid=terminal-host]") as unknown as { __xterm: { rows: number; buffer: { active: { viewportY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).__xterm
    const b = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "")
    return lines.join("\n")
  })

async function controllableAttention(page: Page): Promise<(hidden: boolean) => Promise<void>> {
  await page.addInitScript(() => {
    ;(window as unknown as { __hidden: boolean }).__hidden = false
    Object.defineProperty(document, "visibilityState", { get: () => ((window as unknown as { __hidden: boolean }).__hidden ? "hidden" : "visible") })
    document.hasFocus = () => !(window as unknown as { __hidden: boolean }).__hidden
  })
  return (hidden) =>
    page.evaluate((h) => {
      ;(window as unknown as { __hidden: boolean }).__hidden = h
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event(h ? "blur" : "focus"))
    }, hidden)
}

test.describe.configure({ mode: "serial" })

// Later specs count the terminals of the scratch core: what this file started goes away with it.
const started: string[] = []
const agents: StandIn[] = []
test.afterAll(() => {
  for (const a of agents) a.close()
  for (const address of started) {
    try {
      hc("kill", address)
    } catch {
      // already ended
    }
  }
})

test("chat for an agent: the hint, the toggle, a recorded turn, stop, model and effort, a / command, the extension leaving and returning, and seen", async ({ page }) => {
  const folder = fs.mkdtempSync(path.join(root(), "chat-"))
  await addSpace({ id: "sp-chat", name: "chatspace", folder })
  const setHidden = await controllableAttention(page)
  const go = path.join(folder, "go")
  // Reports pi's idle at once; when `go` appears, a turn: working, then idle again.
  const address = (JSON.parse(hc("run", "--bg", "--name", "chat-agent", "--keep", "--no-parent", "--label", "herdr.space=sp-chat", "--label", "herdr.seen=0", "--", "sh", "-c", `${osc("idle")}; while [ ! -e ${go} ]; do sleep 0.1; done; ${osc("working")}; sleep 1; ${osc("idle")}; sleep 600`)) as { address: string }).address
  started.push(address)
  const socketPath = agentsSocketPath(scratchEnv(root()))
  const connect = async (): Promise<StandIn> => {
    const a = await StandIn.connect({ socketPath, terminalId: address, dir: path.join(folder, "sessions"), stepMs: 200 })
    agents.push(a)
    return a
  }

  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "chatspace" }).click()

  // A pi with no extension: the terminal, no toggle, and one quiet line saying what chat needs.
  await expect(page.getByTestId("agent-row")).toHaveAttribute("data-state", "idle", { timeout: 10_000 })
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-address", address, { timeout: 10_000 })
  await expect(page.getByTestId("view-toggle")).toHaveCount(0)
  const hint = page.getByTestId("extension-hint")
  await expect(hint).toContainText("herdr-web pi extension")
  await expect(hint).toContainText("Trying chat")

  // The extension connects: the toggle appears and the pane stays on the terminal; the hint is gone.
  let agent = await connect()
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "terminal")
  await expect(page.getByTestId("terminal-view")).toBeVisible()
  await expect(hint).toHaveCount(0)

  // Chat: the thread the agent already had, and only the chat is live (the terminal's socket is closed).
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("terminal-view")).toHaveCount(0)
  await expect(page.getByTestId("row-assistant")).toHaveCount(1, { timeout: 5000 })
  await expect(page.getByTestId("thread")).toContainText("The capital of France is Paris.")
  await expect(page.getByTestId("model-select")).toContainText("Alpha")
  await expect(page.getByTestId("effort-select")).toContainText("Low")

  // Send: the agent gets the text; the reply is written in pieces, then the tools, then the answer, with nothing doubled.
  const composer = page.getByTestId("composer-input")
  await composer.fill("Use bash twice, please")
  await composer.press("Enter")
  await expect.poll(() => agent.actions.filter((a) => a.op === "send").length, { timeout: 5000 }).toBe(1)
  expect(agent.actions.find((a) => a.op === "send")).toMatchObject({ text: "Use bash twice, please" })
  await expect(page.getByTestId("row-user").last()).toContainText("Use bash twice, please")

  const lengths: number[] = []
  let sawTools = 0
  let sawWorking = false
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    const texts = await page.getByTestId("live-text").allTextContents()
    if (texts.length > 0) lengths.push(texts.join("").length)
    // a running tool is its row, with a spinner, from the moment pi has written the call
    sawTools = Math.max(sawTools, await page.locator("[data-testid=row-tool][data-status=running]").count())
    sawWorking ||= (await page.getByTestId("working").count()) > 0
    if ((await page.getByTestId("row-assistant").count()) === 2 && (await page.getByTestId("working").count()) === 0) break
    await page.waitForTimeout(40)
  }
  await agent.idle()
  const distinct = [...new Set(lengths)]
  expect(distinct.length, `live text came in ${distinct.length} pieces: ${distinct.join(", ")}`).toBeGreaterThanOrEqual(3)
  expect(distinct).toEqual([...distinct].sort((a, b) => a - b)) // it only grows
  expect(sawWorking).toBe(true)
  expect(sawTools).toBe(2)
  // Settled: the finished rows replaced the live ones, once each.
  await expect(page.getByTestId("working")).toHaveCount(0)
  await expect(page.getByTestId("live-text")).toHaveCount(0)
  await expect(page.getByTestId("live-tool")).toHaveCount(0)
  await expect(page.getByTestId("row-assistant")).toHaveCount(2)
  await expect(page.getByTestId("row-user")).toHaveCount(2)
  // the steps of the turn are one collapsed group (DEV-31) once the answer is in; open it to see them
  await expect(page.getByTestId("row-group")).toHaveCount(1)
  await expect(page.getByTestId("group-trigger")).toHaveAttribute("aria-expanded", "false")
  await page.getByTestId("group-trigger").click()
  await expect(page.getByTestId("row-thinking")).toHaveCount(3)
  const tools = page.getByTestId("row-tool")
  await expect(tools).toHaveCount(2)
  await expect(tools.nth(0)).toHaveAttribute("data-status", "ok")
  await expect(tools.nth(1)).toHaveAttribute("data-status", "error")
  await expect(page.getByTestId("stop")).toHaveCount(0)

  // Stop: the click reaches the agent, and the thread goes quiet.
  await composer.fill("And again")
  await composer.press("Enter")
  await expect(page.getByTestId("live-thinking")).toBeVisible({ timeout: 5000 })
  await page.getByTestId("stop").click()
  await expect.poll(() => agent.actions.filter((a) => a.op === "stop").length, { timeout: 5000 }).toBe(1)
  await agent.idle()
  await expect(page.getByTestId("working")).toHaveCount(0, { timeout: 5000 })
  await expect(page.getByTestId("stop")).toHaveCount(0)
  await expect(page.getByTestId("live-thinking")).toHaveCount(0)

  // Model and effort: each change reaches the agent and shows; a model with one level has no effort selector.
  await page.getByTestId("model-select").click()
  await page.getByRole("option", { name: "Beta" }).click()
  await expect.poll(() => agent.actions.filter((a) => a.op === "set_model").map((a) => (a as { model: string }).model)).toEqual(["stand/beta"])
  await expect(page.getByTestId("model-select")).toContainText("Beta")
  await expect(page.getByTestId("effort-select")).toHaveCount(0)
  await page.getByTestId("model-select").click()
  await page.getByRole("option", { name: "Alpha" }).click()
  await expect(page.getByTestId("effort-select")).toBeVisible({ timeout: 5000 })
  await page.getByTestId("effort-select").click()
  await page.getByRole("option", { name: "high" }).click()
  await expect.poll(() => agent.actions.filter((a) => a.op === "set_effort").map((a) => (a as { effort: string }).effort)).toEqual(["high"])
  await expect(page.getByTestId("effort-select")).toContainText("High")

  // A / command is not sent through the extension: the agent is asked to empty its input box, and the text is typed into the terminal.
  const before = agent.actions.length
  await composer.fill("/hw-typed-by-chat")
  await composer.press("Enter")
  await expect(page.getByTestId("typed-note")).toContainText("Typed into the terminal", { timeout: 15_000 })
  expect(agent.actions.slice(before).map((a) => a.op)).toEqual(["clear_input"])
  await page.getByTestId("show-terminal").click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 10_000 })
  await expect.poll(async () => (await terminalText(page)).includes("/hw-typed-by-chat"), { timeout: 5000 }).toBe(true)
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("thread")).toBeVisible()

  // The extension goes away: the rows stay, stale, the composer is off with a sentence, and the Terminal side still works.
  agent.close()
  await expect(page.getByTestId("composer-disabled")).toContainText("extension is not connected", { timeout: 5000 })
  await expect(page.getByTestId("chat-side")).toHaveAttribute("data-stale", "true")
  await expect(page.getByTestId("row-assistant")).toHaveCount(2)
  await expect(composer).toBeDisabled()
  await expect(page.getByTestId("view-toggle")).toBeVisible() // the terminal's record says chat: false now, but the pane that held a chat keeps its toggle
  await page.getByTestId("view-terminal").click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 10_000 })
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("chat-waiting")).toHaveAttribute("data-phase", "unavailable", { timeout: 5000 })
  await page.getByTestId("view-terminal").click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live")

  // It comes back (a new session, as after /new): the thread is the new one.
  agent = await connect()
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("row-assistant")).toHaveCount(1, { timeout: 5000 })
  await expect(page.getByTestId("composer-disabled")).toHaveCount(0)
  await expect(composer).toBeEnabled()

  // Seen: a chat pane that is shown counts as the pane being shown. Hidden page: the agent stays done; shown again: seen is written.
  const row = page.getByTestId("agent-row")
  await setHidden(true)
  fs.writeFileSync(go, "")
  await expect(row).toHaveAttribute("data-state", "done", { timeout: 5000 })
  await page.waitForTimeout(1000)
  await expect(row).toHaveAttribute("data-state", "done")
  expect(labels(address)["herdr.seen"]).toBe("0")
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat")
  await setHidden(false)
  await expect(row).toHaveAttribute("data-state", "idle", { timeout: 5000 })
  expect(labels(address)["herdr.seen"]).toBe("1")
})
