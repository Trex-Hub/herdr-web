"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { backendUrl, login, signedIn } from "@/lib/backend"

export default function LoginPage() {
  const router = useRouter()
  const [passphrase, setPassphrase] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [backend, setBackend] = useState("") // known only in the browser, so set after mount

  useEffect(() => {
    setBackend(backendUrl())
    void signedIn().then((yes) => {
      if (yes) router.replace("/")
    })
  }, [router])

  useEffect(() => {
    if (waitUntil <= Date.now()) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [waitUntil])

  const remaining = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const waiting = waitUntil > 0 && remaining > 0

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || waiting) return
    setBusy(true)
    setMessage(null)
    setWaitUntil(0)
    const result = await login(passphrase)
    setBusy(false)
    if (result.ok) return router.replace("/")
    setPassphrase("")
    switch (result.reason) {
      case "wrong":
        return setMessage("That passphrase is wrong.")
      case "slow": {
        const t = Date.now()
        setNow(t)
        setWaitUntil(t + result.retryAfterSeconds * 1000)
        return setMessage("Too many wrong tries.")
      }
      default:
        return setMessage(result.message)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>herdr web</CardTitle>
          <CardDescription>Enter the passphrase{backend && ` for ${backend}`}.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              type="password"
              name="passphrase"
              aria-label="Passphrase"
              placeholder="Passphrase"
              autoComplete="current-password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <Button type="submit" disabled={busy || waiting || passphrase === ""}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            {message && (
              <p role="alert" data-testid="login-error" className="text-sm text-destructive">
                {message}
                {waiting && ` Slow down: try again in ${remaining} s.`}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
