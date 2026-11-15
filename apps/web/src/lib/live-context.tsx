"use client"

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { backendUrl, signedIn, socketUrl } from "./backend"
import { ChatFeed, type ChatEntry } from "./chat/feed"
import { LiveClient } from "./live"
import { applyMessage, initialState, setLink, Store, type LiveState } from "./store"

const StoreContext = createContext<Store<LiveState> | null>(null)
const FeedContext = createContext<ChatFeed | null>(null)

/** Runs the one main socket for the page and keeps its state in a store. Mount it only once signed in. */
export function LiveProvider({ children, onSignedOut }: { children: React.ReactNode; onSignedOut: () => void }) {
  const [store] = useState(() => new Store<LiveState>(initialState))
  const client = useRef<LiveClient | null>(null)
  const [feed] = useState(() => new ChatFeed((m) => client.current?.send(m) ?? false))
  useEffect(() => {
    const live = new LiveClient(
      { url: socketUrl(), checkSession: () => signedIn(backendUrl()) },
      {
        onMessage: (m) => {
          store.setState((s) => applyMessage(s, m))
          feed.handle(m)
        },
        onLink: (l) => {
          store.setState((s) => setLink(s, l))
          feed.setOpen(l === "open") // every new main socket starts with no chat subscribed: the feed asks again
        },
        onSignedOut,
      },
    )
    client.current = live
    live.start()
    return () => {
      live.stop()
      client.current = null
      feed.setOpen(false)
    }
  }, [store, feed, onSignedOut])
  return (
    <StoreContext.Provider value={store}>
      <FeedContext.Provider value={feed}>{children}</FeedContext.Provider>
    </StoreContext.Provider>
  )
}

/** Gives the views below a chat feed (the LiveProvider does; tests do it with a feed of their own). */
export const ChatFeedProvider = FeedContext.Provider

/** One terminal's chat while `enabled`: the feed subscribes for as long as the caller shows it. */
export function useChat(address: string, enabled: boolean): ChatEntry {
  const feed = useContext(FeedContext)
  if (!feed) throw new Error("useChat needs a LiveProvider")
  useEffect(() => (enabled ? feed.watch(address) : undefined), [feed, address, enabled])
  const get = () => (enabled ? feed.entry(address) : IDLE)
  return useSyncExternalStore(feed.subscribe, get, get)
}

const IDLE: ChatEntry = { phase: "loading", store: null, reason: null }

export function useLiveState(): LiveState {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useLiveState needs a LiveProvider")
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

/** The current time, refreshed every `everyMs`, for "39m ago" labels. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

/** A value kept in localStorage, per browser; reads after mount so the server render matches. */
export function useStored<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) setValue(JSON.parse(raw) as T)
    } catch {
      // unreadable: keep the fallback
    }
    setLoaded(true)
  }, [key])
  const set = useMemo(
    () => (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // storage full or blocked: the value still holds for this page
      }
    },
    [key],
  )
  return [loaded ? value : fallback, set]
}
