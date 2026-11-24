"use client"

import "@xterm/xterm/css/xterm.css"
import type { Terminal as Wire } from "@herdr-web/protocol"
import type { Terminal as Xterm } from "@xterm/xterm"
import { useEffect, useRef, useState } from "react"
import { terminalSocketUrl } from "@/lib/backend"
import { jetbrainsMono } from "@/lib/fonts"
import { isDark } from "@/lib/theme"
import { describeEnd } from "@/lib/terminal/describe"
import { currentPalette, displayFacts } from "@/lib/terminal/colors"
import { TerminalLink, type LinkState } from "@/lib/terminal/link"
import { suppressFocusReports, tagReplies, type ParserHost } from "@/lib/terminal/replies"

const FONT = `${jetbrainsMono.style.fontFamily}, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`
const SCROLLBACK = 10_000

const encoder = new TextEncoder()

/** xterm's binary events (legacy mouse reports) carry one byte per char. */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function statusText(s: LinkState): string | null {
  switch (s.kind) {
    case "connecting":
      return "Connecting…"
    case "live":
      return null
    case "reconnecting":
      return s.why ? `Connection lost (${s.why}). Reconnecting…` : "Connection lost. Reconnecting…"
    case "unreachable":
      return "Cannot connect to this terminal. Still trying."
    case "ended":
      return describeEnd(s)
    case "gone":
      return `Cannot show this terminal: ${s.why}`
  }
}

/**
 * One terminal on screen: an xterm.js emulator fed from the terminal socket. Mounted for the
 * selected pane only; unmounting closes the socket, which detaches on core.
 */
