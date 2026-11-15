// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Row } from "@herdr-web/agents/rows"
import { RowView } from "@/components/chat/rows"
import { assistant, thinking, tool, user } from "./helpers"

const show = (row: Row, extra: { end?: boolean; fullResult?: (id: string) => Promise<string> } = {}) =>
  render(<RowView row={row} end={extra.end ?? false} fullResult={extra.fullResult ?? (async () => "full")} />)

/** Both themes: the dark one is the `.dark` class on the page, as the app's theme toggle sets it. */
const themes = [["light", false], ["dark", true]] as const
for (const [name, dark] of themes) {
  describe(`rows, ${name} theme`, () => {
    const wrap = (ui: React.ReactElement) => {
      document.documentElement.classList.toggle("dark", dark)
      return render(ui)
    }
    it("a user message is a bubble with its text; images are counted, not drawn", () => {
      wrap(<RowView row={{ ...(user("u1", "Fix the importer") as Extract<Row, { kind: "user" }>), images: 2 }} end={false} fullResult={async () => ""} />)
      const row = screen.getByTestId("row-user")
      expect(within(row).getByText("Fix the importer")).toBeTruthy()
      expect(row.querySelector("[data-slot=bubble]")).toBeTruthy()
      expect(within(row).getByText("2 images attached")).toBeTruthy()
    })

    it("assistant text is markdown with no bubble: headings, lists, tables, inline code", async () => {
      wrap(<RowView row={assistant("a1", "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nUse `pnpm test` now.")} end={false} fullResult={async () => ""} />)
      const row = screen.getByTestId("row-assistant")
      await waitFor(() => expect(row.querySelector("table")).toBeTruthy())
      expect(row.querySelector("h1")?.textContent).toBe("Title")
      expect(row.querySelectorAll("li")).toHaveLength(2)
      expect(row.querySelector("[data-slot=bubble]")).toBeNull()
      expect(within(row).getByText("pnpm test").tagName).toBe("CODE")
    })

    it("a fenced block has its language, highlighted code and a copy button", async () => {
      wrap(<RowView row={assistant("a1", "```ts\nconst x = 1\n```")} end={false} fullResult={async () => ""} />)
      const block = await screen.findByTestId("code-block")
      expect(block.getAttribute("data-language")).toBe("ts")
      expect(block.textContent).toContain("const x = 1")
      expect(within(block).getByRole("button", { name: "Copy" })).toBeTruthy()
    })

    it("the end of a reply has a copy button at the left and `model · effort` at the right; no retry, no thumbs", () => {
      wrap(<RowView row={assistant("a1", "done", "p/a", "high")} end fullResult={async () => ""} />)
      const footer = screen.getByTestId("reply-end")
      expect(within(footer).getByTestId("copy")).toBeTruthy()
      expect(within(footer).getByTestId("reply-by").textContent).toBe("p/a · high")
      expect(within(footer).getAllByRole("button")).toHaveLength(1)
      expect(footer.firstElementChild?.getAttribute("data-testid")).toBe("copy")
    })

    it("a reply written with no known effort shows the model alone", () => {
      wrap(<RowView row={assistant("a1", "done", "p/a", null)} end fullResult={async () => ""} />)
      expect(screen.getByTestId("reply-by").textContent).toBe("p/a")
    })

    it("a model change inside the thread is a quiet divider that names the model", () => {
      wrap(<RowView row={{ kind: "model", id: "m1", at: 1, model: "anthropic/claude" }} end={false} fullResult={async () => ""} />)
      expect(screen.getByRole("separator").textContent).toBe("Switched to anthropic/claude")
    })

    it("thinking is one collapsed line that opens to the text", async () => {
      wrap(<RowView row={thinking("th1", "weighing the options")} end={false} fullResult={async () => ""} />)
      const row = screen.getByTestId("row-thinking")
      expect(within(row).getByText("Thought")).toBeTruthy()
      expect(within(row).queryByText("weighing the options")).toBeNull()
      fireEvent.click(within(row).getByText("Thought"))
      await waitFor(() => expect(within(row).getByText("weighing the options")).toBeTruthy())
    })

    it("a tool is one collapsed line: name, main argument, duration; it opens to the arguments and the result", async () => {
      wrap(<RowView row={tool("t1", { args: { command: "ls -la", timeout: 5 } })} end={false} fullResult={async () => ""} />)
      const row = screen.getByTestId("row-tool")
      expect(row.textContent).toContain("bash")
      expect(row.textContent).toContain("ls -la")
      expect(within(row).getByTestId("tool-duration").textContent).toBe("14 ms")
      expect(within(row).queryByTestId("tool-result")).toBeNull()
      fireEvent.click(within(row).getByText("bash"))
      const result = await within(row).findByTestId("tool-result")
      expect(result.textContent).toContain("total 0")
      expect(row.textContent).toContain('"timeout": 5')
    })

    it("a failed tool carries an error mark", () => {
      wrap(<RowView row={tool("t1", { status: "error", result: { text: "boom", truncated: false, totalChars: 4 } })} end={false} fullResult={async () => ""} />)
      expect(screen.getByTestId("tool-error").textContent).toBe("failed")
      expect(screen.getByTestId("row-tool").getAttribute("data-status")).toBe("error")
    })

    it("a tool still running shows a spinner and no duration; an interrupted one says it was stopped", () => {
      const { unmount } = wrap(<RowView row={tool("t1", { status: "running", result: null, durationMs: null })} end={false} fullResult={async () => ""} />)
      expect(screen.getByTestId("tool-spinner")).toBeTruthy()
      expect(screen.queryByTestId("tool-duration")).toBeNull()
      unmount()
      wrap(<RowView row={tool("t2", { status: "interrupted", result: null, durationMs: null })} end={false} fullResult={async () => ""} />)
      expect(screen.getByTestId("tool-interrupted").textContent).toBe("stopped")
      expect(screen.queryByTestId("tool-spinner")).toBeNull()
    })

    it("a tool the user ran with ! says so", () => {
      wrap(<RowView row={tool("t1", { byUser: true })} end={false} fullResult={async () => ""} />)
      expect(screen.getByTestId("row-tool").textContent).toContain("(you)")
    })

    it("a compaction is a thin divider with text that opens to its summary", async () => {
      wrap(<RowView row={{ kind: "compaction", id: "c1", at: 1, summary: "## Goal\nfix it", tokensBefore: 126_480 }} end={false} fullResult={async () => ""} />)
      const row = screen.getByTestId("row-compaction")
      expect(within(row).getByRole("separator").textContent).toBe("Compacted · 126k tokens before")
      fireEvent.click(within(row).getByRole("separator"))
      await waitFor(() => expect(row.textContent).toContain("fix it"))
    })

    it("a notice is a quiet line, marked by its level", () => {
      wrap(<RowView row={{ kind: "notice", id: "n1", at: 1, level: "error", text: "Provider error." }} end={false} fullResult={async () => ""} />)
      const line = screen.getByTestId("row-notice")
      expect([line.textContent, line.getAttribute("data-level")]).toEqual(["Provider error.", "error"])
    })
  })
}

