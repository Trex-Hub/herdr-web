/**
 * The names of the tools that have a view of their own (`components/chat/tools`). They are never folded into a group of steps, so
 * their line stays on the page. Kept here so the grouping does not import components.
 */
export const TOOLS_WITH_VIEW: ReadonlySet<string> = new Set(["ask_user"])
