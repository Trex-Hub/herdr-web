# herdr-web protocol: browser ⇄ bridge

What the web app builds against. Types and validators for every message below are exported by this
package (`@herdr-web/protocol`): `ServerMessageSchema`, `ClientMessageSchema`, `parseServerMessage`,
`parseClientMessage`, `encodeMessage`. Both sides use them; the bridge validates what it receives.

This version covers sign-in and the **main socket**. Terminal sockets, operations and chat come in later tickets.

`PROTOCOL_VERSION` is **1**. It is bumped when a message changes so that an older browser cannot read it.
Adding a message type, or a field a client may ignore, does not bump it. Validators drop fields they do not know.

## Where the bridge is

The bridge is its own process (default `http://127.0.0.1:7420`); the web app is configured with its address.
The browser calls it directly with `credentials: "include"` (fetch) and opens the socket from the web app's origin.
The bridge answers only origins listed in `HERDR_WEB_ORIGINS` (comma separated, default `http://localhost:3000`).

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
