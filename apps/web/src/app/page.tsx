"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { backendUrl, logout, signedIn } from "@/lib/backend"
import { LiveProvider } from "@/lib/live-context"
import { AppShell } from "@/components/shell/app-shell"

type Gate = "checking" | "in" | "unreachable"

export default function Page() {
  const router = useRouter()
  const [gate, setGate] = useState<Gate>("checking")
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    void signedIn().then((yes) => {
      if (cancelled) return
      if (yes === false) router.replace("/login")
      else if (yes) setGate("in")
      else {
        setGate("unreachable")
        retry = setTimeout(() => setAttempt((n) => n + 1), 3000) // the backend may just be restarting
      }
    })
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [router, attempt])

  const toLogin = useCallback(() => router.replace("/login"), [router])
  const signOut = useCallback(async () => {
    await logout()
    toLogin()
  }, [toLogin])

  if (gate === "in") {
    return (
      <LiveProvider onSignedOut={toLogin}>
        <AppShell onSignOut={signOut} />
      </LiveProvider>
    )
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      {gate === "checking" ? (
        "Checking your session…"
      ) : (
        <>
          <p data-testid="unreachable">Cannot reach the backend at {backendUrl()}.</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </>
      )}
    </main>
  )
}
