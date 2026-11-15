// The agents socket, for a backend (or a test harness standing in for one) that wants it served.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { acceptAgentConnection, type AgentConnection } from "./pi/connection.js"
import type { Thread } from "./thread.js"

export interface AgentsServer {
  readonly path: string
  close(): Promise<void>
}

export interface ServeOptions {
  log?: (line: string) => void
  /** Called for each agent that identified itself. `connection.closed` resolves when it goes. */
  onThread(thread: Thread, connection: AgentConnection): void
}

/**
 * Listen on `socketPath`: its folder is made with mode 700, a stale socket left by a dead backend
 * is removed, and a live one makes this throw (two backends must not share a socket).
 */
export async function serveAgents(socketPath: string, options: ServeOptions): Promise<AgentsServer> {
  const dir = path.dirname(socketPath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  await removeStale(socketPath)
  const connections = new Set<AgentConnection>()
  const server = net.createServer((socket) => {
    const connection = acceptAgentConnection(socket, { log: options.log })
    connections.add(connection)
    void connection.closed.then(() => connections.delete(connection))
    connection.identified.then((thread) => options.onThread(thread, connection), () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  fs.chmodSync(socketPath, 0o600)
  return {
    path: socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) c.close()
        server.close(() => resolve())
      }),
  }
}

async function removeStale(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath)
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", () => resolve(false))
  })
  if (alive) throw new Error(`another backend is already listening on ${socketPath}`)
  fs.unlinkSync(socketPath)
}
