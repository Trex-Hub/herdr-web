# How products show the agent's todo list (DEV-41)

## Answer

Every product shows the list with the same ingredients and differs only in **where it sits**. Four placements are in use; the prototype (`/tmp/herdr-web-dev41-prototype/todo-prototype.html`) builds each so they can be compared.

| Placement | Who does it |
|---|---|
| A. Pinned card at the composer, collapsible | VS Code Copilot ("Todo control at the top of the Chat view"), vercel-labs/open-agents `pinned-todo-panel.tsx`, 1agents `PlanChecklist` |
| B. Slim progress line (count, current step, bar) | `task-progress-mod` for Claude Code (a pinned bar above the prompt), VegaStack `TaskListProgress` |
| C. Inline card in the transcript, updated in place | Cursor ("visible to you in chat"), Claude Code terminal, claude-code-webui; users then ask for a pinned copy (anthropics/claude-code#31243) because inline updates "get buried in the conversation scroll" |
| D. Right rail "Progress" section | Claude Cowork (right panel: Progress, Working folder, Context), Claudette Tasks bar, Ona sidebar |

## Behaviours worth copying

- **Say what is happening now, even when folded.** VS Code: the control "automatically collapses as the todo list is worked through and shows only the current task in progress" (v1.104 notes). Claude Code's own SDK doc renders `activeForm` for the in-progress item in place of its subject. Ona: "if it shimmers, work happens", second line is the current todo.
- **Long lists fold by relevance, not by position.** VegaStack Task List: five or fewer rows never fold; longer lists keep the live item on top, finished items fold into "✓ N done", the next two follow, the rest become "+N more"; opening a fold shows everything.
- **Show the count at the end, not "Done".** VS Code changed the collapsed title to `Todos (3/3)` when everything completes (microsoft/vscode#275449).
- **Hide when there is nothing to show.** open-agents hides the panel when empty, all done, or all pending (the agent is still writing its list). rpiv-todo's terminal panel drops completed rows the next turn and disappears when empty.
- **Replace wholesale from the last committed snapshot.** Claude's SDK doc ("render the last call and skip one whose input is still streaming"), Codex (`update_plan` is a full snapshot each time), open-agents ("ignores still-streaming todo tool inputs").
- **Keep the pinned view when the list scrolls away.** VegaStack's `TaskListProgress` is a slim sticky bar that scrolls back to the list on click.
- **Accessibility:** rows read state first ("In progress: Create the PDF"); one polite live region announcing the live item at most every 3 s (VegaStack).

## Failure modes users complain about (design against them)

- Panel stale until end of turn (Cursor forum, "Todo list panel does not refresh during long agent turns"): update live, from the stream.
- List never reaches 100% after the agent finishes, items stuck on a spinner (microsoft/vscode#332934): when the turn ends, stop the spinner on any in-progress row.
- Cards vanishing after all items complete (Cursor 3.0 fix): keep the final `N/N` visible until the next turn.
- Duplicate/stale items (Cursor v2026.11.04 fix): replace the list, never append.

## What the experts say

- Ona (Christian Weichel, "In search for parallel flow"): todos are "a flexible feedback device that embed the user's intentions with the actions of the agent", not a rigid up-front plan; the sidebar shows progress `2/5` and the current todo as peripheral vision across parallel work.
- agentic-ux.com "Progress Ledger": update incrementally, animate the active step subtly, allow collapse once users trust the run, never let the ledger vanish after completion with no archive; very granular steps feel performative.

## Sources

- https://code.visualstudio.com/updates/v1_104/ and https://github.com/microsoft/vscode/issues/275449, /332934
- https://cursor.com/changelog/1-2, https://cursor.com/docs/release-notes, https://forum.cursor.com/t/todo-list-panel-does-not-refresh-during-long-agent-turns-update-todos-is-fire-and-forget/177775
- https://code.claude.com/docs/en/agent-sdk/todo-tracking, https://github.com/anthropics/claude-code/issues/31243, https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- https://github.com/openai/codex (`codex-rs/core/src/tools/handlers/plan_spec.rs`, `base_instructions/default.md`)
- https://design.vegastack.com/docs/components/task-list, https://agentic-ux.com/patterns/progress-ledger, https://ona.com/stories/in-search-for-parallel-flow
- https://github.com/vercel-labs/open-agents (`apps/web/components/pinned-todo-panel.tsx`), https://ui.shadcn.com/docs/ai-elements/base/queue
- Not reached (search rate limit): Windsurf Cascade and Devin docs.
