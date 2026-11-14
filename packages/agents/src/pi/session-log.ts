// Reads a pi session file (JSONL) as it grows and walks the active branch. Written against
// pi's documented session format (docs/session-format.md), not pi's code: pi's own
// `buildContextEntries` drops what a compaction summarised, and the thread shows the whole branch.
import fs from "node:fs"

/** A session entry as read: only what every entry has is relied on; the rest is checked where it is used. */
export interface Entry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  /** Line in the file (1 is the header). */
  line: number
  [key: string]: unknown
}

export interface Header {
  id: string | null
  cwd: string | null
  version: number | null
}

export class SessionLog {
  readonly entries = new Map<string, Entry>()
  /** Lines that could not be read as an entry. */
  readonly broken: number[] = []
  header: Header | null = null
  /** The last entry in the file, the leaf pi itself starts from. */
  lastId: string | null = null
  /** The session's name, from the latest `session_info` entry. */
  name: string | null = null

  private offset = 0
  private lineNo = 0

  constructor(readonly file: string | null) {}

  /** Read what was appended since the last call. Returns whether anything changed. */
  refresh(): boolean {
    if (!this.file) return false
    let fd: number
    try {
      fd = fs.openSync(this.file, "r")
    } catch {
      return false // not written yet: pi creates the file with the first assistant message
    }
    try {
      const size = fs.fstatSync(fd).size
      if (size < this.offset) this.reset() // replaced or truncated: start over
      if (size === this.offset) return false
      const buf = Buffer.allocUnsafe(size - this.offset)
      let got = 0
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, this.offset + got)
        if (n === 0) break
        got += n
      }
      // Only whole lines: the last one may still be being written.
      const end = buf.subarray(0, got).lastIndexOf(0x0a)
      if (end < 0) return false
      const text = buf.subarray(0, end + 1).toString("utf8")
      this.offset += end + 1
      let changed = false
      for (const raw of text.slice(0, -1).split("\n")) {
        this.lineNo++
        if (raw.trim() === "") continue
        changed = this.take(raw) || changed
      }
      return changed
    } finally {
      fs.closeSync(fd)
    }
  }

  private reset(): void {
    this.entries.clear()
    this.broken.length = 0
    this.header = null
    this.lastId = null
    this.name = null
    this.offset = 0
    this.lineNo = 0
  }

  private take(raw: string): boolean {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      this.broken.push(this.lineNo)
      return true
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.broken.push(this.lineNo)
      return true
    }
    if (value.type === "session") {
      this.header = {
        id: typeof value.id === "string" ? value.id : null,
        cwd: typeof value.cwd === "string" ? value.cwd : null,
        version: typeof value.version === "number" ? value.version : null,
      }
      return true
    }
    if (typeof value.id !== "string" || !(value.parentId === null || value.parentId === undefined || typeof value.parentId === "string")) {
      this.broken.push(this.lineNo)
      return true
    }
    const entry: Entry = { ...value, type: value.type, id: value.id, parentId: value.parentId ?? null, line: this.lineNo }
    this.entries.set(entry.id, entry)
    this.lastId = entry.id
    if (entry.type === "session_info") this.name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null
    return true
  }

  /**
   * The entries from the root to `leafId`, oldest first. A leaf the file does not hold (or none)
   * means the last entry. `found` says whether the wanted leaf was there.
   */
  branch(leafId: string | null): { path: Entry[]; found: boolean } {
    const found = leafId !== null && this.entries.has(leafId)
    let cursor = found ? leafId : this.lastId
    const path: Entry[] = []
    const seen = new Set<string>()
    while (cursor !== null) {
      const entry = this.entries.get(cursor)
      if (!entry || seen.has(cursor)) break
      seen.add(cursor)
      path.push(entry)
      cursor = entry.parentId
    }
    path.reverse()
    return { path, found: found || leafId === null }
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
