import fs from "node:fs"
import path from "node:path"
import { agentsSocketPath } from "@herdr-web/agents/wire"
import { expect, test, type Page } from "@playwright/test"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"
import { PASSPHRASE } from "./global-setup"
import { addSpace, hc, root } from "./scratch"
import { StandIn } from "./stand-in"

// The terminal fits the box that is left under the Chat/Terminal bar or the hint line: every row fully visible, at 768 and
// 1440 px, with the toggle, with the hint, and with neither. Screenshots of the Terminal side go to /tmp/hw-shots/dev-26-fit.

const SHOTS = "/tmp/hw-shots/dev-26-fit"
const osc = (state: string) => `printf '\\033]7501;state=${state}:app=pi\\007'`
// Fills the screen, so the last row is a row with text on it.
const fill = "i=1; while [ $i -le 120 ]; do echo \"row $i of the fill\"; i=$((i+1)); done"

/** Where the emulator's rows are, against the box the host leaves them and the window. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector("[data-testid=terminal-host]") as HTMLElement & { __xterm: { rows: number } }
    const screen = host.querySelector(".xterm-screen") as HTMLElement
    const h = host.getBoundingClientRect()
    const s = screen.getBoundingClientRect()
    const cs = getComputedStyle(host)
    const top = h.top + parseFloat(cs.paddingTop)
    const bottom = h.bottom - parseFloat(cs.paddingBottom)
    const rows = host.__xterm.rows
    return {
      innerHeight: window.innerHeight,
      hostBottom: h.bottom,
      screenBottom: s.bottom,
      boxHeight: bottom - top,
      boxBottom: bottom,
      rows,
      cell: s.height / rows,
      rowsHeight: s.height,
    }
  })

async function expectFits(page: Page, label: string) {
  // the host may still be refitting after a size change
  await expect
    .poll(async () => {
      const g = await geometry(page)
      return g.screenBottom <= g.boxBottom + 0.5 && g.screenBottom <= g.innerHeight && g.rowsHeight <= g.boxHeight + 0.5 && g.boxHeight - g.rowsHeight < g.cell
    }, { message: label, timeout: 5000 })
    .toBe(true)
  const g = await geometry(page)
  console.log(`${label}: rows ${g.rows} × cell ${g.cell.toFixed(2)} = ${g.rowsHeight.toFixed(1)} px in a box of ${g.boxHeight.toFixed(1)} px; rows end at ${g.screenBottom.toFixed(1)}, window ${g.innerHeight}`)
}

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

test("the terminal fits under the toggle, under the hint and with neither, at 768 and 1440, light and dark", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const folder = fs.mkdtempSync(path.join(root(), "fit-"))
  const spaces = { plain: "sp-fit-plain", hint: "sp-fit-hint", toggle: "sp-fit-toggle" }
  for (const [key, id] of Object.entries(spaces)) await addSpace({ id, name: `fit ${key}`, folder })
  const run = (name: string, space: string, program: string): string => {
    const a = (JSON.parse(hc("run", "--bg", "--name", name, "--keep", "--no-parent", "--label", `herdr.space=${space}`, "--label", "herdr.seen=0", "--", "sh", "-c", program)) as { address: string }).address
    started.push(a)
    return a
  }
  run("fit-plain", spaces.plain, `${fill}; sleep 600`)
  run("fit-hint", spaces.hint, `${osc("idle")}; ${fill}; sleep 600`) // reports pi's status, no extension: the hint
  const withChat = run("fit-toggle", spaces.toggle, `${osc("idle")}; ${fill}; sleep 600`)
  agents.push(await StandIn.connect({ socketPath: agentsSocketPath(scratchEnv(root())), terminalId: withChat, dir: path.join(folder, "sessions"), stepMs: 200 }))

  await page.goto("/login")
  await page.getByLabel("Passphrase").fill(PASSPHRASE)
  await page.getByRole("button", { name: "Sign in" }).click()

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("herdr-web.theme", t), theme)
    await page.reload()
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: width === 768 ? 733 : 900 }) // a height that is not a whole number of rows
      for (const [key, space] of Object.entries(spaces)) {
        await page.getByTestId("space-row").filter({ hasText: `fit ${key}` }).click()
        if (key === "toggle") {
          await expect(page.getByTestId("view-toggle")).toBeVisible({ timeout: 10_000 })
          await page.getByTestId("view-terminal").click()
        }
        if (key === "hint") await expect(page.getByTestId("extension-hint")).toBeVisible({ timeout: 10_000 })
        if (key === "plain") await expect(page.getByTestId("extension-hint")).toHaveCount(0)
        await expect(page.getByTestId("terminal-host")).toBeVisible()
        await expect.poll(async () => (await page.getByTestId("terminal-host").evaluate((h) => (h as unknown as { __xterm: { buffer: { active: { length: number } } } }).__xterm.buffer.active.length)), { timeout: 10_000 }).toBeGreaterThan(40)
        await expectFits(page, `${theme} ${width} ${key} (${space})`)
        // The scrollbar has a thumb in the theme's own hue and no track: nothing opaque or black at the right edge.
        const bar = await page.getByTestId("terminal-host").evaluate((h) => {
          const slider = h.querySelector(".xterm-slider") as HTMLElement | null
          const rail = h.querySelector(".xterm-scrollbar") as HTMLElement | null
          return {
            slider: slider ? getComputedStyle(slider).backgroundColor : null,
            rail: rail ? getComputedStyle(rail).backgroundColor : null,
          }
        })
        expect(bar.slider, `${theme} ${width} ${key}: a thumb in the theme's hue, quiet`).toBe(theme === "dark" ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.2)")
        expect(bar.rail, "no track").toBe("rgba(0, 0, 0, 0)")
        // the thumb shows while the reader scrolls: scroll a little so the screenshot has it
        await page.getByTestId("terminal-host").hover()
        await page.mouse.wheel(0, -90)
        await page.waitForTimeout(150)
        // and back to the bottom, so the last row is the one on show
        await page.getByTestId("terminal-host").evaluate((h) => (h as unknown as { __xterm: { scrollToBottom(): void } }).__xterm.scrollToBottom())
        await page.waitForTimeout(350)
        await page.screenshot({ path: path.join(SHOTS, `terminal-${key}-${theme}-${width}.png`) })
      }
    }
  }
})
