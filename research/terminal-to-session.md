# Terminal → session file (pi and Claude Code)

## Answer

Resolve per terminal from `terminal.get`, never from cwd alone. **Claude Code: read Claude's own PID record** `<config>/sessions/<pid>.json`, validate it against the process table, and derive `<config>/projects/<slug(cwd)>/<sessionId>.jsonl`. **pi: there is no file to find — pi keeps no PID record and holds no open fd** (`appendFileSync` per entry), so the only reliable route is a report from inside the pi process: a pi extension that calls `ctx.sessionManager.getSessionFile()` (the web viewer's pi.ts does exactly this over a unix socket, and herdr's own `pane.report_agent_session` when the runtime supports it). Without such a report, fall back to "newest `*.jsonl` in `<agentDir>/sessions/--<slug(foreground.cwd)>--`", validated by mtime/title, and label it a guess. **lsof and `/proc/<pid>/fd` do not work for either agent** (both open-append-close); use them only for agents that hold their log open (codex, omp, copilot). On a remote machine everything runs through `machine.exec`/`file.read` with the same steps — `lsof` is absent on both added machines, so `/proc/<pid>/fd` via `ls -l` is the only fd route there. Detect switches by re-reading: Claude rewrites its PID file in place, pi changes file on `/new`, `/resume`, `/fork` (not `/tree`), so re-check on every `status`/`turn` event and on title change.

## Evidence

### 1. How devswha/herdr-web-ui does it (primary source: its server code)

Cloned at commit `e35ae49`; referenced below as `server/...` under `/tmp/research-terminal-to-session/herdr-web-ui`.

