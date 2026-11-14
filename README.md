# herdr-web

A self-hosted, single-user web client for herdr-core (`hc`). A bridge process beside a core talks to it over its Unix socket; a Next.js app (not built yet) talks to the bridge. See `AGENTS.md` for how work is organised.

What exists so far: the bridge connects to core, keeps a live terminal list in memory, and shows it on a loopback debug endpoint. No browser UI, terminal streaming or login yet.

## Layout

- `packages/core-client` (`@herdr-web/core-client`): the herdr-core client.
  - `frame.ts`: framed-mode frame encode/decode.
  - `connection.ts`: one framed connection; concurrent JSON-RPC calls, notifications, event-channel credit.
  - `store.ts`: the terminal store; applies core's events to a snapshot.
  - `session.ts`: connect, subscribe, mirror into the store, reconnect with backoff.
  - `endpoint.ts`: socket discovery. `types.ts`: hand-written from `hc schema` (core 0.1.21).
- `apps/bridge` (`bridge`): Express process on `127.0.0.1`.

## Run

Needs Node 24 and pnpm.

```sh
pnpm install
pnpm build
HERDR_WEB_PASSPHRASE='…' pnpm --filter bridge start   # PORT=7420 by default; loopback only
curl 127.0.0.1:7420/health        # core version, connection state, seq (no sign-in)
curl -c jar -H 'Content-Type: application/json' -d '{"passphrase":"…"}' 127.0.0.1:7420/api/login
curl -b jar 127.0.0.1:7420/terminals          # live terminals + machines (like `hc ls --json`)
curl -b jar '127.0.0.1:7420/terminals?all=1'  # finished terminals too (like `hc ls --all`)
```

Settings (environment): `HERDR_WEB_PASSPHRASE` (required; the bridge refuses to start without it; changing it signs every device out), `HERDR_WEB_ORIGINS` (comma-separated web origins allowed to call the bridge, default `http://localhost:3000`), `PORT`, `HERDR_WEB_BUILD_ID` (default: git short hash). The browser protocol (login, `/api/ws` main socket) is described in `packages/protocol/PROTOCOL.md`. `/terminals` is a debugging surface, not the browser protocol.

The bridge finds core's socket in this order: `HC_SOCKET`, `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, `/run/user/<uid>/herdr-core/<session>.sock`, then `$XDG_STATE_HOME` (default `~/.local/state`)`/herdr-core/<session>/<session>.sock`. `<session>` is `HC_SESSION`, default `default`. Only the first socket that exists is used.

## Test

```sh
pnpm test    # unit tests (frames, event table, store, session against a fake core)
pnpm lint    # typecheck
```

The unit tests need no core. For a manual check, never touch the real core (session `default`): use a scratch one.

```sh
export HC_SESSION=herdr-web-test XDG_STATE_HOME=/tmp/hw-scratch/state XDG_CONFIG_HOME=/tmp/hw-scratch/config
mkdir -p $XDG_STATE_HOME $XDG_CONFIG_HOME
hc server start
pnpm --filter bridge start &
hc run --bg sleep 100             # shows up in /terminals
hc label t1 a=b; hc kill t1       # label and finish show up too
hc server stop; hc server start   # the bridge reconnects by itself
```
