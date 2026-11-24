import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { PASSPHRASE } from "./global-setup"
import { addSpace, hc, liveDir, root } from "./scratch"
import { StandIn } from "./stand-in"

// Break tests for the guardrails approval card (DEV-42), in a browser, against the real backend and a scratch core, with the stand-in
// pi-live (e2e/stand-in.ts) made to park guardrails prompts: answers that hang, are refused or are closed elsewhere, keys with menus
// open, the terminal view, the phone width, hostile commands. Named zz- so it runs after the specs that expect a fresh core document.

const osc = (state: string) => `printf '\\033]7501;state=${state}:app=pi\\007'`
const SHOTS = "/tmp/hw-shots"

test.use({ trace: "off" })

const started: string[] = []
const stands: StandIn[] = []
test.afterAll(() => {
  for (const s of stands) s.close()
  for (const address of started) {
    try {
      hc("kill", address)
    } catch {
      // already ended
    }
  }
})

const OPTIONS = [
  { result: "allow", label: "Allow once" },
  { result: "allow-session", label: "Allow for session" },
  { result: "deny", label: "Deny" },
  { result: "stop", label: "Decline and stop" },
]
const PATH_OPTIONS = [
  { result: "allow-file-once", label: "Allow once" },
  { result: "allow-dir-once", label: "Allow folder once" },
  { result: "allow-file-session", label: "Allow file for session" },
  { result: "allow-dir-session", label: "Allow folder for session" },
  { result: "allow-file-always", label: "Always allow file" },
  { result: "allow-dir-always", label: "Always allow folder" },
  { result: "deny", label: "Deny" },
]

/** Guardrails prompts parked on the stand-in, and what happens to an answer: deliver (default), hang, refuse, or `closed`. */
class Guard {
  answers: { id: string; answer: any }[] = []
  mode: "deliver" | "hang" | "refuse" | "closed" = "deliver"
  private open = new Set<string>()
  private raw: any
  constructor(stand: StandIn) {
    this.raw = stand
    this.raw.onAnswer = (m: any) => this.onAnswer(m)
  }
  command(id: string, command: string, over: Record<string, unknown> = {}, openedAt = Date.now()): void {
    this.park({ id, owner: "guardrails", kind: "guardrails.command", title: "Dangerous command", view: { toolName: "bash", command, reason: "recursive delete", options: OPTIONS, ...over }, openedAt })
  }
  path(id: string, over: Record<string, unknown> = {}, openedAt = Date.now()): void {
    this.park({
      id,
      owner: "guardrails",
      kind: "guardrails.path",
      title: "Outside workspace",
      view: { toolName: "read", path: "/Users/dev/.ssh/config", displayPath: "~/.ssh/config", directory: "/Users/dev/.ssh", cwd: "/tmp", target: "file", reason: "outside the workspace", alwaysSavedTo: "project", options: PATH_OPTIONS, ...over },
      openedAt,
    })
  }
  private park(item: Record<string, unknown>): void {
    this.open.add(String(item.id))
    this.raw.working = true
    this.raw.state()
    this.raw.send({ type: "item_opened", item })
  }
  close(id: string, by = "keyboard"): void {
    this.open.delete(id)
    this.raw.send({ type: "item_closed", id, outcome: { by } })
  }
  private onAnswer(m: { reqId: string; id: string; answer: any }): void {
    this.answers.push({ id: m.id, answer: m.answer })
    const reply = (status: string, reason?: string) => this.raw.send({ type: "answer_result", reqId: m.reqId, id: m.id, status, ...(reason !== undefined && { reason }) })
    if (!this.open.has(m.id) || this.mode === "closed") return reply("closed")
    if (this.mode === "hang") return
    if (this.mode === "refuse") return reply("invalid", `option "${m.answer?.result}" not offered`)
    reply("delivered")
    this.close(m.id, "client")
  }
}

