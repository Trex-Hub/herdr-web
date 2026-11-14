// @vitest-environment node
import { Terminal } from "@xterm/headless"
import { describe, expect, it } from "vitest"
import { suppressFocusReports, tagReplies, type ParserHost } from "../src/lib/terminal/replies"

interface Got {
  data: string
  automatic: boolean
}

function setup() {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, vtExtensions: { win32InputMode: true, kittyKeyboard: true } } as never)
  const tagging = tagReplies(term as unknown as ParserHost)
  const got: Got[] = []
  term.onData((data: string) => got.push({ data, automatic: tagging.isAutomatic() }))
  const feed = (s: string) => new Promise<void>((resolve) => term.write(s, resolve))
  return { term, tagging, got, feed }
}

describe("reply tagging", () => {
  it("tags every answer to pi's start-up probe as automatic, in order", async () => {
    const { got, feed } = setup()
    // pi-tui: kitty keyboard push + query, colour probe, then primary device attributes, in one write
    await feed("\x1b[>7u\x1b[?u\x1b]11;?\x1b\\\x1b[c")
    expect(got.length).toBeGreaterThanOrEqual(2) // the colour answer comes from the browser build only; the e2e test covers it
    expect(got.every((g) => g.automatic)).toBe(true)
    const all = got.map((g) => g.data)
    const kitty = all.findIndex((d) => /^\x1b\[\?\d+u$/.test(d))
    const da1 = all.findIndex((d) => /^\x1b\[\?[\d;]+c$/.test(d))
    expect(kitty).toBeGreaterThanOrEqual(0)
    expect(da1).toBeGreaterThan(kitty) // the kitty reply leaves before DA1, as pi expects
  })

  it("tags device attributes, status, cursor position, DECRQM, XTVERSION and DECRQSS replies", async () => {
    const { got, feed } = setup()
    await feed("\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[?2026$p\x1b[4;1$p\x1b[>q\x1bP$qm\x1b\\")
    expect(got.length).toBeGreaterThanOrEqual(7)
    expect(got.every((g) => g.automatic), JSON.stringify(got)).toBe(true)
  })

  it("never tags what a person types, even right after a query", async () => {
    const { term, tagging, got, feed } = setup()
    await feed("\x1b[c")
    expect(got.at(-1)?.automatic).toBe(true)
    // typing arrives in a later task
    await new Promise((r) => setTimeout(r, 0))
    term.input("ls\r", true)
    expect(got.at(-1)).toEqual({ data: "ls\r", automatic: false })
    expect(tagging.isAutomatic()).toBe(false)
  })

  it("leaves nothing flagged after a query that gets no answer", async () => {
    const { tagging, feed } = setup()
    await feed("\x1b[99;99$p\x1b]10;#ffffff\x1b\\") // an OSC that sets a colour, not a query
    await new Promise((r) => setTimeout(r, 0))
    expect(tagging.isAutomatic()).toBe(false)
  })
})

describe("focus reports", () => {
  it("xterm never reports focus once the program turns 1004 on, alone or among other modes", async () => {
    const { term, got, feed } = setup()
    suppressFocusReports(term as unknown as ParserHost)
    await feed("\x1b[?1004h")
    await feed("\x1b[?1004;2004h")
    // xterm's own reports come from its DOM focus handlers only when this mode is set on it
    const core = (term as unknown as { _core: { coreService: { decPrivateModes: { sendFocus: boolean; bracketedPasteMode: boolean } } } })._core
    expect(core.coreService.decPrivateModes.sendFocus).toBe(false)
    expect(core.coreService.decPrivateModes.bracketedPasteMode).toBe(true) // the other mode in the list still took effect
    expect(got).toEqual([])
  })

  it("lets other private modes through untouched", async () => {
    const { term, feed } = setup()
    suppressFocusReports(term as unknown as ParserHost)
    await feed("\x1b[?2004h\x1b[?25l")
    const core = (term as unknown as { _core: { coreService: { decPrivateModes: { bracketedPasteMode: boolean } } } })._core
    expect(core.coreService.decPrivateModes.bracketedPasteMode).toBe(true)
  })
})
