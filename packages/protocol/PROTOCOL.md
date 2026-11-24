# herdr-web protocol: browser ⇄ bridge

What the web app builds against. Types and validators for every message below are exported by this
package (`@herdr-web/protocol`): `ServerMessageSchema`, `ClientMessageSchema`, `parseServerMessage`,
`parseClientMessage`, `encodeMessage`. Both sides use them; the bridge validates what it receives.

This version covers sign-in, the **main socket**, the **terminal socket**, the **operations** and **chat** (a thread of rows per terminal, read over the main socket and acted on over HTTP).

`PROTOCOL_VERSION` is **2**. It is bumped when a message changes so that an older browser cannot read it.
Adding a message type, or a field a client may ignore, does not bump it. Validators drop fields they do not know.

## Where the bridge is

The bridge is its own process (default `http://127.0.0.1:7420`); the web app is configured with its address.
The browser calls it directly with `credentials: "include"` (fetch) and opens the socket from the web app's origin.
The bridge answers only origins listed in `HERDR_WEB_ORIGINS` (comma separated, default `http://localhost:3000` and `http://127.0.0.1:3000`).

## Sign-in (plain HTTP, JSON)

| Request | Result |
|---|---|
| `POST /api/login` body `{"passphrase": "…"}` | `200 {"signedIn": true}` and a `Set-Cookie`; `401 {"error": "wrong passphrase"}`; `400` for a body that is not that; `429` with `Retry-After` (seconds) and `{"error":"too many attempts","retryAfterSeconds":N}` while slowed down; `403` from a foreign `Origin` |
| `POST /api/logout` | `200 {"signedIn": false}`; clears the cookie on this device only |
| `GET /api/session` | `200 {"signedIn": true|false}` |
| `GET /health` | open; `{"core": {…}|null, "connection": "connected", "seq": 12}`. `error` (why the last connection to core failed; it names core's socket path) is added only for a signed-in caller |
| `GET /terminals` | needs the cookie (`401` without); debugging view, `?all=1` includes finished terminals |

The cookie is `herdr_web_session`: HttpOnly, SameSite=Lax, `Secure` when the request came over HTTPS, 30 days,
renewed by every authenticated request and by a socket upgrade. Changing `HERDR_WEB_PASSPHRASE` and restarting
the bridge signs every device out. After 5 wrong passphrases in a row each further failure doubles the wait
(1 s, 2 s, 4 s … up to 15 min); during the wait every attempt gets `429`, the right passphrase included.

## Main socket: `GET /api/ws` (WebSocket)

- The upgrade is refused with `401` without a valid cookie, `403` when `Origin` is missing or not allowed, `404` on another path.
- All messages are JSON text. A binary message from the browser closes the socket (code 1003); an invalid
  message closes it (1008).
- On connect the bridge sends `hello`, then `snapshot`, then one small message per change, in order.
  **There is no resume**: a reconnect always starts with `hello` and a fresh `snapshot`. Reconnect with backoff; treat
  data as stale while the socket is down.
- A browser that stops reading is closed (1013) once too many bytes queue up for it; reconnect.
- If `hello.protocol` is not the version the web app was built with, or `hello.build` differs from the build the page
  was loaded from, ask the user to reload.

### Bridge → browser

#### `hello`: first message
```json
{ "type": "hello", "protocol": 2, "build": "a1b2c3d" }
```

#### `snapshot`: everything, once, right after `hello`
```json
{
  "type": "snapshot",
  "connection": { "state": "connected", "error": null, "core": { "id": "9f2c", "name": "mac", "version": "0.1.21" } },
  "terminals": [ { "address": "t7", "…": "see Terminal" } ],
  "machines": [ { "name": "cachyos", "…": "see Machine" } ],
  "layouts": [ { "machine": null, "status": "ok", "…": "see Layout" } ]
}
```
`terminals` includes finished ones (`state: "finished"`); `hc ls` hides those, the web app decides what to show.
`layouts` has one entry for the bridge's own core (`machine: null`) first, then one per machine added to it.

#### `terminal`: a terminal was added or changed (whole record)
```json
{ "type": "terminal", "terminal": { "address": "t7", "…": "…" } }
```
#### `terminal.removed`: core forgot a terminal
```json
{ "type": "terminal.removed", "address": "t7" }
```
#### `machines`: the machine list changed (whole list)
```json
{ "type": "machines", "machines": [ { "name": "cachyos", "state": "unreachable", "…": "…" } ] }
```
Core sends no event when a machine's line drops; the bridge polls every 15 s, so this can lag.
#### `layout`: one machine's spaces/tabs/panes changed (whole layout of that machine)
```json
{ "type": "layout", "layout": { "machine": "cachyos", "status": "ok", "reason": null, "version": 15, "spaces": [] } }
```
#### `layout.removed`: a machine was removed from core
```json
{ "type": "layout.removed", "machine": "cachyos" }
```
#### `connection`: the bridge's connection to core changed
```json
{ "type": "connection", "connection": { "state": "reconnecting", "error": "cannot connect to core", "core": null } }
```
`state` is `connecting`, `connected`, `reconnecting` or `stopped`. While it is not `connected` the other data is the
last known and may be stale; when it is `connected` again, changes since the outage arrive as ordinary `terminal`,
`terminal.removed` and `layout` messages (only what differs).
#### `app.shared`: herdr-app's groups and names (read-only)
```json
{ "type": "app.shared", "shared": { "agents.groups": [{ "id": "g1", "name": "ayra-oauth" }], "agents.groupLabel": { "gr-g1": "ayra", "gr-": "freebrawl" },
  "agents.agentGroup": { "t20": "g1" }, "agents.agentLabel": { "t20": "AYR-59" }, "agents.spaceGroup": { "sp1": "g1" }, "space.colors": { "sp1": "ansi6" } } }
```
Sent right after `snapshot` when herdr-app's `shared.json` exists, and again whenever it changes. The bridge only reads that file (`~/.config/herdr-app/shared.json`,
or the path in `HW_HERDR_APP_SHARED`); it never writes it, and it sends only these six keys. Malformed entries are dropped, so every key is
present. `shared` is `null` when the file has gone away; while there is no file, nothing is sent. Agent keys are terminal addresses (`t20`, `machine/t20`); space keys are space ids
(`sp…`, `machine/sp…`). A browser that does not know this message ignores it.
#### `pong`: answer to `ping`
```json
{ "type": "pong" }
```

