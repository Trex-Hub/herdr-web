# @herdr-web/agents

What the backend knows about an agent running in a terminal, and the code that learns it. Today one
agent, **pi**, through two packages:

- `packages/agents` (this one): the adapter interface, the row and wire schemas, and the backend's side of the pi connection.
- `packages/pi-extension`: a small extension loaded into every pi that herdr-core starts. It reports what pi's session file cannot say (the reply while it is written, the session's current leaf, working or settled, the model and effort, queued messages) and carries the app's actions in. It does nothing in a pi that was not started by herdr-core (no `HC_TERMINAL_ID`).

The backend half is `apps/backend/src/chat.ts` and `chat-operations.ts` (how the backend pairs connections with terminals, serves subscriptions on the main socket and takes the app's actions; `packages/protocol/PROTOCOL.md`, section Chat). This package is what they call.

## 1. The adapter: `Thread`

`src/thread.ts`. An adapter is asked for a **thread** when an agent says hello for a terminal. A thread is one agent in one terminal, for as long as that agent's connection lives.

```ts
interface Thread {
  kind: string                      // "pi"
  terminalId: string                // `t17`: the herdr-core terminal it runs in
  snapshot(): ThreadSnapshot        // identity, last page of rows, live state, capabilities, seq
  subscribe(l: (c: ThreadChange) => void): () => void
  page(beforeRowId: string, limit?: number): Promise<{ rows: Row[]; hasMore: boolean }>
  toolResult(rowId: string): Promise<string>
  send(text: string): Promise<void>       // queued as a steer while the agent works
  stop(): Promise<void>
  setModel(id: string): Promise<void>     // `provider/id`, one of capabilities.models.list
  setEffort(level: string): Promise<void>
  clearInput(): Promise<void>             // empty pi's input box before a `/command` is typed into the terminal
  onClose(l: () => void): void; close(): void; readonly closed: boolean
}
```

Every action resolves when pi accepted it and rejects with an `ActionError` whose message is a sentence the app shows as it is ("This model does not take the effort “max”. It takes: off, low.").

`send` does not treat a leading `/` specially. Pi's slash commands are not messages: the backend types them into the terminal (after `clearInput()`), and pi reloads the extension for `/new`, `/resume`, `/fork` and `/reload`, which shows up here as a **new connection** (a new thread; the old one closes).

### The rows and the rest: `@herdr-web/agents/rows`

`src/rows.ts` is the schemas (zod) and their types: `Row` (`user`, `assistant`, `thinking`, `tool`, `compaction`, `model`, `notice`), `Live`, `Capabilities`, `Identity`, `ThreadSnapshot`, `ThreadChange`. **It imports only zod**, so the web app and `packages/protocol` import it through the subpath `@herdr-web/agents/rows` without pulling in Node (a test holds this). The wire is `@herdr-web/agents/wire`.

- A row's **id** is stable: the session entry's id, plus `.<n>` for the n-th block of an assistant message (`98ad1ba9.0` is the thinking block, `98ad1ba9.1` the text), plus `.stop` for the "Stopped." / error notice an aborted or failed message gets, `broken:<line>` for a line of the file that could not be read. The same file always gives the same ids.
- The thread shows the **whole active branch from its start**, a compaction as a `compaction` row between what was summarised and what came after (pi's own context builder drops the summarised part; we do not use it).
- An `assistant` row carries `effort`: the thinking level in force when the reply was written, tracked from the branch's `thinking_level_change` entries (`null` when none says). A `model` row ("Switched to …") comes from a `model_change` entry on the branch that is **not the first one** and names a different model than the one before; the first is the header of the session, not a switch.
- Hidden entries (`custom_message` with `display: false`, thinking changes, labels, `session_info`, …) give no rows. Entries it does not know give no rows. An entry it cannot map gives a warning `notice` row and the rest still shows.
- A **tool** row is `running` while its call has no result and the agent works, `interrupted` when the agent is not working any more and no result came, otherwise `ok` or `error`. `byUser` marks `!command` runs.

### Snapshot, changes, and the leaf moving

`snapshot()` is the last `PAGE_SIZE` rows plus `hasMore`, the live state and `seq`. Take it and `subscribe()` in the same tick and nothing is lost: every change has the next `seq`.

A `ThreadChange` is one of:

- `update`: any of `rows` (upserts by id: a known id is replaced where it is, a new one goes at the end), `live`, `capabilities`, `identity`, applied **together**. A reply that just became a row arrives in the same update as the row, so there is never a moment with the reply live and as a row, or as neither.
- `reset`: the branch moved (`/tree`, `/fork`, a leaf that is not the end of what was shown). It carries a whole new snapshot, which replaces everything the app holds, `page`d rows included.

**When the leaf moves between a snapshot and a `page()` request**: the thread has already sent (or is about to send) a `reset`; `page(beforeRowId)` for a row that is no longer on the branch rejects with an `ActionError` ("That part of the conversation is no longer there. Reload the thread."). The app should treat that as "take the `reset`": drop the rejected page, and render from the reset's snapshot. If no reset has reached it yet, calling `snapshot()` again gives the same state. A page that does resolve is always a slice of the current branch (the rows before `beforeRowId`, oldest first), so a page and a later reset never mix: apply a page only if no `reset` arrived while it was in flight.

### Sizes

| | | |
|---|---|---|
| `PAGE_SIZE` | 50 rows | the opening snapshot and each `page()` default; `page(…, limit)` is clamped to 1…500 |
| `TOOL_RESULT_CUT` | 4000 characters | a tool row's `result.text` is cut here (`truncated`, `totalChars` say so); `toolResult(rowId)` returns the whole |
| `TOOL_ARG_CUT` | 1000 characters | per string inside a tool call's arguments (`argsTruncated`) |

## 2. The wire between the extension and the backend

NDJSON on a Unix socket, one JSON object per line, every line carrying `v` (**`WIRE_VERSION` = 1**). Defined in `src/wire.ts` (zod). The extension cannot import it (it imports only Node built-ins so it can be installed on its own), so it writes the same shapes by hand and `packages/pi-extension/test/extension.test.ts` validates every line it sends against the schemas, including a replay of events recorded from a live pi.

- Extension → backend: `hello` (terminal id, pid, session id/file/cwd, `reason` = startup/new/resume/fork/reload), `models`, `state` (leaf id, model, effort and its levels, working, queued messages, context usage, name; always whole), `reply` (the reply so far, at most every 50 ms, empty list = none), `tool` (start/end), `entries` ("pi has written; read the file", with the leaf and whether a reply just ended), `notice`, `result` (to an action).
- Backend → extension: `welcome`, `refused {reason}`, `action {id, op}` with `op` = `send`, `stop`, `set_model`, `set_effort`, `clear_input`.
- A first line of another version is answered with `refused` and logged as **one line**: `agents: refused a connection: the extension speaks wire version 2, this backend speaks 1`. The extension then waits 60 s before trying again. Lines of another version after hello are ignored and logged.
- Path: `$HERDR_WEB_AGENTS_SOCKET`, else `$XDG_STATE_HOME/herdr-web/agents.sock`, else `~/.local/state/herdr-web/agents.sock` (`agentsSocketPath()`). The folder is mode 700, the socket 600, a stale socket from a dead backend is replaced and a live one makes `serveAgents` throw.
- Limits: a line of 4 MiB (`MAX_LINE_BYTES`) ends the connection; the extension drops a `reply` message when more than 1 MiB is waiting to be written (everything else is always written); it reconnects with a delay of 0.5 s doubling to 30 s, quietly, with its socket and timers `unref`'d so it never keeps pi alive.

### Hardening (what a broken pi or file may not do)

- A session file that is not a regular file (a named pipe, a folder) is never opened for blocking reads: one `notice` row says so. A file over 256 MiB is not read (a notice says so); one entry over 32 MiB is one unreadable line and the rest is read; a half-written last line waits for its end. The path in `hello` is used only when it is absolute and ends in `.jsonl`.
- A leaf that is not in the file is taken for the end of the file; missing parents and cycles end the walk instead of looping.
- A line from the extension arriving in many pieces is joined once (not re-copied per piece); a character split between two reads is whole. 4 MiB without a newline ends the connection. At most 256 connections (`maxConnections`); the next is dropped with one log line.
- `serveAgents` replaces a stale *socket* and refuses anything else at the path (`… exists and is not a socket`); it never deletes a file it did not make.
- Two connections for one terminal: each has a monotonic `order` (when it was accepted); the later one wins whichever identifies first. That is for the **same process**: pi loads the extension again on `/new`, `/resume`, `/fork` and `/reload`, so a hello whose `pid` equals the holder's replaces the old connection.
- **A different process is refused while the holder lives.** A pi started inside a pi's terminal (`pi -p`, a sub-agent) inherits `HC_TERMINAL_ID`. The extension therefore connects only in pi's interactive mode (`ctx.mode === "tui"`; print, JSON and RPC runs make no connection at all), and `serveAgents` takes an `admit(hello)` hook through which the backend refuses a hello from another `pid` while the terminal has a live connection (`refused`, one log line; the extension asks again after 60 s, so it pairs once the holder is gone). The wire version stays **1**: `hello` already carried `pid` and `refused` already existed, and an older extension is not misread, it only lacks the mode check.
- **Known and accepted:** an *interactive* pi started inside another interactive pi's terminal gets no chat for as long as the outer one lives (the outer pi holds the terminal; the inner one retries every 60 s). Chat belongs to the terminal, and a terminal has one pi at the keyboard.
- Nothing a connection does can throw into the backend: a thread that cannot be built closes that connection and logs a line.

### The one entry point for the backend

```ts
import { serveAgents } from "@herdr-web/agents"

const server = await serveAgents(agentsSocketPath(), {
  log: (line) => console.log(line),
  onThread: (thread, connection) => { /* a pi identified itself: wire `thread` to the main socket */ },
})
// connection.closed resolves when it goes; thread.onClose fires too. server.close() ends them all.
```

`serveAgents` listens and, for each accepted socket, calls `acceptAgentConnection(socket, { log })`, which is the real entry point if the backend owns the listening itself: pass it each accepted `net.Socket`; it returns `{ identified: Promise<Thread>, closed: Promise<void>, close() }`. `identified` resolves after `hello` **and** the first `state`, so the first `snapshot()` is complete; it rejects if the connection was refused or ended first (a connection that says nothing is closed after 5 s). Nothing else of this package needs to be called.

## How pi's session file is read

`src/pi/session-log.ts` reads the JSONL file as it grows (whole lines only) and walks `parentId` from the leaf the extension reports. The file does not say which entry is the leaf after `/tree` (its last line may be an abandoned branch), which is why `state.leafId` exists. Pi writes the file **after** an extension's `message_end` handler ran, and creates it only with the first assistant message, so the extension sends `entries` one tick later and the adapter re-reads for up to 1.5 s until the leaf is in the file; the reply stays live until then, so the row and the reply change in the same update.

## Tests

```sh
pnpm --filter @herdr-web/agents test         # unit tests: rows from recorded sessions, threads, connections, browser-safety of rows.ts
pnpm --filter @herdr-web/pi-extension test   # the extension against a fake pi and a fake backend; replays of recorded events
pnpm test:agents                             # live: a real pi on a scratch core, once against this package's own socket, once through the real backend (below)
```

Fixtures under `test/fixtures/pi/` are trimmed recordings from pi 1.5.2 (sessions and extension events); `README.md` there says which case is which.

### `pnpm test:agents`

Needs `hc`, `pi`, and the local model `llama-swap/zorro-davidau-3.8-flash-next` (and one reasoning model in pi's list, for the effort check). **Nothing is ever sent to pi while a model other than the local one is selected**: pi's list holds paid providers. The effort check only selects a reasoning model, changes its effort and selects the local model again (in a `finally`), and a `beforeEach` in both files fails any test that would start while pi is on another model. Three files: the two below, and a browser spec in `apps/web` (`e2e-live/chat-live.spec.ts`, see the root README). `live/agents.live.test.ts` (this package alone) makes its own scratch root `/tmp/hw-ag-live-*`, starts a scratch core there (never the default core: every `hc` call runs under `scripts/scratch-env.mjs`), starts pi in a terminal with this repo's extension, and serves the agents socket itself in place of a backend. It checks that: pi starts and answers with the extension loaded and no backend listening; with no `HC_TERMINAL_ID` the extension makes no connection; the thread identifies itself; a message sent through the thread shows live text in growing pieces, then the finished row, never both; a tool call is a running row and then `ok` with its result; stop settles the agent; an effort change is reported back; `/new` and `/reload` typed into the terminal (via `hc send`) give a new connection, empty or on the same rows; a wire-2 hello is refused with the one log line. At the end it checks that `~/.pi/agent/settings.json`, the extensions folder and the sessions folder were not changed by it (no session of the test went into pi's own sessions folder) and that the real core's pid is still running, then stops its scratch core.

`live/backend.live.test.ts` goes through the real backend. It builds the backend first (`pnpm test:agents` runs turbo's build), starts a scratch core in `/tmp/hw-bk-live-*`, starts `apps/backend/dist/index.js` as a child of the test (port 18440, scratch environment, pid recorded and stopped by that pid), signs in, opens the main socket as the app will, and starts pi with this repo's extension (pi finds the backend's socket under the scratch `XDG_STATE_HOME`; no override). It checks: the sign-in and `Origin` refusals; `chat: true` on pi's terminal; a subscription's snapshot; send over HTTP with live text in pieces, the finished row replacing it (never both) and a seq without gaps; a tool row running and then `ok`, and its whole result; stop; a refused effort and a refused model as sentences, a reasoning model's levels and the change reported back, a `model` row; `older`; `/compact`, `/reload` and `/new` through the `/` rule (the input box emptied, the command typed into the terminal, a `reset` on the subscriber); the backend killed and started again under a connected pi (the extension reconnects, a fresh socket sees the same rows, a message still goes through); the terminal ending (subscribers told, the flag off). It prints a few measured numbers at the end (stop latency, time for `/reload` and `/new` to show as a reset, the `/compact` typing time) and checks again that pi's files and the real core are untouched. Prompts are a few words each; the longest wait is the stop test, which cuts the reply as soon as its first live text shows.

