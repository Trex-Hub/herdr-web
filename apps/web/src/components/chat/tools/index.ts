import type { ToolView } from "./types"
import { askUserView } from "./ask-user"
import { todoView } from "../todo"
import { linkCompactView, linkListView, linkSendView } from "../link"

/**
 * Tools shown in their own way, by name. Every other tool is a plain line (`ToolLine`). A tool listed here is never folded into a
 * group of steps (`TOOLS_WITH_VIEW` in `lib/chat/tool-views.ts` says which, and a test keeps the two the same).
 */
export const toolViews: Readonly<Record<string, ToolView>> = {
  ask_user: askUserView,
  link_send: linkSendView,
  link_list: linkListView,
  link_compact: linkCompactView,
  todo: todoView,
}

/** The view of a tool, or undefined for one shown plainly. A name like `constructor` is not a view. */
export function toolView(name: string): ToolView | undefined {
  return Object.hasOwn(toolViews, name) ? toolViews[name] : undefined
}
