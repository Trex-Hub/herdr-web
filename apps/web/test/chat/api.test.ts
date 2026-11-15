import { describe, expect, it } from "vitest"
import { chatActions } from "@/lib/chat/api"

function backend(reply: (path: string, body: unknown) => { status: number; body: unknown }) {
  const calls: { path: string; body: unknown; credentials?: RequestCredentials }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ path: new URL(url).pathname, body, credentials: init.credentials })
    const r = reply(new URL(url).pathname, body)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { calls, actions: chatActions("t7", "http://b", fetchImpl) }
}
const ok = () => ({ status: 200, body: { ok: true } })

describe("chat actions", () => {
  it("send posts the text and sends the cookie", async () => {
    const { calls, actions } = backend(() => ({ status: 200, body: { via: "agent" } }))
    await actions.send("hello")
    expect(calls).toEqual([{ path: "/api/chat/send", body: { terminal: "t7", text: "hello" }, credentials: "include" }])
  })
  it("stop, model and effort go to their own paths", async () => {
    const { calls, actions } = backend(ok)
    await actions.stop()
    await actions.setModel("p/m")
    await actions.setEffort("high")
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ["/api/chat/stop", { terminal: "t7" }],
      ["/api/chat/model", { terminal: "t7", model: "p/m" }],
      ["/api/chat/effort", { terminal: "t7", effort: "high" }],
    ])
  })
  it("loads an older page and a whole tool result", async () => {
    const { calls, actions } = backend((path) => (path.endsWith("older") ? { status: 200, body: { rows: [], hasMore: false } } : { status: 200, body: { text: "all of it" } }))
    expect(await actions.loadOlder("row-9")).toEqual({ rows: [], hasMore: false })
    expect(await actions.fullToolResult("row-3")).toBe("all of it")
    expect(calls.map((c) => c.body)).toEqual([{ terminal: "t7", before: "row-9" }, { terminal: "t7", row: "row-3" }])
  })
  it("rejects with the backend's sentence, as it is", async () => {
    const { actions } = backend(() => ({ status: 409, body: { error: "This model does not take the effort “max”. It takes: off, low." } }))
    await expect(actions.setEffort("max")).rejects.toThrow("This model does not take the effort “max”. It takes: off, low.")
  })
  it("says so when the backend cannot be reached, and when its answer is not what was expected", async () => {
    const down = chatActions("t7", "http://b", (async () => {
      throw new TypeError("failed")
    }) as typeof fetch)
    await expect(down.send("x")).rejects.toThrow("Cannot reach the backend.")
    const odd = backend(() => ({ status: 200, body: { rows: "no" } }))
    await expect(odd.actions.loadOlder("r")).rejects.toThrow(/Reload the page/)
  })
})
