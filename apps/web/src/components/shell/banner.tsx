"use client"

import { AlertTriangle, CloudOff, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { staleness, type LiveState } from "@/lib/store"

/** What the banner says, or null when everything on screen is current. */
export function bannerFor(state: LiveState): { kind: "reload" | "backend" | "core" | "connecting"; text: string } | null {
  if (state.reload) return { kind: "reload", text: state.reload }
  switch (staleness(state)) {
    case "backend":
      return state.ready
        ? { kind: "backend", text: "Lost the connection to the backend. Reconnecting; what is shown may be out of date." }
        : { kind: "connecting", text: state.link === "connecting" ? "Connecting to the backend…" : "Cannot reach the backend. Retrying…" }
    case "core": {
      const why = state.connection?.error ? ` (${state.connection.error})` : ""
      return { kind: "core", text: `The backend lost its connection to herdr-core${why}. Reconnecting; what is shown may be out of date.` }
    }
    default:
      return null
  }
}

export function Banner({ state }: { state: LiveState }) {
  const banner = bannerFor(state)
  if (!banner) return null
  const Icon = banner.kind === "reload" ? RefreshCw : banner.kind === "core" ? AlertTriangle : CloudOff
  return (
    <div
      role="status"
      data-testid="banner"
      data-kind={banner.kind}
      className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{banner.text}</span>
      {banner.kind === "reload" && (
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      )}
    </div>
  )
}
