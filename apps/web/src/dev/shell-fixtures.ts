// Fixture data for /dev/shell: what the backend would send for a small, busy setup, so the sidebar can be built,
// reviewed and screenshotted with no backend. Shaped like the protocol's records.
import type { AppShared, Layout, Machine, Terminal } from "@herdr-web/protocol"

export const NOW = 1_794_700_000_000
const MIN = 60_000

type Pane = Layout["spaces"][number]["tabs"][number]["panes"][number]

const LONG_NAME = "sidebar-modification-with-a-very-long-agent-name-that-has-to-truncate"

interface AgentSpec {
  address: string
  /** The terminal's own name (null: it has none). */
  name: string | null
  app: string
  state: "working" | "blocked" | "idle"
  /** Minutes since its status changed. */
  ago: number
  pinned?: boolean
  /** A finished turn nobody has looked at: "done". */
  unseen?: boolean
}

const AGENTS: AgentSpec[] = [
  { address: "t17", name: "pi", app: "pi", state: "working", ago: 2, pinned: true },
  { address: "t4m", name: null, app: "pi", state: "blocked", ago: 14 },
  { address: "t4n", name: null, app: "pi", state: "idle", ago: 95, unseen: true },
  { address: "t20", name: "AYR-59", app: "pi", state: "working", ago: 7 },
  { address: "t3f", name: "oauth-engineer", app: "pi", state: "idle", ago: 61 },
  { address: "t3g", name: "oauth-tester", app: "claude", state: "idle", ago: 200 },
  { address: "t3k", name: "pi-command-code", app: "codex", state: "idle", ago: 30, unseen: true },
  { address: "t3c", name: LONG_NAME, app: "pi", state: "working", ago: 3 },
  { address: "t3q", name: "pi-user-lack-alert", app: "claude", state: "idle", ago: 600 },
  { address: "t99", name: "scratch", app: "pi", state: "idle", ago: 5000 },
  { address: "devserver/t5", name: "build-bot", app: "claude", state: "working", ago: 1 },
  { address: "devserver/t6", name: null, app: "pi", state: "blocked", ago: 22 },
]

function terminal(a: AgentSpec): Terminal {
  const labels: Record<string, string> = {}
  if (a.pinned) labels["herdr.pinned"] = "1"
  return {
    address: a.address,
    name: a.name,
    state: "live",
    argv: [a.app],
    cwd: "/Users/dev/Desktop/devendras-work/herdr-web",
    cols: 100,
    rows: 30,
    created_ms: NOW - 10_000_000 + AGENTS.findIndex((x) => x.address === a.address) * 1000,
    finished_ms: null,
    exit_code: null,
    signal: null,
    reason: null,
    title: a.name ?? "",
    labels,
    status: { state: a.state, app: a.app },
    status_ms: NOW - a.ago * MIN,
    turn: a.unseen ? 3 : 0,
    foreground: null,
    keep: false,
    parent: null,
    template: null,
    chat: false,
  }
}

const term = (address: string): Pane => ({ id: `p-${address}`, kind: "terminal", terminal: address })
const tab = (id: string, ...addresses: string[]) => ({ id, name: "", panes: addresses.map(term) })

const MANY = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]

export interface ShellFixture {
  terminals: Record<string, Terminal>
  machines: Machine[]
  layouts: Record<string, Layout>
  appShared: AppShared | null
}

export interface ShellScenario {
  /** herdr-app's file is there. */
  file: boolean
  agents: boolean
  /** Many spaces, so the Spaces block has to scroll. */
  many: boolean
  /** Many agents, so the Agents block has to scroll. */
  crowd: boolean
}

export function shellFixture(s: ShellScenario): ShellFixture {
  const specs = s.agents ? [...AGENTS] : []
  if (s.agents && s.crowd)
    for (let i = 0; i < 14; i++) specs.push({ address: `t${200 + i}`, name: `worker-${i + 1}`, app: i % 3 === 0 ? "claude" : "pi", state: i % 4 === 0 ? "working" : "idle", ago: 10 + i * 17 })

  const local: Layout = {
    machine: null,
    status: "ok",
    reason: null,
    version: 1,
    spaces: [
      { id: "sp-home", name: "Home", folder: "/Users/dev", tabs: [tab("a", "t20", "t3f"), tab("b", "t3g", "t3k")] },
      { id: "sp-herdr", name: "herdr-web", folder: "/Users/dev/Desktop/devendras-work/herdr-web", tabs: [tab("a", "t17"), tab("b", "t4m", "t4n")] },
      { id: "sp-box", name: "server-box", folder: "/home/zosma/projects/api/service", tabs: [tab("a", "t3c", "t3q")] },
      { id: "sp-bare", name: "scratchpad", folder: "", tabs: [] },
      ...(s.many ? MANY.map((n) => ({ id: `sp-${n}`, name: `${n[0]!.toUpperCase()}${n.slice(1)} project`, folder: `/Users/dev/Desktop/work/${n}/app`, tabs: [] })) : []),
    ],
  }
  const devserver: Layout = {
    machine: "devserver",
    status: "ok",
    reason: null,
    version: 1,
    spaces: [
      { id: "sp-ayra", name: "ayra", folder: "/home/zosma/ayra/app", tabs: [tab("a", "devserver/t5", "devserver/t6")] },
      { id: "sp-ops", name: "ops", folder: "/root", tabs: [] },
    ],
  }
  const machine = (name: string, state: string, why: string | null): Machine => ({ name, id: name, host: name, target: `ssh://${name}`, version: "0.1.21", state, why, since_ms: null, temporary: false })

  const appShared: AppShared | null = s.file
    ? {
        "agents.groups": [
          { id: "gayra", name: "ayra-oauth" },
          { id: "ghw", name: "herdr-web" },
          { id: "gempty", name: "empty group" },
        ],
        "agents.groupLabel": { "gr-gayra": "ayra", "gr-": "freebrawl" },
        "agents.agentGroup": { t17: "ghw", t4m: "ghw", t4n: "ghw", t20: "gayra", t3f: "gayra" },
        "agents.agentLabel": { t17: "ui-lead", t4m: "engineer", t4n: "tester", t20: "AYR-59" },
        "agents.spaceGroup": { "sp-box": "gayra" },
        "space.colors": { "sp-home": "ansi4", "sp-herdr": "ansi6", "devserver/sp-ayra": "ansi5", "sp-bravo": "ansi1", "sp-charlie": "ansi2", "sp-delta": "ansi3" },
      }
    : null

  return {
    terminals: Object.fromEntries(specs.map((a) => [a.address, terminal(a)])),
    machines: [
      machine("devserver", "connected", null),
      machine("cachyos", "unreachable", "ssh: connect to host cachyos.tail1234.ts.net port 22: Connection timed out after 30 seconds; the last successful connection was 2 days ago (tailscale reports the node as offline)"),
    ],
    layouts: { "": local, devserver },
    appShared,
  }
}
