import {
  operationPath,
  STARTERS_PATH,
  StartersSchema,
  type KillInput,
  type KillResult,
  type OperationName,
  type PinInput,
  type PinResult,
  type SeenInput,
  type SeenResult,
  type StartInput,
  type StartResult,
  type Starter,
  type UnreadInput,
} from "@herdr-web/protocol"
import { backendUrl } from "./backend"

/** What an operation came to: its result, or one sentence the app can show. */
export type OpResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type Fetch = typeof fetch

export async function request<T>(url: string, init: RequestInit, check: (body: unknown) => T, fetchImpl: Fetch): Promise<OpResult<T>> {
  let res: Response
  try {
    res = await fetchImpl(url, { credentials: "include", ...init })
  } catch {
    return { ok: false, error: "Cannot reach the backend." }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, error: `The backend answered with status ${res.status} and no message.` }
  }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error
    return { ok: false, error: typeof error === "string" && error ? error : `The backend refused (status ${res.status}).` }
  }
  try {
    return { ok: true, value: check(body) }
  } catch {
    return { ok: false, error: "The backend's answer was not what this page expects. Reload the page." }
  }
}

const post = <T>(name: OperationName, input: unknown, fetchImpl: Fetch, base: string): Promise<OpResult<T>> =>
  request(
    `${base}${operationPath(name)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    (b) => b as T,
    fetchImpl,
  )

/** The backend's five operations. `base` and `fetchImpl` are there for tests. */
export function operations(base: string = backendUrl(), fetchImpl: Fetch = (...a) => fetch(...a)) {
  return {
    start: (i: StartInput) => post<StartResult>("start", i, fetchImpl, base),
    kill: (i: KillInput) => post<KillResult>("kill", i, fetchImpl, base),
    seen: (i: SeenInput) => post<SeenResult>("seen", i, fetchImpl, base),
    unread: (i: UnreadInput) => post<SeenResult>("unread", i, fetchImpl, base),
    pin: (i: PinInput) => post<PinResult>("pin", i, fetchImpl, base),
    starters: (): Promise<OpResult<Starter[]>> => request(`${base}${STARTERS_PATH}`, {}, (b) => StartersSchema.parse(b).starters, fetchImpl),
  }
}

export type Operations = ReturnType<typeof operations>
