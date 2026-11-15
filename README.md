# herdr-web

A self-hosted, single-user web client for herdr-core (`hc`). A bridge process (the backend) beside a core talks to it over its Unix socket; a Next.js app talks to the backend. See `AGENTS.md` for how work is organised.

What exists so far: the backend connects to core, keeps the terminal list and each machine's layout live, and serves login and the main socket. The web app signs in and shows a live shell (spaces by machine, tabs, the agents sidebar) and, for the selected pane, the terminal itself. It can start terminals in a space, kill them, pin agents and mark them seen or unread. A pi agent that has the herdr-web extension loaded also has a chat view (see "Trying chat").

## Layout

- `packages/core-client` (`@herdr-web/core-client`): the herdr-core client.
  - `frame.ts`: framed-mode frame encode/decode.
  - `connection.ts`: one framed connection; concurrent JSON-RPC calls, notifications, event-channel credit.
  - `store.ts`: the terminal store; applies core's events to a snapshot.
  - `session.ts`: connect, subscribe, mirror into the store, reconnect with backoff.
  - `endpoint.ts`: socket discovery. `types.ts`: hand-written from `hc schema` (core 0.1.21).
- `packages/protocol` (`@herdr-web/protocol`): the browser protocol's message types and validation; `PROTOCOL.md`.
- `apps/backend` (`backend`, the bridge): Express process on `127.0.0.1`.
- `apps/web` (`web`): the Next.js app (App Router, Tailwind v4, shadcn/ui on Base UI).
  - `src/lib/store.ts`: applies the backend's snapshot and changes. `live.ts`: the main-socket client (reconnect with backoff). `model.ts`: spaces, tabs and panes from layout plus terminals. `agents.ts`: the agent state rule.
  - `src/components/shell/`: sidebar, tab strip, main area, banner. `src/components/terminal/`: the terminal view.
  - `src/lib/terminal/`: `link.ts` (the terminal socket client: attach, reconnect, byte credit), `replies.ts` (tags the emulator's automatic answers, keeps focus reports off the wire), `colors.ts` (theme colours and cell size as core's display facts).

## Run

Needs Node 24 and pnpm.

```sh
pnpm install
pnpm build
HERDR_WEB_PASSPHRASE='…' pnpm backend start   # PORT=7420 by default; loopback only
curl 127.0.0.1:7420/health        # core version, connection state, seq (no sign-in; `error` only with the cookie)
curl -c jar -H 'Content-Type: application/json' -d '{"passphrase":"…"}' 127.0.0.1:7420/api/login
curl -b jar 127.0.0.1:7420/terminals          # live terminals + machines (like `hc ls --json`)
curl -b jar '127.0.0.1:7420/terminals?all=1'  # finished terminals too (like `hc ls --all`)
```

Settings (environment): `HERDR_WEB_PASSPHRASE` (required; the bridge refuses to start without it; changing it signs every device out), `HERDR_WEB_ORIGINS` (comma-separated web origins allowed to call the bridge, default `http://localhost:3000` and `http://127.0.0.1:3000`), `PORT`, `HERDR_WEB_BUILD_ID` (default: git short hash). The browser protocol (login, `/api/ws` main socket) is described in `packages/protocol/PROTOCOL.md`. `/terminals` is a debugging surface, not the browser protocol.

The bridge finds core's socket in this order: `HC_SOCKET`, `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, `/run/user/<uid>/herdr-core/<session>.sock`, then `$XDG_STATE_HOME` (default `~/.local/state`)`/herdr-core/<session>/<session>.sock`. `<session>` is `HC_SESSION`, default `default`. Only the first socket that exists is used.

### The web app

Run both sides, backend first. The app needs a built backend only for `pnpm test:e2e`; for development `pnpm backend dev` rebuilds and restarts on change.

```sh
HERDR_WEB_PASSPHRASE='…' pnpm backend dev   # http://127.0.0.1:7420
pnpm web dev                                # http://localhost:3000
```

