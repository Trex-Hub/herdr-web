"use client"

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { backendUrl, signedIn, socketUrl } from "./backend"
import { LiveClient } from "./live"
import { applyMessage, initialState, setLink, Store, type LiveState } from "./store"

const StoreContext = createContext<Store<LiveState> | null>(null)

/** Runs the one main socket for the page and keeps its state in a store. Mount it only once signed in. */
export function LiveProvider({ children, onSignedOut }: { children: React.ReactNode; onSignedOut: () => void }) {
  const [store] = useState(() => new Store<LiveState>(initialState))
  useEffect(() => {
    const client = new LiveClient(
      { url: socketUrl(), checkSession: () => signedIn(backendUrl()) },
      {
        onMessage: (m) => store.setState((s) => applyMessage(s, m)),
        onLink: (l) => store.setState((s) => setLink(s, l)),
        onSignedOut,
      },
    )
    client.start()
    return () => client.stop()
  }, [store, onSignedOut])
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

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
