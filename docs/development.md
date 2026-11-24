# Development

Needs Node 24 and pnpm. The repository is a pnpm workspace built with turbo.

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/backend` | `backend` | The backend: an Express process on `127.0.0.1` beside core. |
| `apps/web` | `web` | The Next.js app (App Router, Tailwind v4, shadcn/ui on Base UI). |
| `packages/core-client` | `@herdr-web/core-client` | The herdr-core client: framing, JSON-RPC, the terminal store, reconnect, socket discovery. `types.ts` is hand-written from `hc schema` (core 0.1.21). |
| `packages/protocol` | `@herdr-web/protocol` | Message types and validation for the browser protocol ([PROTOCOL.md](../packages/protocol/PROTOCOL.md)). |
| `packages/agents` | `@herdr-web/agents` | Chat rows, the `Thread` adapter and the pi-live client ([README](../packages/agents/README.md)). |
| `scripts/` | | The scratch core scripts (below). |
| `research/` | | Background findings behind early decisions. |
| `design/reference/` | | The two screenshots the UI follows. |

Places to start in the web app: `src/lib/store.ts` (applies the backend's snapshot and changes), `src/lib/live.ts` (main socket), `src/lib/model.ts` (spaces, tabs and panes), `src/lib/agents.ts` (agent state), `src/lib/chat/` (chat feed, actions, grouping), `src/lib/terminal/` (terminal socket), `src/components/`.

## Run for development

```sh
pnpm install
pnpm build
HERDR_WEB_PASSPHRASE='…' pnpm backend dev   # rebuilds and restarts on change; 127.0.0.1:7420
pnpm web dev                                # Next dev server
```

Development-only pages (a production build answers 404):

- `/dev/chat`: the chat on fixtures. Every kind of row, long and empty threads, a recorded turn played back, a streaming measurement, the `ask_user` lines and panel in each mode (the `ask-…` scenarios), and pi waiting on a dialog of its own (the `waiting-…` scenarios).
- `/dev/shell`: the sidebar on fixtures. Several machines, one unreachable, and switches for many agents or spaces.

## Tests

```sh
pnpm lint          # typecheck
pnpm test          # unit tests; no core needed
pnpm test:e2e      # browser tests on a scratch core and a stand-in pi-live
pnpm test:agents   # a real pi on a scratch core (needs hc, pi and a local model)
```

`pnpm test:e2e` needs, once: `pnpm build` and `pnpm --filter web exec playwright install chromium`. It starts its own scratch core, backend (port 18420) and web server (port 14000, build folder `.next-e2e`), so it can run beside your dev servers. The specs, in `apps/web/e2e/`:

| Spec | Checks |
| --- | --- |
| `shell.spec.ts` | Sign-in, a new terminal showing as a tab without a reload, the banner when core stops. |
| `terminal.spec.ts` | Typing, resizing (`stty size` matches), Ctrl-C stopping a flood, recovery from a backend restart, a shell exiting. |
| `terminal-ops.spec.ts` | Start, kill, pin, and seen while the page is shown or hidden. |
| `terminal-fit.spec.ts` | Rows end inside the pane at 768 and 1440 px, light and dark; the scrollbar style. |
| `terminal-chat.spec.ts` | The whole chat against a stand-in for pi-live (`e2e/stand-in.ts`) playing a recorded turn: hints, streaming, tools, stop, model and effort, slash routing, disconnect and reset, seen. |
| `terminal-ask.spec.ts` | `ask_user` in the chat against the same stand-in: the panel for a single choice, several, a comment, typing and a batch with a skip, a refused answer and then a good one, an answer that comes too late, a second tab, and a prompt cancelled at the keyboard. The file name sorts it after `shell.spec.ts`, which expects the core's herdr-app doc at version 0, and this spec adds a space. |
| `terminal-waiting.spec.ts` | The "Waiting for you in the terminal" line against the stand-in, which sets `state.waitingForUser`: it shows with its title, Open terminal switches the view, it goes when the state clears, and it never shows beside an `ask_user` prompt. Named like `terminal-ask.spec.ts`, for the same reason. |
| `chat-dev.spec.ts`, `chat-paging-blank.spec.ts`, `groups-dev.spec.ts` | `/dev/chat` on fixtures, no core: screenshots, scrolling and paging, streaming into 2,000 rows (longest frame under 100 ms), groups opening within 200 ms. |
| `ask-dev.spec.ts` | `/dev/chat` on fixtures, no core: every state of an `ask_user` line, and the panel in each mode, light and dark, at 1440 and 390 px, with screenshots (`/tmp/hw-shots/dev34-*`). |
| `waiting-dev.spec.ts` | `/dev/chat` on fixtures, no core: the waiting line with and without a title, Open terminal, hidden behind an `ask_user` prompt or card; light and dark at 1440 and dark at 390, with screenshots (`/tmp/hw-shots/dev39-*`). |
| `link-dev.spec.ts` | `/dev/chat` on fixtures, no core: pi-link messages received (grouped, folded, a batch that cannot be split), sent (sent, not delivered, sending), `link_list`, compaction lines, and another extension's message as a notice; light and dark at 1440 and dark at 390, with screenshots (`/tmp/hw-shots/dev40-*`). |
| `todo-dev.spec.ts` | `/dev/chat` on fixtures, no core: the todo card above the composer with every status, a long list that folds and opens, collapsed, no card for an empty list, and a list written, worked, finished and dropped across a turn; light and dark at 1440 and dark at 390, with screenshots (`/tmp/hw-shots/dev41-*`). |
| `shell-dev.spec.ts` | `/dev/shell` on fixtures, no core: the sidebar's layout. |
| `zz-*-attack.spec.ts` | Adversarial checks of the shell, the terminal and the chat. They run last, because some restart the backend. |

`pnpm test:agents` runs pi for real: once with the agents package alone, once through the backend, three times in a browser (`apps/web/e2e-live/`; the second and third, `ask-live.spec.ts` (answers `ask_user` prompts) and `waiting-live.spec.ts` (a confirm of an extension's tool), use the Claude model of the relay in `~/.pi/agent/models.json`, which it only reads). What it covers and the rules it keeps (only the local model for the first three, nothing touched under `~/.pi`) are in [packages/agents/README.md](../packages/agents/README.md#pnpm-testagents).

Screenshots from the browser tests go to `/tmp/hw-shots/`.

## Scratch core

Anything that starts, labels, types into or kills a terminal, or stops a core, runs against a scratch core, never your real one. Inside a herdr terminal a bare `hc` means the real core, so two scripts make the scratch one the only choice:

```sh
scripts/scratch-run hc server start              # start the scratch core
scripts/scratch-run hc run --bg sleep 100        # a terminal in it
scripts/scratch-run pnpm backend start           # the backend, talking to it
scripts/scratch-run hc label t1 a=b && scripts/scratch-run hc kill t1
scripts/scratch-stop                             # done: keep off and kill each terminal, stop the core
scripts/scratch-stop --delete                    # the same, then remove the scratch root
```

`scratch-run <command…>` runs the command with these environment changes:

- **Removed:** `HC_SOCKET`, `HC_SCOPE`, `HC_TERMINAL_SOCKET`, `HC_TERMINAL_ID` and `XDG_RUNTIME_DIR`.
- **Set:** `HC_SESSION=herdr-web-test`, `XDG_STATE_HOME=<root>/state`, `XDG_CONFIG_HOME=<root>/config` and `PI_LIVE_DIR=<root>/live`.

So a pi or backend started this way never sees `~/.pi/agent/live`.

The root is `$HW_SCRATCH`, default `/tmp/hw-scratch`. Give each agent its own. The root must be under `/tmp`, and anything else is refused. Put the script in front of every command instead of exporting an environment, and chain with `&&`.

`scratch-stop` turns keep off and kills each live terminal, stops the core, then waits up to 10 s for every process to let go of the root. If a process still holds a file there, the script prints its pid and exits with status 1. It never stops a process by name, and never calls `hc` while the core is down, because any `hc` command starts one. Node code builds the same environment with `scripts/scratch-env.mjs`.

### A pi on the scratch core

```sh
scripts/scratch-run hc server start
HERDR_WEB_PASSPHRASE=<something> scripts/scratch-run pnpm backend start
pnpm web dev
scripts/scratch-run hc run --bg --name try-pi --cwd /tmp/hw-scratch/work --label herdr.space=<space id> \
  -- pi -ne -e <provider extension, if the model needs one> -e "$PWD/node_modules/pi-live" \
  --no-mcp --no-skills --no-prompt-templates --no-context-files --session-dir /tmp/hw-scratch/pi-sessions --model <a cheap or local model>