Open `http://localhost:3000` (or `http://127.0.0.1:3000`; the dev server and the backend's default `HERDR_WEB_ORIGINS` allow both) and sign in with the passphrase. A page at any other address needs that address in `HERDR_WEB_ORIGINS`; the sign-in page says so when the backend is running but refuses the page, and says the backend is not running when nothing answers. The backend's address is `NEXT_PUBLIC_BACKEND_URL`. When unset, the app uses port 7420 on the host the page was opened from (`localhost:3000` → `localhost:7420`); a fixed `127.0.0.1` would be a different site from `localhost` and the browser would not send the sign-in cookie. Set it when the backend is elsewhere, and add the web app's origin to `HERDR_WEB_ORIGINS`. `NEXT_PUBLIC_*` values are fixed at build time (`pnpm web build`), and `pnpm web start` serves a build.

What the shell shows, and where it chooses: a machine whose layout cannot be read lists its live terminals flat; a live terminal labelled `herdr.space=<space id>` that sits in no pane is an extra tab of that space; a pane whose terminal is not live is hidden. The selected space, tab and pane, the sidebar's collapsed state and the theme are kept in the browser's localStorage.

### Operations

The browser changes core only through five named backend operations (`POST /api/ops/start|kill|seen|unread|pin`, plus `GET /api/starters`; see `packages/protocol/PROTOCOL.md`, "Operations"). In the shell: a **+** at the end of the tab strip starts a Shell, `pi` or one of core's templates in the selected space (not offered for a machine whose layout cannot be read); the new terminal arrives as a tab and is selected. The **⋯** menu on a tab kills a terminal (after a confirmation that names it); the menu on an agent row pins or unpins it, marks it unread, or kills it. A refusal or core's own error shows next to the control. Every control is off while the backend or core is away, and nothing is queued.

Seen is written automatically: while an agent's pane is the one shown and the page is visible and focused, `herdr.seen` is raised to the agent's `turn`, once per new turn; if the page is hidden or unfocused when a turn ends, it is written when the page is shown and focused again. It is never lowered, and a mark unread made while the agent is on screen is not overruled until the next turn. Everything the backend writes to core is `terminal.run`, `terminal.kill` and `terminal.label` (plus the read `templates.list`); a unit test checks that the backend never names `doc.set`, `machine.exec`, `file.*`, `server.*` or machine add and remove.

A killed terminal that was started with `keep` stays finished when core restarts (checked on core 0.1.21 with a shell and with a program), so the kill does not turn keep off first.

### The terminal view

The selected pane's terminal is attached through its own socket (`/api/terminal/<address>`, see `PROTOCOL.md`); only that one is attached, and choosing another pane detaches it. It fills the pane and follows its size, focused or not: when the pane's box changes (the sidebar collapsing, the window resized) the view refits and tells core the new size while the browser tab is visible, and sends nothing while it is hidden; with two windows on one terminal the size settles on whichever acted last (a window also sends its size when it is focused). The browser keeps 10,000 lines of scrollback. Select to copy (Ctrl+Shift+C also copies when Ctrl+C is the interrupt key); paste with the browser's paste. If the socket drops the view says so and attaches again by itself, with a full repaint, and typed input is not queued while it is down; after five failed attempts in a row it says "Cannot connect to this terminal" and keeps trying at the slow end of the backoff. A terminal that has ended shows how (exit code or signal) and opens no socket.

The browser keeps some keys for itself and they never reach the terminal: Cmd+W, Cmd+T, Cmd+N, Cmd+Q, Cmd+L, Cmd+R / F5 and Cmd+Tab on macOS; Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+L, Ctrl+R / F5 and Alt+F4 elsewhere (Ctrl+W and Ctrl+R are in use in shells, so on those systems use the program's other bindings or an installed app window).

xterm.js, pinned exactly:

| package | version |
| --- | --- |
| `@xterm/xterm` | `6.1.0-beta.337` |
| `@xterm/addon-fit` | `0.12.0-beta.333` |
| `@xterm/addon-webgl` | `0.20.0-beta.330` |
| `@xterm/addon-unicode11` | `0.10.0-beta.331` |
| `@xterm/headless` (tests only) | `6.1.0-beta.335` |

Why a beta: the kitty keyboard protocol and win32-input-mode (`vtExtensions` in the terminal options) exist only in the 6.1 betas; the stable 6.0.0 has neither, and programs such as pi use the kitty protocol to tell Shift+Enter from Enter. Rendering uses WebGL and falls back to the DOM renderer when the browser takes the context away. Not supported: mode 2048, XTGETTCAP, images.

### The chat view

**In the pane.** A terminal whose record says `chat: true` (an agent is connected for it, see `packages/pi-extension`) shows a Chat / Terminal toggle above its pane; Chat is the default, and the choice is remembered per terminal in the browser. Only the side that is shown is live: the chat is subscribed (`chat.subscribe` on the main socket) only while Chat is shown, and the terminal socket is open only while Terminal is shown. A terminal with `chat: false` shows the terminal and no toggle. If chat appears while a pane is open, the toggle appears and the pane stays where the reader is looking. A local terminal whose status says its program is pi, but that has no chat, shows one dismissible line above the terminal: chat needs the herdr-web pi extension (this README, "Trying chat"). The line is dismissed per browser.

**Wiring.** `apps/web/src/lib/chat/feed.ts` (`ChatFeed`) holds the threads this page watches: it sends `chat.subscribe` / `chat.unsubscribe`, subscribes again after every main-socket reconnect and takes the new snapshot (the same store object is kept, so the view starts again at its end), applies each `chat.change`, treats a `reset` as a different thread whatever its seq (a new session starts counting again), and asks again when a change is missing. `chat.unavailable` keeps the rows of the last thread on screen, dimmed, with the composer off and a sentence ("the agent's herdr-web extension is not connected"); the Terminal side still works, and a later `reset` brings the chat back. An older page asked for before a reset and answered after it is dropped. The actions are plain POSTs to `/api/chat/*` (`apps/web/src/lib/chat/api.ts`); a failure is the backend's sentence, shown as it is, and nothing is queued while the backend or core is away (the composer says which). A message that starts with `/` goes through the same `send`: the backend types it into the terminal, the composer says "Typed into the terminal. pi runs it a few seconds after it is typed" (core presses Enter after about three seconds of quiet) and offers "Show terminal" (the note shows at once: the backend answers such a message only when core has typed it and pi has taken it up, which took about 5 s for `/new`); commands that open a picker in pi switch the pane to Terminal by themselves.

**Seen.** A pane that is shown counts as shown whichever side it is on: the rule from "Operations" (once per turn, only while the page is visible and focused, only upward) runs on the pane's terminal, so reading a reply in Chat marks it seen.

**Components.** `/dev/chat` shows it on fixtures (every kind of row, an empty thread, a thread with 1,950 older rows to page in, a thread of 2,000 rows, a recorded turn played back, a "Measure a streaming reply" button, a disconnected switch). The page exists only under `pnpm web dev`; a production build answers 404 there.

Rows come from `packages/agents` (`rows.ts`). A user message is a right-aligned bubble ("2 images attached" when it has images); the assistant's text is rendered as markdown without a bubble, code blocks highlighted (shiki, light and dark) with a copy button; a thinking row says "Thought" and opens to its text (the row has no duration, so it cannot say "for 3 s"); a tool row is one line (icon, name, main argument, duration, "failed" or "stopped") that opens to the call and its result, with "Show all" when core's text was cut; compaction is a divider that opens to its summary; notices are quiet lines. The footer under a finished reply has copy and "model · effort" (the effort the reply was written at, from the row). A model change inside the session is a divider, "Switched to …". The composer sends on Enter and breaks the line on Shift+Enter (not while an input method is composing), keeps a draft per terminal, shows a Stop button while the agent works, and a message sent while it works shows as pending until the agent takes it. Slash commands that open a picker in pi (`/settings`, `/resume`, `/tree` and so on) are not sent: the composer says so and offers the terminal.

Scrolling: the thread follows the end while text arrives until the reader scrolls up (text that grows inside the live row is followed in the same commit, before paint: the scroller's own follow runs from a resize observer and an animation frame, so on its own the newest line showed one frame late; `chat-dev.spec.ts` samples the distance to the end on every frame of a slow turn); then nothing moves, and "Jump to latest" brings the follow back. Older rows load when the top comes near, and the reader keeps their place. Only the newest 120 rows are on the page; the rest are kept in memory and put on the page as the reader goes up, and taken off again once the reader is back at the end. Reason, from measurement: the scroll component reads the size of every row on the page on every scroll and every change, and on a page the reader had scrolled through at 2,000 rows that was about 12 ms a read, three reads a frame, with frames of 50 ms while a reply was written; with the window the longest frame while a reply streams into 2,000 rows is 33 ms (p99 17 ms, no long task). Rows off screen also use `content-visibility: auto`. Finished rows do not render again while a reply streams (a unit test counts renders).

Components from shadcn/ui kept as generated: `message`, `bubble`, `message-scroller` (with `@shadcn/react`), `trace` (tool lines), `code-block`, `collapsible`, `hover-card`, `progress`, `select`, `textarea`, `input-group`, `button`. Written here: the thread view's windowing and place-holding, the live tail, the markdown wrapper (Streamdown, with its code block replaced by `code-block`), the composer and its pickers, and the context ring.

### Trying chat

Chat comes from the herdr-web pi extension, `packages/pi-extension`. It is loaded into one pi run with `-e <folder>`, which loads an extension for that run only: nothing is installed into pi and nothing under `~/.pi` is touched (do not use `pi install` for this). It talks to the backend's agents socket, `$HERDR_WEB_AGENTS_SOCKET`, else `$XDG_STATE_HOME/herdr-web/agents.sock` (default `~/.local/state/herdr-web/agents.sock`), and finds its terminal through `HC_TERMINAL_ID`, which core sets in every terminal. So the pi must run in a terminal of the same core the backend is connected to, with the same state folder as the backend.

On the scratch core, for testing (the backend and the pi both go through `scripts/scratch-run`, so they share its state folder):

```sh
scripts/scratch-run hc server start
HERDR_WEB_PASSPHRASE=<something> scripts/scratch-run pnpm backend start      # one terminal of yours
pnpm web dev                                                                # another
scripts/scratch-run hc run --bg --name try-pi --cwd /tmp/hw-scratch/work --label herdr.space=<a space id from the herdr-app document> \
  -- pi -ne -e <folder of a provider extension, if the model needs one> -e "$PWD/packages/pi-extension" \
  --no-mcp --no-skills --no-prompt-templates --no-context-files --session-dir /tmp/hw-scratch/pi-sessions --model <a cheap or local model>
```

`-ne` keeps pi's other extensions out of the test; `--session-dir` keeps its sessions out of `~/.pi/agent/sessions`; the terminal needs a `herdr.space` label (or none: then it is listed under its machine). `pnpm test:agents` does exactly this with the local model and the real backend, and `pnpm test:e2e` does it without any pi.

On one of your own agents (text only; the tests never do this): start the backend beside your real core with `pnpm backend start` (it needs `HERDR_WEB_PASSPHRASE`), then, in a terminal of that core, start pi with the extension added to your usual flags, for example `pi -e /path/to/herdr-web/packages/pi-extension`. pi reads its own settings as usual; the extension is loaded for that run only. Open the web app, select the agent: it has the Chat / Terminal toggle. A pi that is already running has to be started again: `-e` is read at start-up. `/new`, `/resume`, `/fork` and `/reload` make pi load the extension again, and the thread follows.

## Test

```sh
pnpm test    # unit tests (frames, event table, store, session against a fake core; web store, agent rule, layout rules, socket client)
pnpm lint    # typecheck
pnpm test:e2e   # browser test (below); not part of pnpm test
pnpm test:agents   # a real pi on a scratch core with the pi extension: alone, through the real backend, and in a browser; not part of pnpm test (packages/agents/README.md)
```

The unit tests need no core.

### Scratch core

Anything that starts, labels, types into or kills a terminal, or stops a core, runs against a scratch core, never the real one (session `default`). Inside a herdr terminal a bare `hc` always means the real core, so two scripts make the scratch one the only choice:

```sh
scripts/scratch-run hc server start              # start the scratch core
scripts/scratch-run hc run --bg sleep 100        # a terminal in it
scripts/scratch-run pnpm backend start           # the backend, talking to it
scripts/scratch-run hc label t1 a=b && scripts/scratch-run hc kill t1
scripts/scratch-run hc server stop && scripts/scratch-run hc server start   # the backend reconnects by itself
scripts/scratch-stop                             # done: keep off and kill each terminal, stop the core
scripts/scratch-stop --delete                    # the same, then remove the scratch root
```

`scratch-run <command…>` runs the command with `HC_SOCKET`, `HC_SCOPE`, `HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID` and `XDG_RUNTIME_DIR` removed and `HC_SESSION=herdr-web-test`, `XDG_STATE_HOME=<root>/state`, `XDG_CONFIG_HOME=<root>/config` set. The root is `$HW_SCRATCH` (default `/tmp/hw-scratch`; give each agent its own) and must be under `/tmp`; anything else is refused and the command does not run. Put the script in front of every command rather than exporting or sourcing an environment, and use `&&` rather than `;` so a failed step stops the line.

`scratch-stop` goes through `scratch-run`. It keeps off and kills each live terminal, stops the core, then waits up to 10 seconds for every process to let go of the files under the root. A process that still holds one is printed with its pid and the exit status is 1; nothing is ever stopped by name. It never calls `hc` while the core is down, because any `hc` command starts one. Node code that spawns `hc` or the backend builds its environment with `scripts/scratch-env.mjs`, which follows the same rules.

### Browser test

`pnpm test:e2e` signs in through a real browser, starts a terminal with `hc run`, expects it as a tab of its space without a reload, then stops core and expects the banner. A second spec drives a shell in the terminal view: typing, resizing the window (`stty size` must match), a flood stopped by Ctrl-C within 2 seconds, a backend restart that the view recovers from by itself, and a shell that exits. A third spec (`terminal-ops.spec.ts`) starts a shell from the "+", kills one from the tab menu, pins and unpins, and checks that an agent finishing a turn becomes idle by itself when its pane is shown and the page is focused, and stays done while the page is hidden. A fourth spec (`chat-dev.spec.ts`) needs no core: it takes the screenshots of `/dev/chat` (every kind of row, light and dark, 768 and 1440 px, to `/tmp/hw-shots/dev-26`), checks the scroll rule and the older-page place, and times a reply streaming into 2,000 rows (longest frame under 100 ms). A fifth spec (`terminal-chat.spec.ts`) has no pi and no model: a stand-in for the extension (`e2e/stand-in.ts`, speaking the wire of `@herdr-web/agents/wire`) connects to the backend's agents socket for a scratch terminal and plays a turn recorded from a live pi (`packages/agents/test/fixtures/pi/session-b-tools.jsonl`) with the reply in pieces. The spec checks the hint for a pi with no extension, the toggle appearing, live text in pieces, running and finished tool lines, finished rows replacing the live ones with nothing doubled, Stop reaching the stand-in, a model and an effort change, a `/` command typed into the terminal, the stand-in leaving (stale rows, composer off) and returning (a reset), and seen being written for a shown chat pane. The others start everything themselves and touch nothing else: a scratch core (a temporary root under `/tmp`, set up with `scripts/scratch-env.mjs` and taken down with `scripts/scratch-stop --delete`), the backend on port 18420 and a web dev server on port 14000 (its build folder is `.next-e2e`), so it can run beside `pnpm backend dev` and `pnpm web dev`. One-time setup: `pnpm build` (the test runs the built backend) and `pnpm --filter web exec playwright install chromium`.

`pnpm test:agents` ends with a browser spec of its own (`apps/web/e2e-live/chat-live.spec.ts`, `playwright.live.config.ts`, backend on port 18441 and web on 14041) with a real pi on the local model: one full turn, with the message in pi's own screen; a model and an effort change (the model list of pi holds paid providers, so a model that reasons is selected and its effort changed but no message is ever sent while it is selected: the local model is selected again, over HTTP in a `finally`, and every message is guarded by a check that the local model is current); Stop on a reply; `/new` giving an empty thread; a message typed at the terminal appearing in the thread within a second of pi writing it; the hint on a pi started without the extension. It writes screenshots to `/tmp/hw-shots/dev-26-live`.
