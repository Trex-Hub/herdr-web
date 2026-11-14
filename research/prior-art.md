# Prior art: DEV-11 — do others already build what herdr-web is heading for?

## Answer

Yes — two projects already do almost exactly this, and one of them (Ovis, formerly `herdr-web-ui`) is
a mature MIT-licensed TypeScript app with 2,059★, 118 contributors, a commit today, and — crucially —
an adapter that drives **herdr-core** (`hc`) through the same JSON-RPC the plan targets, plus ~15
per-agent chat/transcript adapters including pi and Claude Code.

Recommendation: **do not fork** (Ovis is 22 MB of server code, Bun runtime, and its own layout
document semantics we'd have to keep compatible), and **do not build from zero** either. Build the
Next.js/Express bridge as planned, but borrow three things concretely: (1) Ovis's `hc connect`
framed-protocol client + OpenRPC type generation, (2) Ovis's pi/Claude transcript readers
(pi's append-only entry tree is the non-obvious part), (3) its turn-folding chat model. Read the
`herdr-app` document for layout and never write it. Everything else these projects prove is that
the hard parts are *attach-slot contention, terminal flow control, and session-identity ambiguity* —
not the UI.

## Evidence

### 1. The product landscape: two runtimes, two sockets, no shared agents

| | herdr (TUI) | herdr-core (`hc`) |
|---|---|---|
| repo | herdrdev/herdr, 50,898★, Apache-2.0, v0.9.5 (`herdr --version`) | herdrdev/herdr-core, 685★, Apache-2.0, v0.1.21 (`hc --version`) |
| socket | `~/.config/herdr/herdr.sock`, `~/.config/herdr/sessions/<name>/herdr.sock` (herdr `docs/next/website/src/content/docs/socket-api.mdx:639-640`); verified present on this machine | `HC_SOCKET`, else `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, else state dir (herdr-core `schema/README.md:24`, discovery rules in Ovis `server/herdr-core/discovery.ts:474-498`) |
| protocol | JSON-lines socket API, **protocol 22** (`herdr api schema --json` → `protocol: 22`); plugins get the whole CLI (`docs/next/website/src/content/docs/plugins.mdx:21-25`) | JSON-RPC 2.0, generation 1, OpenRPC at `/tmp/hcore/schema/hc.openrpc.json`; framed mode `[channel u32][kind u8][len u32][payload]` (herdr-core `schema/README.md:12,40-58`) |
| layout | spaces/tabs/splits in the server | **none** — core has terminals, labels and opaque documents only |

Authors' direction of travel: herdr.dev says "Herdr TUI is the original Herdr: a terminal app with
its own server. This is a new, separate program built on herdr-core. **They don't share agents**"
(https://herdr.dev/, FAQ). herdr-core is *preview*: "protocol generation 1, version 0.x", additive
only, guarded by `released.openrpc.json` (`/tmp/hcore/schema/README.md:12-20`). herdr-app installs
core if missing (`/tmp/happ/README.md:37`) and states the split plainly: "Use herdr-core for running
and coordinating programs; use the app to change what you see" (`/tmp/happ/README.md:107`).
herdr-app 0.1.15 (installed) requires exactly: `terminal.run/list/kill/label/attach/keep`,
`doc.get`, `doc.set`, `events.subscribe`, `GENERATION = 1` (`/tmp/happ/src/hc.rs:207-209`).

**Layout lives in a document the desktop app owns**: `doc.set {"name":"herdr-app","version":N,
"value":{"spaces":[{id,name,folder,tabs:[{id,name,root}]}]}}` (`/tmp/happ/src/mirror_sync.rs:76-104`,
shapes at `/tmp/happ/src/mirror.rs:10-42`; node types `Content::Terminal|Mod|Context|Agent` plus
row/column/stack/floats at `/tmp/happ/src/layout.rs:9-40`). Unknown fields are preserved by
`serde(flatten)`, so the document is safely extensible — but a second writer will fight the app for
the version (`conflict` → re-read). Shared client state convention: `herdr.seen=<turn>`,
`herdr.pinned=1`, and `herdr.space`/`herdr.tab` labels (`/tmp/happ/docs/labels.md:16-60`).

Trust model: herdr-core's socket **is** the trust boundary — "Anyone who can connect to its API can
run commands, read and change files… There is no separate API password or per-client permission
check. … Do not expose the socket or forward the raw API" (`/tmp/hcore/docs/security.md:4,24,31`;
dirs are 0700, `:21`). Whatever auth herdr-web adds sits in front of an all-powerful socket.

### 2. Ovis (devswha/herdr-web-ui → devswha/ovis) — **the closest prior art, MIT**

- Meta: 2,059★, 286 forks, 118 contributors, MIT, TypeScript/Bun, created 2026-09-17, last push
  2026-11-14, release `v0.5.3`. `gh api repos/devswha/herdr-web-ui` resolves to `devswha/ovis`.
- Runtime: **both**, one per server process, chosen by `OVIS_RUNTIME=herdr|herdr-core` or Settings →
  About → Terminals (`server/herdr-core/runtime.ts:16-24`, `docs/guide.md:212-221`).
- herdr-core access: never guesses the socket path — it spawns **`hc connect`** and speaks the framed
  protocol over stdin/stdout (`server/herdr-core/connection.ts:1-30`; hello timeout 10 s, 16 MiB
  payload cap `:30`), with typed calls generated from hc's OpenRPC
  (`server/herdr-core/hc-api.generated.ts`, `bun run generate:types`).
- Architecture trick worth understanding: a **shim adapter** makes hc impersonate herdr's socket API
  (`ping`, `session.snapshot`, `pane.get/read/send_text/send_keys`, `agent.prompt`,
  `events.subscribe`) on a local `herdr-core.sock`, so all herdr-era callers work unchanged
  (`server/herdr-core/adapter.ts:19-45`, `server/herdr-core/pipe.ts:1-18`). For our project this is
  the *anti-pattern to skip*: we have one runtime and one API, so we call JSON-RPC directly.
- Layout: on a bare core Ovis keeps its **own** `ovis-layout` document plus `herdr.space`/`herdr.tab`
  labels, and **refuses to write the app's `herdr-app` document** — if the app arranges the core, Ovis
  only reads it (`server/herdr-core/layout-doc.ts:1-16`, `server/herdr-core/adapter.ts:500-520`,
  `docs/herdr-core-layout.md`). Geometry is top-down shares of a 1000×1000 area, never terminal
  grids (`layout-doc.ts:10-13`).
- Terminal: `terminal.attach` over a framed channel, xterm.js 6.0.0 (+fit/image/web-links/unicode
  graphemes), and a Rust PTY sidecar used for ACK-based flow control: xterm `write()` callback →
  `pty-ack`, pause at 256 KiB, resume at ≤64 KiB, 1 MiB budgets, close 4008 for stuck clients, 128 KiB
  replay tail (`docs/terminal-flow-control.md:1-40`). It also emulates viewer facts (display query
  answers, focus reports, clear-history) — `server/herdr-core/attach-session.ts:1-24`.
- Chat view: per-agent transcript adapters, the single biggest reusable asset: `server/pi.ts`,
  `pi-tree.ts`, `pi-delivery.ts`, `pi-ask-bridge.ts`, `claude-store.ts` (75 KB), `claude-transcript.ts`,
  `claude-subagents.ts` (119 KB), `codex.ts` (234 KB), `conversation.ts` (266 KB), plus omp/omo/agy/
  kimi/muse/gjc. Store paths documented in-file: Claude
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` with the "every non-alphanumeric → `-`"
  encoding (`server/claude-store.ts:1-15`); pi at `PI_CODING_AGENT_SESSION_DIR` else
  `<PI_CODING_AGENT_DIR>/sessions` (`server/pi.ts:20-38`).
- **pi specifics to copy**: a pi session is an append-only *entry tree* (id/parentId); `/tree` moves
  the leaf without rewriting, so the visible conversation is the path from the *last* line back to
  the root, and side branches must be ignored (`server/pi-tree.ts:1-12`, bounds
  `MAX_PI_INDEX_ENTRIES 100_000`, `MAX_PI_ENTRY_BYTES 16 MiB`). Ovis also brackets a send with a
  16-byte-offset prefix digest + leaf id to prove which turn is ours (`server/pi-delivery.ts:11-30`).
- Chat UX to copy: turn folding — tools/reasoning/commentary collapse under "Worked for 7s · 1 edit",
  only final prose stays (`src/lib/workBlocks.ts:12-24`: `isAnswer` = prose with
  `phase !== "commentary"`).
- Access/auth: no user DB; trust by origin — loopback, Tailscale identity header, paired-device
  cookie, or shared token, constant-time compares, HttpOnly SameSite=Strict cookies
  (`server/access.ts:1-20`).
- Verdict: **borrow specific parts** (named above), don't fork. It is a fine-grained fork of nothing
  we can maintain: 589 TS files under `server/`, `api.contract.test.ts` alone is 375 KB, `DESIGN.md`
  537 KB, `CHANGELOG.md` 813 KB.

### 3. Wherdr (afloury/wherdr) — herdr **TUI** only, MIT, 17★

Nuxt 4 + Nitro on `127.0.0.1:7683`, Herdr API socket `~/.config/herdr/herdr.sock`, terminals relayed
through `herdr terminal session control <pane>` (`docs/overview.md:51-55`), xterm.js 5.5 + WebGL,
`herdr-plugin.toml` manifest with `min_herdr_version = "0.9.1"`. **No herdr-core support anywhere**
(no `hc`/core reference in the repo). Its transcript layer is a good *small* reference:
`server/utils/transcripts.ts` reads backwards in 2 MiB windows (24 MiB cap, 120 items/page,
20,000-char text cap, `:20-24`) and pages incrementally by anchor hash (4 KiB anchor, sha1-12,
`/<start>.<hash>`, `:54`); Claude queue/pending-prompt parsing and Codex session claiming (rollout
created within −5 s/+120 s of pane birth, `:41-42,1142`) live there too. WS route is 20 lines:
`server/routes/ws/term.ts:1-8`. Security = loopback + Host allowlist (403 "Host not allowed") +
optional WebAuthn passkey (`docs/security.md`). Verdict: **ignore as a base**, borrow the paging idea
and the Host-allowlist gate. 6 contributors, French comments, wide feature sprawl.

### 4. Others, briefly (all primary-source checked in README/LICENSE/package metadata)

| project | ★ / licence | runtime | what it is | verdict |
|---|---|---|---|---|
| kcosr/herdr-web | 165, MIT, last push 2026-10-07 | herdr TUI only | React+Vite+Capacitor, Rust `herdr-web-bridge` (axum/ws), **ghostty-web** renderer, vendored "private Herdr APIs" | stale vs 0.9.x; ignore |
| AltanS/collie | 1,650, MIT | TUI primary; `COLLIE_MUX=herdr-core` experimental | TS PWA, reads the app's `herdr-app` document to mirror spaces/tabs; documents the core socket rules (`docs/multiplexers.md:213-250`) | borrow only its "read the app document" confirmation |
| alecuba16/herdr-webui | 44, **AGPL-3.0 + commercial** | own multiplexer; "external-herdr" compat | Rust axum, embedded JS UI, Argon2id password | licence forbids code reuse; ignore |
| powerfooI/roamgate | 327, MIT | TUI only | Bun bridge, two sockets (`herdr.sock` NDJSON + `herdr-client.sock` binary), protocol allowlist rejecting 21 (`docs/DEPLOYMENT.md:14-22`) | ignore |
| 0cv/herdr-mobile-relay | 380, **AGPL-3.0** | TUI **and** core (`HERDR_RELAY_BACKEND=hc`, one per process) | Go relay + PWA; huge per-agent transcript adapters; documents core behaviours incl. size leasing and "rename refused when the desktop changed layout at the same moment" (`docs/herdr-core.md:1-40`) | read for core edge cases, don't copy code |
| sheprd-labs/sheprd | 2,295, Apache-2.0 | pins herdr-core | Rust+GPUI native client | ignore (native) |
| eliasstravik/shepherdr | 1,140, MIT | herdr-core, as a *Herdr app layout/mod* | JS | interesting: the app is scriptable (`/tmp/happ/defaults/AGENTS.md:1-30`), so a "web client" could partly be a layout |
| ZingerLittleBee/Heeler | 884, Apache-2.0 | TUI **or** core over SSH | Swift iOS | ignore |
| official Herdr phone app | closed | herdr-core only | SSH to core on each machine, no server in between; "Does it work with Herdr TUI? No"; spaces appear only when herdr-app runs there (https://herdr.dev/mobile/) | confirms: core + the app's document are the supported surface |

`gh search repos herdr` also returns ~20 tiny "herdr-web" personal attempts (barnuri, eyalev,
qike-ms, tigorlazuardi…, 0-16★) — all TUI-era, none a design reference.

### 5. What is genuinely harder than it looks (each one cost someone a bug)

1. **Attach-slot contention.** herdr keeps one writable attach per terminal; a second client gets
   `terminal attach failed: terminal term_0 already has an attached client; retry with --takeover`
   and a 400-line read of an idle alt-screen agent refuses attaches meanwhile (Ovis
   `server/core/terminal-process.ts:20-33`, `ATTACH_RETRY_FOR_MS = 20_000`). herdr TUI docs say the
   same (`cli-reference.mdx:387`, `persistence-remote.mdx:135`). herdr-core instead separates
   `observe` viewers from the one active viewer, with RESIZE/FOCUS/FACTS frames
   (`/tmp/hcore/schema/README.md:69-101`).
2. **Flow control is mandatory, not optional.** A stream starts with 256 KiB credit, the viewer sends
   CREDIT for bytes it wrote, >4 MiB behind gets a repaint
   (`/tmp/hcore/schema/README.md:103-108`). Ovis needed an ACK protocol plus a Rust PTY sidecar and a
   4008 stuck-client policy (`docs/terminal-flow-control.md`).
3. **Session identity cannot be guessed.** "Never choose a session solely because it is newest or
   shares the cwd" (`herdr-web-ui/docs/chat-mode-audit.md:45-58`); Codex's daemon-reported session was
   wrong often enough that Wherdr claims rollouts by *birth time* instead
   (`wherdr/server/utils/transcripts.ts:41-42,1142`).
4. **pi rewinds.** Reading a pi `.jsonl` top-to-bottom gives the wrong conversation after `/tree`
   (`herdr-web-ui/server/pi-tree.ts:1-12`).
5. **Layout documents conflict.** `doc.set` is versioned; the app retries on `conflict` and re-reads
   (`/tmp/happ/src/mirror_sync.rs:90-104`), Ovis does exactly one retry then refuses
   (`herdr-web-ui/server/herdr-core/adapter.ts:509-515`), and 0cv reports renames refused when the
   desktop wrote at the same moment. Two clients editing the same tree will collide.
6. **A chat view is not a terminal scrape.** Status comes from OSC 7501 only — "no screen scraping,
   no list of known agents" (https://herdr.dev/core/) — so "is this agent waiting?" must come from
   status+`turn`, not from parsing the screen; transcript text comes from files
   (`/tmp/hcore/schema/README.md:113-178`).

## Concrete borrow list

1. `hc connect` + framed-protocol client, incl. 16 MiB cap and hello timeout —
   `herdr-web-ui/server/herdr-core/connection.ts`.
2. Types generated from `hc schema --json` (OpenRPC), not hand-written —
   `herdr-web-ui/server/herdr-core/hc-api.generated.ts` + `scripts/generate-protocol-types.ts`.
3. Socket resolution that matches `hc` exactly (HC_SOCKET → XDG_RUNTIME_DIR → state dir) —
   `herdr-web-ui/server/herdr-core/discovery.ts:474-498`.
4. Read `herdr-app` via `doc.get`, subscribe `events.subscribe {docs:["herdr-app"]}`, re-read on
   `doc`/`missed` events, never write it — `herdr-web-ui/server/herdr-core/snapshot.ts:28`,
   `clients` in `/tmp/hcore/schema/README.md:198-215`, `/tmp/happ/src/hc.rs:130-140`.
5. Labels for shared state: `herdr.seen`, `herdr.pinned`, `herdr.space`, `herdr.tab` —
   `/tmp/happ/docs/labels.md`, `herdr-web-ui/docs/herdr-core-layout.md`.
6. pi: entry-tree path resolution + send bracketing — `herdr-web-ui/server/pi-tree.ts`,
   `server/pi-delivery.ts`; Claude store dir encoding — `server/claude-store.ts:1-15`.
7. Turn folding model (`work` vs `answer`) — `herdr-web-ui/src/lib/workBlocks.ts`.
8. Backwards windowed transcript paging with an anchor token instead of re-reading the file —
   `wherdr/server/utils/transcripts.ts:20-24,54`.
9. Renderer: Ovis is on xterm.js 6 with the image addon; kcosr uses `ghostty-web`. The repo already
   vendors `ghostty-web` (0.4.0) and `restty` (0.3.0) locally, so that choice is open — but note
   flow control differs: xterm's `write(data, cb)` gives a parse-complete ACK signal for free.
10. Attach UX: open terminal = `observe` when we only watch, active when typing; expect a retry loop.

## Open questions (unverified)

- Whether herdr TUI has any published plan to move onto herdr-core. Only the marketing FAQ
  ("a new, separate program") says anything; `herdr`'s CHANGELOG has zero mentions of herdr-core
  (`grep -ci herdr-core CHANGELOG.md` → 0). Treat "core is the future" as the authors' product
  messaging, not a documented migration.
- Which licence our project wants. Two of the most complete reference implementations
  (alecuba16/herdr-webui, 0cv/herdr-mobile-relay) are AGPL-3.0 — read them, copy no code.
- `hc` has no CLI verb for documents (`doc.get`/`doc.set` are API-only, `/tmp/hcore/schema/README.md:191`),
  so a bridge must speak JSON-RPC; I did not exercise writing a document (rules: read-only core).
- Exact behaviour when two clients attach the same herdr-core terminal and both type: the schema says
  "the last active viewer sets the size" (`schema/README.md:71-72`), but I did not test simultaneous
  input on the user's live core.
- herdr-app's `view` state (active space/tab, zoom, recents: `/tmp/happ/src/mirror.rs:44-59`) is
  per-screen and *not* in the shared document — so "same layout on web and desktop" means same
  spaces/tabs/panes, not the same focus. That may be acceptable; unverified how the app reacts if a
  web client also wants to select a space (the `herdr-app` socket takes `space.select`,
  `/tmp/happ/docs/commands.md:177`).
