"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowUp, Square, Terminal } from "lucide-react"
import type { Capabilities, Live } from "@herdr-web/agents/rows"
import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { sentence, type ChatActions } from "@/lib/chat/actions"
import { capitalise, formatTokens, parseSlash } from "@/lib/chat/format"

/** Drafts live in memory only, per agent, so moving between panes does not lose what was typed. */
const drafts = new Map<string, string>()
export const clearDrafts = () => drafts.clear()

const MAX_LINES = 8

/** The small ring at the right of the composer; the numbers show on hover. */
export function UsageRing({ usage }: { usage: NonNullable<Live["usage"]> }) {
  const percent = usage.percent ?? (usage.tokens !== null ? (usage.tokens / usage.window) * 100 : null)
  if (percent === null) return null
  const clamped = Math.min(100, Math.max(0, percent))
  const r = 7
  const c = 2 * Math.PI * r
  const used = usage.tokens !== null ? `${formatTokens(usage.tokens)} of ${formatTokens(usage.window)} tokens` : `window ${formatTokens(usage.window)} tokens`
  const text = `Context ${Math.round(clamped)}% · ${used}`
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <span data-testid="usage" data-percent={Math.round(clamped)} role="img" aria-label={text} className="flex items-center gap-1 px-1">
            <svg viewBox="0 0 20 20" className="size-4 -rotate-90">
              <circle cx="10" cy="10" r={r} fill="none" strokeWidth="3" className="stroke-foreground/15" />
              <circle cx="10" cy="10" r={r} fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - clamped / 100)} className={clamped >= 90 ? "stroke-destructive" : "stroke-foreground/60"} />
            </svg>
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{Math.round(clamped)}%</span>
          </span>
        }
      />
      <HoverCardContent side="top" className="w-auto text-xs" data-testid="usage-card">
        {text}
      </HoverCardContent>
    </HoverCard>
  )
}

interface ChooserProps {
  label: string
  testId: string
  items: { value: string; label: string }[]
  current: string | null
  onChoose: (value: string) => Promise<void>
  onError: (message: string | null) => void
  disabled: boolean
}

/** A selector whose change shows at once and is put back, with the error, when it fails. */
function Chooser({ label, testId, items, current, onChoose, onError, disabled }: ChooserProps) {
  const [chosen, setChosen] = useState<string | null>(null)
  // What the agent reports takes over again as soon as it differs from what was chosen
  useEffect(() => {
    if (chosen !== null && current === chosen) setChosen(null)
  }, [current, chosen])
  const shown = chosen ?? current
  return (
    <Select
      value={shown}
      items={items}
      disabled={disabled}
      onValueChange={(value) => {
        if (typeof value !== "string" || value === shown) return
        const before = chosen
        setChosen(value)
        onError(null)
        onChoose(value).catch((e) => {
          setChosen(before)
          onError(sentence(e))
        })
      }}
    >
      <SelectTrigger size="sm" aria-label={label} data-testid={testId} className="h-7 max-w-52 border-0 bg-transparent px-2 text-xs text-foreground/70 shadow-none hover:bg-muted hover:text-foreground disabled:text-muted-foreground">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="min-w-48">
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value} data-testid={`${testId}-option`}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export interface ComposerProps {
  actions: ChatActions
  capabilities: Capabilities
  live: Live
  /** Why nothing can be sent now (disconnected, the extension gone); null when it can. */
  disabledReason: string | null
  /** The agent this composer is for: its draft is kept under it. */
  draftKey: string
  /** Switch the pane to the terminal view. */
  onShowTerminal: () => void
}

export function Composer({ actions, capabilities, live, disabledReason, draftKey, onShowTerminal }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectorError, setSelectorError] = useState<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const sendingRef = useRef(false)

  const reason = disabledReason ?? (capabilities.send ? null : "This agent cannot take messages.")
  const disabled = reason !== null

  useEffect(() => {
    drafts.set(draftKey, text)
  }, [draftKey, text])

  // Grows with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20
    const limit = line * MAX_LINES
    el.style.height = `${Math.min(el.scrollHeight, limit)}px`
    el.style.overflowY = el.scrollHeight > limit ? "auto" : "hidden"
  }, [text])

  const submit = async () => {
    const message = text.trim()
    if (!message || disabled || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    const slash = parseSlash(message)
    // The backend's answer to a command comes when core has typed it and pi has taken it up, a few seconds on: the note is there from the start.
    setTyped(slash ? message : null)
    try {
      await actions.send(message)
      setText("")
      if (slash?.opensPicker) onShowTerminal()
    } catch (e) {
      setTyped(null)
      setError(sentence(e)) // the text stays
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await actions.stop()
    } catch (e) {
      setError(sentence(e))
    } finally {
      setStopping(false)
    }
  }

  const models = capabilities.models
  const efforts = capabilities.efforts && capabilities.efforts.list.length > 1 ? capabilities.efforts : null
  const shownError = error ?? selectorError
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3" data-testid="composer" data-disabled={disabled}>
      {reason && (
        <div role="status" data-testid="composer-disabled" className="sr-only">
          {reason}
        </div>
      )}
      {typed && (
        <div data-testid="typed-note" className="flex items-center gap-2 pb-1 text-xs text-muted-foreground">
          <span>Typed into the terminal. pi runs it a few seconds after it is typed.</span>
          <Button variant="link" size="xs" data-testid="show-terminal" onClick={onShowTerminal}>
            <Terminal /> Show terminal
          </Button>
        </div>
      )}
      <InputGroup className="rounded-2xl has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <InputGroupTextarea
          ref={area}
          data-testid="composer-input"
          aria-label="Message"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={reason ?? (live.working ? "Steer the agent…" : "Message the agent…")}
          className="min-h-10 resize-none text-[15px] leading-[1.6]"
          onChange={(e) => {
            setText(e.target.value)
            if (typed) setTyped(null)
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return
            // An input method still composing (Enter picks a candidate) is never a send.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            e.preventDefault()
            void submit()
          }}
        />
        <InputGroupAddon align="block-end" className="gap-1">
          {models && models.list.length > 0 && (
            <Chooser label="Model" testId="model-select" items={models.list.map((m) => ({ value: m.id, label: m.name }))} current={models.current} onChoose={actions.setModel} onError={setSelectorError} disabled={disabled} />
          )}
          {efforts && <Chooser label="Effort" testId="effort-select" items={efforts.list.map((l) => ({ value: l, label: capitalise(l) }))} current={efforts.current} onChoose={actions.setEffort} onError={setSelectorError} disabled={disabled} />}
          <span className="flex-1" />
          {live.usage && <UsageRing usage={live.usage} />}
          {/* While working with nothing typed, Stop alone; with a draft Send steers and stays, Stop beside it; idle, Send alone. */}
          {live.working && capabilities.stop && (
            <Button variant="outline" size="icon-sm" aria-label="Stop" data-testid="stop" disabled={stopping || disabledReason !== null} onClick={() => void stop()}>
              <Square className="fill-current" />
            </Button>
          )}
          {!(live.working && text.trim() === "") && (
            <Button size="icon-sm" aria-label="Send" data-testid="send" disabled={disabled || sending || text.trim() === ""} onClick={() => void submit()}>
              <ArrowUp />
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
      {shownError && (
        <p role="alert" data-testid="composer-error" className="pt-1 text-xs text-destructive">
          {shownError}
        </p>
      )}
    </div>
  )
}
