"use client"

import { useEffect, useMemo, useState } from "react"
import { MessageSquare, Terminal as TerminalIcon, X } from "lucide-react"
import type { Terminal } from "@herdr-web/protocol"
import { Button } from "@/components/ui/button"
import { ChatView } from "@/components/chat/chat-view"
import { TerminalView } from "@/components/terminal/terminal-view"
import { chatActions } from "@/lib/chat/api"
import { awayReason, HINT_KEY, initialView, PI_GONE, readView, wantsChatHint, writeView, type View } from "@/lib/chat/pane"
import { useChat } from "@/lib/live-context"
import { cn } from "@/lib/utils"

/** Chat or Terminal. */
function ViewToggle({ view, onChoose }: { view: View; onChoose: (view: View) => void }) {
  const item = (value: View, label: string, Icon: typeof MessageSquare) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === value}
      data-testid={`view-${value}`}
      onClick={() => onChoose(value)}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        view === value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3" /> {label}
    </button>
  )
  return (
    <div role="tablist" aria-label="View" data-testid="view-toggle" className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {item("chat", "Chat", MessageSquare)}
      {item("terminal", "Terminal", TerminalIcon)}
    </div>
  )
}

/** The one quiet line above the terminal of a pi that has no chat: what to do, and where it is written. Dismissed for good, per browser. */
function ChatHint() {
  const [dismissed, setDismissed] = useState<boolean | null>(null) // null until localStorage was read, so a dismissed hint never flashes
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(HINT_KEY) === "1")
    } catch {
      setDismissed(false)
    }
  }, [])
  if (dismissed !== false) return null
  return (
    <div data-testid="extension-hint" role="note" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Chat needs pi-ask-user with pi-live 0.2 or later. Install or update it; see “Trying chat” in the README.</span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        data-testid="extension-hint-dismiss"
        onClick={() => {
          setDismissed(true)
          try {
            localStorage.setItem(HINT_KEY, "1")
          } catch {
            // blocked: dismissed for this page only
          }
        }}
      >
        <X />
      </Button>
    </div>
  )
}

function ChatSide({ terminal, away, onShowTerminal }: { terminal: Terminal; away: "backend" | "core" | null; onShowTerminal: () => void }) {
  const entry = useChat(terminal.address, true)
  const actions = useMemo(() => chatActions(terminal.address), [terminal.address])
  const gone = entry.phase === "unavailable"
  if (!entry.store) {
    return (
      <div data-testid="chat-waiting" data-phase={entry.phase} className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p>{gone ? (entry.reason ?? PI_GONE) : "Loading the conversation…"}</p>
        {gone && (
          <Button variant="outline" size="sm" onClick={onShowTerminal}>
            <TerminalIcon /> Show terminal
          </Button>
        )}
      </div>
    )
  }
  const reason = awayReason(away) ?? (gone ? PI_GONE : null)
  return (
    <div data-testid="chat-side" data-stale={gone || away !== null} className={cn("flex min-h-0 flex-1 flex-col", gone && "opacity-70")}>
      <ChatView store={entry.store} actions={actions} disabledReason={reason} draftKey={terminal.address} onShowTerminal={onShowTerminal} />
    </div>
  )
}

/**
 * What one terminal's pane shows: its chat or its terminal. Only the one shown is live: the chat is subscribed while Chat is
 * shown and the terminal socket is open while Terminal is shown. A terminal with no chat shows the terminal and no toggle.
 */
export function PaneView({ terminal, away }: { terminal: Terminal; away: "backend" | "core" | null }) {
  const address = terminal.address
  // Whether this pane has held a chat since it was opened: when the agent goes away the chat stays on screen, stale, and Terminal still works.
  const [hadChat, setHadChat] = useState(terminal.chat)
  if (terminal.chat && !hadChat) setHadChat(true)
  // A pane that opened without chat stays on the terminal when chat appears; one that opens with chat starts on Chat (or the reader's earlier choice).
  const [view, setView] = useState<View>(() => initialView(terminal.chat, readView(address)))
  const toggle = hadChat && terminal.state === "live"
  const shown: View = toggle ? view : "terminal"
  const choose = (next: View) => {
    setView(next)
    writeView(address, next)
  }
  return (
    <div data-testid="pane-view" data-view={shown} className="flex min-h-0 flex-1 flex-col gap-2">
      {(toggle || wantsChatHint(terminal)) && (
        <div className="flex min-h-6 shrink-0 items-center justify-between gap-2 px-2">
          {toggle ? <ViewToggle view={shown} onChoose={choose} /> : <ChatHint />}
        </div>
      )}
      {shown === "chat" ? <ChatSide terminal={terminal} away={away} onShowTerminal={() => setView("terminal")} /> : <TerminalView terminal={terminal} />}
    </div>
  )
}
