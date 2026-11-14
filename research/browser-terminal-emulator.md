# Browser terminal emulator for herdr-core attach streams (DEV-9)

## Answer

Use **xterm.js 6.0.0** (`@xterm/xterm` + `addon-fit`, `addon-webgl`, `addon-unicode11`,
`addon-image`, optionally `addon-serialize`) as the renderer, with the bridge owning every
byte that is not a human keystroke.

It is the only candidate that already encodes **win32-input-mode (DECSET 9001)** and the
**kitty keyboard protocol** (flags, push/pop, per-screen stacks) — the two things core's
attach stream explicitly delegates to the viewer (`/tmp/hcore/schema/README.md:62-77`).
ghostty-web is a closer VT engine but has neither, cannot report cell pixels, and merges
query replies into `onData`; restty merges replies into the PTY channel by design.

xterm.js still leaves real gaps — automatic-reply tagging, mode 2048, XTGETTCAP, OSC 7501
status display, kitty-image acks — all listed under **Gaps** below.

## Evidence

### What the attach stream actually demands

- Framed kinds: `0 DATA`, `1 CREDIT`, `2 CLOSE`, `3 RESIZE (u16 cols, u16 rows)`, `4 FOCUS`,
  `5 FACTS`, `6 AUTOMATIC_INPUT` (`/tmp/hcore/schema/README.md:45-60`).
- First paint = "the current screen, optional history, the latest status report and title, and
  `CSI ?9001h` or `l`" (`/tmp/hcore/schema/README.md:62-67`); implemented as `0x18`
  (CAN) + paint + `?9001h|l` + replayed OSC 7501 in `/tmp/hcore/crates/herdr-core/src/viewers.rs:496-512`.
  CAN is legal "abort sequence" to xterm.js (`src/common/parser/EscapeSequenceParser.ts:121`
  maps `0x18` to EXECUTE in ground), so history-then-screen is safe to feed straight to `write()`.
- "The core never encodes keys: a viewer that honors 9001 sends key events in that format
  itself" (`schema/README.md:67-69`).
- "Automatic query answers (including mode 2048 reports, kitty graphics and XTGETTCAP replies)
  use AUTOMATIC_INPUT, not DATA … **Tag replies at their source, never by inspecting their
  bytes**" (`schema/README.md:73-77`). Requires `hello.features` + attach `automatic_input: true`.
- Core strips only what its own ghostty screen answered — DA1, OSC 11, DSR — and deliberately
  leaves XTGETTCAP, kitty-graphics APCs and **in-band resize** to the viewer
  (`/tmp/hcore/crates/herdr-core/src/relay.rs:56-60,244-259,288-300`).
- Reference viewer behaviour (herdr-app): on DATA → `vt.write(bytes)` + `core.credit(len)` +
  `take_replies()` → `core.automatic_input(ch, &replies)` (`/tmp/happ/src/terminal.rs:536-545`);
  on resize → `core.resize` then the same `automatic_input` path (`terminal.rs:228-237`);
  FACTS in **device** pixels, only on change (`terminal.rs:188-200`).

### xterm.js 6.0.0 (recommended)

- Version/licence/maintenance: `6.0.0`, MIT, published 2026-11-08 (beta `6.1.0-beta.337`);
  repo `xtermjs/xterm.js` 21.3k★, last push 2026-11-08, not archived (npm metadata; `gh api
  repos/xtermjs/xterm.js`). Addons on the same date: webgl 0.19.0, fit 0.11.0, unicode11 0.9.0,
  image 0.9.0, serialize 0.14.0 (experimental), program-status 0.1.0.
