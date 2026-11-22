# @herdr-web/agents

What the backend knows about an agent running in a terminal, and the code that learns it. Today one
agent, **pi**, through **pi-live**, a pi extension that pi-ask-user also bundles (a separate project, `github:Trex-Hub/pi-live`; the contract is its `docs/protocol.md`):

- `packages/agents` (this one): the adapter interface, the row schemas, and the client of a pi's pi-live socket (`src/pi-live/`), which feeds a `Thread` (`src/pi/thread.ts`) with what pi says and reads pi's session file for the rows.
- pi-live runs inside pi and tells, over a local socket, what pi's session file cannot say (the reply while it is written, the session's current leaf, working or settled, the model and effort, queued messages), and carries the app's actions in. Nothing of it is in this repository; the live tests load a pinned copy (root devDependency `pi-live`) with `-e`.

The backend half is `apps/backend/src/chat.ts` and `chat-operations.ts` (how the backend finds the pi-live session files, links them to terminals, serves subscriptions on the main socket and takes the app's actions; `packages/protocol/PROTOCOL.md`, section Chat). This package is what they call.

## 1. The adapter: `Thread`

`src/thread.ts`. An adapter is asked for a **thread** when the backend has connected to an agent's socket for a terminal. A thread is one agent in one terminal, for as long as that agent's connection lives.

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
  setName(name: string): Promise<void>    // `/name <name>`
  compact(instructions?: string): Promise<void>   // `/compact [instructions]`; a failure arrives later as a notice in `live`
  onClose(l: () => void): void; close(): void; readonly closed: boolean
}
```

Every action resolves when pi accepted it and rejects with an `ActionError` whose message is a sentence the app shows as it is ("This model does not take the effort “max”. It takes: off, low.").

`send` does not treat a leading `/` specially; the backend routes (`apps/backend/src/chat-operations.ts`): pi's own commands (`PI_BUILTIN_COMMANDS`, pi-live's list) are typed into the terminal after `clearInput()`, `/compact` and `/name <name>` are actions, and any other `/text` (a skill, a prompt template, an extension's command) is `send`. pi loads pi-live again for `/new`, `/resume`, `/fork` and `/reload`, which shows up as a **new connection** (a new thread; the old one closes with a `goodbye` that says why).

### The rows and the rest: `@herdr-web/agents/rows`

`src/rows.ts` is the schemas (zod) and their types: `Row` (`user`, `assistant`, `thinking`, `tool`, `compaction`, `model`, `notice`), `Live`, `Capabilities` (with `disabled`: the sentence for a pi that cannot be chatted with, null otherwise), `Identity`, `ThreadSnapshot`, `ThreadChange`. **It imports only zod**, so the web app and `packages/protocol` import it through the subpath `@herdr-web/agents/rows` without pulling in Node (a test holds this).

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

## 2. The connection to pi-live

`src/pi-live/wire.ts` (zod shapes of what pi-live sends; `PI_BUILTIN_COMMANDS`, `PI_LIVE_MAX_LINE_BYTES`, `PI_LIVE_MAX_SEND_BYTES`) and `src/pi-live/connection.ts`. NDJSON on the Unix socket a pi's `<session id>.json` names. Finding the files, linking a session to a terminal and reconnecting belong to the caller (the backend).

```ts
const connection = connectPiLive(socketPath, { terminalId, log })   // openPiLive(duplex, …) for a socket that is already made
const { thread, session, chat, control, disabled } = await connection.ready   // thread holds the first picture
const end = await connection.closed   // { shutdown: "quit" | "new" | "reload" | "resume" | "fork" | null, why }
```

- The client says `hello` (`protocol` 1, `client: { name: "herdr-web" }`, `chat: true`) and reads `welcome`; `welcome.chat` is the first picture (state, models, reply, tools, entries), then `state`, `models`, `reply`, `tool`, `entries` and `notice` messages feed the thread. `commands`, `items`, `item_*` and `waitingForUser` are ignored. `ready` rejects when the connection ends or no `welcome` comes within 10 s (`welcomeTimeoutMs`).
- Actions go out as `{ type: "action", reqId, op, … }` and are answered by an `action_result` with the same `reqId`; a thread's action resolves or rejects with the sentence; one with no answer in time rejects (`actionTimeoutMs`).
- **Two states, composer off, rows shown:** no `"chat"` in `welcome.features` → `NO_CHAT` ("Update pi-live to chat with this pi."); `welcome.control` false → `NO_CONTROL` ("Control is off for this pi."). `ready.disabled` is the sentence, the thread's `capabilities.disabled` too, and every action is refused with it.
- `goodbye.shutdown` is how the caller tells a pi quitting (`"quit"`, or a goodbye with no reason) from one about to open a new session (anything else); `null` is a connection that ended with no goodbye (a crash or a dropped socket).
- Limits: a line over 64 MiB (`PI_LIVE_MAX_LINE_BYTES`) closes the connection; a `send` over 1 MiB (`PI_LIVE_MAX_SEND_BYTES`) is refused with `TOO_LONG` before it is written. A line that is not JSON, or a message of a known type that does not fit its shape, is ignored with one log line each.

### Hardening (what a broken pi or file may not do)

- A session file that is not a regular file (a named pipe, a folder) is never opened for blocking reads: one `notice` row says so. A file over 256 MiB is not read (a notice says so); one entry over 32 MiB is one unreadable line and the rest is read; a half-written last line waits for its end. The path pi-live names is used only when it is absolute and ends in `.jsonl`.
- A leaf that is not in the file is taken for the end of the file; missing parents and cycles end the walk instead of looping.
- A line from pi arriving in many pieces is joined once (not re-copied per piece); a character split between two reads is whole.
- Nothing a connection does can throw into the backend: a thread that cannot be built closes that connection and logs a line.

## How pi's session file is read

`src/pi/session-log.ts` reads the JSONL file as it grows (whole lines only) and walks `parentId` from the leaf pi-live reports. The file does not say which entry is the leaf after `/tree` (its last line may be an abandoned branch), which is why `state.leafId` exists. Pi writes the file **after** an extension's `message_end` handler ran, and creates it only with the first assistant message, so pi-live sends `entries` one tick later and the adapter re-reads for up to 1.5 s until the leaf is in the file; the reply stays live until then, so the row and the reply change in the same update.

## Row kinds and ai-sdk

The web uses these rows, not ai-sdk's `UIMessage` (why: [docs/architecture.md](../../docs/architecture.md#decisions)). To keep a converter possible, **every row kind added here must map to an ai-sdk message part**:

| Row | ai-sdk part |
| --- | --- |
| `user` | user message `text` |
| `thinking` | `reasoning` |
| `assistant` | `text` |
| `tool` running / ok / error / interrupted | `tool-*` with `input-available` / `output-available` / `output-error` / `output-error` |
| `compaction`, `model`, `notice` | `data-compaction`, `data-model`, `data-notice` |

## Tests

```sh
pnpm --filter @herdr-web/agents test         # unit tests: rows from recorded sessions, threads, the pi-live connection against a fake pi-live (test/fake-pi-live.ts), browser-safety of rows.ts
pnpm test:agents                             # live: a real pi on a scratch core, once with this package's client alone, once through the real backend, once in a browser (below)
```

Fixtures under `test/fixtures/pi/` are trimmed recordings from pi 1.5.2 (sessions and events); `README.md` there says which case is which.

### `pnpm test:agents`

Needs `hc`, `pi`, and the local model `llama-swap/zorro-davidau-3.8-flash-next` (and one reasoning model in pi's list, for the effort check). **Nothing is ever sent to pi while a model other than the local one is selected**: pi's list holds paid providers. The effort check only selects a reasoning model, changes its effort and selects the local model again (in a `finally`), and a `beforeEach` in both files fails any test that would start while pi is on another model. A test pi is started as `pi -ne -e <llama> -e node_modules/pi-live …` with `PI_LIVE_DIR=<scratch root>/live`: nothing is installed into `~/.pi`, and nothing connects to `~/.pi/agent/live` or to a backend on port 7420 (every backend a test starts is passed that folder explicitly). Three files: the two below, and a browser spec in `apps/web` (`e2e-live/chat-live.spec.ts`).

`live/agents.live.test.ts` (this package alone) makes its own scratch root `/tmp/hw-ag-live-*`, starts a scratch core there (never the default core: every `hc` call runs under `scripts/scratch-env.mjs`), starts pi in a terminal with pi-live, and plays the backend itself: it reads the session files of that folder and connects with `connectPiLive`. It checks that: pi starts and answers with pi-live loaded and no client connected, its session file naming the terminal; with no `HC_TERMINAL_ID` no terminal is named and no client is made; a pi-live with control off gives rows and refuses every action with the sentence; the thread identifies itself; a message sent through the thread shows live text in growing pieces, then the finished row, never both; a tool call is a running row and then `ok` with its result; stop settles the agent; an effort change is reported back; `/new` and `/reload` typed into the terminal (via `hc send`) end the connection with a goodbye that says `new` / `reload` and give a new connection, empty or on the same rows; `compact` and `setName` are actions (nothing is typed into the terminal); `/quit` ends it with `quit` and no new connection comes. At the end it checks that `~/.pi/agent/settings.json`, the extensions folder and the sessions folder were not changed by it (no session of the test went into pi's own sessions folder), that none of the files in `~/.pi/agent/live` names the scratch root, and that the real core's pid is still running, then stops its scratch core.

`live/backend.live.test.ts` goes through the real backend. It builds the backend first (`pnpm test:agents` runs turbo's build), starts a scratch core in `/tmp/hw-bk-live-*`, starts `apps/backend/dist/index.js` as a child of the test (port 18440, scratch environment with `PI_LIVE_DIR` explicit, pid recorded and stopped by that pid), signs in, opens the main socket as the app will, and starts pi with pi-live and a one-command extension of the test (`/hw-ping`, written into the scratch root). It checks: the sign-in and `Origin` refusals; `chat: true` on pi's terminal; a subscription's snapshot; a nested `pi -p` carrying the terminal's id making no link; send over HTTP with live text in pieces, the finished row replacing it (never both) and a seq without gaps; a tool row running and then `ok`, and its whole result; stop; a refused effort and a refused model as sentences, a reasoning model's levels and the change reported back, a `model` row; `older`; `/compact` and `/name <name>` as pi-live actions (`via: "agent"`, nothing typed into the input box); an extension's command from the composer running in pi; `/reload` and `/new` typed into the terminal each giving exactly one `reset` on the subscriber and never an `unavailable`; the backend killed and started again under a connected pi (it finds the pi again, a fresh socket sees the same rows, a message still goes through); `/quit` giving `unavailable` at once; a pi killed with no goodbye giving `unavailable` and the flag off. It prints a few measured numbers at the end (stop latency, time for `/reload` and `/new` to show as a reset) and checks again that pi's files, `~/.pi/agent/live` and the real core are untouched. Prompts are a few words each; the longest wait is the stop test, which cuts the reply as soon as its first live text shows.

`apps/web/e2e-live/chat-live.spec.ts` (`playwright.live.config.ts`, backend on port 18441, web on 14041) drives the same real pi in a browser: a full turn with the message in pi's own screen, a model and an effort change (the local model is selected again over HTTP in a `finally`, and every message checks first that it is current), Stop, `/new` giving an empty thread without the chat ever showing as gone, an extension's command from the composer, a message typed at the terminal appearing in the thread within a second, and the hint on a pi started without pi-live. Screenshots go to `/tmp/hw-shots/dev-26-live`.

All three print one line per turn at the end (`turn "…": working 0.0 s, first output 3.2 s, settled 9.8 s (after send)`): the time from the message being sent to the agent showing as working, to the first output of the model (live text, thinking or a tool) and to the agent being settled, so a model slow to load shows in the gap before "first output" and not only as a timeout. **A wait for the model allows five minutes** (`MODEL_WAIT_MS` in `live/support.ts`): the local model is a llama-swap on another machine that other people's agents share, and its first token has taken over a minute, now and then over two, on a turn that took a second in the run before (pi showing "Working" with nothing arriving, while a plain request to the same server answers in 0.4 s). That is the server, not the code under test; the turn times say when it happens. **A failed run keeps its scratch root**: the core is stopped, the folder is left and its path is printed (`a live test failed: its scratch root is kept at /tmp/… (core stopped; pi's sessions are in …)`); a run that passes removes it through `scripts/scratch-stop --delete`. When the browser spec's wait for a turn runs out, its failure message includes the end of pi's newest session file, the status core reports and the last 40 lines of the terminal.

