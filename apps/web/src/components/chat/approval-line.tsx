"use client"

import { ShieldAlert, ShieldCheck, ShieldMinus, ShieldX } from "lucide-react"
import type { Approval } from "@herdr-web/agents/rows"
import { approvalLineFromKey, approvalLineKey, approvalLineText, type ApprovalLine } from "@/lib/chat/approvals"
import { cn } from "@/lib/utils"
import { useThreadValue } from "./tools/context"

const TONE = {
  waiting: { Icon: ShieldAlert, className: "text-amber-700 dark:text-amber-400" },
  allowed: { Icon: ShieldCheck, className: "text-muted-foreground" },
  denied: { Icon: ShieldX, className: "text-destructive" },
  muted: { Icon: ShieldMinus, className: "text-muted-foreground" },
} as const

/** One short line: what guardrails asked about a call and how it ended. */
export function ApprovalLineView({ line, subject }: { line: ApprovalLine; subject?: string }) {
  const { text, tone } = approvalLineText(line)
  const { Icon, className } = TONE[tone]
  return (
    <p data-testid="approval-line" data-tone={tone} role={tone === "waiting" ? "status" : undefined} className={cn("flex min-w-0 items-center gap-1.5 ps-0.5 text-xs", className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{text}</span>
      {subject && <span className="min-w-0 truncate font-mono text-foreground/70">· {subject}</span>}
    </p>
  )
}

/** A tool row or live tool, and under it the line of a guardrails prompt about its call, when there is one. */
export function WithApprovalLine({ callId, children }: { callId: string; children: React.ReactNode }) {
  const key = useThreadValue((s) => approvalLineKey(s.live, callId), "")
  const line = approvalLineFromKey(key)
  if (!line) return <>{children}</>
  return (
    <div className="flex flex-col gap-1" data-testid="with-approval">
      {children}
      <ApprovalLineView line={line} />
    </div>
  )
}

/** The open prompts no call can be found for (a guardrails without `toolCallId`): their line goes at the end of the thread. */
export function UnpinnedApprovalLines({ approvals }: { approvals: readonly Approval[] }) {
  return approvals.map((a) => <ApprovalLineView key={a.id} line={{ kind: "open", id: a.id }} subject={a.kind === "guardrails.command" ? a.view.command.split("\n")[0] : a.view.displayPath} />)
}
