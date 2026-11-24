/**
 * The names of the tools that have a view of their own (`components/chat/tools`). They are never folded into a group of steps, so
 * their line stays on the page. Kept here so the grouping does not import components.
 */
export const TOOLS_WITH_VIEW: ReadonlySet<string> = new Set(["ask_user", "link_send", "link_list", "link_compact"])

/** Tools that have a view of their own and are still folded into a group of steps: `todo` calls come often, and the list pinned above the composer already shows where they lead. */
export const TOOLS_GROUPED_WITH_VIEW: ReadonlySet<string> = new Set(["todo"])