async function setup(page: Page, name: string, width = 1440, height = 900): Promise<{ stand: StandIn; guard: Guard; address: string }> {
  const folder = fs.mkdtempSync(path.join(root(), `${name}-`))
  await addSpace({ id: `sp-${name}`, name: `${name}space`, folder })
  await fs.promises.mkdir(SHOTS, { recursive: true })
  const address = (JSON.parse(hc("run", "--bg", "--name", `${name}-agent`, "--keep", "--no-parent", "--label", `herdr.space=sp-${name}`, "--label", "herdr.seen=0", "--", "sh", "-c", `${osc("idle")}; sleep 600`)) as { address: string }).address
  started.push(address)
  const stand = await StandIn.connect({ liveDir: liveDir(), terminalId: address, dir: path.join(folder, "sessions"), stepMs: 100 })
  stands.push(stand)
  const guard = new Guard(stand)
  await page.setViewportSize({ width, height })
  await page.addInitScript(() => localStorage.setItem("herdr-web.theme", "dark"))
  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.getByTestId("space-row").filter({ hasText: `${name}space` }).click()
  await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 10_000 })
  if (width < 640) await page.getByLabel("Collapse sidebar").click() // the 272px sidebar leaves a phone no room (DEV-38)
  await page.getByTestId("view-chat").click()
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 10_000 })
  return { stand, guard, address }
}


/** Anything inside the approval panel that sticks out past the viewport (the page's own width belongs to the shell: DEV-38). */
const stickingOut = (page: Page) =>
  page.evaluate(() => {
    const w = window.innerWidth
    const panel = document.querySelector('[data-testid="approval-panel"]')!
    return [panel, ...panel.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > w + 1 && !e.closest("pre")).map((e) => `${e.tagName}[${e.getAttribute("data-testid") ?? ""}]`)
  })

const card = (page: Page) => page.getByTestId("approval-card")
const armed = (page: Page) => expect(card(page)).toHaveAttribute("data-guarding", "false", { timeout: 5000 })
const quiet = (page: Page, ms = 700) => page.waitForTimeout(ms)

test("Escape that closes a menu or dialog elsewhere on the page does not deny the command", async ({ page }) => {
  const { guard } = await setup(page, "esc")
  guard.command("g1", "rm -rf ./build")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  // the user opens the New terminal menu in the sidebar, then changes their mind
  await page.getByLabel("New terminal").first().click()
  await expect(page.getByTestId("starter").first()).toBeVisible()
  await page.keyboard.press("Escape")
  await quiet(page)
  expect(guard.answers, "Escape that closed another menu answered the approval").toEqual([])
  await expect(card(page)).toBeVisible()
})

test("Enter on the arrow (More ways to allow) opens the grants for a keyboard user", async ({ page }) => {
  const { guard } = await setup(page, "menuenter")
  guard.path("p1")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-more").focus()
  await page.keyboard.press("Enter")
  await quiet(page, 400)
  expect(await page.getByTestId("approval-grant").count(), "Enter on 'More ways to allow' does nothing (noEnter): a keyboard user must guess Space").toBeGreaterThan(0)
  expect(guard.answers).toEqual([])
})

test("the grants menu by keyboard: Space opens it, Escape closes only the menu, Arrow+Enter picks a grant", async ({ page }) => {
  const { guard } = await setup(page, "menu")
  guard.path("p1")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-more").focus()
  await page.keyboard.press("Space")
  await expect(page.getByTestId("approval-grant").first()).toBeVisible()
  await page.keyboard.press("Escape")
  await quiet(page)
  expect(guard.answers).toEqual([])
  await expect(page.getByTestId("approval-grant")).toHaveCount(0)
  await page.getByTestId("approval-more").focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect.poll(() => guard.answers.length).toBe(1)
  expect(guard.answers[0]!.answer).toEqual({ result: expect.stringMatching(/^allow-/) })
})

test("⌘/Ctrl+Enter with the grants menu open allows nothing", async ({ page }) => {
  const { guard } = await setup(page, "menucmd")
  guard.command("g1", "sudo true")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-more").click()
  await expect(page.getByTestId("approval-grant").first()).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Enter")
  await quiet(page)
  expect(guard.answers).toEqual([])
})

