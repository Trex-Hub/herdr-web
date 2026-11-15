"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Ellipsis, Plus } from "lucide-react"
import type { Starter } from "@herdr-web/protocol"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { Operations, OpResult } from "@/lib/operations"
import type { SpaceItem } from "@/lib/model"

/** Runs one operation at a time for a control: whether it is running, and the sentence it failed with. */
export function useOperation() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(async <T,>(call: () => Promise<OpResult<T>>): Promise<T | null> => {
    setPending(true)
    setError(null)
    const result = await call()
    if (!alive.current) return result.ok ? result.value : null
    setPending(false)
    if (result.ok) return result.value
    setError(result.error)
    return null
  }, [])
  return { pending, error, run, clear: () => setError(null) }
}

export function OpError({ error, className }: { error: string | null; className?: string }) {
  if (!error) return null
  return (
    <p role="alert" data-testid="op-error" className={className ?? "text-xs text-destructive"}>
      {error}
    </p>
  )
}

/** The "+" at the end of the tab strip: Shell, pi, then core's templates. */
export function NewTerminalMenu({ space, ops, disabled, onStarted }: { space: SpaceItem; ops: Operations; disabled: boolean; onStarted: (address: string) => void }) {
  const [starters, setStarters] = useState<Starter[] | null>(null)
  const list = useOperation()
  const start = useOperation()

  const open = (isOpen: boolean) => {
    if (!isOpen) return
    start.clear()
    // Asked each time the menu opens, so templates added to core's folder show up.
    void list.run(() => ops.starters()).then((s) => s && setStarters(s))
  }
  const choose = async (s: Starter) => {
    const result = await start.run(() => ops.start({ machine: space.machine, space: space.id, what: s.kind === "template" ? { kind: "template", name: s.name } : { kind: s.kind } }))
    if (result) onStarted(result.address)
  }
  const shown = starters ?? [{ kind: "shell", name: "Shell", description: "" }, { kind: "pi", name: "pi", description: "" }]
  return (
    <div className="flex shrink-0 items-center gap-2">
      <DropdownMenu onOpenChange={open}>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="New terminal" data-testid="new-terminal" disabled={disabled || start.pending} />}
        >
          <Plus className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <div className="px-1.5 py-1 text-xs text-muted-foreground">New terminal in {space.name}</div>
          {shown.map((s) => (
            <DropdownMenuItem key={`${s.kind}:${s.name}`} data-testid="starter" data-kind={s.kind} onClick={() => void choose(s)}>
              {s.name}
            </DropdownMenuItem>
          ))}
          {list.error && (
            <>
              <DropdownMenuSeparator />
              <OpError error={list.error} className="px-1.5 py-1 text-xs text-destructive" />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <OpError error={start.error} className="max-w-64 truncate text-xs text-destructive" />
    </div>
  )
}

export interface KillTarget {
  address: string
  /** What the confirmation calls it. */
  name: string
}

/** The confirmation before a kill; it names the terminal and shows core's answer if the kill fails. */
export function KillDialog({ target, ops, disabled, onClose, onKilled }: { target: KillTarget | null; ops: Operations; disabled: boolean; onClose: () => void; onKilled: (address: string) => void }) {
  const op = useOperation()
  // keep the name on screen while the dialog fades out
  const last = useRef<KillTarget | null>(null)
  if (target) last.current = target
  const shown = target ?? last.current
  useEffect(() => {
    if (target) op.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.address])
  const confirm = async () => {
    if (!target) return
    const result = await op.run(() => ops.kill({ terminal: target.address }))
    if (result) {
      onKilled(target.address)
      onClose()
    }
  }
  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && !op.pending && onClose()}>
      <AlertDialogContent data-testid="kill-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Kill {shown?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This ends the program running in {shown?.name} ({shown?.address}). What it was doing is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <OpError error={op.error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={op.pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" data-testid="kill-confirm" disabled={disabled || op.pending} onClick={() => void confirm()}>
            {op.pending ? "Killing…" : "Kill"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export interface MenuItemSpec {
  key: string
  label: string
  testId: string
  disabled?: boolean
  run: () => void
}

/** A small "⋯" menu for a tab or an agent row. */
export function KebabMenu({ label, items, disabled, testId, className }: { label: string; items: MenuItemSpec[]; disabled: boolean; testId: string; className?: string }) {
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} data-testid={testId} disabled={disabled} className={className} />}>
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map((i) => (
          <DropdownMenuItem key={i.key} data-testid={i.testId} disabled={i.disabled} onClick={i.run}>
            {i.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
