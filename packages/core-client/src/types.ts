// Hand-written from `hc schema` (herdr-core 0.1.21, protocol generation 1),
// covering only what this client uses. Field names and optionality follow
// hc.openrpc.json; see schema/README.md in herdr-core for the event table.

export interface CoreInfo {
  id: string;
  name: string;
}

export interface HelloParams {
  framed?: boolean;
  generation?: number | null;
  features?: string[];
}

export interface HelloResult {
  generation: number;
  version: string;
  core: CoreInfo;
  framed: boolean;
  methods: string[];
  features: string[];
}

/** One 7501 record. */
export interface Status {
  state: string;
  app?: string;
  kind?: string | null;
  msg?: string;
  progress?: number | null;
  title?: string;
}

export interface Foreground {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
}

export interface Terminal {
  /** `t7`, or `machine/t7` for a terminal on an added machine. */
  address: string;
  argv: string[];
  cols: number;
  rows: number;
  created_ms: number;
  cwd: string;
  /** "live" or "finished". */
  state: string;
  screen: string;
  labels: Record<string, string>;
  die_with_parent?: boolean;
  exit_code?: number | null;
  finished_ms?: number | null;
  foreground?: Foreground | null;
  identity?: string;
  keep?: boolean;
  name?: string | null;
  notify?: boolean;
  parent?: string | null;
  paste_gap_ms?: number | null;
  pid?: number | null;
  reason?: string | null;
  records?: Record<string, Status>;
  reported?: boolean;
  rm?: boolean;
  signal?: number | null;
  status?: Status | null;
  status_ms?: number | null;
  stop?: string | null;
  submit?: string | null;
  template?: string | null;
  title?: string;
  turn?: number;
}

export interface MachineView {
  name: string;
  target: string;
  id: string;
  host: string;
  version: string;
  /** connecting, connected, needs_login or unreachable. */
  state: string;
  session?: string | null;
  since_ms?: number | null;
  why?: string | null;
  temporary?: boolean;
  via?: boolean;
  keeps_running_after_logout?: boolean | null;
  logout_linger_user?: string | null;
}

export interface SubscribeParams {
  terminal?: string | null;
  children_of?: string | null;
  labels?: Record<string, string>;
  docs?: string[];
}

export interface SubscribeResult {
  seq: number;
  terminals: Terminal[];
  /** Framed mode: the channel the events arrive on. */
  channel?: number | null;
}

export interface MachineListResult {
  machines: MachineView[];
}

export interface ListParams {
  all?: boolean;
  labels?: Record<string, string>;
}

export interface ListResult {
  terminals: Terminal[];
  hidden_finished: number;
  machines: MachineView[];
}

export interface DocGetParams {
  name: string;
  /** Another machine, by the name this core gives it. */
  on?: string;
}

export interface DocGetResult {
  /** null: never written. */
  value: unknown;
  version: number;
}

export interface RunParams {
  /** Program and arguments, or a template name; omitted: that machine's own shell. */
  argv?: string[];
  cwd?: string;
  /** Another machine, by the name this core gives it. */
  on?: string;
  keep?: boolean;
  no_parent?: boolean;
  labels?: Record<string, string>;
}

/** What `terminal.run` returns: the new terminal's record. */
export type RunResult = Terminal;

export interface TemplateInfo {
  name: string;
  description: string;
  command: string;
  /** Set when the file can't be used. */
  error?: string | null;
}

/** Methods this client calls, by name. */
export interface Methods {
  hello: { params: HelloParams; result: HelloResult };
  "events.subscribe": { params: SubscribeParams; result: SubscribeResult };
  "machine.list": { params: Record<string, never>; result: MachineListResult };
  "doc.get": { params: DocGetParams; result: DocGetResult };
  "terminal.list": { params: ListParams; result: ListResult };
  "terminal.run": { params: RunParams; result: RunResult };
  "terminal.kill": { params: { terminal: string }; result: Terminal };
  /** `key=` removes a label. */
  "terminal.label": { params: { terminal: string; labels: Record<string, string> }; result: Terminal };
  /** Pastes `text` and presses Enter, as a person would. Refuses a blocked program unless `force`. */
  "terminal.send": { params: { terminal: string; text: string; force?: boolean }; result: { turn: number; started?: boolean | null; status?: string | null } };
  "templates.list": { params: Record<string, never>; result: { templates: TemplateInfo[] } };
}

// --- notifications -------------------------------------------------------

export interface LostData {
  reason: string | null;
  exit_code: number | null;
  signal: number | null;
  finished_ms: number | null;
}

export interface FinishedData {
  reason: string | null;
  exit_code: number | null;
  signal: number | null;
  finished_ms: number | null;
}

export interface StatusData {
  status: Status | null;
  records: Record<string, Status>;
  reported: boolean;
}

export interface LabelsData {
  labels: Record<string, string>;
  /** Whole record, sent when the terminal newly matches the subscriber's filter. */
  record?: Terminal;
}

/** `foreground` event payload; null when nothing runs. */
export type ForegroundData = Foreground | null;

interface EventBase {
  seq: number;
  /** Absent on `doc` events. */
  terminal?: string;
  /** Set on events relayed from an added machine. */
  machine?: string;
}

export type TerminalEvent = EventBase &
  (
    | { type: "created"; data: Terminal }
    | { type: "lost"; data: LostData }
    | { type: "restarted"; data: Terminal }
    | { type: "keep"; data: { keep: boolean } }
    | { type: "finished"; data: FinishedData }
    | { type: "removed"; data: Record<string, never> }
    | { type: "status"; data: StatusData }
    | { type: "turn"; data: { turn: number; state?: string } }
    | { type: "title"; data: { title: string } }
    | { type: "labels"; data: LabelsData }
    | { type: "size"; data: { cols: number; rows: number } }
    | { type: "foreground"; data: ForegroundData }
    | { type: "doc"; data: { name: string; version: number } }
  );

export type CoreNotification =
  | { method: "event"; params: TerminalEvent }
  | { method: "heartbeat"; params: { seq: number } }
  | { method: "missed"; params: { seq: number; terminals: Terminal[] } };
