"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, ChevronRight, ListChecks } from "lucide-react"
import type { TodoTask, Todos } from "@herdr-web/agents/rows"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { blockedLabel, countTodos, currentTask, describeTodoCall, foldTodos, taskLabel } from "@/lib/chat/todos"
import { cn } from "@/lib/utils"
import type { ToolRowViewProps, ToolView } from "./tools/types"

const STATE_WORD = { pending: "Pending", in_progress: "In progress", completed: "Done" } as const

/** The mark in front of a task: a dashed circle waiting, a ring that turns while the agent works, a check when done. */
function Mark({ status, working }: { status: TodoTask["status"]; working: boolean }) {
  if (status === "completed") {
    return (
      <span aria-hidden data-testid="todo-mark" data-status="completed" className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-600/90 text-white dark:bg-emerald-500/90">
        <Check className="size-3" strokeWidth={3} />
      </span>
    )
  }
  if (status === "in_progress") {
    return (
      <span
        aria-hidden
        data-testid="todo-mark"
        data-status="in_progress"
        data-spinning={working}
        className={cn("mt-0.5 size-4 shrink-0 rounded-full border-2 border-foreground/70", working ? "animate-spin border-t-transparent motion-reduce:animate-none" : "border-dashed")}
      />
    )
  }
  return <span aria-hidden data-testid="todo-mark" data-status="pending" className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-dashed border-muted-foreground/60" />
}

function TaskRow({ task, all, working }: { task: TodoTask; all: TodoTask[]; working: boolean }) {
  const blocked = task.status === "completed" ? null : blockedLabel(task, all)
  return (
    <li data-testid="todo-task" data-status={task.status} data-task-id={task.id} className="flex items-start gap-2 py-0.5 text-sm">
      <Mark status={task.status} working={working} />
      <span className="min-w-0 flex-1">
        <span className="sr-only">{STATE_WORD[task.status]}: </span>
        <span className={cn("break-words", task.status === "completed" && "text-muted-foreground line-through", task.status === "in_progress" && "font-medium")}>{task.subject}</span>
        {task.status === "in_progress" && task.activeForm && task.activeForm !== task.subject && (
          <span data-testid="todo-active" className="block text-xs text-muted-foreground">
            {task.activeForm}
          </span>
        )}
        {blocked && (
          <span data-testid="todo-blocked" className="ms-2 text-xs text-muted-foreground">
            {blocked}
          </span>
        )}
      </span>
    </li>
  )
}

/** A value that follows `value`, but changes at most once in `ms`; the last change always lands. */
function useSettled(value: string, ms: number): string {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    if (value === shown) return
    const wait = Math.max(0, last.current + ms - Date.now())
    const t = setTimeout(() => {
      last.current = Date.now()
      setShown(value)
    }, wait)
    return () => clearTimeout(t)
  }, [value, shown, ms])
  return shown
}

export interface TodoPanelProps {
  todos: Todos
  /** The agent is mid-turn: a task in progress shows a turning ring. */
  working: boolean
  /** A question from the agent is open: the card folds to its header so the question has the room. */
  asking?: boolean
}

/** The agent's todo list, pinned above the composer. */
export function TodoPanel({ todos, working, asking = false }: TodoPanelProps) {
  const { tasks } = todos
  const [openByUser, setOpen] = useState(true)
  const open = openByUser && !asking
  const [all, setAll] = useState(false)
  const { done, total } = countTodos(tasks)
  const current = currentTask(tasks)
  const folded = all ? { shown: tasks, hiddenDone: 0, hiddenOpen: 0 } : foldTodos(tasks)
  const foldable = foldTodos(tasks).hiddenDone + foldTodos(tasks).hiddenOpen > 0
  const announce = useSettled(current ? `Working on: ${taskLabel(current)}. ${done} of ${total} done.` : `${done} of ${total} done.`, 3000)
  const label = current ? taskLabel(current) : null
  return (
    <div className="mx-auto w-full max-w-3xl px-4" data-testid="todos" data-open={open}>
      <section aria-label="Todos" className="flex max-h-[33vh] flex-col rounded-t-xl border border-b-0 bg-card text-card-foreground">
        <button
          type="button"
          data-testid="todos-toggle"
          aria-expanded={open}
          disabled={asking}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full min-w-0 shrink-0 items-center gap-2 rounded-t-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          <span className="font-medium">Todos</span>
          <span data-testid="todos-count" className="font-mono text-xs text-muted-foreground tabular-nums">
            {done}/{total}
          </span>
          {!open && label && (
            <span data-testid="todos-current" className="min-w-0 flex-1 truncate text-muted-foreground">
              · {label}
            </span>
          )}
        </button>
        {!open && (
          <div aria-hidden data-testid="todos-meter" className="mx-3 mb-2 h-0.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-600/80 transition-[width] dark:bg-emerald-500/80" style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }} />
          </div>
        )}
        {open && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" data-testid="todos-body">
            {folded.hiddenDone > 0 && (
              <button type="button" data-testid="todos-done-fold" onClick={() => setAll(true)} className="mb-0.5 flex items-center gap-2 py-0.5 text-sm text-muted-foreground hover:text-foreground">
                <span aria-hidden className="w-4 shrink-0 text-center">✓</span>
                {folded.hiddenDone} done
              </button>
            )}
            <ul className="flex flex-col">
              {folded.shown.map((t, i) => (
                <TaskRow key={`${t.id}:${i}`} task={t} all={tasks} working={working} />
              ))}
            </ul>
            {folded.hiddenOpen > 0 && (
              <button type="button" data-testid="todos-more" onClick={() => setAll(true)} className="py-0.5 ps-6 text-sm text-muted-foreground hover:text-foreground">
                +{folded.hiddenOpen} more
              </button>
            )}
            {all && foldable && (
              <button type="button" data-testid="todos-less" onClick={() => setAll(false)} className="py-0.5 ps-6 text-sm text-muted-foreground hover:text-foreground">
                Show less
              </button>
            )}
          </div>
        )}
        <div role="status" aria-live="polite" className="sr-only" data-testid="todos-live">
          {announce}
        </div>
      </section>
    </div>
  )
}

/** The `todo` tool as one line of what it changed; any other outcome is the plain tool line. */
function TodoRow({ row, plain }: ToolRowViewProps) {
  const text = row.status === "ok" ? describeTodoCall(row.args, row.details) : null
  if (text === null) return <>{plain}</>
  return (
    <Trace data-testid="row-todo" data-row-id={row.id} data-name="todo" data-status={row.status}>
      <TraceLine>
        <TraceIcon>
          <ListChecks />
        </TraceIcon>
        <TraceTitle className="min-w-0 flex-1 truncate font-medium text-foreground/80">{text}</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

export const todoView: ToolView = { Row: TodoRow }
