import { execFileSync } from "node:child_process"
import path from "node:path"
import { CoreConnection } from "@herdr-web/core-client"
import { scratchEnv } from "../../../scripts/scratch-env.mjs"

export const root = (): string => process.env.HW_E2E_ROOT!
/** The folder of pi-live's session files that the backend under test watches (the scratch root's own). */
export const liveDir = (): string => scratchEnv(root()).PI_LIVE_DIR!
/** `hc` against the scratch core of this run. */
export const hc = (...args: string[]): string => execFileSync("hc", args, { env: scratchEnv(root()), encoding: "utf8" })

type Call = (method: string, params: unknown) => Promise<{ version?: number; value?: { spaces?: unknown[] } | null }>

/** Adds a space to the scratch core's `herdr-app` document, next to whatever another spec wrote. */
export async function addSpace(space: { id: string; name: string; folder: string }): Promise<void> {
  const sock = path.join(scratchEnv(root()).XDG_STATE_HOME!, "herdr-core", "herdr-web-test", "herdr-web-test.sock")
  const conn = await CoreConnection.connect({ path: sock })
  try {
    const call = (conn as unknown as { call: Call }).call.bind(conn)
    const current = await call("doc.get", { name: "herdr-app" }).catch(() => ({}) as Awaited<ReturnType<Call>>)
    const spaces = [...(current.value?.spaces ?? []), { ...space, tabs: [] }]
    await call("doc.set", { name: "herdr-app", value: { spaces }, version: current.version ?? 0 })
  } finally {
    conn.close()
  }
}
