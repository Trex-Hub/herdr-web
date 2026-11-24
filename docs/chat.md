# Chat

![A pi agent's chat in herdr-web: a table, tool calls folded into one line, and markdown](images/chat.png)

A pi agent with [pi-live](https://github.com/Trex-Hub/pi-live) loaded gets a chat view in its pane, next to the terminal. pi-ask-user bundles pi-live, so a pi with [pi-ask-user](https://github.com/Trex-Hub/pi-ask-user) has it too.

## Set up

1. Install pi-live 0.2 or later: `pi install git:github.com/Trex-Hub/pi-live`. If you use pi-ask-user, update it instead (`pi update`), because it already includes pi-live. Questions in the chat need the Trex-Hub fork of pi-ask-user (a plain pi-ask-user asks in the terminal only). To try it for one run without installing, start pi with `pi -e git:github.com/Trex-Hub/pi-live`.
2. Restart any pi that is already running. Extensions load at start-up.
3. Run pi interactively, in a terminal of the core the backend is connected to.

`/new`, `/resume`, `/fork` and `/reload` keep the chat, which follows pi into the new session.

A pi is linked to its terminal only if all of these hold:

- pi-live names the terminal. It reads `HC_TERMINAL_ID`, which core sets in every terminal.
- pi is interactive. `pi -p`, JSON and RPC runs, such as a sub-agent started from inside a pi, are never linked.
- The terminal is live, on this computer, in the backend's core.
- pi-live and the backend use the same folder ([configuration](configuration.md#which-pi-live-folder)).

### Control

The backend connects as a chat client named `herdr-web`. With control off, the chat still shows but nothing can be sent. To turn it off for a pi, set `PI_LIVE_CONTROL=0`, or put `{ "control": false }` in `pi-live.json`.

Your own pis accept control from any program running as you, so treat pi-live's folder as private.

## In the pane

A terminal with a chat shows a **Chat / Terminal** toggle. Chat is the default, and the browser remembers your choice per terminal. Only the shown side is live: the chat subscribes while Chat is shown, and the terminal attaches while Terminal is shown.

When a pane has no chat, or can't send, it shows one line saying why:

| Line | Meaning |
| --- | --- |
| "Chat needs pi-live 0.2 or later…" | The terminal runs pi but has no chat. It shows above the terminal, and you can dismiss it. |
| "Update pi-live to chat with this pi." | That pi-live cannot chat. The rows show, and the composer is off. |
| "Control is off for this pi." | The rows show, and the composer is off. |
| "pi-live is not connected to this agent, so nothing can be sent" | pi went away. The last rows stay, dimmed, until it comes back. |

## The thread

- **Your messages** are bubbles on the right. The agent's replies are markdown, with highlighted code blocks you can copy.
- **Thinking** shows as "Thought" and opens to its text.
- **Tool calls** take one line each: name, main argument, duration and outcome. A line opens to the call and its result.
- **Runs of tool calls and thinking** collapse into one line, such as "Thought, ran 5 commands, read 1 file". The run the agent is working on stays open until the turn ends.
- **Compactions** and **model switches** show as dividers. Notices are quiet lines.
- **Messages from other agents** over [pi-link](#pi-link) are bubbles on the left. See below.
- **Under each reply** are a copy button and the model and effort it was written with.
- **Scrolling.** The thread follows new text until you scroll up. **Jump to latest** brings it back. Older history loads as you near the top.

## pi-link

When the agent talks to other pi terminals over [pi-link](https://github.com/alvivar/pi-link), the thread reads like a conversation between them.

- **Messages it received** are bubbles on the left, each under the sender's name, a small avatar with its initials, "pi-link" and the time. Several messages from one sender in a row share the name. A long message shows its first lines and **Show more**. Messages are markdown.
- **Messages it sent** (`link_send`) are dashed bubbles on the right, under "To <name>", with "Sending", "Sent · <time>", "Stopped", or "Not delivered: <reason>" in red when pi-link could not deliver it.
- **Each terminal has its own colour**, the same in every chat: it comes from the terminal's name.
- **`link_list`** is one line, "Listed 3 terminals", which opens to each terminal and its status. **`link_compact`** is a small line, "Asked <name> to compact", and the answer is another, "<name> compacted" or what went wrong.
- These are never folded into a run of tool calls.
- A batch the app cannot split into its messages for certain (a message that quotes another one's `From "…":` header) shows as one bubble with all of its text and a note saying so.

The app only shows what pi-link wrote in the session; sending to another terminal from the browser is not part of it. Messages that other extensions show in the chat stay quiet lines.

## The agent's todo list

When the agent keeps a todo list (the `todo` tool of [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)), the chat shows it as a card pinned on top of the composer, as the terminal shows it above its editor.

- The header reads **Todos** and `done/total`. Click it to collapse the card to one line with the task being worked on and a thin progress meter; click again to open it. It starts open.
- A task waiting is a dashed circle; the one in progress is a turning ring, in bold, with what the agent is doing under it; a finished one is a green check, struck through. A task that waits on another one that is not done says `after #5`. A screen reader hears each row's state first ("In progress: …"), and a polite message names the task being worked on, at most every three seconds.
- A list of more than five tasks folds to what matters: finished tasks become `✓ 3 done`, then the task in progress and the next two, then `+4 more`. Click either to see every row, and **Show less** to fold again. The whole card, header included, never takes more than a third of the window height; the rows scroll inside. While a question from the agent is open the card folds to its header so the question has the room, and opens again when it is answered.
- Deleted tasks are not shown, and an empty list shows no card. When every task is done the card stays as `Todos 4/4` until you send the next message, then it goes. When the turn ends, the ring of a task still in progress stops turning (it does not turn at all for someone who asked their system for reduced motion).
- The list updates as the agent works. It is always the agent's latest list in full, never added to.
- In the thread the `todo` calls are short lines in the run of steps (`Started: Fix the parser`, `Completed: …`, `Added 5 tasks`), not JSON. A call that failed, or an action the app does not know, shows as any tool does.

The list is only shown; changing it from the browser is not part of this.

## Questions from the agent

When pi asks you something with [pi-ask-user](https://github.com/Trex-Hub/pi-ask-user) (its `ask_user` tool, the Trex-Hub fork that parks each prompt on pi-live), the composer gives way to a panel, and the thread shows the question as one line.

- **The panel** takes the composer's place until the question is answered or closed. With several waiting, the oldest shows first and "1 more question waiting" says so. **Stop** stays in the panel.
- **Choices** are one list, each with its number. Pressing a number picks that row. A single choice without a comment is sent as soon as you pick; with several choices you tick rows and press **Submit**.
- **Type something else…** is the last row when the question allows free text. Typing there replaces any pick, and Enter sends it.
- **A comment** is an optional line under the choices when the question allows one.
- **Several questions at once** show one at a time, with **n/N** at the right, **Previous**, **Skip** and **Next**. Picking an answer moves on to the next question, and the last one waits for **Submit**. One answer goes to pi at the end, with the skipped questions marked.
- **A long context** shows its first lines, with **Show more**.
- If pi refuses an answer, its reason shows under the choices and the panel stays. If the question was already answered or closed (at the keyboard, in another window), the panel says so and goes.

The line in the thread follows the question: "Awaiting input…" while it is open (with "· expires in 2 min" when it has a deadline), "Answered" for the moment between sending and pi's reply, then **"Asked: … · Answered: …"**, which opens to every question and answer. A batch reads **"Asked: <heading> · 2 of 3 answered"** (the heading is the call's top-level `question`; without one, "3 questions"), or "0 of 3 answered" when every question was skipped. A question that was cancelled, timed out or cut off by Stop reads "Not answered"; one that pi went away in the middle of reads "Stopped".

A prompt that pi-live does not hold (a pi with no pi-ask-user, or an old one) shows a read-only card with the question, its options and "Answer in the terminal." You answer it in the terminal; the line still ends with the answer.

## Approving guardrails prompts

With [pi-guardrails](https://github.com/Trex-Hub/pi-guardrails) (the Trex-Hub fork that parks each prompt on pi-live), a dangerous command or a path outside the workspace can be approved from the chat. A delegate (a classifier that decides for you) still goes first; the card shows only what reaches you.

- **The card** takes the composer's place: "Needs approval" and the tool, the question ("Run this command?", "Use a file outside the workspace?", "Open a folder outside the workspace?"), "Guardrails stopped it: <reason>", then the command whole (numbered when it has several lines, folded past 12 lines with **Show all N lines**, or past about 1,400 characters with **Show the whole command**) or the path. With several waiting, the oldest shows with "1 of N" and "N more waiting".
- **Allow once** is the main button. The arrow beside it opens the wider grants: **Allow for session** for a command; for a path the folder once, the file or folder for the session, and **Always allow** (saved to the project's or your global guardrails settings, as the line under it says; off with its reason in a project that is not trusted). **Deny** is next to it, and for a command **Deny and stop the turn** denies and stops the agent.
- **Safety**: Allow (and Deny and stop the turn) stays off for 0.6 s after a card appears (a thin bar fills meanwhile), so a tap meant for something else cannot approve or abort. Enter never approves (on the arrow it opens the menu). **Esc** denies, **⌘/Ctrl+Enter** allows once; Deny works at once. The command is never cut: long lines and runs of spaces wrap inside the box, so nothing can be pushed out of sight. The card is announced as a dialog, and shows "Sending…" while an answer is on its way.
- If pi refuses an answer its reason shows and the card stays; if the prompt was already answered (in the terminal, another window) the card says so and goes.

The call in the thread gets one line under it: **"Awaiting approval"** while the prompt is open, then how it ended: "Allowed once", "Allowed for this session", "Always allowed this folder", "Denied", "Denied and stopped", "Answered in the terminal", "Answered in another window", "Denied: the agent was stopped", "Not answered: pi closed the prompt". A call made through another tool (codemode) gets the line under that tool's row; a prompt that names no call shows its line at the end of the thread. The lines last as long as the backend's connection to the pi.

A pi with upstream pi-guardrails, or with no pi-live, keeps the terminal prompt and the line "Waiting for you in the terminal" below.

## When pi waits for you in the terminal

Some of pi's own screens cannot be answered from the browser: a permission confirm, a picker or a form an extension opens (`ctx.ui.select`, `confirm`, `input`, `editor`, `custom`). While one is open, the thread shows one muted line, **"Waiting for you in the terminal"** (with `: <title>` when pi names the dialog), in place of "Working…", and **Open terminal** switches the pane to the Terminal view. Answer it there; the line goes when pi moves on. The composer stays as it is.

A question from `ask_user` is not shown twice: it has its own panel (or, for a pi that does not park it, the read-only card), and the line above stays hidden while either is there. The same goes for an open guardrails card. pi's built-in screens (`/model`, `/tree`, …) are not reported, so they show no line.

## The composer

- Enter sends. Shift+Enter starts a new line.
- A draft is kept per terminal.
- While the agent works, a **Stop** button shows, and a message you send waits as pending until the agent takes it.
- Model and effort pickers switch pi's model and thinking level.

### Slash commands

| You type | What happens |
| --- | --- |
| `/compact [instructions]`, `/name <name>` | Sent to pi as actions. |
| A skill, a prompt template, or an extension's command | Sent to pi as a message, which pi runs. |
| One of pi's own commands (`/new`, `/resume`, `/model`, `/settings`, `/reload`, `/quit`, …) | Typed into the terminal. pi runs it a few seconds later, and the composer offers **Show terminal**. Commands that open a picker in pi switch the pane to Terminal. |

Some of pi's own commands have no extension API at all (`/login`, `/settings`, `/share`, `/export` and others), so the terminal is the only way to run them.