```

- `node_modules/pi-live` is a pinned devDependency, loaded for that run only with `-e`.
- A pi that asks questions needs `-e "$PWD/node_modules/pi-ask-user"` too (a pinned devDependency, the Trex-Hub fork that parks its prompts on pi-live). **Test pis load both extensions.** The fork's `package.json` lists its own copy of pi-live at `./node_modules/@dev8-npm/pi-live/index.ts`, which pnpm does not create, so `-e node_modules/pi-ask-user` alone has no pi-live and the prompt is never parked. A test pi that does not ask questions needs only pi-live.
- pnpm refuses the fork's git dependency on pi-live unless `blockExoticSubdeps: false` is set in `pnpm-workspace.yaml`. The lockfile pins both packages to exact commits.
- `-ne` keeps your other extensions out.
- `--session-dir` keeps the test's sessions out of `~/.pi/agent/sessions`.
- Without a `herdr.space` label, the terminal is listed under its machine.

## Pinned versions

xterm.js is pinned exactly, because the kitty keyboard protocol exists only in the 6.1 betas:

| Package | Version |
| --- | --- |
| `@xterm/xterm` | `6.1.0-beta.337` |
| `@xterm/addon-fit` | `0.12.0-beta.333` |
| `@xterm/addon-webgl` | `0.20.0-beta.330` |
| `@xterm/addon-unicode11` | `0.10.0-beta.331` |
| `@xterm/headless` (tests only) | `6.1.0-beta.335` |

These shadcn/ui components are kept exactly as generated: `message`, `bubble`, `message-scroller`, `trace`, `code-block`, `collapsible`, `hover-card`, `progress`, `select`, `textarea`, `input-group`, `button`. The thread's windowing, the live tail, the markdown wrapper, the composer and the context ring are written here.
