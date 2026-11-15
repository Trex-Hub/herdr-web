import { describe, expect, it } from "vitest"
import { operations } from "@/lib/operations"

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("operations client", () => {
  it("posts JSON to /api/ops/<name> with the cookie and returns the result", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ address: "t9" }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await operations("http://b", f).start({ machine: null, space: "s1", what: { kind: "shell" } })
    expect(r).toEqual({ ok: true, value: { address: "t9" } })
    expect(seen!.url).toBe("http://b/api/ops/start")
    expect(seen!.init).toMatchObject({ method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } })
    expect(JSON.parse(seen!.init.body as string)).toEqual({ machine: null, space: "s1", what: { kind: "shell" } })
  })
  it("returns the backend's sentence as the error", async () => {
    expect(await operations("http://b", reply(409, { error: "t1 has ended." })).kill({ terminal: "t1" })).toEqual({ ok: false, error: "t1 has ended." })
  })
  it("says so when the backend cannot be reached, or answers without a message", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    expect(await operations("http://b", down).pin({ terminal: "t1", pinned: true })).toEqual({ ok: false, error: "Cannot reach the backend." })
    const r = await operations("http://b", (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch).seen({ terminal: "t1", turn: 1 })
    expect(r).toEqual({ ok: false, error: "The backend answered with status 502 and no message." })
    expect(await operations("http://b", reply(500, {})).unread({ terminal: "t1" })).toEqual({ ok: false, error: "The backend refused (status 500)." })
  })
  it("reads the list of starters", async () => {
    const starters = [{ kind: "shell", name: "Shell", description: "x" }]
    expect(await operations("http://b", reply(200, { starters })).starters()).toEqual({ ok: true, value: starters })
    expect((await operations("http://b", reply(200, { starters: "no" })).starters()).ok).toBe(false)
  })
})
