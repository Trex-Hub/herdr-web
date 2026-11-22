# Configuration

Everything is set through environment variables. The backend also reads a `.env` file at the repository root if one exists (it is git-ignored).

## Backend

| Variable | Default | Meaning |
| --- | --- | --- |
| `HERDR_WEB_PASSPHRASE` | (required) | The sign-in passphrase. The backend will not start without it. Changing it signs every device out. |
| `HERDR_WEB_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Web origins allowed to call the backend, comma-separated. |
| `PORT` | `7420` | The backend's port. It listens on `127.0.0.1` only. |
| `HERDR_WEB_BUILD_ID` | git short hash | The build id the backend reports. |
| `HW_HERDR_APP_SHARED` | `~/.config/herdr-app/shared.json` | herdr-app's shared file. Agent groups, agent names and space colours for the sidebar come from it. The backend watches it and never writes it. |
| `HC_SOCKET`, `HC_SESSION` | | Which core to connect to (see below). |
| `PI_LIVE_DIR` | | pi-live's folder (see below). |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's agent folder, used to find pi-live's folder. |

### Which core

The backend uses the first of these sockets that exists:

1. `HC_SOCKET`
2. `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`
3. `/run/user/<uid>/herdr-core/<session>.sock`
4. `$XDG_STATE_HOME/herdr-core/<session>/<session>.sock` (`XDG_STATE_HOME` defaults to `~/.local/state`)

`<session>` is `HC_SESSION`, which defaults to `default`.

### Which pi-live folder

pi-live writes one `<session id>.json` per running pi into a folder. The backend watches that folder and connects to each pi's socket. It takes the first of these:

1. `PI_LIVE_DIR`
2. `dir` in `<agent dir>/pi-live.json`
3. `<agent dir>/live`

`<agent dir>` is `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that is unset. pi-live and the backend must agree on the folder.

## Web app

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | port 7420 on the host the page was opened from | Where the backend is. It is fixed at build time (`pnpm web build`). |

The default follows the page's host on purpose. A fixed `127.0.0.1` would be a different site from `localhost`, and the browser would not send the sign-in cookie.

To open the app from another address, add that address's origin to `HERDR_WEB_ORIGINS`. If you forget, the sign-in page tells you that the backend refused the page. If the backend is not running at all, it says that instead.

## Debugging endpoints

```sh
curl 127.0.0.1:7420/health                    # core version, connection state, seq; no sign-in needed
curl -c jar -H 'Content-Type: application/json' -d '{"passphrase":"…"}' 127.0.0.1:7420/api/login
curl -b jar 127.0.0.1:7420/terminals          # live terminals and machines, like `hc ls --json`
curl -b jar '127.0.0.1:7420/terminals?all=1'  # finished terminals too, like `hc ls --all`
```

`/health` includes `error` only when you send the sign-in cookie. `/terminals` is for debugging and is not part of the browser protocol. The browser protocol is in [packages/protocol/PROTOCOL.md](../packages/protocol/PROTOCOL.md).
