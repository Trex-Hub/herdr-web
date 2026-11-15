"use client"

import type { PendingMessage } from "@herdr-web/agents/rows"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import type { ChatActions } from "@/lib/chat/actions"
import type { ThreadStore } from "@/lib/chat/thread-store"
import { useThread } from "@/lib/chat/use-thread"
import { Composer } from "./composer"
import { ThreadView } from "./thread-view"

/** Messages sent while the agent works that it has not taken yet, just above the composer. */
export function PendingList({ pending }: { pending: PendingMessage[] }) {
  if (pending.length === 0) return null
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-end gap-1.5 px-4 pb-2" data-testid="pending">
      {pending.map((p) => (
        <div key={p.id} data-testid="pending-message" data-mode={p.mode} className="flex max-w-[80%] flex-col items-end gap-0.5">
          <Bubble variant="secondary" align="end" className="max-w-full opacity-70">
            <BubbleContent className="whitespace-pre-wrap">{p.text}</BubbleContent>
          </Bubble>
          <span className="px-1 text-xs text-muted-foreground">{p.mode === "steer" ? "Pending: taken after the current step" : "Pending: sent when the agent is done"}</span>
        </div>
      ))}
    </div>
  )
}

function EmptyThread({ name, folder }: { name: string; folder: string | null }) {
  return (
    <div data-testid="empty-thread" className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-base font-medium">{name}</p>
      {folder && <p className="font-mono text-xs text-muted-foreground">{folder}</p>}
    </div>
  )
}

export interface ChatViewProps {
  store: ThreadStore
  actions: ChatActions
  /** Why the composer is off (backend or core away, extension gone); null when it works. */
  disabledReason: string | null
  /** The agent's draft is kept under this. */
  draftKey: string
  onShowTerminal: () => void
}

/** The thread, what is waiting to be taken, and the composer. */
export function ChatView({ store, actions, disabledReason, draftKey, onShowTerminal }: ChatViewProps) {
  const identity = useThread(store, (s) => s.identity)
  const empty = useThread(store, (s) => s.rows.length === 0 && s.live.reply === null && !s.live.working)
  const live = useThread(store, (s) => s.live)
  const capabilities = useThread(store, (s) => s.capabilities)
  return (
    <div data-testid="chat" className="flex min-h-0 flex-1 flex-col">
      {empty ? <EmptyThread name={identity.title ?? identity.terminalId} folder={identity.cwd} /> : <ThreadView store={store} actions={actions} />}
      <PendingList pending={live.pending} />
      <Composer actions={actions} capabilities={capabilities} live={live} disabledReason={disabledReason} draftKey={draftKey} onShowTerminal={onShowTerminal} />
    </div>
  )
}