test("in the terminal view, Escape and Ctrl+Enter reach the terminal and answer nothing; the card is back, guarded, in the chat", async ({ page }) => {
  const { guard } = await setup(page, "term")
  guard.command("g1", "rm -rf ./x")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await page.getByTestId("approval-open-terminal").click()
  await expect(page.getByTestId("pane-view")).toHaveAttribute("data-view", "terminal")
  await page.waitForTimeout(1200)
  await page.keyboard.press("Escape")
  await page.keyboard.press("ControlOrMeta+Enter")
  await quiet(page)
  expect(guard.answers, "keys typed in the terminal answered the approval").toEqual([])
  await page.getByTestId("view-chat").click()
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toHaveAttribute("data-guarding", "true")
  // switching back at once and pressing ⌘Enter does nothing
  await page.keyboard.press("ControlOrMeta+Enter")
  await quiet(page, 300)
  expect(guard.answers).toEqual([])
})

test("answered in the terminal while the card is open (and while an answer is in flight): the card goes, the thread says so", async ({ page }) => {
  const { guard } = await setup(page, "kbd")
  guard.command("g1", "rm -rf ./a")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  guard.close("g1", "keyboard")
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId("composer")).toBeVisible()
  await expect(page.getByTestId("live-tail").getByTestId("approval-line")).toHaveCount(0) // nothing names a call, so no line under a call; the record has no home
  // in flight: Allow is hanging, the keyboard answers first
  guard.mode = "hang"
  guard.command("g2", "rm -rf ./b")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-allow").click()
  await expect.poll(() => guard.answers.length).toBe(1)
  guard.close("g2", "keyboard")
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId("composer")).toBeVisible()
})

test("a refused answer stays, says why, and Deny still works; an answer that was closed says so and takes nothing more", async ({ page }) => {
  const { guard } = await setup(page, "refuse")
  guard.mode = "refuse"
  guard.command("g1", "rm -rf ./a")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-allow").click()
  await expect(page.getByTestId("approval-rejected")).toContainText('option "allow" not offered')
  await expect(page.getByTestId("approval-allow")).toBeEnabled()
  guard.mode = "deliver"
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 10_000 })
  expect(guard.answers.map((a) => a.answer.result)).toEqual(["allow", "deny"])

  guard.mode = "closed"
  guard.command("g2", "rm -rf ./b")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-allow").click()
  await expect(page.getByTestId("approval-closed")).toBeVisible()
  await expect(page.getByTestId("approval-deny")).toBeDisabled()
  await expect(page.getByTestId("approval-allow")).toBeDisabled()
  // the card says "already answered" but stays until the prompt's close arrives; Open terminal is still there
  await expect(page.getByTestId("approval-open-terminal")).toBeVisible()
  guard.close("g2", "keyboard")
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 10_000 })
})

test("two prompts closing out of order: the one shown keeps what the reader did to it", async ({ page }) => {
  const { guard } = await setup(page, "order")
  const now = Date.now()
  guard.command("g1", Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join("\n"), {}, now)
  guard.command("g2", "rm -rf ./second", {}, now + 10)
  guard.path("p3", {}, now + 20)
  await expect(page.getByTestId("approval-count")).toHaveText("1 of 3", { timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-command-more").click()
  await expect(page.getByTestId("approval-command")).toHaveAttribute("data-folded", "false")
  guard.close("p3", "keyboard") // the newest closes first
  await expect(page.getByTestId("approval-count")).toHaveText("1 of 2")
  await expect(page.getByTestId("approval-command")).toHaveAttribute("data-folded", "false")
  await expect(card(page)).toHaveAttribute("data-guarding", "false")
  guard.close("g1", "keyboard") // the one shown closes under the reader
  await expect(page.getByTestId("approval-command")).toContainText("rm -rf ./second")
  await expect(page.getByTestId("approval-count")).toHaveCount(0)
  await expect(card(page)).toHaveAttribute("data-guarding", "true")
  await expect(page.getByTestId("approval-allow")).toBeDisabled()
  // a click on Allow where the first card's button was, within the guard, approves nothing
  await page.getByTestId("approval-allow").click({ force: true })
  expect(guard.answers).toEqual([])
})

test("pi goes away with an answer in flight: the card goes, nothing is left locked, and the composer is back", async ({ page }) => {
  const { stand, guard } = await setup(page, "gone")
  guard.mode = "hang"
  guard.command("g1", "rm -rf ./a")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-allow").click()
  await expect.poll(() => guard.answers.length).toBe(1)
  stand.goodbye("reload")
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 15_000 })
})

