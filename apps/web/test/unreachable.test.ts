import { afterEach, describe, expect, it, vi } from "vitest"
import { login, whyUnreachable } from "@/lib/backend"

afterEach(() => vi.unstubAllGlobals())

const page = (origin: string) => vi.stubGlobal("window", { location: { origin, hostname: new URL(origin).hostname, protocol: new URL(origin).protocol } })

/** A backend that is up but answers no CORS request: the real call fails, an opaque `no-cors` one succeeds. */
function refusingBackend() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.mode === "no-cors") return { type: "opaque", ok: false, status: 0 } as Response
    throw new TypeError("Failed to fetch")
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

/** Nothing listening: every call fails. */
const deadBackend = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))

describe("telling a stopped backend from one that refuses this page's address", () => {
  it("a backend that answers a no-cors probe is running: the message names the page's address and HERDR_WEB_ORIGINS", async () => {
    page("http://192.168.1.5:3000")
    const fetchMock = refusingBackend()
    const w = await whyUnreachable("http://192.168.1.5:7420")
    expect(w.reason).toBe("origin")
    expect(w.message).toContain("http://192.168.1.5:3000")
    expect(w.message).toContain("HERDR_WEB_ORIGINS")
    expect(w.message).not.toMatch(/not running/)
    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.5:7420/health", expect.objectContaining({ mode: "no-cors", credentials: "omit" }))
  })

  it("when even the probe fails nothing is listening: the message says the backend is not running and names its address", async () => {
    page("http://localhost:3000")
    deadBackend()
    const w = await whyUnreachable("http://localhost:7420")
    expect(w.reason).toBe("unreachable")
    expect(w.message).toContain("http://localhost:7420")
    expect(w.message).toContain("not running")
    expect(w.message).not.toContain("HERDR_WEB_ORIGINS")
  })

  it("login reports each case with its own reason", async () => {
    page("http://10.0.0.2:3000")
    refusingBackend()
    expect(await login("x", "http://10.0.0.2:7420")).toMatchObject({ ok: false, reason: "origin" })
    deadBackend()
    expect(await login("x", "http://10.0.0.2:7420")).toMatchObject({ ok: false, reason: "unreachable" })
  })
})
