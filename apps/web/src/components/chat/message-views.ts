import type { ComponentType, ReactNode } from "react"
import type { NoticeRow } from "@herdr-web/agents/rows"
import { LinkMessage } from "./link"

/** What a message's own view is given. `plain` is the notice line every other message is shown as. */
export type MessageView = ComponentType<{ row: NoticeRow; plain: ReactNode }>

/** Messages an extension showed (a `custom_message`) that have a view of their own, by `source` (their customType). Any other is a notice line. */
export const messageViews: Readonly<Record<string, MessageView>> = {
  link: LinkMessage,
}

/** The view of a message's source, or undefined for one shown as a notice. A source like `constructor` is not a view. */
export function messageView(source: string): MessageView | undefined {
  return Object.hasOwn(messageViews, source) ? messageViews[source] : undefined
}
