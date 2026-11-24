import type { TodoTask } from "@herdr-web/agents/rows"

/** A list longer than this folds. */
export const FOLD_OVER = 5
/** Open tasks (not done) shown while folded: the one being worked on and the next two. */
const OPEN_SHOWN = 3

export interface TodoCounts {
  done: number
  total: number
}

export const countTodos = (tasks: TodoTask[]): TodoCounts => ({ done: tasks.filter((t) => t.status === "completed").length, total: tasks.length })

/** What the collapsed card says: the task in progress, else the first one waiting, else null (nothing left to do). */
export function currentTask(tasks: TodoTask[]): TodoTask | null {
  return tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending") ?? null
}

/** The line a task shows: what is being done now, for the one in progress. */
export const taskLabel = (t: TodoTask): string => (t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject)

export interface FoldedTodos {
  shown: TodoTask[]
  /** Tasks done and left out. */
  hiddenDone: number
  /** Open tasks left out. */
  hiddenOpen: number
}

/**
 * The rows of a long list when it is folded: the done ones become a count, and of those left the first three show
 * (the one in progress comes first among them, being the one the agent is on). A short list, or one with nothing
 * left to do, shows whole.
 */
export function foldTodos(tasks: TodoTask[]): FoldedTodos {
  const open = tasks.filter((t) => t.status !== "completed")
  if (tasks.length <= FOLD_OVER || open.length === 0) return { shown: tasks, hiddenDone: 0, hiddenOpen: 0 }
  const inProgress = open.filter((t) => t.status === "in_progress")
  const waiting = open.filter((t) => t.status !== "in_progress")
  const room = Math.max(OPEN_SHOWN - inProgress.length, 0)
  const keep = new Set<TodoTask>([...inProgress, ...waiting.slice(0, room)])
  const shown = open.filter((t) => keep.has(t))
  return { shown, hiddenDone: tasks.length - open.length, hiddenOpen: open.length - shown.length }
}

/** `after #2, #3` for a task waiting on others that are not done; null when nothing holds it back. */
export function blockedLabel(task: TodoTask, tasks: TodoTask[]): string | null {
  const open = (task.blockedBy ?? []).filter((id) => tasks.some((t) => t.id === id && t.status !== "completed"))
  return open.length > 0 ? `after ${open.map((id) => `#${id}`).join(", ")}` : null
}

/** What a `todo` row carries as its details: the action and the tasks (deleted ones too), as the agents package trimmed them. */
export function readTodoRowDetails(details: unknown): { action: string; tasks: { id: number; subject: string }[] } | null {
  if (typeof details !== "object" || details === null) return null
  const d = details as Record<string, unknown>
  if (typeof d["action"] !== "string" || !Array.isArray(d["tasks"]) || typeof d["error"] === "string") return null
  const tasks = d["tasks"].flatMap((t: unknown) => {
    const r = typeof t === "object" && t !== null ? (t as Record<string, unknown>) : null
    return r && typeof r["id"] === "number" && typeof r["subject"] === "string" ? [{ id: r["id"], subject: r["subject"] }] : []
  })
  return { action: d["action"], tasks }
}

const VERBS: Record<string, string> = { in_progress: "Started", completed: "Completed", deleted: "Removed", pending: "Reset" }

/** The one line a `todo` call is shown as, or null to show it as any tool (an error, an action not known, details that are not there). */
export function describeTodoCall(args: Record<string, unknown>, details: unknown): string | null {
  const read = readTodoRowDetails(details)
  if (read === null) return null
  const subjectOf = (id: unknown) => (typeof id === "number" ? (read.tasks.find((t) => t.id === id)?.subject ?? `#${id}`) : null)
  switch (read.action) {
    case "create": {
      if (Array.isArray(args["tasks"])) return args["tasks"].length === 1 ? "Added 1 task" : `Added ${args["tasks"].length} tasks`
      return typeof args["subject"] === "string" ? `Added: ${args["subject"]}` : "Added a task"
    }
    case "update": {
      const name = subjectOf(args["id"])
      const status = typeof args["status"] === "string" && Object.hasOwn(VERBS, args["status"]) ? VERBS[args["status"]]! : "Updated"
      return name === null ? "Updated the list" : `${status}: ${name}`
    }
    case "delete": {
      const name = subjectOf(args["id"])
      return name === null ? "Removed a task" : `Removed: ${name}`
    }
    case "clear":
      return "Cleared the list"
    case "list":
    case "get":
      return "Checked the list"
    default:
      return null
  }
}
