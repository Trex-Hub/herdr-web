"use client"

import { useEffect, useReducer, useRef, useState } from "react"
import { Square } from "lucide-react"
import type { Ask, Capabilities } from "@herdr-web/agents/rows"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire"
import { sentence, type ChatActions } from "@/lib/chat/actions"
import { batchAnswer, emptyDraft, responseFor, type AskDraft } from "@/lib/chat/asks"
import { Markdown } from "./markdown"

// The options are one bordered list with hairlines between the rows, as in the reference; a single choice has no dot.
const CHOICES = "gap-0 overflow-hidden rounded-lg border border-input"
const CHOICE = "min-h-11 rounded-none border-0 border-b border-b-border bg-transparent last:border-b-0 has-[>input:focus-visible]:ring-inset data-checked:border-0 data-checked:border-b data-checked:border-b-border dark:bg-transparent"
const NO_DOT = "data-[type=radio]:**:data-[slot=questionnaire-choice-indicator]:hidden"
const INPUT_ROW = "min-h-11 rounded-none border-0 bg-transparent px-3 pe-11 focus-visible:ring-inset dark:bg-transparent"
const BADGE = "pointer-events-none absolute end-3 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md border border-input bg-background font-mono text-[0.625rem] leading-none font-medium text-muted-foreground"

/** Where a long context is cut until the reader asks for the rest. */
const CONTEXT_LINES = 6

const CLOSED = "This question was already answered or closed."

type QuestionView = Extract<Ask, { kind: "ask_user.question" }>["view"]
type BatchQuestion = Extract<Ask, { kind: "ask_user.batch" }>["view"]["questions"][number]

