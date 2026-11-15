import type { ConnectionInfo, CoreSession, MachineView, SessionChange, Terminal as CoreTerminal } from "@herdr-web/core-client";
import { PROTOCOL_VERSION, type Machine, type ServerMessage, type Terminal } from "@herdr-web/protocol";

/** Core's record as the browser protocol carries it: the same names, a fixed set of fields, no gaps. */
export function toWireTerminal(t: CoreTerminal, chat = false): Terminal {
  return {
    address: t.address,
    name: t.name ?? null,
    state: t.state === "finished" ? "finished" : "live",
    argv: t.argv,
    cwd: t.cwd,
    cols: t.cols,
    rows: t.rows,
    created_ms: t.created_ms,
    finished_ms: t.finished_ms ?? null,
    exit_code: t.exit_code ?? null,
    signal: t.signal ?? null,
    reason: t.reason ?? null,
    title: t.title ?? "",
    labels: t.labels,
    status: t.status ?? null,
    status_ms: t.status_ms ?? null,
    turn: t.turn ?? 0,
    foreground: t.foreground ?? null,
    keep: t.keep ?? false,
    parent: t.parent ?? null,
    template: t.template ?? null,
    chat,
  };
}

export function toWireMachine(m: MachineView): Machine {
  return {
    name: m.name,
    id: m.id,
    host: m.host,
    target: m.target,
    version: m.version,
    state: m.state,
    why: m.why ?? null,
    since_ms: m.since_ms ?? null,
    temporary: m.temporary ?? false,
  };
}

function toWireConnection(c: ConnectionInfo): ConnectionInfo {
  return { state: c.state, error: c.error, core: c.core };
}

export function helloMessage(buildId: string): ServerMessage {
  return { type: "hello", protocol: PROTOCOL_VERSION, build: buildId };
}

/** Everything the browser needs to draw, as of now. Terminals include finished ones. */
export function snapshotMessage(session: CoreSession, hasChat: (address: string) => boolean = () => false): ServerMessage {
  return {
    type: "snapshot",
    connection: toWireConnection(session.connection),
    terminals: session.store.list().map((t) => toWireTerminal(t, hasChat(t.address))),
    machines: session.store.machines.map(toWireMachine),
    layouts: session.layouts.list(),
  };
}

export function changeMessage(change: SessionChange, hasChat: (address: string) => boolean = () => false): ServerMessage {
  switch (change.type) {
    case "terminal":
      return { type: "terminal", terminal: toWireTerminal(change.terminal, hasChat(change.terminal.address)) };
    case "terminal-removed":
      return { type: "terminal.removed", address: change.address };
    case "machines":
      return { type: "machines", machines: change.machines.map(toWireMachine) };
    case "layout":
      return { type: "layout", layout: change.layout };
    case "layout-removed":
      return { type: "layout.removed", machine: change.machine };
    case "connection":
      return { type: "connection", connection: toWireConnection(change.connection) };
  }
}
