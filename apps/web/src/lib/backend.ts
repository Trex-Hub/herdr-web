/**
 * The backend's address. NEXT_PUBLIC_BACKEND_URL when set; otherwise port 7420 on the host
 * the page was opened from. Not a fixed 127.0.0.1: the sign-in cookie is SameSite=Lax, and a
 * page at localhost:3000 calling 127.0.0.1:7420 is cross-site, so the browser would not send it.
 */
export function backendUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BACKEND_URL
  if (configured) return configured.replace(/\/+$/, "")
  if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.hostname}:7420`
  return "http://127.0.0.1:7420"
}

export function socketUrl(base = backendUrl()): string {
  return `${base.replace(/^http/, "ws")}/api/ws`
}

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "wrong" }
  | { ok: false; reason: "slow"; retryAfterSeconds: number }
  | { ok: false; reason: "unreachable" | "origin" | "error"; message: string }

/**
 * Why a call to the backend never got an answer. A `no-cors` request to /health is not held to the
 * origin list: it comes back (opaque) when the backend is running, even if it will not answer this
 * page's address, and fails only when nothing is listening.
 */
export async function whyUnreachable(base = backendUrl()): Promise<{ reason: "unreachable" | "origin"; message: string }> {
  try {
    await fetch(`${base}/health`, { mode: "no-cors", credentials: "omit" })
  } catch {
    return { reason: "unreachable", message: `Cannot reach the backend at ${base}: it is not running, or the address is wrong.` }
  }
  const page = typeof window !== "undefined" ? window.location.origin : "this page"
  return {
    reason: "origin",
    message: `The backend at ${base} is running but does not allow this page's address, ${page}. Add it to HERDR_WEB_ORIGINS on the backend and restart it.`,
  }
}

export async function login(passphrase: string, base = backendUrl()): Promise<LoginResult> {
  let res: Response
  try {
    res = await fetch(`${base}/api/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    })
  } catch {
    return { ok: false, ...(await whyUnreachable(base)) }
  }
  if (res.ok) return { ok: true }
  if (res.status === 401) return { ok: false, reason: "wrong" }
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: unknown }
    const header = Number(res.headers.get("retry-after"))
    const seconds = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : Number.isFinite(header) && header > 0 ? header : 1
    return { ok: false, reason: "slow", retryAfterSeconds: seconds }
  }
  return { ok: false, reason: "error", message: `The backend answered ${res.status}.` }
}

export async function logout(base = backendUrl()): Promise<void> {
  await fetch(`${base}/api/logout`, { method: "POST", credentials: "include" }).catch(() => {})
}

/** true / false; null when the backend cannot be reached. */
export async function signedIn(base = backendUrl()): Promise<boolean | null> {
  try {
    const res = await fetch(`${base}/api/session`, { credentials: "include" })
    if (!res.ok) return null
    return ((await res.json()) as { signedIn?: unknown }).signedIn === true
  } catch {
    return null
  }
}