/** A question's context as markdown, cut after a few lines with a way to open it. */
function AskContext({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.split("\n").length > CONTEXT_LINES
  return (
    <div data-testid="ask-context" data-collapsed={long && !open} className="flex flex-col items-start gap-1 text-sm">
      <div className={long && !open ? "max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]" : undefined}>
        <Markdown text={text} className="text-sm leading-normal [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:text-sm" />
      </div>
      {long && (
        <Button type="button" variant="link" size="xs" data-testid="ask-context-toggle" className="h-auto p-0" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  )
}

/** After a pick in a batch: on to the next question, or, on the last, to Submit (which the reader presses). */
function advance(form: HTMLFormElement | null): void {
  if (!form) return
  const next = form.querySelector<HTMLElement>("[data-slot=questionnaire-next]:not([hidden])")
  if (next) next.click()
  else form.querySelector<HTMLElement>("[data-slot=questionnaire-submit]:not([hidden])")?.focus()
}

/** The enter key in the comment line goes on, as it does in the options: to the next question, or sends. */
function goOn(form: HTMLFormElement | null): void {
  form?.querySelector<HTMLElement>("[data-slot=questionnaire-next]:not([hidden]), [data-slot=questionnaire-submit]:not([hidden])")?.click()
}

/** One open prompt: a question or a batch, answered through the shadcn Questionnaire. */
function AskForm({ ask, actions, disabled }: { ask: Ask; actions: ChatActions; disabled: boolean }) {
  const batch = ask.kind === "ask_user.batch"
  const questions: Array<QuestionView | BatchQuestion> = ask.kind === "ask_user.batch" ? ask.view.questions : [ask.view]
  const allowComment = ask.view.allowComment
  // What the reader has put in lives in a ref as well as drawing: a submit that follows a click in the same tick (Skip on the last question) must see it.
  const model = useRef({ drafts: questions.map(emptyDraft) as AskDraft[], skipped: new Set<number>() })
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [index, setIndex] = useState(0) // the question shown, for Skip
  const [rejected, setRejected] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const busy = useRef(false)
  const arrow = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  // A single question whose pick sends has nothing to press: no buttons, no empty row.
  const submit = batch || questions[0]!.allowMultiple || allowComment || questions[0]!.allowFreeform || questions[0]!.options.length === 0
  const locked = disabled || sent || closed || busy.current

  useEffect(() => {
    form.current?.querySelector<HTMLElement>("fieldset:not([hidden])")?.focus({ preventScroll: true })
  }, [])

  const change = (at: number, edit: (draft: AskDraft) => AskDraft) => {
    model.current.drafts[at] = edit(model.current.drafts[at]!)
    model.current.skipped.delete(at)
    setRejected(null)
    setError(null)
    redraw()
  }

  const send = async (body: Record<string, unknown>) => {
    if (busy.current || sent || closed) return
    busy.current = true
    setRejected(null)
    setError(null)
    redraw()
    try {
      const result = await actions.answer(ask.id, body)
      if (result.status === "delivered") setSent(true)
      else if (result.status === "invalid") setRejected(result.reason || "That answer was not accepted.")
      else setClosed(true)
    } catch (e) {
      setError(sentence(e))
    } finally {
      busy.current = false
      redraw()
    }
  }

  const pick = (at: number, q: QuestionView | BatchQuestion, title: string, checked: boolean) => {
    const next = (d: AskDraft): AskDraft => ({ ...d, text: "", selected: q.allowMultiple ? (checked ? [...d.selected.filter((t) => t !== title), title] : d.selected.filter((t) => t !== title)) : checked ? [title] : [] })
    change(at, next)
    // One question, one choice, nothing to add: picking is answering. An arrow key only moves along the options; Enter then sends.
    if (!batch && !q.allowMultiple && !allowComment && checked && !arrow.current) void send(responseFor(next(model.current.drafts[at]!), q.options))
    // In a batch a single choice (with no comment to add) moves on: after the library has taken the pick, so Next sees the question answered.
    else if (batch && !q.allowMultiple && !allowComment && checked && !arrow.current) setTimeout(() => advance(form.current), 0)
  }

  return (
    <Questionnaire
      ref={form}
      data-testid="ask-form"
      shortcuts="numbers"
      defaultItem="q0"
      onItemChange={(name) => setIndex(Number(name.slice(1)))}
      onKeyDownCapture={(e) => {
        arrow.current = e.key === "ArrowUp" || e.key === "ArrowDown"
        // The number after the last option is the text row: the library numbers only the options.
        const q = questions[index]!
        if ((q.allowFreeform || q.options.length === 0) && e.key === String(q.options.length + 1) && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement && e.target.type === "text")) {
          e.preventDefault()
          e.currentTarget.querySelector<HTMLInputElement>("fieldset:not([hidden]) input[type=text]")?.focus()
        }
      }}
      onKeyUpCapture={() => {
        arrow.current = false
      }}
      onSubmit={(e) => {
        e.preventDefault()
        const { drafts, skipped } = model.current
        void send(ask.kind === "ask_user.batch" ? batchAnswer(ask, drafts, skipped) : { ...responseFor(drafts[0]!, questions[0]!.options) })
      }}
    >
      {questions.map((q, i) => {
        const draft = model.current.drafts[i]!
        const freeform = q.allowFreeform || q.options.length === 0
        return (
          <QuestionnaireItem key={i} name={`q${i}`} multiple={q.allowMultiple} required={!batch} invalid={rejected !== null && i === index} data-testid="ask-item" className="gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                {batch && ask.kind === "ask_user.batch" && ask.view.heading && i === 0 && <span className="text-xs text-muted-foreground">{ask.view.heading}</span>}
                <QuestionnaireTitle className="!mb-0 text-base font-medium">{q.question}</QuestionnaireTitle>
              </div>
              {batch && (
                <QuestionnaireProgress data-testid="ask-progress" className="min-w-0 shrink-0 text-right">
                  {i + 1}/{questions.length}
                </QuestionnaireProgress>
              )}
            </div>
            {q.context && <AskContext text={q.context} />}
            <QuestionnaireChoices className={CHOICES}>
              {q.options.map((o) => (
                <QuestionnaireChoice key={o.title} className={q.allowMultiple ? CHOICE : `${CHOICE} ${NO_DOT}`} value={o.title} checked={draft.selected.includes(o.title)} disabled={locked} onChange={(e) => pick(i, q, o.title, e.target.checked)}>
                  {o.title}
                  {o.description && <QuestionnaireChoiceDescription>{o.description}</QuestionnaireChoiceDescription>}
                </QuestionnaireChoice>
              ))}
              {freeform && (
                <div className="relative">
                  <QuestionnaireInput
                    aria-label="Type something else"
                    placeholder="Type something else…"
                    className={INPUT_ROW}
                    value={draft.text}
                    disabled={locked}
                    onChange={(e) => change(i, (d) => ({ ...d, text: e.target.value, selected: e.target.value.trim() === "" ? d.selected : [] }))}
                  />
                  {q.options.length < 9 && <span aria-hidden data-testid="ask-input-number" className={BADGE}>{q.options.length + 1}</span>}
                </div>
              )}
            </QuestionnaireChoices>
            {allowComment && (
              <Input
                aria-label="Comment"
                data-testid="ask-comment"
                placeholder="Add a comment (optional)"
                value={draft.comment}
                disabled={locked}
                onChange={(e) => change(i, (d) => ({ ...d, comment: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return
                  e.preventDefault()
                  goOn(e.currentTarget.form)
                }}
              />
            )}
            <QuestionnaireError data-testid="ask-rejected">{rejected ?? undefined}</QuestionnaireError>
          </QuestionnaireItem>
        )
      })}
      {submit && (
      <QuestionnaireActions>
        <QuestionnairePrevious disabled={locked} />
        {batch && (
          <QuestionnaireSkip
            disabled={locked}
            onClick={() => {
              model.current.drafts[index] = emptyDraft()
              model.current.skipped.add(index)
              setRejected(null)
              redraw()
            }}
          />
        )}
        <QuestionnaireNext disabled={locked} />
        <QuestionnaireSubmit disabled={locked} />
      </QuestionnaireActions>
      )}
      {sent && (
        <p data-testid="ask-sent" role="status" className="text-xs text-muted-foreground">
          Sent. Waiting for the agent…
        </p>
      )}
      {closed && (
        <p data-testid="ask-closed" role="alert" className="text-sm text-muted-foreground">
          {CLOSED}
        </p>
      )}
      {error && (
        <p data-testid="ask-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </Questionnaire>
  )
}

export interface AskPanelProps {
  /** The prompts that are open, oldest first: the first is shown. */
  asks: readonly Ask[]
  actions: ChatActions
  capabilities: Capabilities
  /** Why nothing can be sent now (disconnected, pi gone); null when it can. */
  disabledReason: string | null
}

/** The open prompt, in the composer's place: the question, its options, and Stop. */
export function AskPanel({ asks, actions, capabilities, disabledReason }: AskPanelProps) {
  const ask = asks[0]!
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const stop = async () => {
    setStopping(true)
    setStopError(null)
    try {
      await actions.stop()
    } catch (e) {
      setStopError(sentence(e))
    } finally {
      setStopping(false)
    }
  }
  const waiting = asks.length - 1
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3" data-testid="ask-panel" data-ask-id={ask.id} data-disabled={disabledReason !== null}>
      <div className="flex flex-col gap-3 rounded-2xl border border-input bg-background p-4 dark:bg-input/30">
        <AskForm key={ask.id} ask={ask} actions={actions} disabled={disabledReason !== null} />
        {disabledReason && (
          <p role="status" data-testid="ask-disabled" className="text-xs text-muted-foreground">
            {disabledReason}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <span data-testid="ask-waiting" className="text-xs text-muted-foreground">
            {waiting > 0 ? `${waiting} more ${waiting === 1 ? "question" : "questions"} waiting` : ""}
          </span>
          {capabilities.stop && (
            <Button type="button" variant="outline" size="icon-sm" aria-label="Stop" data-testid="stop" disabled={stopping || disabledReason !== null} onClick={() => void stop()}>
              <Square className="fill-current" />
            </Button>
          )}
        </div>
        {stopError && (
          <p role="alert" data-testid="ask-stop-error" className="text-xs text-destructive">
            {stopError}
          </p>
        )}
      </div>
    </div>
  )
}
