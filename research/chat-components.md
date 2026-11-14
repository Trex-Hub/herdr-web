# Chat view component set (DEV-10)

## Answer

Build the agent chat view on **shadcn/ui AI Elements** (`npx shadcn@latest add <name>` from the `ui.shadcn.com` registry, Base UI flavour, Tailwind v4). It is MIT, it is the official successor to Vercel's `ai-elements`, and — critically — its components have **no AI SDK dependency at all**: `messages` and the render tree are plain props/children, so our WebSocket-fed adapters plug straight in. The AI SDK only appears in the docs' demo snippets.

Add two focused extras: **markdown** via Streamdown (what shadcn's own Message pattern recommends), and **diffs** via `@pierre/diffs` (Apache-2.0), because shadcn has no diff pattern. Take HextaUI's *free* Base UI chat components (message, bubble, message-scroller, attachment, questionnaire, prompt-input block) only as a visual/behaviour reference — they are restyled forks of the same shadcn primitives. Skip assistant-ui as the base (it drags in a runtime/provider model) and skip prompt-kit (stale, thin coverage).

We still build ourselves: the adapter→props mapper, thread-list-with-status sidebar, context-usage widget, approval/question plumbing to the socket, todo/plan + subagent trees, and the pi-tool → card mapping.

## Evidence

### shadcn/ui AI Elements — recommended base

- Licence MIT (`https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md`), repo pushed 2026-11-13 (`api.github.com/repos/shadcn-ui/ui`). Install is shadcn-registry copy-in, **not** an npm package: `https://ui.shadcn.com/docs/ai-elements/base/chat.md:480` → `npx shadcn@latest add message-scroller message bubble input-group`.
- It is the announced replacement for Vercel's set. `https://raw.githubusercontent.com/vercel/ai-elements/main/README.md` (top warning): *"AI Elements is moving to shadcn/ui. This project will be deprecated at the end of November 2026"* — verified, and `vercel/ai-elements` is still unarchived (Apache-2.0 per its `LICENSE`, GitHub API reports `NOASSERTION`).
- **No runtime AI-SDK dependency.** I pulled every component from the registry and grepped the source: `message-scroller`, `message`, `bubble`, `trace`, `code-block`, `input-group`, `attachment`, `questionnaire`, `item`, `progress`, `hover-card`, `collapsible` — zero `from "ai"` / `@ai-sdk` imports (`/tmp/research-chat-components/reg/*.json`). Only the doc examples use `useChat` (`ui.shadcn.com/docs/ai-elements/base/tool.md:11-12`, `chat.md:12-13`). Coupling is **types-only and only in examples**.
- Registry deps: `message-scroller` → `["cn", "@shadcn/react"]` + `registryDependencies: ["button"]` (`https://ui.shadcn.com/r/styles/base-rhea/message-scroller.json`). `@shadcn/react` is MIT 0.3.1 (2026-08-31), peer `react >=19`, and holds the *behaviour* (`@shadcn/react/message-scroller`); the copied file is styling only.
- Three primitive flavours, same component names: `base-rhea` (Base UI), `radix-rhea` (Radix), `aria-rhea` (React Aria) — all return 200 for `message-scroller`, `message`, `trace`, `code-block`, `questionnaire`. `apps/v4/registry/bases/README.md` in shadcn-ui/ui documents the parallel registries. Bubble/dialog/collapsible import `@base-ui/react/...` in the base flavour.
- Tailwind v4 + React 19 (`https://ui.shadcn.com/docs/tailwind-v4.md:3`). Components are `"use client"`, `data-slot`-driven, `cn` from the `cn` package (MIT 0.5.2).
- **Scroll behaviour is exactly what we need**, and it is the strongest single reason to pick this. `https://ui.shadcn.com/docs/components/base/message-scroller.md:2642-2676`:
  - scroll hot path stays out of React state (imperative, mirrored to `data-*`), no rerender of transcript rows while streaming;
  - `MessageScrollerItem` ships `[content-visibility:auto] [contain-intrinsic-size:auto_10rem]` (`registry/bases/base/ui/message-scroller.tsx`);
  - "comfortable for ... hundreds to low thousands of turns";
  - *"Virtualization is intentionally left outside the primitive"* — when we need it, `MessageScrollerViewport` is the scroll element and `@tanstack/react-virtual` owns the rows (concrete recipe at `message-scroller.md:2665-2730`).
  - Provider props (`/docs/react/message-scroller.md:184-200`): `autoScroll` (default `false`), `defaultScrollPosition: "start"|"end"|"last-anchor"`, `scrollPreviousItemPeek`; `Item.scrollAnchor` marks the turn boundary — our user turns. A11y: `Content` is `role="log" aria-relevant="additions"`, `Viewport` is `role="region" aria-label="Messages" tabIndex={0}`.
- Coverage of our needed pieces comes from **one** primitive plus a markup pattern: `Trace` (`Trace`, `TraceLine status="running"|"error"|"pending"`, `TraceIcon`, `TraceTitle`, `TraceCollapsible*`) is the row for reasoning, tool calls, plan, queue, task, subagent and terminal — `ui.shadcn.com/docs/components/base/trace.md:2` calls it *"The building block for reasoning, tool calls, sources and more."* Patterns that exist: chat, message, reasoning, tool, terminal, plan, queue, task, context, confirmation, subagent, chain-of-thought, file-tree, prompt-input, model-selector (`p-*.md` in /tmp/research-chat-components). **No diff pattern** anywhere.
- `code-block` pairs `shiki` with a `use-highlighted-code` registry item — good for both markdown fences and tool output.

### assistant-ui — capable, wrong shape for us

- MIT, `@assistant-ui/react@0.15.36` published 2026-11-12, three releases in the last three days (npm `time`). Deps include `radix-ui`, `zustand`, `zod`, `assistant-cloud`, `assistant-stream`; peer `react ^18||^19` (`packages/react/package.json`).
- Install via its own CLI/registry: `npx assistant-ui@latest init`, `npx shadcn@latest add @assistant-ui/thread`; registry at `https://r.assistant-ui.com/{name}.json` (175 items) with style-aware `styles/{style}/{name}.json` (`apps/docs/content/docs/(getting-started)/base-ui.mdx`). `npx shadcn init` defaults to Base UI styles since July 2026 (same file).
- The `thread` item's deps are just `@assistant-ui/react@^0.15.36` + `lucide-react`, and its source has **no** ai-sdk import (`aui-thread.json`). So the AI SDK is not required *if* you also avoid `useChatRuntime`/`@assistant-ui/ai-sdk`.
- But state must be supplied as a **runtime**, not props: `AssistantRuntimeProvider` + `useExternalStoreRuntime` with `messages`, `isRunning`, `onNew`, `onCancel`, `onLoadEarlier`/`hasEarlier`, `queue`, `onRespondToToolApproval`, `onRespondToToolApproval` (`packages/core/src/runtimes/external-store/external-store-adapter.ts:112-260`). `useAssistantTransportRuntime` streams *state snapshots* and converts them — also a protocol of its own (`apps/docs/content/docs/runtimes/custom/assistant-transport.mdx`).
- Its coverage is excellent and broader than shadcn's: 229 files under `packages/ui/src/components/react/assistant-ui/elements/`, incl. `todo-list.tsx` (168 lines, pure presentational), `agent-plan.tsx`, `subagent-list.tsx`, `approval-card.tsx`, `question-flow.tsx`, `terminal-block.tsx` (453), `code-diff.tsx`, `reviewable-diff.tsx`, `file-tree.tsx`, `context-display.tsx`, `message-queue.tsx`, `tool-fallback.aui.tsx` (1336), `thread-list.tsx` (with an `isRunning` dot + `sr-only "Running"`, `thread-list.aui.tsx:324-366`).
- Virtualization is a **guide, not a component**: *"assistant-ui does not ship a virtualized thread component"* (`apps/docs/content/docs/guides/virtualization.mdx:7`), using `@tanstack/react-virtual` + `createThreadRowsSelector` + `ThreadPrimitive.Row`; rows are `message`/`part`/`turn-end` with keys stable during streaming.
- There is a ready-made Pi adapter: `@assistant-ui/react-pi@0.0.33` (MIT) — browser entry `usePiRuntime` + `createPiHttpClient` over an HTTP/SSE `PiClient` contract, `./node` entry `createPiNodeClient` driving Pi's `AgentSession` SDK. It exposes `contextUsage {tokens, contextWindow, percent}`, thinking levels, mid-run steer/queue, and the blocking extension UI as approvals (`packages/react-pi/README.md`). Note: it **drives** Pi in-process; our adapters **tail session files**, so this only helps if we switch to driving Pi over the bridge instead. `@assistant-ui/acp` exists but is private/unpublished: *"This package is private and not published to npm"* (`packages/acp/README.md`).
- Verdict: only worth it if we want a full runtime + its element kit. Adopting it means replacing our prop-driven view model with its message-part store.

### prompt-kit — thin, and going quiet

- MIT (`LICENCE.md`, © 2025 Julien Thibeaut), 3155 stars, `pushed_at 2026-09-28`, last commits Sep 2026 and Mar 2026 (GitHub commits API). Registry install only: `https://prompt-kit.com/c/<component>.json` (message, prompt-input, chat-container, markdown, code-block, tool, reasoning all 200).
- 21 components (`components/prompt-kit/`). No AI-SDK imports inside them (grep clean). Radix-based (`@radix-ui/*` in `package.json`), Tailwind v4, Next 15.1.10, React 19.
- Coverage is the gap: `chat-container.tsx` is a 1.4 KB `use-stick-to-bottom` wrapper; `tool.tsx` is a single collapsible that expects AI-SDK `ToolPart` state strings (`input-streaming|input-available|output-available|output-error`). No thread list, no todo/plan, no diff, no subagent, no approval, no context usage.

### HextaUI — same look, mostly paid, free parts are forks

- Free components MIT (`preetsuthar17/hextaui`, 154 stars, pushed 2026-11-14). Pro blocks are under the Pro License (`https://hextaui.com/legal/license.md`): perpetual use, unlimited projects, but no redistribution as a kit — fine for us, just not free. Blocks list (`hextaui.com/blocks.md:41,50`): **Chat Thread and the Hexta AI block are Pro**; **Prompt Input is free**.
- The free `message-scroller` is a **restyled fork of shadcn's**: same `@shadcn/react/message-scroller` imports, plus a spacer-hold effect; 394 vs 136 lines; adds `@tabler/icons-react`, `cn`, and `theme.json`/`motion.json`/`message.json` registry deps (`https://hextaui.com/r/message-scroller.json`). Bubble/message/attachment/questionnaire likewise import `@base-ui/react`.
- Free chat set (`hextaui.com/components.md:15`): messages, bubbles, message scroller, attachments, date markers — plus `questionnaire`, `sidebar`, `tabs`, `collapsible`, `item`, `scroll-area`, `resizable`. Free `prompt-input` block lives at `https://hextaui.com/r/pro/prompt-input.json` (174 KB).
- Tailwind v4, Base UI, shadcn-registry install, `.md` twin for every page. Reuse the *theme tokens and the visual treatment*; do not take Pro code.

### Markdown and diff

- **Streamdown** — Apache-2.0, 2.7.1 (2026-10-19), deps `marked`/`remark-gfm`/`rehype-*`/`remend`/`harden`; no AI SDK. `ui.shadcn.com/docs/ai-elements/base/message.md` tells you to render replies with Streamdown and route fences to Code Block. `@streamdown/code` 2.0.0 Apache-2.0 for the shiki plugin.
- **@pierre/diffs** — Apache-2.0, 1.6.4 (1.7.0-beta.3 on 2026-11-09), peer `react ^18.3.1||^19`, deps `diff@9` + `shiki`; exports `.`, `./react`, `./ssr`, `./edit`, `./worker`; split/stacked layouts, annotation framework, accept/reject hooks (`packages/diffs/README.md`).
- `react-diff-view` 3.3.3 MIT is the fallback but peers `react >=16.14`, pulls `lodash`, and has no shiki highlight integration.
- kibo-ui (`shadcnblocks/kibo`, MIT, 3986 stars, pushed 2026-05-04) is a general shadcn registry (gantt, kanban, its own `code-block`). Nothing chat-specific; shadcn's own `code-block` supersedes theirs.

### Comparison

| | shadcn/ui AI Elements | assistant-ui | prompt-kit | HextaUI (free parts) |
|---|---|---|---|---|
| Licence | MIT | MIT | MIT | MIT (free) / Pro licence (blocks) |
| Primitives | Base UI **or** Radix **or** React Aria (`base-rhea`/`radix-rhea`/`aria-rhea`) | Radix or Base UI, one headless runtime | Radix | Base UI |
| Tailwind | v4 | v4 | v4 | v4 |
| Install | shadcn registry copy-in (`npx shadcn@latest add`) + `@shadcn/react` for scroll behaviour | `assistant-ui` CLI / `r.assistant-ui.com` registry, npm runtime | shadcn registry copy-in | shadcn registry copy-in |
| State model | **plain props/children** (patterns show AI-SDK `UIMessage`, but components take none) | **runtime + provider** (`ExternalStoreAdapter`, `AssistantTransport`) | plain props | plain props |
| AI SDK need | none at runtime; types only in examples | none if you avoid `useChatRuntime`; `@assistant-ui/ai-sdk` otherwise | none | none |
| Thread + stick-to-bottom | **yes**, `MessageScroller` (anchors, peek, a11y, content-visibility) | yes, `ThreadPrimitive.Viewport` (`autoScroll`, `turnAnchor`) | thin `StickToBottom` wrapper | fork of `MessageScroller` |
| Virtualization | recipe on the primitive (`@tanstack/react-virtual`) | recipe only (`createThreadRowsSelector` + `Row`) | none | none |
| Message / markdown / code | `message`, `bubble`, Streamdown + `code-block`(shiki) | yes + `react-markdown` pkg | yes | yes |
| Reasoning / tool / terminal | `Trace` + `trace`/`tool`/`terminal` patterns | `reasoning`, `tool-fallback`, `tool-group`, `terminal-block` | `reasoning`, `tool`, `steps` | not in free set |
| Plan / todo / subagent / queue | patterns (plan, queue, task, subagent) rendered with Trace | shipped elements (`todo-list`, `agent-plan`, `subagent-list`, `message-queue`) | none | none |
| Diff | **none** | `diff-viewer`, `code-diff`, `reviewable-diff` | none | none |
| Approval / question | `confirmation`, `questionnaire` (Base UI, `@shadcn/react`) | `approval-card`, `question-flow`, `elicitation-form` | none | `questionnaire` (free) |
| Context usage | `context` pattern (hover-card + progress) | `context-display`, `context-usage` | none | in free Prompt Input |
| Thread list + status | not a pattern (use `sidebar`) | yes, running dot | none | `sidebar` only |
| Composer + slash/attachments | `prompt-input` pattern (`input-group`, `attachment`, dropdown menus) | `composer` (733 lines), `composer-trigger-popover` w/ slash+mention adapters | `prompt-input`, `file-upload` | free `prompt-input` block |
| Maintenance | very active (2026-11-13) | very active (2026-11-12) | last push 2026-09-28 | active (2026-11-14), but free tier is the loss leader |
| Next.js App Router / React 19 | first-class (`"use client"`, RSC-safe, `@shadcn/react` peers `react>=19`) | first-class (`with-ai-sdk-v7`, `with-pi` examples) | legacy (Next 15.1, AI SDK v5 demo) | first-class |

## Open questions

- **Virtualization reality check.** shadcn claims "hundreds to low thousands of turns" with `content-visibility:auto`. Our worst case is a pi session with thousands of rows *and* a reasoning block per turn. Unverified whether that is enough, or whether we must ship the `@tanstack/react-virtual` composition from day one. Needs a spike against a real long session file.
- **Does `@shadcn/react` cover our anchoring needs?** `defaultScrollPosition: "last-anchor"` looks right for opening a tailed session at the last user turn, but I did not run it; the "Avoiding a Flash on Reload" section (`/docs/react/message-scroller.md:135`) suggests the contract is still settling (`0.3.1`, first release 2026-06-26).
- **shadcn AI Elements is young.** The registry items exist and install cleanly, but the whole `base-rhea`/`trace` set is newer than the vercel one and there is no diff pattern; I could not find a changelog/versioning signal for the pattern docs, so treat the pattern prose (not the primitives) as the volatile part.
- **HextaUI free `prompt-input` licence.** The page says free "under the Pro License" (`hextaui.com/blocks/prompt-input.md:18`) while the free *components* repo is MIT. Which text governs a copied block is ambiguous; if we reuse it, take only ideas.
- **assistant-ui's Pi adapter** fits driving Pi over the bridge, not tailing session files. If we later switch the bridge from "tail sessions" to "own the runs", `@assistant-ui/react-pi` becomes a strong option — not verified that its `PiClient` could be served over our existing WebSocket rather than HTTP/SSE.
- Not verified: whether any shadcn pattern handles *interleaved* file-edit/write tool cards (edit → read → write with per-call diff) beyond the generic `tool` pattern; and no candidate ships a "subagent transcript nested inside a row" beyond assistant-ui's `subagent-list` and shadcn's `subagent` pattern prose.
