# Architecture

## How the pieces fit

```
 inside each pi                 herdr-web backend                         browser
┌──────────────┐   unix socket  ┌──────────────────────────────┐  HTTPS/WS  ┌─────────┐
│ pi + pi-live │◀───────────────│ pi-live client (per session) │◀──────────▶│ web app │
└──────────────┘  (pi listens)  │ rows: packages/agents        │  signed in └─────────┘
┌──────────────┐   unix socket  │                              │
│ herdr-core   │◀───────────────│ herdr-core client            │
└──────────────┘                └──────────────────────────────┘
```

- **pi-live** knows only about pi. It reports what pi is doing, streams the reply, runs the app's actions and holds prompts that are waiting for an answer. Its socket is local and has no login. It is a separate project (in pi-ask-user), and its contract is pi-live's `docs/protocol.md`.
- **herdr-core** knows only about terminals: the PTYs, starting programs, the terminal view, and typing into a terminal.
- **The backend** is the only part that knows both. It links each pi to its terminal, builds the chat rows from pi's session file, and handles the browser's sign-in.
- **The web app** talks only to the backend, over one main WebSocket, one socket per attached terminal, and plain HTTP for actions ([PROTOCOL.md](../packages/protocol/PROTOCOL.md)).

## Decisions

These were settled when chat moved onto pi-live (DEV-35).

- **One extension: pi-live.** herdr-web ships no pi extension. pi-live says nothing about herdr except the `terminal` field, which it fills from `HC_TERMINAL_ID`. There is one socket per pi session, and the backend finds each one in pi-live's folder.
- **Only an interactive pi is a terminal's chat.** The first interactive pi in a terminal keeps it. The same process replaces its own session on `/new`, `/resume`, `/fork` and `/reload`. A `pi -p` or a sub-agent never takes it.
- **The backend builds the rows.** pi-live sends only live parts, plus hints to reread the session file. The rows come from that file, in `packages/agents`. A chat on another device needs a backend anyway, because the socket is local and has no login.
- **Commands go two ways.** Messages, stop, model, effort, name, compact, and every extension, prompt-template and skill command go through pi-live. pi's own commands are typed into the terminal, because pi has no extension API for them. `pi.getCommands()` does not list them, so the web keeps its own list (`PI_BUILTIN_COMMANDS`).
- **Control is on by default** and decided by pi-live: `PI_LIVE_CONTROL`, then a trusted project's `.pi/pi-live.json` (which may only turn it off), then `<agent dir>/pi-live.json`.
- **No ai-sdk for now, but the door stays open.** `useChat` does not fit: it assumes our server calls the model, and it knows nothing of steering, branch resets, paging or several tabs on one pi. Every row kind must still map to an ai-sdk message part, so a converter stays possible ([packages/agents/README.md](../packages/agents/README.md#row-kinds-and-ai-sdk) has the mapping).
- **Pis started outside herdr** (iTerm, VS Code) have pi-live sockets too, and should show in the web with chat only. Not built yet (DEV-36).

## Design notes

- **What the backend writes to core** is limited to `terminal.run`, `terminal.kill` and `terminal.label`, plus the read `templates.list`. A unit test checks that it never calls `doc.set`, `machine.exec`, `file.*`, `server.*`, or adds or removes a machine.
- **Kill leaves `keep` on.** A killed `keep` terminal stays finished when core restarts (checked on core 0.1.21), so turning `keep` off first is not needed.
- **The xterm.js packages are 6.1 betas,** because only those have the kitty keyboard protocol, which pi uses to tell Shift+Enter from Enter. Rendering falls back from WebGL to the DOM renderer when the browser takes the context away.
- **Terminal padding sits on the view, not on the element the fit addon measures.** The addon counts that element's padding as room for rows, which used to cut off the last row.
- **Only the newest 120 chat rows are on the page.** The scroll component measures every row on each scroll. At 2,000 rows that made frames 50 ms long, while the window keeps the longest frame at 33 ms. Off-screen rows also use `content-visibility: auto`.
- **Finished rows do not re-render** while a reply streams. A unit test counts the renders.
- **Streaming text is followed before paint.** Following from the scroller's resize observer alone showed the newest line one frame late.
- **A row and its live reply change together.** pi writes its session file after the extension hears `message_end`, so the adapter waits for the entry before it swaps the live reply for the row. There is never a moment with both on screen, or neither.
