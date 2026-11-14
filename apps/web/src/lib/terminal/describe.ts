
const REASONS: Record<string, string> = {
  server_stop: "core stopped",
  host_shutdown: "the machine is shutting down",
  holder_lost: "its holder process died",
  stopped_by_restart: "core restarted",
  killed: "killed",
}

export function describeEnd(s: { reason: string; exitCode: number | null; signal: number | null }): string {
  if (s.reason === "exited" && s.exitCode !== null) return `Ended: exited with code ${s.exitCode}`
  if (s.signal !== null) return `Ended: killed by signal ${s.signal}`
  const why = REASONS[s.reason] ?? s.reason
  return s.exitCode !== null && s.reason !== "killed" ? `Ended: ${why} (exit code ${s.exitCode})` : `Ended: ${why}`
}
