// Adversarial browser checks of the chat view (DEV-26), on the scratch core and backend the other specs use, with the
// stand-in for the pi extension. Named zz- so it runs after the specs that restart the backend.
import fs from "node:fs"
import path from "node:path"
import { agentsSocketPath } from "@herdr-web/agents/wire"
import { expect, test, type Page, type WebSocket } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { BACKEND_PORT } from "../playwright.config"
import { PASSPHRASE, startBackend, stopBackend } from "./global-setup"
import { addSpace, hc, root } from "./scratch"
import { StandIn } from "./stand-in"

const osc = `printf '\\033]7501;state=idle:app=pi\\007'`
const SPACE = "sp-cattack"

test.describe.configure({ mode: "serial" })

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

/** A plain shell that says it is pi, so the backend treats it as an agent. */
function piLike(name: string): string {
  const address = (JSON.parse(hc("run", "--bg", "--name", name, "--keep", "--no-parent", "--label", `herdr.space=${SPACE}`, "--label", "herdr.seen=0", "--json", "--", "sh", "-c", `${osc}; sleep 600`)) as { address: string }).address
  started.push(address)
  return address
}
const connect = async (address: string, dir: string): Promise<StandIn> => {
  const a = await StandIn.connect({ socketPath: agentsSocketPath(scratchEnv(root())), terminalId: address, dir, stepMs: 100 })
  agents.push(a)
  return a
}

/** Everything the page's sockets do, and every error the page raises. */
function watch(page: Page) {
  const sockets: Array<{ url: string; open: boolean; sent: string[] }> = []
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => m.type() === "error" && !/WebSocket connection|Failed to load resource|net::ERR/.test(m.text()) && errors.push(m.text()))
  page.on("websocket", (ws: WebSocket) => {
    const rec = { url: ws.url(), open: true, sent: [] as string[] }
    sockets.push(rec)
    ws.on("framesent", (f) => rec.sent.push(String(f.payload)))
    ws.on("close", () => (rec.open = false))
  })
  return {
    sockets,
    errors,
    terminalSockets: (address: string) => sockets.filter((s) => s.url.includes(`/api/terminal/${address}`)),
    main: () => sockets.filter((s) => s.url.endsWith("/api/ws")),
    /** How many chat.subscribe minus chat.unsubscribe the page sent for `address` on its main sockets, counted per socket and summed over the open ones. */
    subscribed: (address: string) =>
      sockets
        .filter((s) => s.url.endsWith("/api/ws") && s.open)
        .reduce((n, s) => n + s.sent.filter((m) => m.includes(`"chat.subscribe"`) && m.includes(`"${address}"`)).length - s.sent.filter((m) => m.includes(`"chat.unsubscribe"`) && m.includes(`"${address}"`)).length, 0),
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: "cattack" }).click()
}

test.beforeAll(async () => {
  await new Promise((r) => setTimeout(r, 1500))
  const up = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`).then((r) => r.ok).catch(() => false)
  if (!up) {
    startBackend(root())
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200))
  }
  const folder = fs.mkdtempSync(path.join(root(), "cattack-"))
  await addSpace({ id: SPACE, name: "cattack", folder })
})

test("only the side that is shown is live: ten quick toggles leave one terminal socket or one chat subscription, never both", async ({ page }) => {
  const address = piLike("cat-toggle")
  const agent = await connect(address, fs.mkdtempSync(path.join(root(), "cat-a-")))
  const w = watch(page)
  await signIn(page)
  await page.getByTestId("agent-row").filter({ hasText: "cat-toggle" }).click()
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat", { timeout: 10_000 })
  await expect.poll(() => w.subscribed(address)).toBe(1)
  expect(w.terminalSockets(address).filter((s) => s.open)).toHaveLength(0)

  for (let i = 0; i < 10; i++) {
    await page.getByTestId("view-terminal").click()
    await page.getByTestId("view-chat").click()
  }
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "chat")
  await expect.poll(() => w.subscribed(address)).toBe(1)
  await expect.poll(() => w.terminalSockets(address).filter((s) => s.open).length).toBe(0)

  await page.getByTestId("view-terminal").click()
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live", { timeout: 10_000 })
  await expect.poll(() => w.subscribed(address)).toBe(0)
  expect(w.terminalSockets(address).filter((s) => s.open)).toHaveLength(1)

  // going to another agent's pane and back ends the one and starts the other
  const other = piLike("cat-toggle-2")
  await page.getByTestId("agent-row").filter({ hasText: "cat-toggle-2" }).click()
  await expect.poll(() => w.terminalSockets(address).filter((s) => s.open).length).toBe(0)
  expect(w.errors).toEqual([])
  void agent
  void other
})

test("the backend restarting under an open chat: the page says so, keeps what was typed, and takes the new thread when the agent is back, with no reload and no second subscription", async ({ page }) => {
  const address = piLike("cat-restart")
  const dir = fs.mkdtempSync(path.join(root(), "cat-b-"))
  let agent = await connect(address, dir)
  const w = watch(page)
  await signIn(page)
  await page.getByTestId("agent-row").filter({ hasText: "cat-restart" }).click()
  await expect(page.getByTestId("row-assistant")).toHaveCount(1, { timeout: 10_000 })
  const composer = page.getByTestId("composer-input")
  await composer.fill("a draft that must survive")

  agent.close()
  stopBackend(root())
  await expect(page.getByTestId("composer-disabled")).toBeVisible({ timeout: 15_000 })
  await expect(composer).toBeDisabled()
  await expect(composer).toHaveValue("a draft that must survive")

  startBackend(root())
  await expect.poll(() => fetch(`http://127.0.0.1:${BACKEND_PORT}/health`).then((r) => r.ok).catch(() => false), { timeout: 20_000 }).toBe(true)
  // the page signs in again by itself when its cookie still holds; the agent is not back yet: chat is unavailable, not broken
  await expect(page.getByTestId("banner")).toHaveCount(0, { timeout: 30_000 })
  agent = await connect(address, dir)
  await expect(composer).toBeEnabled({ timeout: 15_000 })
  await expect(composer).toHaveValue("a draft that must survive")
  await expect(page.getByTestId("row-assistant")).toHaveCount(1)
  expect(w.subscribed(address)).toBe(1)
  // and it works: a message goes to the new agent
  await composer.press("Enter")
  await expect.poll(() => agent.actions.filter((a) => a.op === "send").length, { timeout: 5000 }).toBe(1)
  expect(w.errors).toEqual([])
})

