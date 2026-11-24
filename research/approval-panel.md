# Approving a gated command or path from the chat

Research for DEV-42: how coding-agent products show a permission prompt for a command or a path, and what to copy for the pi-guardrails approvals in herdr-web.

## What guardrails asks (the content we have to show)

- **Command** (`permission-gate`): the full command, a reason ("recursive delete", a custom pattern's description). Answers: Allow once, Allow for session, Deny, Decline and stop (deny + abort the turn).
- **Path** (`path-access`): a path outside the workspace, file or directory, the tool asking. Answers: once / this session / always × this file or its directory (directory only for a directory), and Deny. "Always" writes to the project or global guardrails config.
- No "deny with a comment" in guardrails today. Its deny sends the agent a fixed reason.

## How the products do it

| Product | Where the prompt shows | What it shows | Answers |
| --- | --- | --- | --- |
| Claude Code CLI | Replaces the input box, as a numbered list | "Bash command", the command, Claude's description, "Do you want to proceed?" | 1 Yes · 2 Yes, and don't ask again for `<rule>` · 3 No, and tell Claude what to do differently (Esc). Tab adds a comment to Yes or No. |
| Claude Desktop Code tab / Deventry ([docs](https://deventry.app/permissions/permission-cards/)) | A card **in the conversation**; the sidebar row says "Needs your input"; OS notification when out of view | The question ("Allow this command?"), the input (command, file, diff), Claude's description, a warning when it leaves the sandbox, which subagent asks | Allow · Always allow… (shows and lets you edit the rule; split arrow has "Allow for this session") · Deny · Deny with a message…. ⌘↵ allows and ⌘⌫ denies the oldest prompt. A prompt marked refuse-by-default can't be allowed from the keyboard. After you answer, the card stays and says "Allowed" or "Denied". |
| Claude Code on phone ([remote control](https://code.claude.com/docs/en/remote-control), [#107999](https://github.com/anthropics/claude-code/issues/107999)) | Push notification plus the session view | Today the notification shows only the tool name. Users ask for the command preview, "say when it's cut", and Face ID before Allow. | Allow once · Deny · Deny with comment |
| VS Code Copilot ([docs](https://code.visualstudio.com/docs/agents/run/approvals)) | Inline in the chat, at the tool call | Tool name, its inputs, the command, path or host | **Allow Once** (primary) with a dropdown: scope (exact command or suggested prefix; file or folder) × In this Session / Always Allow. **Skip**. When the command can't be analysed safely, only Allow Once and Skip. |
| Cursor ([run modes](https://cursor.com/docs/agent/security/run-modes)) | Inline command card in the chat | The command | Skip · Run · Add to Allowlist. Forum bugs: a drawer above the input covered the Run button, so placement matters. |
| OpenAI Codex TUI ([approval_overlay.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs)) | Bottom pane overlay in place of the composer | "Would you like to run the following command?" plus the command | Yes, proceed (y) · Yes, and don't ask again for commands that start with `…` (p) · Yes, and don't ask again for this command in this session (a) · No, continue without running it (d) · No, and tell Codex what to do differently (Esc). The app tags the task "Awaiting approval" and sends an OS notification with Approve / Approve for session / Decline. |
| Devin Local ([docs](https://docs.devin.ai/desktop/devin-local/permissions)) | Request card | The command, editable | Approve · always-allow (dropdown) · Reject. Shortcut hints on the buttons. |
| Windsurf Cascade | Command card | The command | Accept / Reject, plus Allowlist → Allow (exact) or Prefix, and Deny. |

## Patterns most of them share

1. **One primary "allow this one" button, with the broader grants one step away** (a dropdown or a secondary row): Copilot, Claude Desktop, Devin. Codex and the Claude CLI list them all, but in a terminal.
2. **Every grant says what it covers**: the exact command, prefix, file or folder, session or always, and where it's saved. Claude Code only offers a broader grant when the prompt can show everything it would allow.
3. **Deny is always one tap, and Escape means deny.** Codex maps Esc to cancel, so dismissing can never quietly become a yes.
4. **Show the real input**, the whole command or the exact path, rendered from the call itself and not from the agent's summary ([agentexperience.tech](https://agentexperience.tech/insights/approval-is-a-workflow/): "Render the request from the call").
5. **Say why it's asking**: a reason or warning line (Claude Desktop: outside the sandbox; guardrails: the matched pattern).
6. **The answer stays visible in the thread** ("Allowed", "Denied"), so the record survives.
7. **Waiting is loud outside the chat**: a sidebar tag ("Needs your input", "Awaiting approval") and OS notifications.
8. **Keyboard**: Claude Desktop uses ⌘↵ / ⌘⌫ on the oldest prompt; Codex uses single letters. Plain Enter never approves.

## What the research warns about

- **Approval fatigue.** Anthropic reports that users accept 93% of manual prompts ([auto mode](https://www.anthropic.com/research/claude-code-auto-mode)). In a study of practitioners ([arXiv 2610.06047](https://arxiv.org/abs/2610.06047)), 47.7% believe they read requests carefully. Make the dangerous part easy to see, make reversibility clear, and keep "reject this action" separate from "reject the approach". Guardrails already maps that to Deny vs Decline and stop.
- **Placement bugs.** In Cursor, a translucent bar covered the Run button. The panel must not sit under other chrome, including our todo card.
- **Truncation.** On a phone, a cut command must say it's cut and open in full before you can allow it (#107999).
- **Accidental taps.** A panel that appears under a thumb can catch a tap meant for something else. Guardrails guards the keyboard with `inputGuardMs`; the browser needs its own guard.

## What this suggests for herdr-web

- Put the approval where the ask panel goes, replacing the composer. It's the one place you look while an agent waits, it doesn't scroll away, and the composer can't be used anyway while pi is blocked.
- Keep a one-line record in the thread at the tool call: "Awaiting approval" first, then "Allowed once" / "Denied".
- Primary **Allow once**. The secondary grants are labelled by scope: "Allow for this session", and for paths "this file / this folder" plus "always (saved to project config)". **Deny** is a plain button. **Decline and stop** is separate and says it ends the turn.
- Reason line first, then the whole command in mono, with Show more past ~12 lines.
- Enter doesn't approve and Escape denies. A visible ~600 ms guard before the buttons work.
- The sidebar shows "Needs approval" on that agent. A notification is a follow-up (out of scope in DEV-42).
