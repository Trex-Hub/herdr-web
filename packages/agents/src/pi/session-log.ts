// Reads a pi session file (JSONL) as it grows and walks the active branch. Written against
// pi's documented session format (docs/session-format.md), not pi's code: pi's own
// `buildContextEntries` drops what a compaction summarised, and the thread shows the whole branch.
import fs from "node:fs"

/** A session file bigger than this is not read at all: reading it would stall the backend. */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024
/** Read in pieces of this size, so a big file never needs one big buffer. */
const READ_CHUNK = 4 * 1024 * 1024
/** One line longer than this is taken for junk and counted as unreadable. */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024

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
  /** Why the file is not shown (too big, not a regular file); null when it is. */
  unreadable: string | null = null

  private offset = 0
  private lineNo = 0
  /** The start of a line whose end has not been written yet. */
  private partial: Buffer = Buffer.alloc(0)
  /** Dropping the rest of a line that was longer than MAX_ENTRY_BYTES. */
  private skipping = false

  constructor(readonly file: string | null) {}

  /** Read what was appended since the last call. Returns whether anything changed. */
  refresh(): boolean {
    if (!this.file) return false
    let fd: number
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    } catch {
      return false // not written yet: pi creates the file with the first assistant message
    }
    try {
      const stat = fs.fstatSync(fd)
      // A named pipe, a device or a folder is not a session: reading it could block for good.
      if (!stat.isFile()) return this.refuse("The session file is not a regular file.")
      if (stat.size > MAX_SESSION_BYTES) return this.refuse(`The session file is larger than ${MAX_SESSION_BYTES / 1024 / 1024} MiB, so its history is not shown.`)
      this.unreadable = null
      const size = stat.size
      if (size < this.offset) this.reset() // replaced or truncated: start over
      if (size === this.offset) return false
      let changed = false
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - this.offset))
      while (this.offset < size) {
        const want = Math.min(buf.length, size - this.offset)
        const n = fs.readSync(fd, buf, 0, want, this.offset)
        if (n === 0) break
        this.offset += n
        changed = this.feed(buf.subarray(0, n)) || changed
      }
      return changed
    } finally {
      fs.closeSync(fd)
    }
  }

  private refuse(why: string): boolean {
    const changed = this.unreadable !== why
    this.unreadable = why
    return changed
  }

  /** Take bytes as they come: whole lines are read, the last part waits for its newline. */
  private feed(bytes: Buffer): boolean {
    let changed = false
    let from = 0
    for (;;) {
      const at = bytes.indexOf(0x0a, from)
      if (at < 0) break
      if (this.skipping) {
        this.skipping = false // the end of an over-long line, already counted
      } else {
        const piece = bytes.subarray(from, at)
        const line = this.partial.length > 0 ? Buffer.concat([this.partial, piece]) : piece
        this.partial = Buffer.alloc(0)
        this.lineNo++
        const raw = line.toString("utf8")
        if (raw.trim() !== "") changed = this.take(raw) || changed
      }
      from = at + 1
    }
    if (this.skipping) return changed
    const rest = bytes.subarray(from)
    if (this.partial.length + rest.length > MAX_ENTRY_BYTES) {
      this.partial = Buffer.alloc(0)
      this.skipping = true
      this.lineNo++
      this.broken.push(this.lineNo)
      return true
    }
    if (rest.length > 0) this.partial = this.partial.length > 0 ? Buffer.concat([this.partial, rest]) : Buffer.from(rest)
    return changed
  }

  private reset(): void {
    this.entries.clear()
    this.broken.length = 0
    this.header = null
    this.lastId = null
    this.name = null
    this.offset = 0
    this.lineNo = 0
    this.partial = Buffer.alloc(0)
    this.skipping = false
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