#### `chat.snapshot`: a thread, once, after `chat.subscribe`
```json
{
  "type": "chat.snapshot",
  "terminal": "t7",
  "snapshot": {
    "seq": 3,
    "identity": { "agent": "pi", "terminalId": "t7", "sessionId": "01a1…", "sessionFile": "/Users/x/.pi/agent/sessions/….jsonl", "title": "Fix the build", "cwd": "/Users/x/work" },
    "rows": [ { "kind": "user", "id": "8c0acb2a", "at": 1731600000000, "text": "hi", "images": 0 } ],
    "hasMore": false,
    "live": { "working": false, "reply": null, "tools": [], "pending": [], "usage": null, "notice": null, "asks": [], "waiting": null },
    "capabilities": { "send": true, "stop": true, "models": null, "efforts": null }
  }
}
```
The thread as it is now: identity, the last page of rows (50), `hasMore` when older ones exist, live state and capabilities. See Chat.
#### `chat.change`: one change of a subscribed thread
```json
{ "type": "chat.change", "terminal": "t7", "change": { "type": "update", "seq": 4, "live": { "working": true, "reply": { "blocks": [ { "kind": "text", "text": "Par" } ] }, "tools": [], "pending": [], "usage": null, "notice": null, "asks": [], "waiting": null } } }
```
`change` is a `ThreadChange` (see Chat): an `update` with the next `seq`, or a `reset`.
#### `chat.unavailable`: the terminal has no chat (now)
```json
{ "type": "chat.unavailable", "terminal": "t7", "reason": "The agent in this terminal has disconnected from the bridge." }
```
`reason` is a sentence. The subscription stays: when an agent connects for the terminal you get a `chat.change` carrying a `reset`.

### Browser → bridge

#### `ping`
```json
{ "type": "ping" }
```
#### `chat.subscribe`
```json
{ "type": "chat.subscribe", "terminal": "t7" }
```
`terminal` is a terminal of the bridge's own computer (`t7`, never `machine/t7`; anything else closes the socket, 1008). The answer is
`chat.snapshot`, or `chat.unavailable` (not running, or no agent connected). Subscribing again to the same terminal starts over with a fresh
snapshot. At most 16 at once on a socket (the 17th is answered with `chat.unavailable`). Closing the socket drops them all.
#### `chat.unsubscribe`
```json
{ "type": "chat.unsubscribe", "terminal": "t7" }
```

