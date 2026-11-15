# herdr-web protocol: browser ⇄ bridge

What the web app builds against. Types and validators for every message below are exported by this
package (`@herdr-web/protocol`): `ServerMessageSchema`, `ClientMessageSchema`, `parseServerMessage`,
`parseClientMessage`, `encodeMessage`. Both sides use them; the bridge validates what it receives.

This version covers sign-in, the **main socket**, the **terminal socket** and the **operations**. Chat comes in a later ticket.

`PROTOCOL_VERSION` is **1**. It is bumped when a message changes so that an older browser cannot read it.
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
{ "type": "hello", "protocol": 1, "build": "a1b2c3d" }
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
#### `pong`: answer to `ping`
```json
{ "type": "pong" }
```

### Browser → bridge

#### `ping`
```json
{ "type": "ping" }
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
| 1008 | the browser broke the protocol; the reason says how |
| 1011 | the bridge failed |
| 4404 | core has no such terminal |
| 4408 | no `attach` within 10 s |
| 4410 | the terminal has finished; nothing to attach to (`ended` came first) |
| 4413 | too slow: more than the bridge's bound of output unconsumed (8 MiB), or input core is not reading |
| 4502 | core, or the machine the terminal lives on, cannot be reached, or the line to it dropped. Attach again when it is back |

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
it has one), `503` the bridge is not connected to core. A refusal by the bridge (`404`, `409`) makes
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
  "keep": true, "parent": null, "template": "pi"
}
```
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
