// pi's own dialogs (`state.waitingForUser`): read from the welcome and every `state`, followed as it is, cleared by a goodbye.
import { afterEach, describe, expect, it } from "vitest"
import { connectPiLive, type PiLiveConnection } from "../src/index.js"
import { ThreadChangeSchema, type ThreadChange } from "../src/rows.js"
import { FakePi, chatPicture, until, type FakeConfig } from "./fake-pi-live.js"

const fakes: FakePi[] = []
const connections: PiLiveConnection[] = []
afterEach(async () => {
  for (const c of connections.splice(0)) c.close()
  for (const f of fakes.splice(0)) await f.stop()
})

async function opened(config: FakeConfig = {}) {
  const fake = await FakePi.start(config)
  fakes.push(fake)
  const log: string[] = []
  const connection = connectPiLive(fake.path, { terminalId: "t1", log: (l) => log.push(l), welcomeTimeoutMs: 1000, thread: { actionTimeoutMs: 300 } })
  connections.push(connection)
  const ready = await connection.ready
  const changes: ThreadChange[] = []
  ready.thread.subscribe((c) => changes.push(ThreadChangeSchema.parse(c)))
  return { fake, connection, log, thread: ready.thread, changes }
}

const picture = (waitingForUser?: unknown) => {
  const base = chatPicture()
  const { waitingForUser: _dropped, ...state } = base.state
  return { ...base, state: waitingForUser === undefined ? state : { ...state, waitingForUser } }
}
const stateMessage = (waitingForUser?: unknown) => ({ type: "state", ...picture(waitingForUser).state })
const waiting = (t: { snapshot(): { live: { waiting: unknown } } }) => t.snapshot().live.waiting

describe("a dialog of pi's own", () => {
  it("is none from a pi-live that does not send waitingForUser, with nothing logged", async () => {
    const { thread, fake, log } = await opened({ chat: picture() })
    expect(waiting(thread)).toBeNull()
    fake.send(stateMessage())
    await until(() => fake.received.length >= 0)
    expect(waiting(thread)).toBeNull()
    expect(log).toEqual([])
  })

  it("is read from the welcome, with its kind and title", async () => {
    const { thread } = await opened({ chat: picture({ kind: "confirm", title: "Deploy?" }) })
    expect(waiting(thread)).toEqual({ kind: "confirm", title: "Deploy?" })
  })

  it("opens and closes with the state, each as one live update", async () => {
    const { fake, thread, changes } = await opened({ chat: picture(null) })
    expect(waiting(thread)).toBeNull()
    fake.send(stateMessage({ kind: "select", title: "Pick one" }))
    await until(() => changes.length === 1, "the opening")
    expect(changes[0]).toMatchObject({ type: "update", live: { waiting: { kind: "select", title: "Pick one" } } })
    fake.send(stateMessage(null))
    await until(() => changes.length === 2, "the closing")
    expect(changes[1]).toMatchObject({ type: "update", live: { waiting: null } })
    expect(waiting(thread)).toBeNull()
  })

  it("has a null title when pi gives none, whether null or missing, and keeps a kind it does not know", async () => {
    const { fake, thread, changes } = await opened({ chat: picture(null) })
    fake.send(stateMessage({ kind: "editor", title: null }))
    await until(() => changes.length === 1)
    expect(waiting(thread)).toEqual({ kind: "editor", title: null })
    fake.send(stateMessage({ kind: "custom" }))
    await until(() => changes.length === 2)
    expect(waiting(thread)).toEqual({ kind: "custom", title: null })
    fake.send(stateMessage({ kind: "a-kind-from-the-future", title: "x", extra: 1 }))
    await until(() => changes.length === 3)
    expect(waiting(thread)).toEqual({ kind: "a-kind-from-the-future", title: "x" })
  })

  it("is followed as the state says: nested dialogs are one span, so the same state again is no change and the one end closes it", async () => {
    const { fake, thread, changes } = await opened({ chat: picture(null) })
    fake.send(stateMessage({ kind: "confirm", title: "Deploy?" }))
    await until(() => changes.length === 1)
    fake.send(stateMessage({ kind: "confirm", title: "Deploy?" })) // pi reports the span again for a nested prompt
    fake.send(stateMessage(null))
    await until(() => changes.length === 2)
    expect(changes[1]).toMatchObject({ live: { waiting: null } }) // the repeat made no update of its own
    expect(waiting(thread)).toBeNull()
  })

  it("does not get in the way of the rest of the live state", async () => {
    const { fake, thread } = await opened({ chat: picture(null) })
    fake.send({ ...stateMessage({ kind: "confirm", title: "Deploy?" }), working: true })
    await until(() => (thread.snapshot().live.working as boolean) === true)
    expect(thread.snapshot().live).toMatchObject({ working: true, waiting: { kind: "confirm", title: "Deploy?" }, asks: [] })
  })

  it("is cleared by a goodbye, as one update, and the connection ending leaves none", async () => {
    const { fake, thread, changes, connection } = await opened({ chat: picture({ kind: "confirm", title: "Deploy?" }) })
    fake.goodbye("reload")
    await until(() => changes.length > 0, "the update")
    expect(changes[0]).toMatchObject({ type: "update", live: { waiting: null } })
    await connection.closed
    expect(waiting(thread)).toBeNull()
  })

  it("is none after the connection ends with no goodbye", async () => {
    const { fake, thread, connection } = await opened({ chat: picture({ kind: "input", title: "Name?" }) })
    expect(waiting(thread)).not.toBeNull()
    fake.crash()
    await connection.closed
    expect(waiting(thread)).toBeNull()
  })
})