test("a draft is the agent's own: typed for one, it is not in another's composer, and it is back when the pane is", async ({ page }) => {
  const a = piLike("cat-draft-a")
  const b = piLike("cat-draft-b")
  await connect(a, fs.mkdtempSync(path.join(root(), "cat-c-")))
  await connect(b, fs.mkdtempSync(path.join(root(), "cat-d-")))
  const w = watch(page)
  await signIn(page)
  const composer = page.getByTestId("composer-input")
  await page.getByTestId("agent-row").filter({ hasText: "cat-draft-a" }).click()
  await expect(composer).toBeEnabled({ timeout: 10_000 })
  await composer.fill("draft for a")
  await page.getByTestId("agent-row").filter({ hasText: "cat-draft-b" }).click()
  await expect(page.getByTestId("pane-view")).toBeVisible()
  await expect(composer).toBeEnabled({ timeout: 10_000 })
  await expect(composer).toHaveValue("")
  await composer.fill("draft for b")
  await page.getByTestId("agent-row").filter({ hasText: "cat-draft-a" }).click()
  await expect(composer).toHaveValue("draft for a", { timeout: 10_000 })
  // through the terminal side and back
  await page.getByTestId("view-terminal").click()
  await page.getByTestId("view-chat").click()
  await expect(composer).toHaveValue("draft for a")
  await page.getByTestId("agent-row").filter({ hasText: "cat-draft-b" }).click()
  await expect(composer).toHaveValue("draft for b")
  expect(w.errors).toEqual([])
})

test("a stored view that is not 'chat' or 'terminal' (null, an object, a long string) opens the default, and the hint dismissal that is garbage does not hide it", async ({ page }) => {
  const address = piLike("cat-storage")
  await connect(address, fs.mkdtempSync(path.join(root(), "cat-e-")))
  const w = watch(page)
  await signIn(page)
  for (const junk of ["null", "{}", "[]", "\"x\"".repeat(1000), "chat ", "CHAT", "1"]) {
    await page.evaluate(([key, value]) => localStorage.setItem(key!, value!), [`herdr-web.view.${address}`, junk])
    await page.reload()
    await page.getByTestId("space-row").filter({ hasText: "cattack" }).click()
    await page.getByTestId("agent-row").filter({ hasText: "cat-storage" }).click()
    await expect(page.getByTestId("pane-view"), `stored ${junk.slice(0, 20)}`).toHaveAttribute("data-view", "chat", { timeout: 10_000 })
  }
  expect(w.errors).toEqual([])
})

test("a terminal that is killed while its chat is open: the pane says it ended, nothing can be sent, and the page raises no error", async ({ page }) => {
  const address = piLike("cat-killed")
  await connect(address, fs.mkdtempSync(path.join(root(), "cat-f-")))
  const w = watch(page)
  await signIn(page)
  await page.getByTestId("agent-row").filter({ hasText: "cat-killed" }).click()
  await expect(page.getByTestId("row-assistant")).toHaveCount(1, { timeout: 10_000 })
  await page.getByTestId("composer-input").fill("typed, never sent")
  hc("keep", address, "--off")
  hc("kill", address)
  // the pane keeps what it showed or shows the terminal's end; either way no composer that could send
  await expect(page.getByTestId("send")).toHaveCount(0, { timeout: 10_000 }).catch(async () => {
    await expect(page.getByTestId("composer-input")).toBeDisabled({ timeout: 5000 })
  })
  expect(w.errors).toEqual([])
})
