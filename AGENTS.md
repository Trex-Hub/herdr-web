# herdr-web

A self-hosted, single-user web client for herdr-core (`hc`). A bridge process beside a core talks to it over its Unix socket; a Next.js app talks to the bridge. The point of the product is a smooth chat view of coding agents.

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
- Devendra's real core (session `default`) holds his live work. Read it only (`hc ls`, `hc get`, `hc read`). Everything that starts, kills, labels, types into or writes a document uses a scratch core: `HC_SESSION=herdr-web-test` with scratch `XDG_STATE_HOME` and `XDG_CONFIG_HOME`.
- Own the code: other projects (Ovis included) are reference, with nothing copied or ported.
- Reference clones and scratch files live outside this folder (`/tmp`).

## Where things are

- `research/`: findings behind the decisions. A build ticket names the ones that matter for it.
- `design/reference/`: the two screenshots the UI follows.