describe("a cut tool result", () => {
  const cut = tool("t1", { result: { text: "first part", truncated: true, totalChars: 9000 } })
  it("says how much is shown and has Show all, which asks for the full text and replaces the cut one", async () => {
    const fullResult = vi.fn(async () => "first part and all the rest")
    show(cut, { fullResult })
    fireEvent.click(screen.getByText("bash"))
    expect(await screen.findByText(/Showing 10 of 9,000 characters/)).toBeTruthy()
    fireEvent.click(screen.getByTestId("show-all"))
    await waitFor(() => expect(screen.getByTestId("tool-result").textContent).toContain("and all the rest"))
    expect(fullResult).toHaveBeenCalledWith("t1")
    expect(screen.queryByTestId("show-all")).toBeNull()
  })
  it("when asking fails, the sentence shows and the cut text stays with its button", async () => {
    show(cut, { fullResult: async () => { throw new Error("The agent has gone away.") } })
    fireEvent.click(screen.getByText("bash"))
    fireEvent.click(await screen.findByTestId("show-all"))
    expect((await screen.findByTestId("show-all-error")).textContent).toBe("The agent has gone away.")
    expect(screen.getByTestId("tool-result").textContent).toContain("first part")
    expect(screen.getByTestId("show-all")).toBeTruthy()
  })
})