## Terminal socket: `GET /api/terminal/<address>` (WebSocket)

One socket per terminal view. `<address>` is the terminal's address as in `Terminal.address`: `t7`, or `cachyos/t7`
on an added machine (the slash stays). `terminalSocketPath(address)` and `parseTerminalSocketPath(path)` build and read it;
anything that is not an address is `404`.

- The upgrade is judged like the main socket's: `404` on a path that is no address, `403` when `Origin` is missing or not
  allowed, `401` without a valid cookie. Nothing is sent to core before the first message.
- The bridge opens its own connection to core for every view and attaches there; closing the socket (or losing it) detaches.
  Two views on one terminal are two attaches. The one that was active last (attached, typed, resized or gained focus) sets the terminal's size.
- Text messages are JSON, binary messages carry bytes. A message larger than 1 MiB closes the socket.

### Browser → bridge, text

#### `attach`: must be the first message (within 10 s), once
```json
{ "type": "attach", "cols": 100, "rows": 30, "history": 10000,
  "display": { "fg": "#d4d4d4", "bg": "#1e1e1e", "cursor": null, "cell": [9, 18] } }
```
`cols` and `rows` are the view's size in cells (1 to 1000). `history` is how many scrollback lines the first paint includes (0 to 100000).
`display` tells programs what the viewer looks like: default colours as `#rrggbb` (or `null`) and the cell size in **device** pixels.
Core uses it to answer colour and size queries.
#### `resize`, `focus`, `display`
```json
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "focus", "focused": true }
{ "type": "display", "display": { "fg": "#111111", "bg": "#fafafa", "cursor": null, "cell": [10, 20] } }
```
Send `resize` and `focus: true` when the view is shown or focused (the last active viewer sets the size), `display` when colours or cell size change.
#### `consumed`: the credit
```json
{ "type": "consumed", "bytes": 65536 }
```
The bytes of output the emulator has parsed since the last `consumed`. Core sends output within a 256 KiB window and the bridge
passes this on as CREDIT **only now**, so a browser that stops sending `consumed` stops core. A `consumed` for more bytes than
were sent closes the socket (1008). Batch it: a message per few KiB parsed, not per byte.

### Bridge → browser, text

#### `attached`: attached on core; output follows
```json
{ "type": "attached", "cols": 100, "rows": 30, "automaticInput": true }
```
`cols` and `rows` are the terminal's size on core. `automaticInput` says whether tag `2` below is sent to core as automatic
input (true) or falls back to ordinary input (false: an older core on the path).
#### `ended`: the terminal ended; the socket closes right after (1000)
```json
{ "type": "ended", "reason": "exited", "exitCode": 0, "signal": null }
```
`reason` is core's (`exited`, `killed`, `server_stop`, …). A terminal that had already finished gets `ended` and close `4410`.

### Binary messages: `[tag][bytes…]`

| tag | direction | meaning |
|---|---|---|
| `0` | bridge → browser | output: bytes the program wrote; the first paint comes first. Feed them to the emulator as they are (a paint may begin with `CAN`, `0x18`) |
| `1` | browser → bridge | **human input**: keys, paste, mouse. Goes to core as DATA |
| `2` | browser → bridge | **automatic replies**: bytes the emulator produced by itself (answers to device queries). Goes to core as AUTOMATIC_INPUT, which does not count as a person typing. Tag them where they are produced; never guess from the bytes |

`tagMessage(tag, bytes)` and `splitTagged(message)` build and read them. An empty message, an unknown tag, or tag `0` from the browser closes the socket (1008).
The bridge also closes a view whose input piles up unread on core's side (4413).

### Close codes

| code | meaning |
|---|---|
| 1000 | the terminal ended (`ended` came first) |
| 1007 | WebSocket level: a text message that is not valid UTF-8 (the `ws` library closes the socket itself) |
| 1008 | the browser broke the protocol; the reason says how |
| 1009 | WebSocket level: a message larger than 1 MiB |
| 1011 | the bridge failed |
| 4404 | core has no such terminal |
| 4408 | no `attach` within 10 s |
| 4410 | the terminal has finished; nothing to attach to (`ended` came first) |
| 4413 | too slow: more than the bridge's bound (8 MiB) of output the browser has not reported as parsed **or** the socket has not delivered (a browser that keeps sending `consumed` without reading does not escape this), or input core is not reading |
| 4502 | core, or the machine the terminal lives on, cannot be reached, or the line to it dropped. Also a **kept** terminal whose stream closed for a reason other than its program exiting or being killed (core stopping, for one): it comes back when core does, so there is no `ended` and no 4410. Attach again when it is back |