test("an answer in flight, then a reload: the prompt is still open for pi, so the card comes back and can be answered", async ({ page }) => {
  const { guard } = await setup(page, "reload")
  guard.mode = "hang"
  guard.command("g1", "rm -rf ./a")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-allow").click()
  await expect.poll(() => guard.answers.length).toBe(1)
  await page.reload()
  await page.getByTestId("view-chat").click().catch(() => {})
  await expect(card(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("approval-sent")).toHaveCount(0)
  guard.mode = "deliver"
  await armed(page)
  await page.getByTestId("approval-deny").click()
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 10_000 })
})

test("the draft in the composer survives an approval", async ({ page }) => {
  const { guard } = await setup(page, "draft")
  await page.getByTestId("composer-input").fill("a half written message")
  guard.command("g1", "rm -rf ./a")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-deny").click()
  await expect(page.getByTestId("composer")).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("composer-input")).toHaveValue("a half written message")
})

test("the card announces itself: a screen reader hears that a command needs approval", async ({ page }) => {
  const { guard } = await setup(page, "a11y")
  guard.command("g1", "sudo rm -rf /var/x")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  const announced = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="approval-panel"]')!
    const roles = ["alert", "alertdialog", "dialog", "status"]
    const own = [panel, ...panel.querySelectorAll("*")].some((el) => roles.includes(el.getAttribute("role") ?? "") && !el.matches('[data-testid="approval-sent"],[data-testid="approval-disabled"]')) || panel.closest("[aria-live]") !== null
    return own
  })
  expect(announced, "no role=alertdialog/alert or live region: the composer vanishes and nothing says why").toBe(true)
  // and focus: where is it?
  const focus = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName)
  console.log("focus after the card appeared:", focus)
})

test("a command that hides its tail: padding pushes `rm -rf ~` past the edge of the box at 1440", async ({ page }) => {
  const { guard } = await setup(page, "pad")
  guard.command("g1", `echo done${" ".repeat(400)}; rm -rf ~`)
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  const hidden = await page.getByTestId("approval-command").evaluate((el) => el.scrollWidth - el.clientWidth)
  await page.screenshot({ path: `${SHOTS}/dev42-break-padded-1440.png` })
  expect(hidden, `part of the command is off the edge of the box by ${hidden}px with no sign that more follows`).toBeLessThanOrEqual(0)
})

test("a very long single line (3000 characters) at 1440 is readable without hidden parts", async ({ page }) => {
  const { guard } = await setup(page, "longline")
  guard.command("g1", `echo ${"a".repeat(3000)} && rm -rf ~`)
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  const hidden = await page.getByTestId("approval-command").evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(hidden, `a 3000 character line runs ${hidden}px past the box; only a scrollbar says so`).toBeLessThanOrEqual(0)
})

test("a 20,000-line command: the card is up and Deny answers in a reasonable time", async ({ page }) => {
  const { guard } = await setup(page, "huge")
  guard.command("g1", Array.from({ length: 20_000 }, (_, i) => `echo ${i}`).join("\n"))
  const t0 = Date.now()
  await expect(card(page)).toBeVisible({ timeout: 30_000 })
  const shown = Date.now() - t0
  await armed(page)
  const t1 = Date.now()
  await page.getByTestId("approval-deny").click({ timeout: 30_000 })
  await expect(page.getByTestId("approval-panel")).toHaveCount(0, { timeout: 30_000 })
  console.log(`20,000 lines: card after ${shown} ms, Deny to gone ${Date.now() - t1} ms`)
  expect(shown).toBeLessThan(8000)
})

