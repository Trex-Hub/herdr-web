import type { ComponentType, ReactNode } from "react"
import type { ToolRow } from "@herdr-web/agents/rows"

/** What a tool's own row view is given. `plain` is the row as every other tool is shown, ready to use when the tool has nothing of its own to say (an error, an old row). */
export interface ToolRowViewProps {
  row: ToolRow
  fullResult: (rowId: string) => Promise<string>
  plain: ReactNode
}

/** What a tool's own view of a running call is given, before its row exists. `plain` is the plain live line. */
export interface ToolLiveViewProps {
  callId: string
  name: string
  argument?: string
  since: number
  plain: ReactNode
}

/** A tool that is shown in its own way. `Live` is for a call that has started and has no row yet; without it the plain live line is used. */
export interface ToolView {
  Row: ComponentType<ToolRowViewProps>
  Live?: ComponentType<ToolLiveViewProps>
}