The close reason is a short English text the app may show. A browser that is told 4502 (or loses the socket without a code) while
the terminal is live should reattach by itself with backoff; each attach starts with a fresh paint, nothing is resumed.

## Operations: `POST /api/ops/<name>` (plain HTTP, JSON)

The browser changes core only through these five named operations; it never calls core's API. They are
plain HTTP rather than main-socket messages because each has one answer the caller waits for, and a
refusal carries a status code. Same rules as sign-in: the session cookie is required (`401` without),
and a browser's `Origin` must be allowed (`403`); CORS with credentials as for `/api/login`. A body
that does not fit its type is a `400`; extra fields are refused too, so the browser cannot name a
folder or a tab id. Nothing is queued: while the bridge is not connected to core every operation answers `503`.

Success is `200` with the result below. Every failure is `{"error": "<a sentence to show as is>"}`:
`400` bad input, `404` unknown terminal, space, machine or template, `409` refused by a rule (the
sentence says which), `502` core refused or failed (its own words, with its hint in brackets when
it has one), `503` the bridge is not connected to core, `504` core did not answer within 10 seconds (the sentence says so; the call may or may not have happened, look at the terminal list before trying again). A refusal by the bridge (`404`, `409`) makes
no call to core, except an unknown or unusable template name, which is found out by reading
`templates.list`.

The bridge checks every input against its own copy of terminals and layouts. Terminal addresses are
`t7` or `machine/t7`; `turn` and the labels come from the bridge's terminal store.

#### `start`: a new terminal in an existing space

```json
{ "machine": null, "space": "sp3a9", "what": { "kind": "shell" } }
```

`machine` is `null` for the core the bridge is connected to, or the machine's name; `space` is the
space's id in that machine's layout document; `what` is `{"kind":"shell"}` (that machine's own
shell), `{"kind":"pi"}` or `{"kind":"template","name":"<template>"}` (a name in core's `templates.list`).
Refused (`404`) for an unknown machine, space or template, and (`409`) when that machine's layout
cannot be read or the template cannot be used. The bridge takes the folder from its own copy of the
layout and calls `terminal.run` with `cwd` = that folder, `on` = the machine (added machines only),
`keep: true`, `no_parent: true`, `argv` = `["pi"]` or `["<template>"]` (none for a shell), and labels
`herdr.space=<space id>`, `herdr.tab=tb<32 hex digits>` (a fresh id), `herdr.seen=0`.

```json
{ "address": "cachyos/t11" }
```

#### `kill`: end a terminal

```json
{ "terminal": "t7" }
```

`404` for an unknown terminal, `409` when it has already ended. Calls `terminal.kill`.

```json
{ "address": "t7", "reason": "killed", "exitCode": null, "signal": 1 }
```

A terminal started with `keep` that is killed stays finished when core restarts (checked on core
0.1.21, for a shell and for a program), so the kill does not turn keep off first.

#### `seen`: raise `herdr.seen`

```json
{ "terminal": "t7", "turn": 3 }
```

Only raises: `409` when `turn` is at or below the current `herdr.seen` label (a missing label is
below everything), or above the terminal's current `turn`, or when the terminal has ended.

```json
{ "address": "t7", "seen": 3 }
```

#### `unread`: mark unread

```json
{ "terminal": "t7" }
```

Writes `herdr.seen=<turn − 1>`; `409` when `turn` is 0 (nothing has finished yet). Answers like `seen`.

#### `pin`: pin or unpin

```json
{ "terminal": "t7", "pinned": true }
```

Writes `herdr.pinned=1`, or the empty value (which removes the label) for `false`.

```json
{ "address": "t7", "pinned": true }
```

#### `GET /api/starters`: what the "+" menu offers

Needs the cookie. Reads core's `templates.list` each time (templates that core marks unusable are left out).

```json
{ "starters": [
  { "kind": "shell", "name": "Shell", "description": "The machine's own shell" },
  { "kind": "pi", "name": "pi", "description": "The pi coding agent" },
  { "kind": "template", "name": "reviewer", "description": "Reviews a diff" } ] }
```

## Chat: threads on the main socket, actions over HTTP

A chat is the conversation of an agent running in one terminal of the bridge's own computer. Today the agent is **pi**, which
runs **pi-live** (version 0.2 or later; pi-ask-user also bundles it); the bridge connects to each pi's pi-live socket itself (see
"The pi-live folder"). A terminal on an added machine never has chat.