- **pi — not lsof, a socket.** `server/pi.ts:131` says it outright: *"herdr-core runs no herdr pi integration, so its agent.get names no session (#2935)"*. Its first choice is herdr's `pane.report_agent_session` record (`agent.agent_session`, `source: "herdr:pi"`, `kind: "path"`). Fallback under herdr-core: `extensionSessionFile()` (`server/pi.ts:134-139`) opens `<agentDir>/herdr-web-ui-ask/<pid>.sock` (`extensionSocket`, `:142-150`; dir name from `shared/pi-ask-bridge.ts:15`), does `GET /v1/state` over it, and accepts the answer only when `state.pid === pi.pid` (`shared/pi-ask-bridge.ts:8-10`), then re-checks the pid is still `foreground` (`server/pi.ts:301-310`). Their own extension lives in `integrations/pi-ask.ts` and reports `sessionFile` from `ctx.sessionManager.getSessionFile()`.
- **Claude — Claude's PID record.** `server/claude-store.ts:742`: `join(configDir, "sessions", `${pid}.json`)`. Validation `claudeProcessSession` (`:731-770`) requires `record.pid === pid`, `kind === "interactive"`, a UUID `sessionId`, a `procStart` string, and then compares that start time to the OS: Linux `/proc/<pid>/stat` field 20, macOS `ps -o lstart= -p <pid>` with `LC_ALL=C TZ=UTC` (`darwinProcessStart`, `:703`), Windows FILETIME. Comment at `:731`: *"Read again on every request: /clear and resume can change sessions in the same process."* Transcript path from Claude's own encoding: `claudeProjectDir` (`:113-120`) = `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, and past `MAX_PROJECT_NAME = 200` (`:29`) append `-<base36 stringHash(cwd)>`. Store discovery reads `CLAUDE_CONFIG_DIR` from the process environment and also accepts `~/.claude-*` siblings; more than one store holding the same PID record is an explicit `AmbiguousClaudeStore` error.
- **lsof is used for other agents only** — `server/omp.ts:378` runs `/usr/sbin/lsof -nPbw -a -p <pids> -FpDin` (3 s budget, `LSOF_DEADLINE_MS` at `:312`) and keys identity on `dev:ino`, with a PID-reuse guard from process start time (`server/process-owner.ts:17-46`). `docs/guide.md:231-236` summarises: Claude "resolved through herdr", omo "through the pane's process tree", pi "resolved through herdr".

### 2. pi internals (installed 1.5.2, `/Users/dev/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent`)

- **Path scheme**: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`, `<path>` = cwd with leading separator dropped and `/`, `\`, `:` → `-`; `<timestamp>` with `:`/`.` → `-` (`docs/session-format.md:10-16`). Store override: `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting (`docs/sessions.md:66`, `docs/cli.md:98`, `docs/environment-variables.md:82`).
- **No held fd.** `_persist` does `appendFileSync(this.sessionFile, ...)` per entry (`dist/bundle/chunks/chunk-VEJDBY3O.js`, `appendFileSync(this.sessionFile,...`), first write `openSync(..., "wx")` then close. Verified live: `lsof -nPbw -p 65979` (the pi in t17) shows **zero** `.jsonl` descriptors; only `~/.local/share/billion-context/sessions/index.db*`.
- **No side-channel of its own**: `~/.pi/agent` has no `*.pid`, `*.lock` or `*.sock` (only `auth.json`, `settings.json`, `sessions/`, `extensions/`, `state/thinking-steps.json`, …). The `~/.claude/sessions/<pid>.json` files on this Mac are written by the third-party `pi-claude-link` (`"version": "pi-claude-link"`, `entrypoint: "pi"`), not by pi.
- **Signals pi does expose**:
  - Extensions: `session_start` with `reason: "startup" | "reload" | "new" | "resume" | "fork"`, `session_before_switch` with `event.targetSessionFile`, `session_shutdown`, and `ctx.sessionManager.getSessionFile()` / `getSessionId()` (`docs/extensions.md:393,473-513`).
  - RPC mode (`pi --mode rpc`): `get_state` returns `sessionFile` and `sessionId` (`docs/rpc-commands.md:176-177`), and `get_session_stats` repeats them (`:541-542`). Only usable if the pane's pi was started in RPC mode; a TUI pi cannot be interrogated this way.
  - OSC 7501 program status: fields are only `state`, `app`, `kind`, `msg` (base64) — `formatProgramStatus` in `chunk-FF6XOTWB.js`; documented at `docs/terminal-setup.md:225-235`. No session identity. herdr-core stores it as `Status{state, kind, progress, app, title, msg}` (`/tmp/hcore/crates/herdr-core/src/status.rs:14-40`) and increments `turn` each time the root record leaves `working`.
  - Title: `setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`)` when the session is named, else `${APP_TITLE} - ${cwdBasename}` (`chunk-VEJDBY3O.js`). Surfaced as `Terminal.title` ("π - herdr-web"). Weak but real hint: it carries the session *name* (`/name`, `--name`, `docs/sessions.md:32`), not the id.
  - Env of the live pi (read via `KERN_PROCARGS2`): `HC_TERMINAL_ID=t17`, `HC_TERMINAL_SOCKET=…/default.sock`, `HC_SCOPE=…`, `PI_MANAGED_INSTALL_ROOT`, `TERM_PROGRAM=ghostty`. No session path — pi does not put one in its environment.
- **herdr's pi extension is already installed** (`~/.pi/agent/extensions/herdr-agent-state.ts`, and on the remote `cachyos` too): on `session_start` (`:229`) it POSTs `pane.report_agent_session` with `agent_session_path: ctx.sessionManager.getSessionFile()` (`:76-83,110-130`) to `HERDR_SOCKET_PATH`. It is a no-op unless `HERDR_ENV === "1"` (`:20-22`), which herdr-core never sets, and herdr-core has no such method at all (`/tmp/hcore/schema/hc.openrpc.json` method list: `terminal.*`, `machine.*`, `file.*`, `doc.*`, `events.subscribe`, `templates.list`, `rpc.discover`).

### 3. Claude Code internals

- Docs confirm the two carrier fields: hooks input has `session_id` and `transcript_path` (`https://code.claude.com/docs/en/hooks.md:752-754`), and the statusLine payload has `session_id` and `transcript_path` too (`https://code.claude.com/docs/en/statusline.md:198-225`, example `:222-225`). A `statusLine.command` wrapper or a `SessionStart` hook (matcher values `startup|resume|clear|compact|fork`, `hooks.md:294`) therefore carries the answer, and herdr-web-ui's `server/statusline-capture.ts` proves the wrapping technique.
- The installed binary (2.1.325, `/Users/dev/.local/share/claude/versions/2.1.325`) contains the PID-record writer: fields `pid, sessionId, cwd, startedAt, procStart, version, kind, entrypoint, messagingSocketPath, name, nameSource, status`, validation message `"has no procStart identity"`, deletion in `process.on("exit")`, and an in-place rewrite (`updatePidFile`) on session switch. So `/clear`, `/resume` and `--continue` all show up as the same PID file with a new `sessionId`.
- Transcript writes are appends too (52 `appendFile`, 23 `appendFileSync` sites), so the same "no held fd" conclusion applies; the PID record, not lsof, is the route.

