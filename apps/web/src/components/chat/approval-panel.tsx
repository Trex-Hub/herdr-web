"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown, File, Folder, ShieldAlert } from "lucide-react"
import type { Approval, ApprovalOption } from "@herdr-web/agents/rows"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { sentence, type ChatActions } from "@/lib/chat/actions"
import { APPROVAL_GUARD_MS, COMMAND_LINES, approvalChoices, approvalQuestion, commandLines, grantDetail } from "@/lib/chat/approvals"
import { cn } from "@/lib/utils"

const CLOSED = "This was already answered or closed."

/** The command as it will run, every line, numbered when there are several; long ones fold until opened. */
function CommandBlock({ command }: { command: string }) {
  const lines = commandLines(command)
  const long = lines.length > COMMAND_LINES
  const [open, setOpen] = useState(false)
  const folded = long && !open
  return (
    <div className="flex flex-col items-start gap-1">
      <pre
        data-testid="approval-command"
        data-folded={folded}
        className={cn(
          "w-full overflow-x-auto rounded-lg border bg-muted/50 py-2 font-mono text-[13px] leading-relaxed",
          folded && "max-h-[calc(12*1.625em+1rem)] overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
          "max-sm:whitespace-pre-wrap max-sm:break-all",
        )}
      >
        {lines.map((l, i) => (
          <div key={i} className="flex pe-3">
            <span aria-hidden className="w-9 shrink-0 pe-3 text-right text-muted-foreground/60 select-none">
              {lines.length > 1 ? i + 1 : "$"}
            </span>
            <span className="min-w-0">{l === "" ? " " : l}</span>
          </div>
        ))}
      </pre>
      {long && (
        <Button variant="link" size="xs" data-testid="approval-command-more" className="h-auto p-0 text-muted-foreground" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </Button>
      )}
    </div>
  )
}

function PathBox({ approval }: { approval: Extract<Approval, { kind: "guardrails.path" }> }) {
  const Icon = approval.view.target === "directory" ? Folder : File
  return (
    <div data-testid="approval-path" title={approval.view.path} className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 font-mono text-[13px] break-all">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{approval.view.path}</span>
    </div>
  )
}

/** Allow stays off for a moment after a card appears; a thin bar fills while it does. */
function useGuard(id: string): boolean {
  const [guarding, setGuarding] = useState(true)
  useEffect(() => {
    setGuarding(true)
    const timer = setTimeout(() => setGuarding(false), APPROVAL_GUARD_MS)
    return () => clearTimeout(timer)
  }, [id])
  return guarding
}

/** Enter on a focused Allow does nothing: approving takes a click, Space, or ⌘/Ctrl+Enter. */
const noEnter = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) e.preventDefault()
}

