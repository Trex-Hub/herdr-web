import type { Connection, Layout, Machine, Terminal } from "@herdr-web/protocol"

export function terminal(address: string, extra: Partial<Terminal> = {}): Terminal {
  return {
    address,
    name: null,
    state: "live",
    argv: ["sh"],
    cwd: "/work",
    cols: 80,
    rows: 24,
    created_ms: 1000,
    finished_ms: null,
    exit_code: null,
    signal: null,
    reason: null,
    title: "",
    labels: {},
    status: null,
    status_ms: null,
    turn: 0,
    foreground: null,
    keep: false,
    parent: null,
    template: null,
    ...extra,
  }
}

export function agent(address: string, state: string, extra: Partial<Terminal> = {}): Terminal {
  return terminal(address, { status: { state, app: "pi" }, status_ms: 5000, ...extra })
}

export function machine(name: string, state = "connected", why: string | null = null): Machine {
  return { name, id: name, host: name, target: `ssh://${name}`, version: "0.1.21", state, why, since_ms: null, temporary: false }
}

export const connected: Connection = { state: "connected", error: null, core: { id: "c", name: "mac", version: "0.1.21" } }

type Pane = Layout["spaces"][number]["tabs"][number]["panes"][number]
export const term = (address: string, id = `p-${address}`): Pane => ({ id, kind: "terminal", terminal: address })
export const other = (id: string, mod: string | null = "chat"): Pane => ({ id, kind: "other", mod })

export function layout(machineName: string | null, spaces: Array<{ id: string; name?: string; folder?: string; tabs: Array<{ id: string; name?: string; panes: Pane[] }> }>): Layout {
  return {
    machine: machineName,
    status: "ok",
    reason: null,
    version: 1,
    spaces: spaces.map((s) => ({ id: s.id, name: s.name ?? s.id, folder: s.folder ?? `/work/${s.id}`, tabs: s.tabs.map((t) => ({ id: t.id, name: t.name ?? "", panes: t.panes })) })),
  }
}

export const unavailable = (machineName: string | null, reason: string): Layout => ({ machine: machineName, status: "unavailable", reason, version: null, spaces: [] })
export const empty = (machineName: string | null): Layout => ({ machine: machineName, status: "empty", reason: "no layout document written yet", version: 0, spaces: [] })