export function TerminalView({ terminal }: { terminal: Wire }) {
  const address = terminal.address
  const hostRef = useRef<HTMLDivElement>(null)
  const latest = useRef(terminal)
  latest.current = terminal
  const xtermRef = useRef<Xterm | null>(null)
  const focusedRef = useRef(false)
  const [state, setState] = useState<LinkState>({ kind: "connecting" })
  const [background, setBackground] = useState<string | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []
    const host = hostRef.current
    if (!host) return

    void (async () => {
      // xterm measures its cell once on open, so the font must be loaded first; if it fails, the fallbacks render.
      const fontReady = document.fonts.load(`13px ${jetbrainsMono.style.fontFamily}`).catch(() => {})
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-unicode11"), fontReady])
      if (disposed) return

      const palette0 = currentPalette(isDark())
      setBackground(palette0.background)
      const term = new Terminal({
        allowProposedApi: true, // the unicode addon
        vtExtensions: { win32InputMode: true, kittyKeyboard: true },
        scrollback: SCROLLBACK,
        cursorBlink: true,
        fontFamily: FONT,
        fontSize: 13,
        theme: palette0,
        // no windowOptions: xterm must not answer pixel-size queries in CSS pixels behind core's back
      })
      xtermRef.current = term
      const fit = new FitAddon()
      term.loadAddon(fit)
      const unicode = new Unicode11Addon()
      term.loadAddon(unicode)
      term.unicode.activeVersion = "11"
      term.open(host)
      ;(host as HTMLDivElement & { __xterm?: Xterm }).__xterm = term // for the browser tests to read the screen

      // GPU rendering when the browser grants a context; on loss, drop to the DOM renderer for good.
      void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
        if (disposed) return
        try {
          const gl = new WebglAddon()
          gl.onContextLoss(() => gl.dispose())
          term.loadAddon(gl)
        } catch {
          // no WebGL: the DOM renderer stays
        }
      })

      const tagging = tagReplies(term as unknown as ParserHost)
      const noFocusReports = suppressFocusReports(term as unknown as ParserHost)

      const dims = () => {
        const p = fit.proposeDimensions()
        return p && Number.isFinite(p.cols) && p.cols > 0 ? { cols: p.cols, rows: p.rows } : { cols: term.cols, rows: term.rows }
      }
      const facts = () => displayFacts(currentPalette(isDark()), term.dimensions?.device.cell ?? null)

      const first = dims()
      term.resize(first.cols, first.rows)

      const link = new TerminalLink(
        {
          url: terminalSocketUrl(address),
          attach: () => {
            const d = focusedRef.current ? dims() : { cols: term.cols, rows: term.rows }
            return { ...d, history: SCROLLBACK, display: facts() }
          },
        },
        {
          onState: (s) => !disposed && setState(s),
          onAttached: ({ again }) => {
            // A new attach starts with a full paint of the screen and its history: start from a blank emulator, or the old scrollback would repeat.
            if (again) term.reset()
            link.display(facts())
            if (focusedRef.current) link.focus(true) // the focus event came before the attach

          },
          onOutput: (bytes, parsed) => term.write(bytes, parsed),
        },
      )

      const send = (data: string) => {
        const bytes = encoder.encode(data)
        if (tagging.isAutomatic()) link.sendAutomatic(bytes)
        else link.sendInput(bytes)
      }
      const onData = term.onData(send)
      const onBinary = term.onBinary((data) => link.sendInput(latin1(data)))

      // The shown pane follows its box, focused or not: a layout change in this window is its user acting, so it
      // takes the size (two windows on one terminal settle on whichever acted last). Nothing is sent while the tab is hidden.
      const onResize = term.onResize(({ cols, rows }) => {
        if (!document.hidden) link.resize(cols, rows)
      })
      let frame = 0
      const refit = () => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (disposed || document.hidden) return
          const d = dims()
          if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows)
        })
      }
      const observer = new ResizeObserver(refit)
      observer.observe(host)
      document.addEventListener("visibilitychange", refit) // the box may have changed while the tab was hidden

      const textarea = term.textarea
      const onFocus = () => {
        focusedRef.current = true
        const d = dims()
        if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows)
        link.resize(term.cols, term.rows)
        link.focus(true)
      }
      const onBlur = () => {
        focusedRef.current = false
        link.focus(false)
      }
      textarea?.addEventListener("focus", onFocus)
      textarea?.addEventListener("blur", onBlur)

      // Copy with Ctrl+Shift+C where Ctrl+C is the interrupt key.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "KeyC" && term.hasSelection()) {
          void navigator.clipboard?.writeText(term.getSelection())
          return false
        }
        return true
      })

      // Follow the page's theme live.
      const retheme = () => {
        const palette = currentPalette(isDark())
        term.options.theme = palette
        setBackground(palette.background)
        link.display(facts())
      }
      const themeObserver = new MutationObserver(retheme)
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

      link.start()
      term.focus()

      cleanups.push(() => {
        cancelAnimationFrame(frame)
        observer.disconnect()
        document.removeEventListener("visibilitychange", refit)
        themeObserver.disconnect()
        textarea?.removeEventListener("focus", onFocus)
        textarea?.removeEventListener("blur", onBlur)
        onData.dispose()
        onBinary.dispose()
        onResize.dispose()
        noFocusReports.dispose()
        tagging.dispose()
        link.stop()
        xtermRef.current = null
        term.dispose()
      })
    })()

    return () => {
      disposed = true
      for (const c of cleanups.reverse()) c()
    }
  }, [address])

  const text = statusText(state)
  // The padding is on the view, not on the host: the fit addon takes the host's whole height as the room for rows and does
  // not subtract the host's own padding, so a padded host got rows that ran past its bottom edge.
  return (
    <div data-testid="terminal-view" data-address={address} data-state={state.kind} className="relative flex min-h-0 flex-1 flex-col p-2" style={{ backgroundColor: background }}>
      <div ref={hostRef} data-testid="terminal-host" className="min-h-0 flex-1 overflow-hidden" />
      {text && (
        <div
          data-testid="terminal-status"
          data-state={state.kind}
          role="status"
          className="pointer-events-none absolute right-3 top-3 max-w-[80%] rounded-md border bg-background/95 px-3 py-1.5 text-xs text-foreground shadow-sm"
        >
          {text}
        </div>
      )}
    </div>
  )
}