The rows, live state, capabilities and changes are the schemas of **`@herdr-web/agents/rows`** (`RowSchema`, `LiveSchema`,
`CapabilitiesSchema`, `IdentitySchema`, `ThreadSnapshotSchema`, `ThreadChangeSchema`); this package re-uses them and keeps no second copy.

### Reading: subscribe on the main socket

A subscription is to a **terminal**, not to one thread object. pi loads pi-live again on `/new`, `/resume`, `/fork` and `/reload`;
the bridge sees a new session file for the same terminal and every subscriber simply gets
`{"type":"chat.change","change":{"type":"reset","seq":N,"snapshot":{…}}}` with the new thread (a `reset` replaces everything the app holds
for that terminal, paged-in rows included). Those four never show as `chat.unavailable` in between: the bridge keeps the terminal's chat for up to 10 seconds, waiting for the pi's new session file. When the agent goes away for good (`/quit`, a crash, the pi's session file gone) the subscriber gets `chat.unavailable` at once; when one comes back, a `reset`.
Several tabs may hold the same terminal's thread.

After `chat.snapshot` (seq *n*) every change has seq *n*+1, *n*+2, …; a gap, or a seq not above what the app holds, means: subscribe again.

**`ThreadSnapshot`**: `seq`, `identity` (`agent`, `terminalId`, `sessionId`, `sessionFile`, `title`, `cwd`), `rows` (the last page, oldest first),
`hasMore`, `live`, `capabilities`, `todos` (optional: the agent's todo list, see below; absent or `null` when it has none to show).

**Rows** (`kind`): every row has a stable `id` (the session entry's id, plus `.<n>` for the n-th block of an assistant message) and `at` (ms since epoch or `null`).
- `user`: `text`, `images` (a count; image data is not carried).
- `assistant`: `text`, `model` (`provider/id` or `null`), `effort` (the thinking level the reply was written at, e.g. `high`, `off`; `null` when the session file does not say).
- `thinking`: `text`. No duration is carried.
- `tool`: `callId`, `name`, `args` (strings longer than 1000 characters are cut; `argsTruncated`), `status` (`running`, `ok`, `error`, `interrupted`), `result` (`{text, truncated, totalChars}` or `null`; `text` is cut at 4000 characters, the rest via the `result` operation), `durationMs`, `byUser` (a `!command`), `details` (only for `ask_user`, `link_send`, `link_list`, `link_compact` and `todo`: the tool result's `details`; for `ask_user` it says what was asked and answered, whoever answered, for the pi-link tools whether the call did its job, which pi-link reports there and not as an error, and for `todo` `{action, error?, tasks}` with the tasks trimmed as `todos` below, deleted ones included, so a row can name the task it touched; left out when its JSON is over 16,000 characters).
- `compaction`: `summary`, `tokensBefore`.
- `model`: `model`. The model was changed inside the session (not the one it started with; picking the model already in use writes nothing). The app draws "Switched to …".
- `notice`: `level` (`info`, `warning`, `error`), `text`: "Stopped.", a failed model call, a line of the session file that could not be read, a session file that is too big to show, or a message an extension showed in the chat (a `custom_message` with `display: true`). Such a message also carries `source` (its `customType`, e.g. `link` for what pi-link received) and `details` (the message's `details`, left out when its JSON is over 16,000 characters), so the app can give a source a view of its own; any other notice has neither. `PROTOCOL_VERSION` stays 2 for these two fields: a browser of this version that does not know them strips them and shows the notice line.

**`live`** (always replaced whole): `working`; `reply` (`{blocks: [{kind: "text"|"thinking", text}]}` as accumulated, or `null`); `tools` (started, not ended; each `{callId, name, argument?}`, `argument` being the call's main argument — the command, path, pattern or such — cut at 200 characters, for the live line); `pending` (messages sent while the agent works and not yet taken: `{id, text, mode: "steer"|"followUp"}`); `usage` (`{tokens, window, percent}` or `null`); `notice` (one line that is not in the session file, such as "Compaction failed: Nothing to compact"); `asks` (the `ask_user` prompts open now, oldest first: see below). `waiting` (`{kind, title}` or `null`: one of pi's own dialogs is open, such as an extension's `ctx.ui.confirm` or a picker, and only the terminal can answer it; `kind` is `select`, `confirm`, `input`, `editor` or `custom`, and a kind the app does not know is kept as it is; `title` is `null` when pi gives none; `ask_user` opens through `custom`, so a prompt of `asks` is also a `waiting`, and the app shows one of the two. It comes from pi-live's `state.waitingForUser`, is `null` for a pi-live that does not send it, and clears when the pi says goodbye or the connection ends). `PROTOCOL_VERSION` stays 2 for this field: a browser of this version that does not know `waiting` strips it and reads everything else, and a browser newer than its backend is already refused by the `hello.build` check.
A finished message becomes a row within a second, in the same `update` that clears `live.reply`: never both, never neither.

**`capabilities`**: `send`, `stop`, `models` (`{list: [{id: "provider/id", name, reasoning}], current}` or `null`), `efforts` (`{list, current}` or `null`; one level means nothing to choose), `disabled` (optional: a sentence when the pi cannot be chatted with — "Update pi-live to chat with this pi." for a pi-live without chat, "Control is off for this pi." for a pi that refuses control — and `null` or absent otherwise. While it is set, `send` and `stop` are `false`, `models` and `efforts` `null`, the rows are still shown, and every operation answers 409 with the same sentence).

**`todos`** (optional on the snapshot, replaced whole on an update; `null` in an update means the list went away): the agent's todo list from `@juicesharp/rpiv-todo`, `{tasks: [{id, subject, status, activeForm?, blockedBy?}]}` with `status` `pending`, `in_progress` or `completed` (deleted tasks are left out; `subject` and `activeForm` are cut at 300 characters). It is a field of the thread and not only of the `todo` rows because the snapshot holds the last page of rows, and the call that wrote the list may be on an older one. It is the **last valid snapshot** on the branch: the `details` of the last `todo` tool result, or, once the branch has any `rpiv-todo-state` entry (rpiv-todo writes one on every change, which also captures a call made through another tool), the last of those entries. A snapshot that does not validate (an id that is not an integer or is used twice, a status of any other name) is skipped whole; one whose tasks, deleted ones left out, come to over 16,000 characters is not taken. A list with every task done is dropped when the next user message arrives. `PROTOCOL_VERSION` stays 2: the field is optional, and a browser that does not know it strips it.

**`ThreadChange`**: `{"type":"update","seq":n,"rows"?,"live"?,"capabilities"?,"identity"?,"todos"?}` (rows are upserts by id: a known id is replaced where it is, a new one goes at the end) or `{"type":"reset","seq":n,"snapshot":{…}}`.

Older rows are asked for with `older`. A page that was asked for before a `reset` arrived and answered after it must be dropped by the app.

**`asks`** hold the prompts the pi's pi-ask-user (the Trex-Hub fork) has parked on pi-live. Each is `{id, kind, title, view, openedAt, expiresAt}`: `id` is the `ask_user` tool call's id (the `callId` of its row and live tool), `expiresAt` is ms since epoch or `null`.
- Kind `ask_user.question`: `view` is `{question, context?, options: [{title, description?}], allowMultiple, allowFreeform, allowComment}`.
- Kind `ask_user.batch`: `view` is `{heading?, allowComment, questions: [{question, context?, options, allowMultiple, allowFreeform}]}`.

A prompt leaves `asks` when it is answered (from anywhere), cancelled, timed out, or when the pi goes away. A pi without the fork (or with pi-live off, or in RPC mode) parks nothing: its `ask_user` tool has no ask.

### Acting: `POST /api/chat/<name>`

Plain HTTP with a JSON body, the same cookie and `Origin` rules as the operations. Every operation checks, before anything is asked of the agent, that the
terminal is **live**, **on this computer** and has a **chat**. A failure is `{"error": "<a sentence to show as it is>"}`.

| name | body | success |
|---|---|---|
| `send` | `{"terminal":"t7","text":"…"}` (1 to 100,000 characters) | `{"via":"agent"}` or `{"via":"terminal"}` |
| `stop` | `{"terminal":"t7"}` | `{"ok":true}` |
| `model` | `{"terminal":"t7","model":"provider/id"}` (one of `capabilities.models.list`) | `{"ok":true}` |
| `effort` | `{"terminal":"t7","effort":"high"}` (one of `capabilities.efforts.list`) | `{"ok":true}` |
| `older` | `{"terminal":"t7","before":"<row id>","limit":50}` (`limit` 1 to 200, optional) | `{"rows":[…],"hasMore":true}`: the rows before `before`, oldest first |
| `result` | `{"terminal":"t7","row":"<tool row id>"}` | `{"text":"…"}`: the whole result its row cut |
| `answer` | `{"terminal":"t7","id":"<ask id>","answer":{…}}` | `{"status":"delivered"}`, `{"status":"invalid","reason":"…"}`, `{"status":"closed"}` or `{"status":"not_found"}` |

Status codes: `400` input that does not fit (`Bad request: <field>: <reason>.`; a terminal on another machine is this), `401`, `403`, `404` no such terminal or operation,
`409` the terminal has ended, has no chat (the sentence says why), or the agent refused (its own sentence, such as "This model does not take the effort “max”. It takes: off, low."),
`502` core refused the typing of a `/command` (its words), `503` the bridge is not connected to core, `504` core did not answer within 10 seconds.

**Where a message goes** (`send`). The bridge decides by the text:

- not starting with `/`: a pi-live `send` (`{"via":"agent"}`); a message over 1 MiB is refused with a sentence;
- `/compact [instructions]`: pi-live's `compact` action (`{"via":"agent"}`); `/name <name>`: `set_name` (`{"via":"agent"}`);
- the first word is one of **pi's own commands** (pi-live's list: `settings model thinking scoped-models login logout llama new resume name session tree fork clone compact import copy export share bug trust mcp reload hotkeys changelog quit`, case-sensitive): the bridge has the agent empty its input box (`clear_input`, so the command is not appended to a draft), then types the text and Enter into the terminal with core's `terminal.send` (`{"via":"terminal"}`). If the input box cannot be emptied nothing is typed. This is the one write the chat makes to core. pi shows the result in its own screen; for `/new`, `/resume`, `/fork` and `/reload` the thread arrives as a `reset`;
- any other `/text` (a skill such as `/skill:review`, a prompt template, an extension's command): a pi-live `send` (`{"via":"agent"}`), which pi runs as it runs anything it is sent.

A message that merely contains a slash later, or starts with a space, is an ordinary message.

**Answering** (`answer`). `id` is an `ask.id`. The bridge does not check the answer: it passes it to pi-live, and pi-ask-user decides.
- A question: `{"kind":"selection","selections":["Blue"],"comment":"…"}` (`comment` optional, only where `allowComment`) or `{"kind":"freeform","text":"…"}`.
- A batch: `{"answers":[{"status":"answered","response":{…}},{"status":"skipped"}]}`, one entry per question, in order. A single question has no skip.
- Results: `delivered` (the prompt took it and will close); `invalid` (pi-ask-user's own `reason`, such as `option "Purple" not offered`; the prompt stays open); `closed` (it was answered or closed already); `not_found` (the pi never had that prompt).
- All four are HTTP 200. The other failures are the usual ones (no chat, `409`; pi did not answer in time, `409`). An answer works with control off. Whoever answers first wins: the others see the ask leave `asks`.

### The pi-live folder (pi ⇄ bridge)

Not for the browser. The bridge reads one folder, once, at start: `$PI_LIVE_DIR`, else `dir` in `<agent dir>/pi-live.json`, else `<agent dir>/live` (agent dir:
`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). pi-live writes a `<session id>.json` there per pi (`sessionId`, `pid`, `socketPath`, `startedAt`, `mode`,
`terminal`, `cwd`, `sessionFile`). The bridge watches the folder (and looks again every few seconds), and for each file whose `mode` is `tui` and whose `terminal`
is a live terminal of the bridge's own machine it connects to `socketPath` as a chat client (`hello`: `client.name` `herdr-web`, `chat: true`; the contract is pi-live's
`docs/protocol.md`), one connection per session id. A file that is gone, half-written or odd is skipped quietly; one that is wrong is logged once.

- A pi in a terminal that already has a pi with another `pid` is not linked (the first keeps the terminal; one log line for the second): a pi started inside a pi's terminal carries the same terminal id. The same `pid` replaces: `/new`, `/resume`, `/fork` and `/reload` load pi-live again in the same pi. pi-live 0.1 names no terminal, so such a pi has no chat.
- `goodbye` with `shutdown` other than `quit` (`new`, `resume`, `fork`, `reload`): the terminal's chat is kept for up to 10 seconds, waiting for a session file with the same `pid` and `terminal` (a `reload` keeps its session id and comes back at the same path with a new `startedAt`; the old file is not read again); on arrival the subscribers get a `reset` and no `chat.unavailable`. `quit`, or a connection that ended with no goodbye while the pi's file is gone or its process is dead, ends the chat at once.
- A connection that dropped while the pi is still there (its file exists, its `pid` lives) is made again with a backoff; subscribers get `chat.unavailable` only if that has not worked within the same 10 seconds.
- Two states with the rows shown and the composer off (`capabilities.disabled`): no `"chat"` in `welcome.features` ("Update pi-live to chat with this pi.") and `welcome.control` false ("Control is off for this pi."). Every action on such a thread is refused with that sentence.
- Limits: a line over 64 MiB from pi closes the connection; a `send` over 1 MiB is refused before it is written.

## Records

**Terminal** (core's field names; `…_ms` are milliseconds since epoch):
```json
{
  "address": "cachyos/t7", "name": null, "state": "live", "argv": ["pi"], "cwd": "/home/x",
  "cols": 200, "rows": 50, "created_ms": 1731600000000, "finished_ms": null,
  "exit_code": null, "signal": null, "reason": null, "title": "pi",
  "labels": { "herdr.seen": "2", "where": "work / main" },
  "status": { "state": "working", "app": "pi", "msg": "thinking" }, "status_ms": 1731600005000, "turn": 3,
  "foreground": { "pid": 9, "name": "node", "argv": ["node"], "cwd": "/home/x" },
  "keep": true, "parent": null, "template": "pi", "chat": false
}
```
`chat` is `true` while the bridge is connected to (or, up to 10 seconds, waiting for) the pi-live of an agent in this terminal, so a chat can be subscribed to (see Chat); it changes
without core saying anything, as an ordinary `terminal` message. It is always `false` for a terminal on an added machine.
`address` is `t7` on the bridge's core and `machine/t7` on an added machine. `state` is `live` or `finished`
(`reason`, `exit_code`, `signal` and `finished_ms` say how it ended). `status.state` and `status.kind` are the
program's own words; do not map them to a closed list. Fields core leaves out arrive as `null` (`turn` as `0`,
`title` as `""`, `keep` as `false`).

**Machine**:
```json
{ "name": "cachyos", "id": "5e1…", "host": "cachyos", "target": "ssh://devendra@cachyos", "version": "0.1.21",
  "state": "connected", "why": null, "since_ms": 1731600000000, "temporary": false }
```
`state` is `connecting`, `connected`, `needs_login` or `unreachable`; `why` explains when it is not connected.

**Layout** (one machine's `herdr-app` document, reduced to what a viewer needs):
```json
{
  "machine": "cachyos", "status": "ok", "reason": null, "version": 14,
  "spaces": [
    { "id": "sp3650…", "name": "devendra - cachyos", "folder": "/home/devendra",
      "tabs": [
        { "id": "tb0e…", "name": "inference",
          "panes": [ { "id": "p1…", "kind": "terminal", "terminal": "cachyos/t7" },
                     { "id": "p2…", "kind": "other", "mod": "chat" } ] } ] } ]
}
```
- `machine` is `null` for the bridge's own core, otherwise the machine's name.
- `status`: `ok`; `empty` (no layout document written on that machine yet); `unavailable` (could not be read or understood, or
  the machine is not connected). `reason` says why and `spaces` is `[]`.
- A tab's `name` is `""` when unnamed; show its position (1, 2, …) instead.
- `panes` are in tree order (depth first); split geometry is not carried. `terminal` is an address as in `Terminal.address`,
  qualified with the machine for added machines. `other` is a pane with no terminal (`mod` names a mod pane such as `chat`, else `null`).
- Spaces and tabs keep the order of the document. The layout is read-only here: the bridge never writes it.
- A terminal may be in no pane (not every terminal is in a layout), and a pane may name a terminal not in `terminals`
  (it ended or is not listed); both are normal.
