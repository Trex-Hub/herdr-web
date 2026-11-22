# herdr-web

A self-hosted, single-user web client for herdr-core (`hc`). The backend (`apps/backend`) runs beside a core and talks to it over its Unix socket; a Next.js app (`apps/web`) talks to the backend. The point of the product is a smooth chat view of coding agents.

## Who does what

Three pi terminals share this folder and talk over pi-link.

- `herdr-web-architect` plans with Devendra and writes build tickets.
- `herdr-web-builder` builds one ticket at a time.
- `herdr-web-tester` checks a branch after the builder reports it done, and writes tests, leaving product code to the builder.

## Tickets

Linear, workspace `devendra` (tools `mcp__linear_devendra__*`), project `herdr-web`.

- A ticket labelled `build` is the whole contract: what to build, what done means, what to read. When it is unclear or wrong, ask the architect over the link before building around it.
- Tickets labelled `wayfinder:*` are planning decisions and belong to the architect.

## Rules

- One branch per build ticket, named in the ticket. Commit locally. Pushing waits for Devendra's explicit approval.
- Own the code: other projects (Ovis included) are reference, with nothing copied or ported.
- Reference clones and scratch files live outside this folder (`/tmp`).
- Tell the architect over the link in one line when you start a ticket, and report when done or stuck. A report lists only what you checked in that run.

## The real core

Devendra's real core (session `default`) holds his live work, these three agents included. Stopping it restarts every terminal he has open; that happened once, on 14 Nov.

- Read it only: `hc ls`, `hc get`, `hc read`. A ticket may narrow this further.
- Everything that starts, kills, labels, types into, attaches to or stops goes to the scratch core, with `scripts/scratch-run` in front of every such command, and ends with `scripts/scratch-stop`. Inside a herdr terminal a bare `hc` means the real core. `docs/development.md`, "Scratch core", has the details.
- Chain commands with `&&`, so a failed step stops the line.
- Stop a process by a pid you recorded when you started it, never by name (`pkill -f`, `killall`).
- Leave files where they are: use a new directory name under `/tmp` rather than deleting one. `rm -rf`, `--force`, `git clean`, `sudo` and `chmod -R` wait for Devendra. The scratch root is removed only by `scripts/scratch-stop --delete`.
- Devendra's pi setup stays as it is: nothing installed into or edited under `~/.pi`, and nothing sent to his own agents. A test pi loads pi-live with `-e` (the pinned copy in `node_modules/pi-live`).
- His own pis have pi-live sockets in `~/.pi/agent/live`, and those accept control: whatever connects can prompt his agents. Nothing of ours connects there. `scripts/scratch-run` sets `PI_LIVE_DIR` to the scratch root's `live` folder, and every backend a test starts gets that folder explicitly.

## Where things are

- `docs/development.md`: layout, test commands, what each browser spec covers, the scratch core. Read before running or adding tests.
- `docs/architecture.md`: how the pieces fit, the settled decisions, and design notes. Read before changing how the backend, pi-live or core connect.
- `docs/using.md`, `docs/chat.md`, `docs/configuration.md`: what the app does and every setting. Update them when behaviour or a setting changes.
- `packages/protocol/PROTOCOL.md` and `packages/agents/README.md`: the browser protocol and the chat rows. Update them with any change to either.
- `research/`: findings behind the decisions. A build ticket names the ones that matter for it.
- `design/reference/`: the two screenshots the UI follows.

The README is for people who find the project on GitHub. Keep it to what herdr-web is, how to start it, and links into `docs/`.
