// The agent's todo list, read from the session file. Written against what @juicesharp/rpiv-todo writes,
// not its code: every state-changing `todo` call returns its tool result with `details` = the whole list
// after the change, and also appends a `custom` entry of type `rpiv-todo-state` holding the same (so a call
// made through another tool, such as codemode, which never lands as a tool result of its own, still counts).
// The last valid snapshot wins. Once the branch has any state entry those are authoritative; a branch
// written before they existed replays from the tool results.
import { DETAILS_CUT, type TodoTask, type Todos } from "../rows.js"
import { isRecord, type Entry } from "./session-log.js"

export const TODO_TOOL = "todo"
export const TODO_STATE_ENTRY = "rpiv-todo-state"
/** Characters of a subject or label kept; a longer one is cut, so one runaway task cannot blow the snapshot. */
const TEXT_CUT = 300

const STATUSES: ReadonlySet<unknown> = new Set(["pending", "in_progress", "completed", "deleted"])

/** A snapshot as the agent wrote it, trimmed to what the app shows. Deleted tasks are still in `tasks`. */
export interface TodoSnapshot {
  action: string
  error: string | null
  tasks: (Omit<TodoTask, "status"> & { status: TodoTask["status"] | "deleted" })[]
}

const optionalString = (v: unknown): boolean => v === undefined || typeof v === "string"

function cut(text: string): string {
  if (text.length <= TEXT_CUT) return text
  const end = text.charCodeAt(TEXT_CUT - 1) >= 0xd800 && text.charCodeAt(TEXT_CUT - 1) <= 0xdbff ? TEXT_CUT - 1 : TEXT_CUT
  return `${text.slice(0, end)}…`
}

/**
 * `details` of a `todo` call as a snapshot, or null when it is not one: a task that does not check out
 * (an id that is not an integer, a status that is not one of the four) makes the whole snapshot invalid,
 * as in rpiv-todo, so the last valid one stays. A snapshot over DETAILS_CUT characters is not taken either.
 */
export function readSnapshot(details: unknown): TodoSnapshot | null {
  if (!isRecord(details) || !Array.isArray(details.tasks) || !Number.isSafeInteger(details.nextId)) return null
  const tasks: TodoSnapshot["tasks"] = []
  for (const raw of details.tasks) {
    if (!isRecord(raw)) return null
    if (!Number.isSafeInteger(raw.id) || typeof raw.subject !== "string" || !STATUSES.has(raw.status)) return null
    if (!optionalString(raw.activeForm)) return null
    if (raw.blockedBy !== undefined && !(Array.isArray(raw.blockedBy) && raw.blockedBy.every((id) => Number.isSafeInteger(id)))) return null
    const task: TodoSnapshot["tasks"][number] = { id: raw.id as number, subject: cut(raw.subject), status: raw.status as TodoSnapshot["tasks"][number]["status"] }
    if (typeof raw.activeForm === "string" && raw.activeForm !== "") task.activeForm = cut(raw.activeForm)
    if (Array.isArray(raw.blockedBy) && raw.blockedBy.length > 0) task.blockedBy = raw.blockedBy as number[]
    tasks.push(task)
  }
  const snapshot: TodoSnapshot = { action: typeof details.action === "string" ? details.action : "", error: typeof details.error === "string" ? details.error : null, tasks }
  return JSON.stringify(snapshot).length <= DETAILS_CUT ? snapshot : null
}

/** What the `todo` tool row carries as its `details`: the action, the error if any, and the tasks. */
export function rowDetails(snapshot: TodoSnapshot): { action: string; error?: string; tasks: TodoSnapshot["tasks"] } {
  return { action: snapshot.action, ...(snapshot.error !== null ? { error: snapshot.error } : {}), tasks: snapshot.tasks }
}

/** The list the panel shows: no deleted tasks, and null when none are left. */
function visible(snapshot: TodoSnapshot | null): Todos | null {
  if (snapshot === null) return null
  const tasks = snapshot.tasks.filter((t): t is TodoTask => t.status !== "deleted")
  return tasks.length === 0 ? null : { tasks }
}

/** One source of snapshots: the last valid one, and whether the list has since been put away. */
class Track {
  snapshot: TodoSnapshot | null = null
  seen = false
  /** Everything was completed when the user spoke again: the list is dropped until the agent writes one. */
  put = false

  take(snapshot: TodoSnapshot): void {
    this.snapshot = snapshot
    this.seen = true
    this.put = false
  }

  /** A user message begins a turn. A list with every task done is dropped then; one with work left stays. */
  userSpoke(): void {
    const list = visible(this.snapshot)
    if (list !== null && list.tasks.every((t) => t.status === "completed")) this.put = true
  }

  result(): Todos | null {
    return this.put ? null : visible(this.snapshot)
  }
}

/** Walks the entries of a branch in order, once, as they are also walked for rows. */
export class TodoWalk {
  private readonly fromEntries = new Track()
  private readonly fromResults = new Track()

  /** Feed the next entry of the branch. */
  see(entry: Entry): void {
    if (entry.type === "custom") {
      if (entry.customType === TODO_STATE_ENTRY) {
        const snapshot = readSnapshot(entry.data)
        if (snapshot) this.fromEntries.take(snapshot)
      }
      return
    }
    if (entry.type !== "message" || !isRecord(entry.message)) return
    const { role } = entry.message
    if (role === "user") {
      this.fromEntries.userSpoke()
      this.fromResults.userSpoke()
    } else if (role === "toolResult" && entry.message.toolName === TODO_TOOL && entry.message.isError !== true) {
      const snapshot = readSnapshot(entry.message.details)
      if (snapshot) this.fromResults.take(snapshot)
    }
  }

  /** The list to show now, or null. */
  todos(): Todos | null {
    return (this.fromEntries.seen ? this.fromEntries : this.fromResults).result()
  }
}