### 4. herdr-core surface (what the bridge may use)

- `Terminal` fields (`/tmp/hcore/schema/hc.openrpc.json`, `components.schemas.Terminal`): `address, argv, cols, created_ms, cwd, die_with_parent, exit_code, finished_ms, first_message, foreground{pid,name,argv,cwd}, identity, keep, labels, name, notify, parent, paste_gap_ms, pid, reason, records, reported, rm, rows, screen, signal, state, status, status_ms, stop, submit, template, title, turn`. No agent/session field, and `hc` 0.1.21 exposes no `agent.*` method.
- `foreground` is re-read ~2×/s from the OS (`crates/herdr-core/src/foreground.rs:96-140`: macOS `proc_name` + `PROC_PIDVNODEPATHINFO` + `KERN_PROCARGS2`; Linux `/proc/<pid>/{comm,cmdline,cwd}`), and `foreground.cwd` is "its working directory now" — so it follows `cd`, unlike `Terminal.cwd`.
- Env core injects into every terminal: `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, `HC_SCOPE`, `PWD`, `TERM`, `COLORTERM`, `TERM_PROGRAM=ghostty` (`crates/herdr-core/src/api/run.rs:216-250`); `machine.exec` strips `HC_*` (`crates/herdr-core/src/exec.rs`).
- `machine.exec` returns base64 `stdout` (first 8 MB) / `stderr` (1 MB) with `code`, `ms`, `timed_out`, `truncated`; `file.read` takes `path`, `on`, `offset`, `limit` and **rejects anything that is not a regular file**.

### 5. Live read-only probes on this machine and the remotes

| Probe | Result |
| --- | --- |
| `hc get t17 --json` | `foreground{pid:65979, argv:["pi",""], cwd:/…/herdr-web}`, `status{app:"pi",state:"done"}`, `title:"π - herdr-web"`, `turn:57`, `status_ms` 16:02:19 |
| `lsof -p 65979 \| grep jsonl` | 0 lines — pi holds no transcript fd (the 65979 in `lsof` is `node`) |
| session file of t17 | `~/.pi/agent/sessions/--Users-dev-Desktop-devendras-work-herdr-web--/2026-11-14T08-13-25-413Z_01a1d91e-….jsonl`, header `cwd=/Users/dev/Desktop/devendras-work/herdr-web`; only file in that dir; mtime 16:08:02 |
| `LC_ALL=C TZ=UTC ps -o lstart= -p 65979` | `Sat Nov 14 13:43:25 2026` = `procStart` in `~/.claude/sessions/65979.json` (written by pi-claude-link) |
| `hc exec --on cachyos -- uname -a` | exit 0, 7 ms — `machine.exec` path works |
| `command -v lsof` on cachyos and devserver | `NO_LSOF` on both |
| `hc file read --on cachyos /proc/1441/environ` | full NUL-separated env (`HC_TERMINAL_ID=t2`, `TERM=xterm-256color`, …) — env is readable remotely |
| `hc file read --on cachyos /proc/1441/fd` (and `/fd/10`, `/cwd`) | `{"error":{"kind":"invalid_params","message":"/proc/1441/fd is not a regular file"}}` — symlinks/dirs need `machine.exec ls -l` instead |
| `hc exec --on cachyos -- ls -l /proc/1441/fd` | full readlink listing works |
| remote pi store | `/home/zosmaai/.pi/agent/sessions/--home-zosmaai-code--/…jsonl` (plus `.jsonl.acp.json` sidecars), `~/.claude` has only `skills/`; no live remote agent was running |

Also: `~/.pi/agent/sessions/<dir>/` can hold `.jsonl.acp.json` siblings and old sessions, so "the only file" is rare; on t17's own folder it happened to be exactly one.

### 6. What each method costs through `machine.exec`

| Method | Local | Remote | Note |
| --- | --- | --- | --- |
| Read `<config>/sessions/<pid>.json` | `readFile` | `file.read` (works; 16 KB is enough) | one round trip |
| List store dir | `readdir` | `machine.exec sh -c 'ls -t …'` | quote the slugged path; use `ls -t` |
| Read `/proc/<pid>/environ` | n/a (sysctl `KERN_PROCARGS2`, `foreground.rs:110-140`) | `file.read` works | macOS `ps -E` is redacted → sysctl only |
| `lsof` | present | absent on both machines | do not depend on it |
| `/proc/<pid>/fd` readlinks | n/a | `machine.exec ls -l /proc/<pid>/fd` | same-user only; `file.read` refuses |
| Extension socket | unix socket connect | impossible (no socket reachability) | remote pi cannot be asked |

## Reliability ranking

1. **An in-process report** (pi extension socket / `pane.report_agent_session` / RPC `get_state`) — exact, survives `cd` and `/resume`, only route that knows an unwritten new session. Requires an install step in the agent; nothing to install on a remote machine's pi beyond the same extension.
2. **Claude's PID record + `procStart` check** — exact for Claude, one small file, works locally and remotely, and self-updates on `/clear` and resume. Failure modes: record absent (older Claude), PID reused (caught by `procStart`), two stores (`CLAUDE_CONFIG_DIR` + `~/.claude-*` must be disambiguated, else error).
3. **Deterministic path + store scan** (`~/.pi/agent/sessions/--<slug(foreground.cwd)>--`, `<config>/projects/<slug>/`) — correct folder with high probability, file ambiguous when several sessions share it. Cheap, works remotely, good fallback for both agents.
4. **Session name from `Terminal.title` / `session_info` entries** — disambiguates within a folder when the user named the session (`"π - <name> - <basename>"`); useless for unnamed sessions.
5. **Activity correlation** (`status_ms`/`turn` vs file mtime) — a tie-breaker, not a proof: pi writes on each entry so an active session is the newest, but a session idle since startup has an old mtime while a sibling could be newer.
6. **Held-file scan (`lsof` / `/proc/<pid>/fd`)** — for pi and Claude it finds nothing (verified); keep it for codex/omp/copilot/grok-style agents.
7. **Screen/OSC scraping** — last resort; 7501 carries no session id, and `/session` output is only visible if the user happened to run it.

## Recommended algorithm

```
for each terminal t (address may be "machine/tN"):
  agent = t.status.app  (fallback: foreground.argv match for "pi"/"claude")
  if t.foreground.pid missing -> unresolved (show "no agent")

  if agent == pi:
    1. if a pi-side report exists (extension socket <agentDir>/<bridge>/<pid>.sock
       answering {pid, sessionFile}, or a runtime report like agent_session):
         path = report.sessionFile
         require: report.pid == t.foreground.pid, realpath(path) inside the pid's store
                  (PI_CODING_AGENT_SESSION_DIR | <agentDir>/sessions | --session-dir in argv),
                  and pid still == t.foreground.pid after the read.
         done.  (accept an unwritten "<ts>_<uuid>.jsonl" name that does not exist yet)
    2. else if argv names a session ("--session <path|id>", "--session-id X", "-c/--continue",
       "--resume"): resolve within the store: an absolute --session path wins; an id maps to
       the single "*_<id>.jsonl".
    3. else dir = <store>/--<slug(foreground.cwd)>--; files = *.jsonl (ignore *.jsonl.acp.json)
         files.len == 1                         -> that file
         files.len > 1                          -> newest by (header timestamp, then mtime);
                                                   if < 2s between the top two, mark "ambiguous"
         files.len == 0                         -> unresolved (session not written yet; retry on next write)
       corroborate with t.title suffix vs the file's "session_info" name when present.
    4. tag the result as reported|derived|guessed and re-verify on every status/turn event.

  if agent == claude:
    1. configDirs = CLAUDE_CONFIG_DIR of the pid's env, else ~/.claude, plus ~/.claude-* siblings
       that contain sessions/<pid>.json. More than one such store -> ambiguous, stop.
    2. record = <configDir>/sessions/<pid>.json; require pid match, kind == "interactive",
       UUID sessionId, and procStart == OS start (Linux /proc/<pid>/stat field 20,
       macOS `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`, Windows process table).
    3. path = <configDir>/projects/<slug(foreground.cwd)>/<sessionId>.jsonl
       (slug = cwd.replace(/[^a-zA-Z0-9]/g,"-"), >200 chars -> first 200 + "-" + base36(stringHash(cwd)))
       if missing: scan every projects/* for "<sessionId>.jsonl" and accept only a unique hit.
    4. no record (old Claude) -> fall back to herdr-hook / statusLine report, then to
       newest *.jsonl in projects/<slug>, tagged "guessed".
```

Cache the resolved `(address, pid, sessionId|path, mtime)`; drop the cache when `foreground.pid` changes, when a new `.jsonl` appears in the watched dir, when `status` or `turn` changes, or when `title` changes.

## Detecting that the agent switched session

| Event | pi | Claude Code |
| --- | --- | --- |
| `/new` | new file in the store; `session_start` reason `"new"` | new `sessionId` written in the same `<pid>.json` |
| `/resume`, `--resume`, `-c` | new file (or existing older one) + `session_before_switch.targetSessionFile`; reason `"resume"` | PID file rewritten; `SessionStart` hook source `resume` |
| `/fork`, `/clone`, `--fork` | **new file** with `parentSession: <old path>`; reason `"fork"` | `SessionStart` source `fork` |
| `/tree` | **same file** — "Moves within the current session file" (`docs/sessions.md:42`); branch view changes, file does not, so no re-resolve needed | n/a |
| `/clear` | n/a | PID file rewritten; `SessionStart` source `clear` |
| `cd` inside the agent | `foreground.cwd` changes; pi keeps writing the *old* file (cwd is fixed at creation) — do **not** re-resolve on cwd change alone | new project dir only for a new session; the record's `sessionId` stays right |

Because `turn` only counts 7501 root transitions, it is a good "something happened, re-check" trigger but carries no identity. Treat title change as the cheapest reload trigger for pi (`setTitle` fires on `/name` and session switch), and re-reading `<pid>.json` as the cheap correctness check for Claude.

## Open questions

- Unverified: whether this herdr-core release could gain `pane.report_agent_session`. `hc` 0.1.21 has no such method and the request path exists only in herdr's own app, so under core the pi extension is inert. Everything about pi therefore assumes herdr-web ships its own extension (or a tiny reporter) for local *and* remote pis.
- Unverified on a remote **live** pi: no pi or Claude was running on `cachyos`/`devserver` during the probes, so remote resolution was exercised only as mechanism (`file.read` of `/proc/<pid>/environ`, `ls -l /proc/<pid>/fd`, `ls -t` of the store), not against a real agent.
- Unverified: how a herdr-core remote machine surfaces its terminals' `foreground` (core performs the read on the remote side and the socket carries the result); `hc get cachyos/t2` did return `foreground{pid,name,argv,cwd}`, so the fields are there, but staleness/refresh cadence on a remote is not measured.
- Unverified: whether a future Claude build drops `sessions/<pid>.json`; 2.1.325 writes it, and herdr-web-ui relies on it, but it is undocumented (inferred from binary strings + the code that consumes it).
- Unknown: whether `~/.pi/agent/sessions/<dir>/*.jsonl.acp.json` sidecars (billion-context) ever shadow a bare session name; treat them as non-sessions.
