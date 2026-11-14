# Transcript libraries for pi + Claude Code (DEV-6)

## Answer

No maintained library does the whole job: **every candidate drops one of the four things a live chat view needs** — pi's active branch, Claude sidechains, images, or incremental tailing. The closest is `@tangle-network/harness-sessions` (MIT, ESM, typed, both formats, good schema, but full-file re-read and pi read in file order), and `kosumic/whip`'s `agent-transcript-core` has the best semantics but is Rust-only, AGPL at the repo root, and needs rustc 1.100.

**Recommendation: build the adapter layer ourselves (~1 file per agent), and take the pi half from the official pi SDK** (`SessionManager` / `buildSessionProjection`, same vendor, MIT, already gives active-path + compaction + images in ~2 ms). Write the Claude Code parser ourselves (~300–500 lines) using `harness-sessions`' rules as the reference; keep it as a dev-time cross-check, not a runtime dependency, because it re-reads the whole file per call and its pi branch policy is wrong for a chat view. Tailing is ours either way: no candidate tails pi.

## Evidence

### What the formats actually demand

- **pi is a tree, not a log.** Entries carry `id`/`parentId`; `/tree` moves the leaf without rewriting, so the visible conversation is the path from the *last* entry back to a root; `compaction` adds `firstKeptEntryId`, `branch_summary` records the abandoned path (https://pi.dev/docs/latest/session-format). Measured on one real 26 MB session: 1858 entries, **2 roots, 4 branch points, 1 branch_summary**, active path 1827 entries, 68 user messages on the active path vs 72 in the file.
- **Claude Code sidechains live in a separate file.** On this machine: 320 main `*.jsonl`, 29 `*/subagents/agent-*.jsonl`; **0** main files contain `isSidechain:true` rows. A subagent file is only readable as a session if you pass its parent id.
- **Images matter but only in tool results (pi).** Across all 659 local pi session files: 971 `image` blocks, and in a 250-file sample every one sat inside `role:"toolResult"` content, never in a user message (79 occurrences). Claude Code puts them in `user` content as `{type:"image",source:{type,media_type,data}}` (3 blocks in one sampled file).
- **Tailing is a byte-offset problem.** pi appends one line per entry and holds no fd (`research/terminal-to-session.md` §2), so a watcher must poll/re-read and handle a torn last line.

### Comparison

| | pi | Claude Code | pi branch (active path) | CC sidechains | Images | Incremental tail | Node lib | Licence | Health |
|---|---|---|---|---|---|---|---|---|---|
| **@tangle-network/harness-sessions** 1.0.13 | yes | yes | **no** — file order + `gaps` note (`dist/formats/pi.js:50-65,136`) | main: skipped w/ note (`dist/formats/claude-code.js:44`); subagents as separate refs w/ `children[]` (`:236-262`) | pi: base64 kept in `toolCall.result.output[]`; CC: attachment `ref:"inline:<uuid>"`, **bytes dropped** (`:164-167`) | **no** (full re-read per `read()`, `dist/formats/fold.js:8-20`) | ESM, `.d.ts`, `node>=22.13` | MIT | 0★, 6 contributors, pushed 2026-11-14, 27 versions since 2026-10-07, 5662 dl/wk |
| **agent-canonical** 0.4.1 | yes | yes | **no** — deliberate file order (`src/parsers/pi/reduce.ts:1-30`) | yes, `agentType` + `parentSessionId` (`src/parsers/claude-code/reduce.ts:165-172`) | **dropped** (`flattenText` keeps only `text`, `src/parsers/pi/records.ts:259,365`) | CC only (`src/parsers/claude-code/incremental.ts:105,164`); pi declares `incrementalRead:false` (`src/dialects/pi.ts:63`) | ESM, zod peer | MIT | 0★, 1 author, last commit 2026-09-02, 48 dl/wk |
| **@hypabolic/trajectory** 0.1.4 + `-node` | yes | yes | **no** (`parentId` appears 0× in `src/internal.ts`) | **dropped**: `sidechain_record_dropped` (`src/internal.ts:534`); sidechain-only file **throws** `missing_user_records` (`:256`) | `"[image]"` placeholder + `image_content_dropped` (`:606-607,1718`) | **best**: `followFile` + `StreamUpdate`/snapshot+delta (`src/streaming.ts:324,908,1297`; `trajectory-node/src/file-stream.ts:341`) | ESM, `node>=22` | MIT | 11★, 1 author, last commit 2026-08-13, 5 dl/wk |
| **txcript** 0.14.4 | yes | yes | **no** (documented file order, `docs/formats/pi.md`) | **no** (`isSidechain` appears 0× in `src/harness/claude_code.rs`) | **preserved**, incl. base64 (`src/common.rs` `Block::Image`) | **no** — wasm text-in/text-out (`src/wasm.rs:3`) | wasm-bindgen CJS `main`, `pkg/txcript.d.ts` | Apache-2.0 | 221★, 9 contributors, 43 open issues, last commit 2026-10-23, 963 dl/wk |
| **agent-transcript-core** 0.3.0 (whip) | yes | yes | **yes** — walks max(order)→root (`src/agent_transcript/pi.rs:312-330`) | filtered out of the visible chain (`claude.rs:201,208,245,335`) | pi: user-role only (`pi.rs:146-155`); tool-result images flattened away (`content.rs:31-70`) | **yes** — `ingest(SourceRecords::Jsonl{generation,bytes})`, `revision()`, offset bookkeeping (`session.rs:62,140,157`) | **no** — Rust crate, no napi/wasm | MIT crate, **AGPL-3.0 repo root** | 151★, 5 contributors, pushed 2026-11-14, 43 total downloads, `rust-version = 1.100` (machine has 1.95 → `cargo build` fails) |
| **agent-session-format** 0.9.0 | **no pi parser at all** (`src/parsers/` = claude-code, codex-family, kimi, opencode, antigravity, hermes) | yes | n/a | n/a | n/a | no | TS, dist committed, install via `github:` | MIT | 0★, 1 author, 20 dl/wk |
| **agent-session-bridge** 0.1.1 | yes | yes | yes (`flattenPiActiveBranch`, `packages/core/src/parsers.ts:52`) | n/a | `{type:"image"}` in `NormalizedContent` | no | **core package unpublished** (`npm view agent-session-bridge-core` → E404; `packages/core` version `0.0.0`) | MIT | 109★ but last commit 2026-04-08, 11 dl/wk |

Also checked and rejected: `Nwflower/dsh-chat-import` (DeepSeek-Harness plugin, not a library), `@junghanacs/entwurf` (no `exports`, CLI/extension bundle, 11 MB), `@earendil-works/pi-client` (transport for pi's *experimental service protocol*, not a file reader).

### Live runs (read-only, `/tmp/research-transcript-library/run`)

Same files through each library; counts only, no content.

| file | harness-sessions | agent-canonical | @hypabolic/trajectory | txcript |
|---|---|---|---|---|
| pi, 56 lines (12 KB) | 40 msgs (12 system / 5 user / 15 assistant / 8 tool), 8 tool calls, 0 gaps | 26 msgs (5 user / 2 system / 6 thinking / 13 assistant) | 33 records | 26 msgs |
| pi, 26 MB, branched | 1788 msgs (123 system / 72 user / 794 assistant / 799 tool), 800 tool calls, 1 gap "4 entries … session branched"; **47–65 ms** | 1348 msgs, 1858 `rawEvents`, **112.7 ms** | 2246 records, **226.1 ms** | 1664 msgs, **96.0 ms** |
| pi, 2 image blocks in toolResult | 2 tool calls with base64 in `result.output[]`, **0** attachment parts | 0 images in messages, 2 in `rawEvents` | `"[image]"` placeholder text | base64 preserved in tool_result blocks |
| CC main, 82 lines | 34 msgs (21 system incl. attachment `rendered`, 5 user / 4 assistant / 4 tool), 4 tool calls, 1 tool-definition snapshot, `ending:"open"`, **6.2 ms** | 9 msgs, 4 assistant lines correctly merged by `message.id` | 18 records + **8 `unknown_semantic_record` diagnostics** | 21 msgs |
| CC subagent file, read standalone | **0 msgs** + gap "71 sidechain records … belong to subagents" | 22 msgs, `agentType:"statusline-setup"`, `parentSessionId` set | **throws** `missing_user_records` | 48 msgs |
| CC subagent file, parent passed | 59 msgs (4 user / 18 assistant / 14 tool), `parentNativeSessionId` set | — | — | — |
| CC file with 3 image blocks | 3 `attachment` parts, `ref:"inline:<uuid>"`, **base64 absent** | 0 in messages | placeholders | 3 image blocks preserved |

Other measurements: `harness-sessions` `readSessionInput('pi',{records})` re-folds the 1858 parsed records in **3.7–6.8 ms** (JSON.parse of the file is 86.7 ms), so "parse once, re-fold on change" is viable even without a tail API. `locate()` cost: 107 ms for pi (walks all 659 files), 55 ms for CC. The pi SDK on the same 26 MB file: `parseSessionEntries` 88 ms → `buildContextEntries` 1827 → `buildSessionProjection` **2 ms** → 1772 messages with blocks `{text 952, thinking 476, toolCall 795, image 69}`.

### Schema quality, briefly

- **harness-sessions** is the best normalized shape for a chat UI: `SessionMessage{role, actor, parts[]}` where `Part = text | reasoning | tool-call | tool-result | attachment`, plus a separate `toolCalls[]` with `input`, `result{output,text,isError}`, `status`, and `modelCalls[]` with served model + usage + error, `integrity{gaps,unparsedRecords,truncated}` (`dist/schema.d.ts`). Its `actor` field (`human|agent|subagent-spawn|injected|tool-result`) is exactly the distinction a chat view needs. Weakness: pi `system` entries (system-prompt snapshots, empty `content`) become **123 empty system messages** on the big file — they must be filtered by the consumer.
- **agent-canonical** has the richest per-message detail (`toolCalls[].argsPreview/outputPreview/outputSha/exitCode`, `usage` incl. cache tokens, `rawEvents` preserving every line) but no image channel at all in `Message`/`ToolCall` (`src/schemas/transcript.ts`).
- **hypabolic** IR is the most "event-like" (`meta`, `message`, `assistant_tool_calls`, `tool_result`, `execution`) and its streaming deltas are genuinely good, but `bigint` cursors break `JSON.stringify` without a replacer, and snapshot records use snake_case while `normalizeToIR` uses camelCase.
- **txcript** is a converter, not a viewer model: MCP/unknown tools collapse into `Tool::Raw` (`src/common.rs:242`), so `mcp__linear__get_issue` arrives as `{name:"Raw", tool_name:"mcp", input:{server:...}}`.

## Open questions

1. **pi's own service protocol.** `@earendil-works/pi-client` says "Application observation APIs such as the coding agent's `Transcript` are ordinary Chord services" (README) — a live push channel would remove file tailing entirely. Marked *experimental*; I found no public schema for the `Transcript` service and did not run it. Worth a spike before committing to a poller.
2. **Claude Code tailing.** No candidate tails CC either; `agent-canonical`'s `readEventsSince` is the only working cursor (verified: 0 events on the consumed prefix, 3 after an append) but its turn-event vocabulary is lossy (no tool results). Unverified whether Claude rewrites rather than appends on `/clear`.
3. **`harness-sessions` stability.** 27 versions in five weeks, 0 stars, and the README is written for Tangle's own capture/eval pipeline. Whether its `HarnessSession` shape is a public contract or an internal one is not stated.
4. **pi images inside tool results** are only reachable as raw base64 in `toolCall.result.output[]` (harness-sessions) or `Block::Image` (txcript); no library models "tool returned a picture" as a first-class message part. If the chat view shows screenshots, that mapping is ours.
5. **`whip`** would be the semantic reference to copy (active-path snapshot + generation/offset ingest + `AgentTranscriptPart::Tool{state,diff}`), but I could not compile it here (rustc 1.95 vs required 1.100), so its behaviour is read from source only.