- Key encoding: `vtExtensions.win32InputMode` gates DECSET/DECRST 9001 and DECRQM
  (`src/common/InputHandler.ts:2044-2046,2294-2296,2394`), encoding in
  `src/common/input/Win32InputMode.ts:1-40` (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`); `vtExtensions.kittyKeyboard`
  gates `CSI =|?|>|< u` with per-buffer push/pop stacks of 16
  (`src/common/InputHandler.ts:259-262,3576-3632`), encoding in `src/common/input/Keyboard.ts`
  / `KittyKeyboard.ts`. Precedence: win32 first, then kitty, then legacy
  (`src/browser/services/KeyboardService.ts:35-49`). **Both default to false** — the client must
  set `vtExtensions: { win32InputMode: true, kittyKeyboard: true }` because core's first paint
  may switch 9001 on before any keystroke.
- Reply plumbing: a **single** `onData` for everything. `CoreService.triggerDataEvent(data,
  wasUserInput=false)` fires `_onData` always and `onUserInput` (void) only for real keys
  (`src/common/services/CoreService.ts:74-104`). Automatic replies all take that path: DA1
  `InputHandler.ts:1712-1714`, DSR `2748-2769`, XTVERSION `1776`, kitty flags query `3584`,
  OSC 4/10/11/12 colour reports (`src/browser/CoreBrowserTerminal.ts:211-240`), CSI 14t/16t
  window reports (`CoreBrowserTerminal.ts:1141-1159`), focus `\x1b[I`/`\x1b[O`
  (`CoreBrowserTerminal.ts:305-310,1127-1141`), kitty graphics ack via
  `addons/addon-image/src/kitty/KittyGraphicsHandler.ts:540-541`. Mouse reports are
  `triggerDataEvent(..., true)` or `triggerBinaryEvent` (`src/browser/services/MouseService.ts:538-543`) —
  so mouse stays human input, which is what we want.
- But the parser is public and pre-emptable: `terminal.parser` is on the stable surface
  (`src/browser/public/Terminal.ts:87-89`, no `allowProposedApi` check; typings
  `typings/xterm.d.ts:1953-2030`), and dispatch runs **most recently registered first**
  (`src/common/parser/EscapeSequenceParser.ts:717-730` CSI, `:150-170` OSC, DcsParser
  `src/common/parser/DcsParser.ts:95-125`). A bridge-side module can register handlers for
  `CSI c / > c / n / t / ? u`, `DCS $q +q`, `OSC 4/10/11/12`, `APC G`, emit those replies on the
  AUTOMATIC_INPUT path and return `true` to stop the built-in ones — this is the mechanism the
  recommendation depends on.
- Resize: `resize(cols, rows)` + `onResize` (`typings/xterm.d.ts:1107,1163`); `addon-fit`
  measures the container; `dimensions` exposes CSS and **device** canvas/cell sizes
  (`typings/xterm.d.ts:2154-2177`), which is exactly the FACTS `cell` field.
- Flow control: `write(data, callback)` calls back when the chunk is parsed
  (`typings/xterm.d.ts:1373-1381`), plus `onWriteParsed` (`src/browser/public/Terminal.ts:82`) —
  a directly usable CREDIT trigger; the internal buffer discards only past 50 MB
  (`src/common/input/WriteBuffer.ts:20,155`), far above core's 256 KiB window.
- Graphics: sixel (DCS final `q`) and kitty graphics (APC final `G`) only via `addon-image`
  (`addons/addon-image/src/ImageAddon.ts:183,205`); the addon **auto-enables CSI 14t/16t/18t
  reports** (`addons/addon-image/README.md:47-56`) — must be disabled with `enableSizeReports:false`
  so core's FACTS remain the single source of cell geometry.
- Rendering cost: WebGL2 renderer with a documented `onContextLoss` recovery hook
  (`addons/addon-webgl/README.md:26-37`, `typings/addon-webgl.d.ts:18`); DOM renderer is the
  built-in fallback (`src/browser/CoreBrowserTerminal.ts:667-669`). Chromium forcibly loses the
  **oldest** WebGL context once a per-GPU limit is reached — "WARNING: Too many active WebGL
  contexts. Oldest context will be lost." (`third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc:551-565`).
  With 6–10 visible panes this is the real risk; the client must handle `onContextLoss` by
  disposing the addon and keeping the pane on DOM rendering.
- Mobile/IME: composition input goes out as user data
  (`src/browser/input/CompositionHelper.ts:157-232`), touch scroll in
  `src/browser/scrollable/touch.ts:215-258`; no on-screen key bar (browser keyboard only).
- OSC 8: built in (`src/common/InputHandler.ts:298`) with `linkHandler`
  (`typings/xterm.d.ts:1481-1512`, incl. `allowNonHttpProtocols`) and `addon-web-links`.
- Bundle: 5.9 MB unpacked (npm), plus addons.

### ghostty-web 0.4.0 (rejected)

- MIT, `0.4.0` published 2026-10-28; `coder/ghostty-web` 3.1k★, push 2026-11-07; Ghostty's own
  VT/parser compiled to WASM (~400 KB), "MVP complete", 95 tests (`ghostty-web/AGENTS.md`).
- Replies are merged into user input: `processTerminalResponses()` reads
  `wasmTerm.readResponse()` and fires the **same** `dataEmitter` as keys — the code comment says
  "This is the same path as user keyboard input" (`ghostty-web/lib/terminal.ts:1836-1849`).
  `input(data, wasUserInput=false)` *writes* data instead of emitting, i.e. semantics differ from
  xterm.js rather than offering a second channel (`lib/terminal.ts:646-668`).
- No win32-input-mode/9001 anywhere (grep `9001|win32` over `lib/` = 0 hits). Kitty keyboard
  encoding exists (`lib/input-handler.ts:176-236`, `lib/ghostty.ts:161-230`) but `setKittyFlags`
  is never called (`lib/ghostty.ts:183-185` is the only occurrence) — flags stay 0. No
  modifyOtherKeys either.
- Cannot answer pixel queries: `resize(cols, rows)` only, no pixel/cell parameter
  (`lib/ghostty.ts:350-357`), so FACTS `cell` has no source and CSI 16t cannot be answered.
- No sixel, no kitty-graphics rendering; renderer is canvas 2D (`lib/renderer.ts:199,650`);
  no focus-report emission (only `hasFocusEvents()` query at `lib/terminal.ts:1904`); IME
  documented as not implemented in the input-handler header comment. Also no public parser API
  (no `registerCsiHandler` export), so the bridge could not pre-empt built-ins even in principle.

### restty 0.3.0 (rejected for now)

- MIT, `0.3.0` published 2026-09-05; `wiedymi/restty` 420★, push 2026-09-05, README: "early-release
  software … some APIs may still change". libghostty-vt in WASM, WebGPU + WebGL2 fallback,
  pane-oriented API (`Restty({root})`, plugins, input/output interceptors).
- Replies go to the PTY channel by construction: `flushWasmOutputToPty()` loops
  `wasm.drainOutput()` → `ptyTransport.sendInput(out)` (`src/runtime/create-runtime/runtime-controller.input.ts:33-58`);
  `forwardTerminalReplies` is all-or-nothing (`:17`), so replies cannot be tagged per-frame.
  Internally `sendInput(text, source: "key"|"program"|"pty")` and `sendKeyInput` →
  `inputHandler.mapKeyForPty(...)` (`src/runtime/create-runtime/pty-input-runtime.ts:120-133`) do
  distinguish sources — a fork could expose that, upstream does not via `onData`.
- Kitty keyboard encoded in TS (`src/input/keymap/kitty.ts:91-188`); **no** win32/9001, **no**
  mode 2048, **no** sixel (greps over `src/` = 0). Good IME (`src/ime/ime.ts`) and touch
  selection modes (`docs/usage.md:44-60`).
- Bundle 9.4 MB unpacked, one runtime dep (`text-shaper`).

### Others

- `wterm` 0.0.1, description "TEST", 2024-08-12 — not a real package. `@ghostty/vt` does not
  exist. `libghostty-vt` 0.6.3 (Apache-2.0) is an unofficial community binding
  (`prime-radiant-inc/ts-libghostty`, 5★, last publish 2026-05-07) — a building block, not a
  viewer, and it has no renderer, IME, input handling or scrollback UI.

### OSC 7501 — what it is and whether the viewer must handle it

- Program Status Protocol: `ESC ] 7501 ; state=…:id=…:kind=…:progress=…:app=…:title=<b64>:msg=<b64> ESC \`,
  states `idle|working|done|blocked|error|clear`
  (`/tmp/hcore/schema/README.md:218-223`; `/tmp/hcore/crates/herdr-core/src/status.rs:1-57`;
  xterm.js addon doc `addons/addon-program-status/README.md`).
- **Core parses it itself** ("stored as reported. hc never infers status from the screen",
  `schema/README.md:218-223`) and answers the feature query once — herdr-core's test asserts the query
  never reaches the viewer and is answered exactly once
  (`/tmp/hcore/crates/herdr-core/tests/m3.rs:172-193`).
- So the viewer **must not** answer `OSC 7501;?`; it does not have to parse the sequence either,
  because attachment status comes from `events.subscribe` / first-paint replay
  (`/tmp/hcore/crates/herdr-core/src/viewers.rs:504-512`). If we later want the same dot-in-the-tab UI inside a pane, parsing is
  free — either `@xterm/addon-program-status` (but its `activate()` answers the query,
  `addons/addon-program-status/src/ProgramStatusAddon.ts:35-40`, which core already answered) or a
  small `registerOscHandler(7501)` of our own.
- Both target agents emit it: pi reports `state=working/blocked/done/error` with `app=…`
  (`pi-tui dist/program-status.js:1-41`, `dist/modes/interactive/program-status-reporter.js`),
  and Claude Code 2.1.325 has `PROGRAM_STATUS:7501` plus its own `OSC 21337` tab status.

### Agent TUIs in xterm.js

- pi-tui probes `CSI > 7 u` + `CSI ? u` + `OSC 7501;?` + `CSI c` in one write and expects the kitty
  reply **before** DA1 (`pi-tui dist/terminal.js:13-16,213-243`), uses mode 2026 synchronized
  output (`dist/tui-main-screen.js:245,268`) and bracketed paste. xterm.js answers `? u` with its
  flags and handles 2026 (`src/common/InputHandler.ts:2036,3584`) — but that reply must be routed
  as AUTOMATIC_INPUT, else pi's negotiation bytes would look like human typing.
- Claude Code probes XTVERSION, DECRQM 2026/1016, `CSI 16 t` cell pixels, kitty graphics and OSC 8
  (strings in `/Users/dev/.local/share/claude/versions/2.1.325`); xterm.js answers XTVERSION
  (`InputHandler.ts:1772-1778`), DECRQM 2026/1016 (`:2380-2393`) and 16t
  (`CoreBrowserTerminal.ts:1152-1157`) — again all through `onData`.

## Comparison

| | xterm.js 6.0.0 | ghostty-web 0.4.0 | restty 0.3.0 | libghostty-vt |
|---|---|---|---|---|
| Licence | MIT | MIT | MIT | Apache-2.0 |
| Engine | JS VT | Ghostty WASM | Ghostty WASM | Ghostty WASM (bindings only) |
| Maintained | 21.3k★, 2026-11-08 | 3.1k★, 2026-11-07, MVP | 420★, 2026-09-05, early | 5★, 2026-05-07 |
| win32-input-mode / 9001 | **yes** (`vtExtensions`) | no | no | no (encoder only) |
| kitty keyboard | yes, flags+push/pop | encoder only, flags never set | yes (TS) | no |
| Replies separable from keys | no callback, but parser is public & pre-emptable | no (same `onData`) | no (same PTY channel) | n/a |
| Mode 2048 in-band resize | no | no | no | no |
| XTGETTCAP | unsupported by design | no | no | no |
| Cell pixels for FACTS | `dimensions.device.cell` | none | canvas size only | none |
| kitty graphics / sixel | addon-image (both) | no | kitty only | n/a |
| OSC 8 | core + linkHandler | yes | yes | n/a |
| Renderer | WebGL2 + DOM fallback | canvas 2D | WebGPU/WebGL2 | n/a |
| Touch / IME | scroll + composition | minimal / not impl. | best | n/a |
| Bundle (unpacked) | 5.9 MB | 2.2 MB | 9.4 MB | small |

## Gaps the recommendation leaves (bridge/client must cover)

1. **AUTOMATIC_INPUT tagging.** No second callback. Register late handlers on `term.parser` for
   `CSI {c, >c, n, ?n, t, ?u, =u, >u, <u}`, `DCS {+q, $q}`, `OSC {4, 10, 11, 12}` and `APC G`,
   reply from our own buffer, return `true` to suppress the built-in. Everything arriving on
   `onData` is then human input → kind 0 DATA. (`onBinary` only carries legacy X10 mouse reports.)
2. **Focus reports.** xterm sends `\x1b[I`/`\x1b[O` itself when 1004 is set
   (`CoreBrowserTerminal.ts:305-310,1127-1141`). Suppress via a pre-empting handler and send the
   FOCUS frame instead — core re-injects `\x1b[I`/`\x1b[O` to the program only when the program
   asked (`viewers.rs:347-361`).
3. **Mode 2048.** No support at all: track `?2048h/l` with a DECSET/DECRST handler and emit
   `CSI 48;rows;cols;cellH*rows;cellW*cols t` as AUTOMATIC_INPUT on every resize; core strips the
   program's own copies (`relay.rs:244-259`) and herdr-app does exactly this via
   `vt.take_replies()` (`/tmp/happ/src/terminal.rs:233-237`).
4. **XTGETTCAP.** Answer `DCS +q <hex-terminfo> ST` (and `$q` DECRQSS) ourselves, tagged automatic.
   Needs a small terminfo table shipped by the bridge.
5. **FACTS in device pixels, once.** Send `{fg,bg,cursor,cell}` from theme +
   `dimensions.device.cell` after first paint and on `onDimensionsChange`; keep
   `addon-image`'s `enableSizeReports:false` and leave `windowOptions` empty so xterm does not
   answer 14t/16t in CSS pixels behind our back.
6. **Credit.** `write(bytes, cb)` → frame `CREDIT` with the chunk length; start with the 256 KiB
   credit core grants and treat `len ≤ 16 MiB` frames as one `write()`.
7. **Canvas repaint.** Observer paints may begin with `0x18` and arrive mid-sequence; feed bytes
   verbatim (xterm aborts the partial sequence) and never `reset()` on repaint.
8. **Kitty-graphics ack ownership.** addon-image sends `ESC _ G i=…;OK ESC \` through `onData`
   (`KittyGraphicsHandler.ts:540-541`); either patch/wrap that call site or accept losing the tag
   for graphics acks. There is no supported hook.
9. **WebGL budget.** 6–10 panes ≈ 6–10 contexts; handle `onContextLoss`, cap concurrent WebGL
   panes, keep background panes on the DOM renderer.
10. **No modifyOtherKeys.** `CSI > 4;2 m` is not implemented; fine as long as `CSI ? u` is
    answered (pi/Claude then choose kitty), which we do — but any program that only speaks
    modifyOtherKeys will get nothing.

## Open questions

- Exact Chromium `max_active_webgl_contexts` value: the macro comes from GPU prefs
  (`webgl_rendering_context_base.cc:486`, overridable with `--max-active-webgl-contexts`,
  `content/public/common/content_switches.cc:511`); the default was **not** located in source —
  treat "≈16" as unverified. Empirically test 8 panes on the target tablet.
- Whether `addons/addon-image` kitty support is good enough for real agent output; its own README
  says "Kitty graphics support is still WIP".
- Performance comparison xterm.js vs ghostty-web on our 6–10-pane layout: the only benchmark in
  the tree compares single-terminal parse throughput (`ghostty-web/bench/versus.ts`), unverified
  for our case.
- Whether suppressing xterm's built-in DA1/DSR breaks any internal expectation (only external
  programs see them, but not tested).
- ghostty-web could become viable if its key path gets 9001 + kitty-flag sync + a pixel size API;
  it is a much better VT engine for complex scripts (its README's own comparison table).
- `@xterm/addon-serialize` is labelled experimental; only needed if we ever rebuild state without
  a core repaint.
