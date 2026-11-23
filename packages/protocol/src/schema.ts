import { z } from "zod";
import { ChatChangeMessageSchema, ChatSnapshotMessageSchema, ChatSubscribeSchema, ChatUnavailableMessageSchema, ChatUnsubscribeSchema } from "./chat.js";

/**
 * Bumped when a message changes in a way an older browser cannot read. Sent in `hello`.
 * Adding a message type or a field a client may ignore does not bump it.
 */
export const PROTOCOL_VERSION = 2;

// --- shared records ---------------------------------------------------------

/** What a program reported about itself over OSC 7501; words are the program's own. */
export const StatusSchema = z.object({
  state: z.string(),
  app: z.string().optional(),
  kind: z.string().nullish(),
  msg: z.string().optional(),
  progress: z.number().nullish(),
  title: z.string().optional(),
});

export const ForegroundSchema = z.object({
  pid: z.number(),
  name: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
});

/** A terminal as core reports it (same field names), without the fields the web app has no use for. */
export const TerminalSchema = z.object({
  /** `t7`, or `machine/t7` on an added machine. */
  address: z.string(),
  name: z.string().nullable(),
  state: z.enum(["live", "finished"]),
  argv: z.array(z.string()),
  cwd: z.string(),
  cols: z.number(),
  rows: z.number(),
  created_ms: z.number(),
  finished_ms: z.number().nullable(),
  exit_code: z.number().nullable(),
  signal: z.number().nullable(),
  reason: z.string().nullable(),
  title: z.string(),
  labels: z.record(z.string(), z.string()),
  status: StatusSchema.nullable(),
  status_ms: z.number().nullable(),
  turn: z.number(),
  foreground: ForegroundSchema.nullable(),
  keep: z.boolean(),
  parent: z.string().nullable(),
  template: z.string().nullable(),
  /** Whether this terminal has a chat to subscribe to: an agent we know is connected to the bridge. Always false on an added machine. */
  chat: z.boolean(),
});

/** A machine added to the core, and its line now. */
export const MachineSchema = z.object({
  name: z.string(),
  id: z.string(),
  host: z.string(),
  target: z.string(),
  version: z.string(),
  /** connecting, connected, needs_login or unreachable. */
  state: z.string(),
  why: z.string().nullable(),
  since_ms: z.number().nullable(),
  temporary: z.boolean(),
});

/** The bridge's connection to core. */
export const ConnectionSchema = z.object({
  state: z.enum(["connecting", "connected", "reconnecting", "stopped"]),
  /** Why the last attempt or connection failed; null while connected. */
  error: z.string().nullable(),
  core: z.object({ id: z.string(), name: z.string(), version: z.string() }).nullable(),
});

// --- layout -----------------------------------------------------------------

export const PaneSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("terminal"), terminal: z.string() }),
  z.object({ id: z.string(), kind: z.literal("other"), mod: z.string().nullable() }),
]);

export const TabSchema = z.object({
  id: z.string(),
  /** Empty when unnamed: show the tab's position. */
  name: z.string(),
  panes: z.array(PaneSchema),
});

export const SpaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  folder: z.string(),
  tabs: z.array(TabSchema),
});

/** One machine's spaces, tabs and panes. */
export const LayoutSchema = z.object({
  /** null: the core the bridge is connected to; otherwise the machine's name there. */
  machine: z.string().nullable(),
  status: z.enum(["ok", "empty", "unavailable"]),
  reason: z.string().nullable(),
  version: z.number().nullable(),
  spaces: z.array(SpaceSchema),
});

// --- herdr-app's names and groups (read-only) ------------------------------

/**
 * The parts of herdr-app's `shared.json` the browser may use, under the file's own keys. The bridge only reads that file;
 * it drops anything malformed before sending, so every key is present and every entry is well formed.
 */
export const AppSharedSchema = z.object({
  /** Custom agent groups in the order herdr-app lists them. */
  "agents.groups": z.array(z.object({ id: z.string(), name: z.string() })),
  /** A group's title by `gr-<id>`; `gr-` is the bucket of agents in no group. */
  "agents.groupLabel": z.record(z.string(), z.string()),
  /** A terminal address to the id of its group. */
  "agents.agentGroup": z.record(z.string(), z.string()),
  /** A terminal address to the name herdr-app shows for it. */
  "agents.agentLabel": z.record(z.string(), z.string()),
  /** A space id (`sp…`, or `machine/sp…`) to the id of the group its agents go to. */
  "agents.spaceGroup": z.record(z.string(), z.string()),
  /** A space id to a colour name such as `ansi4`. */
  "space.colors": z.record(z.string(), z.string()),
});

// --- bridge to browser ------------------------------------------------------

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.number(), build: z.string() }),
  z.object({
    type: z.literal("snapshot"),
    connection: ConnectionSchema,
    terminals: z.array(TerminalSchema),
    machines: z.array(MachineSchema),
    layouts: z.array(LayoutSchema),
  }),
  z.object({ type: z.literal("terminal"), terminal: TerminalSchema }),
  z.object({ type: z.literal("terminal.removed"), address: z.string() }),
  z.object({ type: z.literal("machines"), machines: z.array(MachineSchema) }),
  z.object({ type: z.literal("layout"), layout: LayoutSchema }),
  z.object({ type: z.literal("layout.removed"), machine: z.string().nullable() }),
  z.object({ type: z.literal("connection"), connection: ConnectionSchema }),
  z.object({ type: z.literal("pong") }),
  /** herdr-app's names and groups, after the snapshot when its file exists and whenever it changes; null when the file has gone away. */
  z.object({ type: z.literal("app.shared"), shared: AppSharedSchema.nullable() }),
  ChatSnapshotMessageSchema,
  ChatChangeMessageSchema,
  ChatUnavailableMessageSchema,
]);

// --- browser to bridge ------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("ping") }), ChatSubscribeSchema, ChatUnsubscribeSchema]);

export type Status = z.infer<typeof StatusSchema>;
export type Foreground = z.infer<typeof ForegroundSchema>;
export type Terminal = z.infer<typeof TerminalSchema>;
export type Machine = z.infer<typeof MachineSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type Pane = z.infer<typeof PaneSchema>;
export type Tab = z.infer<typeof TabSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type AppShared = z.infer<typeof AppSharedSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
