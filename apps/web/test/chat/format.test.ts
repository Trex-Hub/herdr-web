import { describe, expect, it } from "vitest"
import { assistant, thinking, tool, user } from "./helpers"
import { capitalise, formatDuration, formatElapsedSeconds, formatTokens, mainArgument, mainArgumentParts, modelName, noticeText, parseSlash, replyEnds } from "@/lib/chat/format"

describe("mainArgument", () => {
  it("is the command for a shell tool, the path for a file tool, the pattern or query otherwise", () => {
    expect(mainArgument({ name: "bash", args: { command: "ls -la\necho two", timeout: 5 } })).toBe("ls -la")
    expect(mainArgument({ name: "read", args: { path: "src/a.ts" } })).toBe("src/a.ts")
    expect(mainArgument({ name: "grep", args: { pattern: "TODO", path: "src" } })).toBe("src")
    expect(mainArgument({ name: "search", args: { query: "cats" } })).toBe("cats")
  })
  it("falls back to the first text argument, and to nothing", () => {
    expect(mainArgument({ name: "x", args: { n: 1, label: "hello" } })).toBe("hello")
    expect(mainArgument({ name: "x", args: {} })).toBe("")
    expect(mainArgument({ name: "x", args: { n: 1 } })).toBe("")
  })
})

describe("modelName", () => {
  const models = [
    { id: "llama-swap/zorro-davidau-3.8-flash-next", name: "Zorro 3.8 flash", reasoning: true },
    { id: "llama-swap/local", name: "Local", reasoning: false },
  ]
  it("shows the display name when the exact id is listed, else the id", () => {
    expect(modelName(models, "llama-swap/zorro-davidau-3.8-flash-next")).toBe("Zorro 3.8 flash")
    expect(modelName(models, "anthropic/claude")).toBe("anthropic/claude")
  })
  it("matches an id that differs only by its provider prefix", () => {
    expect(modelName(models, "local")).toBe("Local")
    expect(modelName(models, "zorro-davidau-3.8-flash-next")).toBe("Zorro 3.8 flash")
  })
  it("needs no list", () => {
    expect(modelName(null, "p/a")).toBe("p/a")
  })
})

describe("capitalise", () => {
  it("capitalises a level for display; off stays Off, an empty string stays empty", () => {
    expect(["off", "low", "medium", "high"].map(capitalise)).toEqual(["Off", "Low", "Medium", "High"])
    expect(capitalise("")).toBe("")
  })
})

describe("noticeText", () => {
  it("a one-line single sentence keeps the rest and loses only its trailing period", () => {
    expect(noticeText("Stopped.")).toBe("Stopped")
    expect(noticeText("Provider error: connection reset.")).toBe("Provider error: connection reset")
  })
  it("multi-sentence and multi-line notices keep their periods", () => {
    expect(noticeText("It is slow. Retry.")).toBe("It is slow. Retry.")
    expect(noticeText("One sentence.\nAnother.")).toBe("One sentence.\nAnother.")
    expect(noticeText("No period here")).toBe("No period here")
  })
})

describe("mainArgumentParts", () => {
  it("also returns the key the value came from, so an expanded row can leave it out", () => {
    expect(mainArgumentParts({ name: "bash", args: { command: "ls" } })).toEqual({ key: "command", value: "ls" })
    expect(mainArgumentParts({ name: "read", args: { path: "src/a.ts", mode: "utf8" } })).toEqual({ key: "path", value: "src/a.ts" })
    expect(mainArgumentParts({ name: "x", args: { n: 1, label: "hi" } })).toEqual({ key: "label", value: "hi" })
    expect(mainArgumentParts({ name: "x", args: {} })).toEqual({ key: "", value: "" })
  })
})

describe("formatElapsedSeconds", () => {
  it("whole seconds: nothing under a second, then 3 s … 59 s, then 1 min 5 s", () => {
    expect(formatElapsedSeconds(0)).toBe("")
    expect(formatElapsedSeconds(0.4)).toBe("")
    expect(formatElapsedSeconds(1.3)).toBe("1 s")
    expect(formatElapsedSeconds(3)).toBe("3 s")
    expect(formatElapsedSeconds(59.9)).toBe("59 s")
    expect(formatElapsedSeconds(65)).toBe("1 min 5 s")
    expect(formatElapsedSeconds(-5)).toBe("")
  })
})

describe("numbers", () => {
  it("durations", () => {
    expect([14, 1342, 12_000, 125_000].map(formatDuration)).toEqual(["14 ms", "1.3 s", "12 s", "2 min 5 s"])
  })
  it("token counts", () => {
    expect([950, 1200, 54_300, 126_480, 1_500_000].map(formatTokens)).toEqual(["950", "1.2k", "54k", "126k", "1.5M"])
  })
})

describe("parseSlash", () => {
  it("is null for ordinary text, including a path or a fraction", () => {
    expect(parseSlash("hello")).toBeNull()
    expect(parseSlash("/usr/bin is where it lives")).toBeNull()
    expect(parseSlash("1/2")).toBeNull()
  })
  it("is null for what pi-live runs: /compact (an action), /name with a name (an action), a skill, a prompt template, another case", () => {
    for (const text of ["/compact", "/compact keep the tests", "/name the refactor", "/skill:review the diff", "/review", "/Model", "/MODEL", "/models", "/model\u0003", "/"]) expect(parseSlash(text), text).toBeNull()
  })
  it("/name alone is pi's own and is typed", () => {
    expect(parseSlash("/name")).toEqual({ name: "name", opensPicker: false })
  })
  it("finds the command and whether it opens a picker in pi", () => {
    expect(parseSlash("/new")).toEqual({ name: "new", opensPicker: false })
    expect(parseSlash("/resume")).toEqual({ name: "resume", opensPicker: true })
    expect(parseSlash("/tree")).toEqual({ name: "tree", opensPicker: true })
    expect(parseSlash("/settings")).toEqual({ name: "settings", opensPicker: true })
  })
  it("/model and /thinking open a picker only without an argument", () => {
    expect(parseSlash("/model")?.opensPicker).toBe(true)
    expect(parseSlash("/model p/a")?.opensPicker).toBe(false)
    expect(parseSlash("/thinking")?.opensPicker).toBe(true)
    expect(parseSlash("/thinking high")?.opensPicker).toBe(false)
  })
})

describe("replyEnds", () => {
  const rows = [user("u1"), thinking("th1"), tool("t1"), assistant("a1"), user("u2"), assistant("a2", "mid"), tool("t2"), assistant("a3")]
  it("an assistant row ends the reply when the next row is not part of the same turn", () => {
    expect([...replyEnds(rows, false)]).toEqual(["a1", "a3"])
  })
  it("the last row ends nothing while the turn visibly goes on (reply text or a tool is live)", () => {
    expect([...replyEnds(rows, true)]).toEqual(["a1"])
  })
})
