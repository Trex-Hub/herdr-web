# Using the web app

## The shell

The sidebar lists spaces by machine, plus the agents. The main area shows the selected space's tabs and panes, laid out as in herdr.

- A machine whose layout cannot be read lists its live terminals flat.
- A live terminal labelled `herdr.space=<space id>` that sits in no pane shows as an extra tab of that space.
- A pane whose terminal is not live is hidden.
- The selected space, tab and pane, whether the sidebar is collapsed, and the theme are kept in the browser.

## Operations

- **Start.** The **+** at the end of the tab strip starts a shell, `pi` or one of core's templates in the selected space. The new terminal opens as a tab and is selected. **+** is not offered for a machine whose layout cannot be read.
- **Kill.** The **⋯** menu on a tab kills the terminal, after a confirmation that names it.
- **Agent menu.** The menu on an agent row pins or unpins the agent, marks it unread, or kills it.

If core refuses an operation, or fails it, the reason shows next to the control. While the backend or core is away every control is off, and nothing is queued for later.

## Questions from an agent

When a pi asks a question (the `ask_user` tool), the chat shows a panel in place of the composer, in both Chat and Terminal use: answer there or at the keyboard, and whichever comes first wins. The other window's panel says the question was already answered. Details: [chat](chat.md#questions-from-the-agent).

## Seen

An agent's turn is marked seen automatically, once per turn, when its pane is shown and the page is visible and focused. If the turn ends while the page is hidden or unfocused, it is marked when you come back. Chat and Terminal count the same. Seen only goes up, and **Mark unread** holds until the agent's next turn.

## The terminal view

Only the selected pane's terminal is attached. Choosing another pane detaches it.

- **Size.** The view fills the pane and follows its size, and tells core about each change while the browser tab is visible. With two windows on one terminal, the size follows whichever window acted last.
- **Scrollback.** 10,000 lines.
- **Copy and paste.** Select text to copy it. Ctrl+Shift+C also copies on systems where Ctrl+C is the interrupt key. Paste with the browser's paste.
- **Connection.** If the connection drops, the view says so and reattaches by itself with a full repaint. Input typed while it is down is dropped. After five failed attempts in a row it shows "Cannot connect to this terminal" and keeps trying, more slowly.
- **Ended terminals** show how they ended (exit code or signal), and no connection is opened.

### Keys the browser keeps

The browser keeps these keys for itself, so they never reach the terminal:

- **macOS:** Cmd+W, Cmd+T, Cmd+N, Cmd+Q, Cmd+L, Cmd+R / F5, Cmd+Tab.
- **Elsewhere:** Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+L, Ctrl+R / F5, Alt+F4.

Shells use Ctrl+W and Ctrl+R. On those systems, use the program's other bindings or install the app as a window.

Not supported: mode 2048, XTGETTCAP, inline images.
