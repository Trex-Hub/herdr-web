"use client"

import { useSyncExternalStore } from "react"
import type { ThreadState, ThreadStore } from "./thread-store"

/** A part of the thread's state. The selector must return the same object while that part is unchanged. */
export function useThread<T>(store: ThreadStore, select: (state: ThreadState) => T): T {
  const get = () => select(store.getState())
  return useSyncExternalStore(store.subscribe, get, get)
}
