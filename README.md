# herdr-web

A self-hosted, single-user web client for herdr-core (`hc`). A bridge process (the backend) beside a core talks to it over its Unix socket; a Next.js app talks to the backend. See `AGENTS.md` for how work is organised.

What exists so far: the backend connects to core, keeps the terminal list and each machine's layout live, and serves login and the main socket. The web app signs in and shows a live, read-only shell: spaces by machine, tabs, and the agents sidebar. No terminal view, chat, or anything that changes core yet.

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
  - `src/components/shell/`: sidebar, tab strip, pane card, banner.

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

Settings (environment): `HERDR_WEB_PASSPHRASE` (required; the bridge refuses to start without it; changing it signs every device out), `HERDR_WEB_ORIGINS` (comma-separated web origins allowed to call the bridge, default `http://localhost:3000`), `PORT`, `HERDR_WEB_BUILD_ID` (default: git short hash). The browser protocol (login, `/api/ws` main socket) is described in `packages/protocol/PROTOCOL.md`. `/terminals` is a debugging surface, not the browser protocol.

The bridge finds core's socket in this order: `HC_SOCKET`, `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, `/run/user/<uid>/herdr-core/<session>.sock`, then `$XDG_STATE_HOME` (default `~/.local/state`)`/herdr-core/<session>/<session>.sock`. `<session>` is `HC_SESSION`, default `default`. Only the first socket that exists is used.

### The web app

Run both sides, backend first. The app needs a built backend only for `pnpm test:e2e`; for development `pnpm backend dev` rebuilds and restarts on change.

```sh
HERDR_WEB_PASSPHRASE='…' pnpm backend dev   # http://127.0.0.1:7420
pnpm web dev                                # http://localhost:3000
```

Open `http://localhost:3000` and sign in with the passphrase. The backend's address is `NEXT_PUBLIC_BACKEND_URL`. When unset, the app uses port 7420 on the host the page was opened from (`localhost:3000` → `localhost:7420`); a fixed `127.0.0.1` would be a different site from `localhost` and the browser would not send the sign-in cookie. Set it when the backend is elsewhere, and add the web app's origin to `HERDR_WEB_ORIGINS`. `NEXT_PUBLIC_*` values are fixed at build time (`pnpm web build`), and `pnpm web start` serves a build.

What the shell shows, and where it chooses: a machine whose layout cannot be read lists its live terminals flat; a live terminal labelled `herdr.space=<space id>` that sits in no pane is an extra tab of that space; a pane whose terminal is not live is hidden. The selected space, tab and pane, the sidebar's collapsed state and the theme are kept in the browser's localStorage.

## Test

```sh
pnpm test    # unit tests (frames, event table, store, session against a fake core; web store, agent rule, layout rules, socket client)
pnpm lint    # typecheck
pnpm test:e2e   # browser test (below); not part of pnpm test
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

`pnpm test:e2e` signs in through a real browser, starts a terminal with `hc run`, expects it as a tab of its space without a reload, then stops core and expects the banner. It starts everything itself and touches nothing else: a scratch core (a temporary root under `/tmp`, set up with `scripts/scratch-env.mjs` and taken down with `scripts/scratch-stop --delete`), the backend on port 18420 and a web dev server on port 14000 (its build folder is `.next-e2e`), so it can run beside `pnpm backend dev` and `pnpm web dev`. One-time setup: `pnpm build` (the test runs the built backend) and `pnpm --filter web exec playwright install chromium`.
