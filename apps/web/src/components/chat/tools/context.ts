"use client"

import { createContext, useContext, useSyncExternalStore } from "react"
import type { ThreadState, ThreadStore } from "@/lib/chat/thread-store"

/** The thread a tool view is part of, for the views that follow more than their own row (an open prompt). Absent where a row is shown alone. */
export const ThreadStoreContext = createContext<ThreadStore | null>(null)

const none = () => () => {}

/** A part of the thread's state, or `fallback` where there is no thread. The selector must return a value that compares equal while that part is unchanged. */
export function useThreadValue<T>(select: (state: ThreadState) => T, fallback: T): T {
  const store = useContext(ThreadStoreContext)
  const get = () => (store ? select(store.getState()) : fallback)
  return useSyncExternalStore(store ? store.subscribe : none, get, get)
}