function ApprovalCard({ approval, actions, disabled, count, onShowTerminal }: { approval: Approval; actions: ChatActions; disabled: boolean; count: number; onShowTerminal: () => void }) {
  const { primary, grants, deny, stop } = approvalChoices(approval)
  const guarding = useGuard(approval.id)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [rejected, setRejected] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const locked = disabled || busy || sent !== null || closed
  const allowOff = locked || guarding

  const answer = async (option: ApprovalOption) => {
    if (locked || option.disabled) return
    setBusy(true)
    setRejected(null)
    setError(null)
    try {
      const result = await actions.answer(approval.id, { result: option.result })
      if (result.status === "delivered") setSent(option.label)
      else if (result.status === "invalid") setRejected(result.reason || "That answer was not accepted.")
      else setClosed(true)
    } catch (e) {
      setError(sentence(e))
    } finally {
      setBusy(false)
    }
  }

  // Escape denies; ⌘/Ctrl+Enter allows once. Not while the grants menu is open (Escape closes it), and not after the guard.
  const keys = useRef({ answer, primary, deny, allowOff, menuOpen })
  keys.current = { answer, primary, deny, allowOff, menuOpen }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current
      if (e.defaultPrevented || k.menuOpen || e.isComposing) return
      if (e.key === "Escape" && k.deny) {
        e.preventDefault()
        void k.answer(k.deny)
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && k.primary && !k.allowOff) {
        e.preventDefault()
        void k.answer(k.primary)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const reason = approval.view.reason
  return (
    <div className="flex flex-col gap-3" data-testid="approval-card" data-kind={approval.kind} data-guarding={guarding}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400">
          <ShieldAlert aria-hidden className="size-3.5" />
          Needs approval
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{approval.view.toolName}</span>
        {count > 1 && <span data-testid="approval-count">1 of {count}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <p data-testid="approval-question" className="text-[15px] font-semibold">
          {approvalQuestion(approval)}
        </p>
        <p data-testid="approval-reason" className="text-sm text-muted-foreground">
          Guardrails stopped it: <span className="font-medium text-foreground">{reason}</span>
        </p>
      </div>
      {approval.kind === "guardrails.path" && <PathBox approval={approval} />}
      {approval.view.command !== undefined && <CommandBlock command={approval.view.command} />}
      <div aria-hidden className={cn("-mt-1 h-0.5 overflow-hidden rounded-full bg-border", !guarding && "invisible")}>
        {guarding && <div data-testid="approval-guard" className="h-full w-full origin-left animate-[approval-guard_600ms_linear_forwards] bg-foreground/60 motion-reduce:animate-none" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        {primary && (
          <div className="inline-flex max-sm:flex">
            <Button
              data-testid="approval-allow"
              size="lg"
              className={cn("px-3.5 max-sm:h-11 max-sm:flex-1", grants.length > 0 && "rounded-e-none")}
              disabled={allowOff}
              onKeyDown={noEnter}
              onClick={() => void answer(primary)}
            >
              {primary.label}
            </Button>
            {grants.length > 0 && (
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger
                  render={<Button size="lg" aria-label="More ways to allow" data-testid="approval-more" className="rounded-s-none border-s border-s-primary-foreground/25 px-2 max-sm:h-11" disabled={allowOff} onKeyDown={noEnter} />}
                >
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-auto min-w-64 max-w-[min(28rem,calc(100vw-2rem))]">
                  {grants.map((g, i) => {
                    const detail = grantDetail(approval, g)
                    const always = g.result.endsWith("-always")
                    const before = grants[i - 1]
                    return (
                      <div key={g.result}>
                        {always && before && !before.result.endsWith("-always") && <DropdownMenuSeparator />}
                        <DropdownMenuItem data-testid="approval-grant" data-result={g.result} disabled={g.disabled === true} className="flex-col items-start gap-0 py-1.5" onClick={() => void answer(g)}>
                          <span>{g.label}</span>
                          {detail && <span className="text-xs break-all text-muted-foreground">{detail}</span>}
                        </DropdownMenuItem>
                      </div>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
        {deny && (
          <Button data-testid="approval-deny" variant="outline" size="lg" className="px-3.5 max-sm:h-11" disabled={locked} onClick={() => void answer(deny)}>
            {deny.label}
          </Button>
        )}
        {stop && (
          <Button data-testid="approval-stop" variant="link" size="sm" className="text-destructive sm:ms-auto max-sm:h-11" disabled={locked} onClick={() => void answer(stop)}>
            Deny and stop the turn
          </Button>
        )}
      </div>
      {sent && (
        <p data-testid="approval-sent" role="status" className="text-xs text-muted-foreground">
          {sent}. Waiting for pi…
        </p>
      )}
      {rejected && (
        <p data-testid="approval-rejected" role="alert" className="text-sm text-destructive">
          pi did not take that: {rejected}
        </p>
      )}
      {closed && (
        <p data-testid="approval-closed" role="alert" className="text-sm text-muted-foreground">
          {CLOSED}
        </p>
      )}
      {error && (
        <p data-testid="approval-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3 border-t pt-2.5 text-xs text-muted-foreground">
        <span className="max-sm:hidden">
          <kbd className="rounded border px-1 font-mono text-[11px]">Esc</kbd> deny · <kbd className="rounded border px-1 font-mono text-[11px]">⌘↵</kbd> allow once
        </span>
        <span className="flex-1" />
        {count > 1 && <span data-testid="approval-waiting">{count - 1} more waiting</span>}
        <Button variant="link" size="xs" data-testid="approval-open-terminal" className="h-auto p-0 text-muted-foreground" onClick={onShowTerminal}>
          Open terminal
        </Button>
      </div>
    </div>
  )
}

export interface ApprovalPanelProps {
  /** The guardrails prompts that are open, oldest first: the first is shown. */
  approvals: readonly Approval[]
  actions: ChatActions
  /** Why nothing can be sent now (disconnected, pi gone); null when it can. */
  disabledReason: string | null
  onShowTerminal: () => void
}

/** The open guardrails prompt, in the composer's place: what would run, why it was stopped, and the answers it offers. */
export function ApprovalPanel({ approvals, actions, disabledReason, onShowTerminal }: ApprovalPanelProps) {
  const approval = approvals[0]!
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3" data-testid="approval-panel" data-approval-id={approval.id} data-disabled={disabledReason !== null}>
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto rounded-2xl border border-input bg-background p-4 shadow-sm dark:bg-input/30">
        <ApprovalCard key={approval.id} approval={approval} actions={actions} disabled={disabledReason !== null} count={approvals.length} onShowTerminal={onShowTerminal} />
        {disabledReason && (
          <p role="status" data-testid="approval-disabled" className="text-xs text-muted-foreground">
            {disabledReason}
          </p>
        )}
      </div>
    </div>
  )
}