test("390px: buttons stack 44px tall, nothing overflows, the grants menu stays on screen, a 200-line command keeps Allow reachable", async ({ page }) => {
  const { guard } = await setup(page, "phone", 390, 700)
  guard.command("g1", Array.from({ length: 200 }, (_, i) => `echo "step ${i}: ${"x".repeat(60)}"`).join("\n"))
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
  for (const id of ["approval-allow", "approval-deny", "approval-stop"]) expect((await box(id)).height, id).toBeGreaterThanOrEqual(44)
  expect(await stickingOut(page)).toEqual([])
  const panel = (await box("approval-panel"))!
  expect(panel.height).toBeLessThanOrEqual(700 * 0.72)
  // Allow is reachable inside the card: scrolling the card brings it into the viewport
  await page.getByTestId("approval-allow").scrollIntoViewIfNeeded()
  const allow = await box("approval-allow")
  expect(allow.y).toBeGreaterThanOrEqual(0)
  expect(allow.y + allow.height).toBeLessThanOrEqual(700)
  await page.getByTestId("approval-more").click()
  const menu = (await page.locator('[data-slot="dropdown-menu-content"]').first().boundingBox())!
  expect(menu.x).toBeGreaterThanOrEqual(0)
  expect(menu.x + menu.width).toBeLessThanOrEqual(390)
  await page.keyboard.press("Escape")
  // expanded: the card scrolls, the page does not
  await page.getByTestId("approval-command-more").scrollIntoViewIfNeeded()
  await page.getByTestId("approval-command-more").click()
  expect(await stickingOut(page)).toEqual([])
  const expanded = (await box("approval-panel"))!
  expect(expanded.height).toBeLessThanOrEqual(700 * 0.72)
  await page.screenshot({ path: `${SHOTS}/dev42-break-phone-200-lines.png` })
})

test("390px: a long path and a long reason wrap inside the card", async ({ page }) => {
  const { guard } = await setup(page, "phonepath", 390, 700)
  guard.path("p1", { path: `/Users/dev/${"very-long-folder-name/".repeat(20)}file.txt`, displayPath: "~/…", reason: "outside the workspace ".repeat(12) })
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  expect(await stickingOut(page)).toEqual([])
  await page.screenshot({ path: `${SHOTS}/dev42-break-phone-path.png` })
})

test("hostile text: markup, an ANSI escape and a bidi override in a command and a reason are shown as text, inert", async ({ page }) => {
  const { guard } = await setup(page, "xss")
  guard.command("g1", `echo "<img src=x onerror=window.__pwned=1>" \u001b[31m\u202Eevil`, { reason: "<script>window.__pwned=1</script> constructor" })
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined()
  await expect(page.getByTestId("approval-command")).toContainText("<img src=x")
  await expect(page.getByTestId("approval-reason")).toContainText("<script>")
  const rendered = await page.getByTestId("approval-command").evaluate((el) => el.textContent)
  // The bidi override reorders what follows it on screen; the card shows no mark for it. Recorded for the report.
  console.log("bidi override in the shown command:", rendered!.includes("\u202E"))
})

test("a double click on Allow and a click on Deny right after it send one answer", async ({ page }) => {
  const { guard } = await setup(page, "dbl")
  guard.mode = "hang"
  guard.command("g1", "rm -rf ./a")
  await expect(card(page)).toBeVisible({ timeout: 10_000 })
  await armed(page)
  await page.getByTestId("approval-allow").dblclick()
  await page.getByTestId("approval-deny").click({ force: true })
  await page.keyboard.press("Escape")
  await quiet(page)
  expect(guard.answers.map((a) => a.answer.result)).toEqual(["allow"])
})
